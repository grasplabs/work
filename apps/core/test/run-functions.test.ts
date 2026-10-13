import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appHost } from "../src/durable-objects.ts";
import { budgetMonth } from "../src/model-budgets.ts";
import { modelLedger } from "../src/model-ledger.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode, graphSentUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished, sleeping, woken } from "./runs.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";
import { runEvents } from "./workflow-apps.ts";

// A workflow run calls a public function of its own App's sealed release
// (`env.APP.callFunction`), and the function's `ctx.resources` resolve
// through the App's approved bindings as the run (spec 12, 32.3, 14.4).
// The ways it can fail come first: a cancelled or stale attempt still
// reaching a resource, a binding revoked between steps still serving, a
// run of one App reaching another's bindings, a model request escaping
// the run's budgets, a retried step repeating a side effect, a held side
// effect completing the step without the person. Everything runs for
// real, through the dispatcher, the engine and connect; only AI Gateway,
// Microsoft's sign-in and Graph are faked.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** The model the tests' deployment allows. */
const allowedModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** A step of a workflow that calls one of its App's functions. */
interface CallingStep {
  name: string;
  /** The function, as the step names it to `env.APP.callFunction`. */
  reference: Record<string, unknown>;
  input: unknown;
  /** Code the step runs after the call, before it answers. */
  after?: string;
}

/**
 * A workflow `id` of `steps`, each calling a function of its App and
 * answering what that answered, with `options`, and `between` each two;
 * it answers every step's answer. Its test mocks every step.
 */
const callingWorkflow = (
  id: string,
  steps: readonly CallingStep[],
  { between = "", options = "retries: { limit: 0 }" } = {}
): Record<string, string> => ({
  [`workflows/${id}.ts`]: `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("${id}", { params: {}, input: z.unknown() }, async (step, { env }) => {
  const answers = [];
${steps
  .map(
    ({ name, reference, input, after = "" }, index) =>
      `${index === 0 ? "" : between}  answers.push(await step.do("${name}", { description: "Call a function", sideEffect: true, input: null, ${options} }, async () => {
    const answered = await env.APP.callFunction(${JSON.stringify(reference)}, ${JSON.stringify(input)});
    ${after}
    return answered;
  }));
`
  )
  .join("")}  return answers;
});
`,
  [`workflows/${id}.workflow-tests.ts`]: `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./${id}.ts";

export default workflowTests(definition, [
  { name: "runs", mocks: ${JSON.stringify(
    Object.fromEntries(steps.map(({ name }) => [name, null]))
  )}, expect: {} },
]);
`,
});

/** The Assistant's `draft`, as a step names it. */
const draft = { contractId: "assist.draft", kind: "action" };

/** A wait of a day between two steps, which a test ends (`woken`). */
const aDay = `  await step.sleep("go", { description: "Wait", duration: "1 day" });
`;

const schemaFile = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ notes: defineTable({ title: v.string() }) });
`;

/** An App whose actions use a text model: once, and twice in one call. */
const modelFiles = (): Record<string, string> => ({
  "schema.ts": schemaFile,
  "operations/assist.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const writer = resource.model("writer", { maxOutputTokens: 300 });

export const draft = action({
  args: { prompt: v.string().min(1) },
  returns: v.string(),
  uses: [writer],
  handler: async (ctx, args) => await ctx.resources.writer.generate({ prompt: args.prompt }),
});

/** Two requests in one call; says how the second ended. */
export const twice = action({
  args: {},
  returns: v.string(),
  uses: [writer],
  handler: async (ctx) => {
    const first = await ctx.resources.writer.generate({ prompt: "one" });
    try {
      await ctx.resources.writer.generate({ prompt: "two" });
      return first + "|ran";
    } catch (error) {
      return first + "|" + String(Reflect.get(Object(error), "code"));
    }
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { draft, twice, writer } from "./operations/assist.ts";
import schema from "./schema.ts";

export default app({
  name: "Assistant",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { assist: { draft, twice } },
  internalOperations: {},
  screens: [],
  uses: [writer],
});
`,
});

/** An App whose action sends mail through Microsoft 365. */
const mailFiles = (): Record<string, string> => ({
  "schema.ts": schemaFile,
  "operations/mail.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const mail = resource.connector("mail", {
  contract: "microsoft-365.mail@1",
  actions: ["send"],
});

export const send = action({
  args: { subject: v.string().min(1) },
  returns: v.boolean(),
  uses: [mail],
  handler: async (ctx, args) => {
    const sent = await ctx.resources.mail.call("send", {
      mailbox: "team@acme.test",
      subject: args.subject,
      body: "Hello.",
      to: ["ada@acme.test"],
    });
    return typeof sent === "object" && sent !== null && Reflect.get(sent, "sent") === true;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { mail, send } from "./operations/mail.ts";
import schema from "./schema.ts";

export default app({
  name: "Mailer",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { mail: { send } },
  internalOperations: {},
  screens: [],
  uses: [mail],
});
`,
});

/** The Mailer's `send`, as a step names it. */
const send = { contractId: "mail.send", kind: "action" };

/** A new App of `builder`'s with `files`, current: its ID. */
const appWith = async (
  builder: Person,
  files: Record<string, string>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Engine" });
  await release(builder, id, files);
  return id;
};

/** `admin`'s approval of the App's `writer` to the allowed model. */
const bindWriter = async (
  admin: Person,
  app: string,
  budget?: { perDay: number }
) =>
  await admin.api.resourceBindings.approve({
    app,
    alias: "writer",
    target: { kind: "model", model: allowedModel },
    reviewed: { version: 1 },
    ...(budget === undefined ? {} : { budget }),
  });

/** AI Gateway answering `replies` in turn, behind the AI binding. */
const gatewayAnswering = (...replies: GatewayReply[]) => {
  const gateway = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
  return gateway;
};

const answer = (text: string): GatewayReply => ({
  text,
  inputTokens: 100,
  outputTokens: 20,
});

/** A run once it has ended, as its starter reads it. */
const endedRun = async (starter: Person, run: string) => {
  await finished(run);
  return await starter.api.workflows.status(run);
};

/** A shared Microsoft 365 account, connected by `admin`: its ID. */
const connectShared = async (admin: Person): Promise<string> => {
  const { url } = await admin.api.connections.start({
    provider: "microsoft",
    scope: "shared",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, `team-${crypto.randomUUID()}`),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: admin.session },
  });
  const listed = await admin.api.connections.list();
  const shared = listed.find((connection) => connection.scope === "shared");
  if (shared === undefined) {
    throw new Error("Expected the shared connection");
  }
  return shared.id;
};

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** How many messages Graph sent with `subject` (each test's own). */
const sentCount = async (subject: string): Promise<number> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await providers.fetch(graphSentUrl);
  const sent = z.array(z.unknown()).parse(await response.json());
  return sent.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      Reflect.get(message, "subject") === subject
  ).length;
};

/**
 * The Mailer, with `workflow`, made current by a builder, with a
 * permission on a shared Microsoft 365 connection an admin granted, and
 * its mail resource bound to it.
 */
const mailerApp = async (workflow: Record<string, string>) => {
  const admin = await personApi("admin");
  const builder = await personApi("builder");
  const app = await appWith(builder, { ...mailFiles(), ...workflow });
  const connectionId = await connectShared(admin);
  const requested = await builder.api.permissions.request({
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId },
    actions: ["mail.send"],
    binding: "MAIL",
  });
  await admin.api.permissions.grant(requested.id, { version: 1 });
  await admin.api.resourceBindings.approve({
    app,
    alias: "mail",
    target: { kind: "connector", permissionId: requested.id },
    reviewed: { version: 1 },
  });
  return { admin, builder, app };
};

describe("an App's functions a workflow run calls", { timeout: 90_000 }, () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await endLiveRuns();
  });

  it("reach a model through the App's binding as the run, counted against the binding's caps and the run's budgets", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...modelFiles(),
      ...callingWorkflow("assist", [
        { name: "draft", reference: draft, input: { prompt: "Hi" } },
      ]),
    });
    await bindWriter(admin, app, { perDay: 1 });
    const gateway = gatewayAnswering(answer("Hello."));
    const run = await builder.api.workflows.start(app, "assist");
    const ended = await endedRun(builder, run.id);
    const [runSpend] = await modelLedger(env).spendOfKeys(
      budgetMonth(env),
      "run",
      [run.id]
    );
    const events = await allEvents();
    const calls = events.filter(
      ({ action, actor }) =>
        action === "model.call" &&
        actor.type === "workflow" &&
        actor.runId === run.id
    );
    const { bindings } = await admin.api.models.settings();
    expect({
      ended,
      asked: gateway.requests.length,
      runSpent: (runSpend?.spentMicros ?? 0) > 0,
      calls: calls.map(({ actor, detail }) => ({
        actor,
        purpose: detail.purpose,
      })),
      bindingSpent:
        (bindings.listed.find((binding) => binding.appId === app)?.today ?? 0) >
        0,
    }).toMatchObject({
      ended: { status: "completed", output: [{ ok: true, value: "Hello." }] },
      asked: 1,
      // The run lineage's spend counts it, so the run's budgets limit it,
      // and so do the binding's own caps.
      runSpent: true,
      bindingSpent: true,
      // Audited as the run, not as the App.
      calls: [
        {
          actor: {
            type: "workflow",
            appId: app,
            workflowId: "assist",
            runId: run.id,
          },
          purpose: "app.resource",
        },
      ],
    });
  });

  it("stop serving a binding revoked between two steps of a run", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...modelFiles(),
      ...callingWorkflow(
        "assist",
        [
          { name: "first", reference: draft, input: { prompt: "One" } },
          { name: "second", reference: draft, input: { prompt: "Two" } },
        ],
        { between: aDay }
      ),
    });
    const binding = await bindWriter(admin, app);
    const gateway = gatewayAnswering(answer("One."), answer("Never sent."));
    const run = await builder.api.workflows.start(app, "assist");
    await sleeping(run.id, "go");
    await admin.api.resourceBindings.revoke(binding.id);
    await woken(run.id);
    expect({
      ended: await endedRun(builder, run.id),
      asked: gateway.requests.length,
    }).toMatchObject({
      ended: {
        status: "completed",
        output: [
          { ok: true, value: "One." },
          { ok: false, error: { code: "resource.unavailable" } },
        ],
      },
      asked: 1,
    });
  });

  it("serve a run only its own App's bindings and functions", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    // Another App of the same code, its writer bound.
    const other = await appWith(builder, modelFiles());
    await bindWriter(admin, other);
    const app = await appWith(builder, {
      ...modelFiles(),
      ...callingWorkflow("assist", [
        { name: "own", reference: draft, input: { prompt: "Hi" } },
        {
          name: "theirs",
          reference: { ...draft, resourceId: other },
          input: { prompt: "Hi" },
        },
        {
          name: "older",
          reference: { ...draft, resourceVersion: 2 },
          input: { prompt: "Hi" },
        },
      ]),
    });
    const gateway = gatewayAnswering(answer("Never sent."));
    const run = await builder.api.workflows.start(app, "assist");
    expect({
      ended: await endedRun(builder, run.id),
      asked: gateway.requests.length,
    }).toMatchObject({
      ended: {
        status: "completed",
        output: [
          // Its own App's writer isn't bound: the other App's binding of
          // the same alias serves it nothing.
          { ok: false, error: { code: "resource.unavailable" } },
          { ok: false, error: { code: "version.mismatch" } },
          { ok: false, error: { code: "version.mismatch" } },
        ],
      },
      asked: 0,
    });
  });

  it("refuse a cancelled run's function its next resource request, however the App's code goes on", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...modelFiles(),
      ...callingWorkflow("assist", [
        {
          name: "twice",
          reference: { contractId: "assist.twice", kind: "action" },
          input: {},
        },
      ]),
    });
    await bindWriter(admin, app);
    const gate = Promise.withResolvers<unknown>();
    const gateway = gatewayAnswering(
      { ...answer("first"), pause: { at: 2, until: gate.promise } },
      answer("Never sent.")
    );
    const run = await builder.api.workflows.start(app, "assist");
    await vi.waitFor(
      () => {
        expect(gateway.requests).toHaveLength(1);
      },
      { timeout: 20_000, interval: 50 }
    );
    await builder.api.workflows.cancel(run.id);
    // The first answer reaches the App's code, which asks again.
    gate.resolve(null);
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        const refused = events.filter(
          ({ action, target }) =>
            action === "workflow.call.refused" && target?.id === run.id
        );
        expect(refused.map(({ detail }) => detail.errorCode)).toContain(
          "execution.stale_attempt"
        );
      },
      { timeout: 20_000, interval: 200 }
    );
    const { status } = await endedRun(builder, run.id);
    expect({ status, asked: gateway.requests.length }).toStrictEqual({
      status: "cancelled",
      asked: 1,
    });
  });

  it("make the same call when a step runs again, so its side effect happens once", async () => {
    const subject = `Invoice ${crypto.randomUUID()}`;
    const { builder, app } = await mailerApp(
      callingWorkflow(
        "mailer",
        [
          {
            name: "send",
            reference: send,
            input: { subject },
            // Runs out of time after the call, every attempt: retried
            // once, as a timeout is.
            after: `await new Promise((resolve) => setTimeout(resolve, 3000));`,
          },
        ],
        {
          options: `timeout: "1 second", retries: { limit: 1, delay: "1 second" }`,
        }
      )
    );
    const run = await builder.api.workflows.start(app, "mailer");
    const ended = await endedRun(builder, run.id);
    const events = await allEvents();
    const calls = events.filter(
      ({ action, actor }) =>
        action === "connection.call" &&
        actor.type === "app" &&
        actor.appId === app
    );
    expect({
      status: ended.status,
      sent: await sentCount(subject),
      // Both attempts called it, under one key: the second got the
      // first's answer.
      calls: calls.map(({ detail }) => [detail.outcome, detail.mode]),
      keys: new Set(calls.map(({ detail }) => detail.idempotencyKeyHash)).size,
    }).toStrictEqual({
      status: "failed",
      sent: 1,
      calls: [
        ["ok", "workflow"],
        ["replayed", "workflow"],
      ],
      keys: 1,
    });
  });

  it("hold the step while a side effect waits for the person, then complete it with the answer, sent once", async () => {
    const subject = `Invoice ${crypto.randomUUID()}`;
    const { builder, app } = await mailerApp(
      callingWorkflow("mailer", [
        { name: "send", reference: send, input: { subject } },
      ])
    );
    // A run of an App that read restricted data: each side effect waits.
    await appHost(env, appIdSchema.parse(app)).restrict();
    const run = await builder.api.workflows.start(app, "mailer");
    await runEvents(run.id, "workflow.run.waiting");
    const waiting = await builder.api.pendingActions.list();
    const held = waiting.find(({ action }) => action === "mail.send");
    if (held === undefined) {
      throw new Error("Nothing held");
    }
    const before = await sentCount(subject);
    await builder.api.pendingActions.confirm(held.id, held.inputHash);
    const ended = await endedRun(builder, run.id);
    const audited = await runEvents(run.id, "workflow.run.completed");
    expect({
      held: { mode: held.mode, restricted: held.restricted },
      before,
      ended,
      sent: await sentCount(subject),
      waitedHeld: audited.includes("workflow.run.waiting held"),
    }).toMatchObject({
      held: { mode: "workflow", restricted: true },
      before: 0,
      // Run again once confirmed, the step got the answer of the call
      // that ran: never `resource.awaiting_confirmation`.
      ended: { status: "completed", output: [{ ok: true, value: true }] },
      sent: 1,
      waitedHeld: true,
    });
  });
});
