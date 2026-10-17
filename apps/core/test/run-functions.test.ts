import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { executionErrors } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction, callRunFunction } from "../src/app-functions.ts";
import type { RunCaller } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor } from "../src/apps.ts";
import { appHost } from "../src/durable-objects.ts";
import { budgetMonth } from "../src/model-budgets.ts";
import { modelLedger } from "../src/model-ledger.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { revokeRelease } from "../src/release-retention.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode, graphSentUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { isolationFiles } from "./isolation-app.ts";
import { endLiveRuns, finished, liveStatus, sleeping, woken } from "./runs.ts";
import { person } from "./sealed-apps.ts";
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
  /** More calls after it, one after another: the step answers them all. */
  more?: readonly { reference: Record<string, unknown>; input: unknown }[];
  /** Code the step runs after the calls, before it answers. */
  after?: string;
}

/** The code of a step's calls, `answered` their answers. */
const callsOf = ({ reference, input, more = [] }: CallingStep): string =>
  [{ reference, input }, ...more]
    .map(
      (call) =>
        `    answered.push(await env.APP.callFunction(${JSON.stringify(call.reference)}, ${JSON.stringify(call.input)}));\n`
    )
    .join("");

/**
 * A workflow `id` of `steps`, each calling functions of its App and
 * answering what that answered (one answer, or each of its calls'), with
 * `options`, and `between` each two; it answers every step's answer. Its
 * test mocks every step.
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
    (calling, index) =>
      `${index === 0 ? "" : between}  answers.push(await step.do("${calling.name}", { description: "Call a function", sideEffect: true, input: null, ${options} }, async () => {
    const answered = [];
${callsOf(calling)}    ${calling.after ?? ""}
    return answered.length === 1 ? answered[0] : answered;
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
import { action, internalQuery } from "#grasp/server";

export const writer = resource.model("writer", { maxOutputTokens: 300 });

export const secret = internalQuery({ args: {}, returns: v.string(), handler: () => "hidden" });

export const draft = action({
  args: { prompt: v.string().min(1) },
  returns: v.string(),
  uses: [writer],
  handler: async (ctx, args) => await ctx.resources.writer.generate({ prompt: args.prompt }),
});

/** Asks the model once, then fails in a way nobody expected. */
export const flaky = action({
  args: {},
  returns: v.string(),
  uses: [writer],
  handler: async (ctx) => {
    await ctx.resources.writer.generate({ prompt: "Hi" });
    throw new Error("Something broke");
  },
});

/** Streams its progress: only a screen following it runs it. */
export const streamed = action({
  args: {},
  returns: v.null(),
  stream: v.object({ done: v.number() }),
  handler: async (ctx) => {
    await ctx.emit({ done: 1 });
    return null;
  },
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
import { draft, flaky, secret, streamed, twice, writer } from "./operations/assist.ts";
import schema from "./schema.ts";

export default app({
  name: "Assistant",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { assist: { draft, twice, flaky, streamed } },
  internalOperations: { hidden: { secret } },
  screens: [],
  uses: [writer],
});
`,
});

/**
 * An App whose action starts the workflow it declares, and whose mutation
 * stages its start for after its commit (workflow-start-intents.ts).
 */
const startingFiles = (): Record<string, string> => ({
  "schema.ts": schemaFile,
  "operations/desk.ts": `import { resource, v } from "@grasp-os/sdk";
import { action, mutation } from "#grasp/server";

export const followUp = resource.workflow("followUp", {
  input: v.object({ who: v.string() }),
  output: v.object({ status: v.string() }),
});

export const kickOff = action({
  args: { who: v.string() },
  returns: v.string(),
  uses: [followUp],
  handler: async (ctx, args) => {
    const started = await ctx.startWorkflow(followUp, { who: args.who });
    return started.startId;
  },
});

export const submit = mutation({
  args: { who: v.string() },
  returns: v.id("notes"),
  uses: [followUp],
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("notes", { title: args.who });
    await ctx.afterCommit.start(followUp, { who: args.who });
    return id;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { followUp, kickOff, submit } from "./operations/desk.ts";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { desk: { kickOff, submit } },
  screens: [],
  uses: [followUp],
});
`,
});

/** A JSON object's schema descriptor, all of `properties` required. */
const objectSchemaOf = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/**
 * A workflow of `owner`'s, bound to App `app` as `followUp`, with the
 * App's `start` on it granted by an admin, for version 1.
 */
const deskWorkflowBound = async (owner: string, app: string) => {
  const by = {
    userId: owner,
    role: "builder" as const,
    teams: [],
    staff: false,
  };
  const admin = await person("admin");
  const workflow = await createWorkflowResource(
    env,
    by,
    `desk-${crypto.randomUUID()}`
  );
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name: workflow.name,
        version: "1.0.0",
        title: workflow.name,
        metadata: {
          grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
        },
      },
      input: { schema: objectSchemaOf({ who: { type: "string" } }) },
      output: { schema: objectSchemaOf({ status: { type: "string" } }) },
      do: [{ greet: { set: { status: "done" } } }],
    }),
    basedOn: null,
  });
  await bindWorkflowToApp(env, by, workflow.id, {
    app,
    alias: "followUp",
    version: 1,
  });
  const asked = await requestPermission(
    env,
    by,
    {
      subject: { type: "app", appId: app },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: "FOLLOW_UP",
    },
    {
      app: async (named: string, role: "user" | "builder") =>
        await appFor(env, by, named, role),
      resource: async (
        ref: Parameters<typeof requireResourceRole>[2],
        needed: Parameters<typeof requireResourceRole>[3]
      ) => {
        await requireResourceRole(env, by, ref, needed);
      },
    }
  );
  await grantPermission(env, admin, asked.id, { version: 1 });
};

/**
 * An App whose actions send mail through Microsoft 365, with a mutation
 * that keeps a note and a query that counts the caller's notes.
 */
const mailFiles = (): Record<string, string> => ({
  "schema.ts": schemaFile,
  "operations/mail.ts": `import { resource, v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";

export const note = mutation({
  args: { title: v.string().min(1) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const count = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).length,
});

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

/** Sends \`count\` mails, \`prefix\` and a number each: how many were sent. */
export const sendMany = action({
  args: { prefix: v.string().min(1), count: v.number().integer().min(1).max(30) },
  returns: v.number(),
  uses: [mail],
  handler: async (ctx, args) => {
    let sent = 0;
    for (let index = 0; index < args.count; index += 1) {
      try {
        await ctx.resources.mail.call("send", {
          mailbox: "team@acme.test",
          subject: args.prefix + " " + index,
          body: "Hello.",
          to: ["ada@acme.test"],
        });
        sent += 1;
      } catch {
        // Held, or refused: the next one.
      }
    }
    return sent;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { count, mail, note, send, sendMany } from "./operations/mail.ts";
import schema from "./schema.ts";

export default app({
  name: "Mailer",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { mail: { send, sendMany, note, count } },
  internalOperations: {},
  screens: [],
  uses: [mail],
});
`,
});

/**
 * The Mailer, with an action that asks a text model (`assist.draft`): an
 * App that keeps notes, sends mail and asks a model.
 */
const draftingMailFiles = (): Record<string, string> => ({
  ...mailFiles(),
  "operations/assist.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const writer = resource.model("writer", { maxOutputTokens: 300 });

export const draft = action({
  args: { prompt: v.string().min(1) },
  returns: v.string(),
  uses: [writer],
  handler: async (ctx, args) => await ctx.resources.writer.generate({ prompt: args.prompt }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { draft, writer } from "./operations/assist.ts";
import { count, mail, note, send, sendMany } from "./operations/mail.ts";
import schema from "./schema.ts";

export default app({
  name: "Mailer",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { mail: { send, sendMany, note, count }, assist: { draft } },
  internalOperations: {},
  screens: [],
  uses: [mail, writer],
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

/**
 * What `who`'s screen gets calling the function `contractId` of the App's
 * `version` (its first unless named), current, with `input`, as a screen
 * calls it.
 */
const callAs = async (
  who: Person,
  app: string,
  {
    contractId,
    kind = "query",
    version = 1,
  }: { contractId: string; kind?: string; version?: number },
  input: unknown = {}
): Promise<OperationResult> => {
  const released = await loadRelease(env, appIdSchema.parse(app), version);
  const answered = await callAppFunction(
    env,
    await who.api.whoami(),
    app,
    JSON.stringify({
      reference: {
        resourceId: app,
        resourceVersion: version,
        contractId,
        fingerprint: released.fingerprints[contractId] ?? "",
        kind,
      },
      input,
    })
  );
  return answered.result;
};

/** What a call of an attempt no longer holding its lease is refused with. */
const stale = () => executionErrors.create("execution.stale_attempt");

/** A workflow `sleeper` that waits a day, so its run is there to act as. */
const sleeper = {
  "workflows/sleeper.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("sleeper", { params: {}, input: z.unknown() }, async (step) => {
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return null;
});
`,
  "workflows/sleeper.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./sleeper.ts";

export default workflowTests(definition, [{ name: "runs", mocks: {}, expect: {} }]);
`,
};

/** A run of `sleeper` in an App of `files`, asleep: its App and run. */
const sleepingRun = async (files: Record<string, string>) => {
  const admin = await personApi("admin");
  const builder = await personApi("builder");
  const app = await appWith(builder, { ...files, ...sleeper });
  const run = await builder.api.workflows.start(app, "sleeper");
  await sleeping(run.id, "go");
  return { admin, builder, app, runId: run.id };
};

/**
 * A step of `sleepingRun`'s run, as core resolves it for its call
 * (`RunCaller`), whose attempt holds its lease while `lease.holds`: the
 * run's own identity, with the lease in the test's hands, for what only a
 * run's timing could bring about otherwise.
 */
const stepOf = (
  { app, builder, runId }: Awaited<ReturnType<typeof sleepingRun>>,
  lease: { holds: boolean }
): RunCaller => ({
  run: {
    app: appIdSchema.parse(app),
    workflow: workflowIdSchema.parse("sleeper"),
    runId: runIdSchema.parse(runId),
    version: 1,
    shareSubject: builder.userId,
    authority: {
      subject: { type: "app", appId: appIdSchema.parse(app) },
      onBehalfOf: builder.userId,
      mode: "workflow",
      appVersion: 1,
    },
  },
  requestId: crypto.randomUUID(),
  deadline: Date.now() + 30_000,
  stillCurrent: async () => {
    await Promise.resolve();
    if (!lease.holds) {
      throw stale();
    }
  },
  requireHolds: () => {
    if (!lease.holds) {
      throw stale();
    }
  },
  held: () => {
    throw new Error("Nothing is held here");
  },
});

/**
 * `caller`, whose call's start is admitted, every other check of the
 * gate passed, only once `meanwhile` has happened: what lands while a
 * call runs, made certain.
 */
const startedBefore = (
  caller: RunCaller,
  meanwhile: () => Promise<void>
): RunCaller => {
  let happened: Promise<void> | undefined;
  return {
    ...caller,
    stillCurrent: async () => {
      happened ??= meanwhile();
      await happened;
      await caller.stillCurrent();
    },
  };
};

/**
 * Core's env with AI Gateway answering `replies` behind the AI binding,
 * the model gateway's `rules`, and `db` as its database.
 */
const callEnv = (
  replies: GatewayReply[],
  { rules = {}, db = env.DB }: { rules?: object; db?: D1Database } = {}
) => {
  const gateway = fakeGateway(...replies);
  const changed: Env = {
    ...env,
    DB: db,
    MODEL_GATEWAY: {
      gateway: "grasp-os-test",
      models: [allowedModel],
      ...rules,
    },
  };
  Reflect.set(changed, "AI", gateway.binding);
  return { gateway, env: changed };
};

/**
 * Core's database, with `onRead` run as the `nth` query that reads from
 * `table` starts: a change landing while a call reads.
 */
const racingRead = (
  table: string,
  nth: number,
  onRead: () => void
): D1Database => {
  const reading = new RegExp(`from "${table}"`, "iu");
  let reads = 0;
  return new Proxy(env.DB, {
    get: (target, property) => {
      if (property === "prepare") {
        return (query: string) => {
          if (reading.test(query)) {
            reads += 1;
            if (reads === nth) {
              onRead();
            }
          }
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
};

/**
 * The Assistant with a workflow of two steps a day apart, each drafting
 * through its writer, which an admin bound.
 */
const twoStepApp = async () => {
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
  return { admin, builder, app, binding: await bindWriter(admin, app) };
};

/**
 * A run of the two-step workflow (`twoStepApp`) `starter` starts, with
 * `change` made while it waits between its steps: its output, as
 * `reader`, an admin, sees it, and how many requests reached the gateway.
 */
const changedBetween = async (
  reader: Person,
  starter: Person,
  app: string,
  change: () => Promise<void>
) => {
  const gateway = gatewayAnswering(answer("One."), answer("Never sent."));
  const run = await starter.api.workflows.start(app, "assist");
  await sleeping(run.id, "go");
  await change();
  await woken(run.id);
  await finished(run.id);
  const { status, output } = await reader.api.workflows.status(run.id);
  return { status, output, asked: gateway.requests.length };
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

  it("start no workflow, from an action or after a mutation's commit, so no run's step opens a lineage of its own", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...startingFiles(),
      ...callingWorkflow("desk", [
        {
          name: "start",
          reference: { contractId: "desk.kickOff", kind: "action" },
          input: { who: "Ada" },
          more: [
            {
              reference: { contractId: "desk.submit", kind: "mutation" },
              input: { who: "Ada" },
            },
          ],
        },
      ]),
    });
    // Bound and granted, as a person's start from a screen needs: what
    // refuses the run's start is that a run makes it, nothing else.
    await deskWorkflowBound(builder.userId, app);
    const run = await builder.api.workflows.start(app, "desk");
    const ended = await endedRun(builder, run.id);
    const receipts = await env.DB.prepare(
      "SELECT count(*) AS count FROM workflow_start_receipts WHERE invoker_type = 'app' AND invoker_id = ?"
    )
      .bind(app)
      .first<{ count: number }>();
    expect({ ended, receipts: receipts?.count }).toMatchObject({
      ended: {
        status: "completed",
        output: [
          [
            { ok: false, error: { code: "resource.unavailable" } },
            { ok: false, error: { code: "resource.unavailable" } },
          ],
        ],
      },
      receipts: 0,
    });
  });

  it("stop serving a binding revoked between two steps of a run", async () => {
    const { admin, builder, app, binding } = await twoStepApp();
    const ended = await changedBetween(admin, builder, app, async () => {
      await admin.api.resourceBindings.revoke(binding.id);
    });
    expect(ended).toMatchObject({
      output: [
        { ok: true, value: "One." },
        { ok: false, error: { code: "resource.unavailable" } },
      ],
      asked: 1,
    });
  });

  it("refuse a run's next step once the person it acts for lost the App", async () => {
    const { admin, builder, app } = await twoStepApp();
    const member = await personApi("user");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    const ended = await changedBetween(admin, member, app, async () => {
      await builder.api.apps.members.remove(app, {
        type: "person",
        id: member.userId,
      });
    });
    expect(ended).toMatchObject({
      output: [
        { ok: true, value: "One." },
        { ok: false, error: { code: "app.not_found" } },
      ],
      asked: 1,
    });
  });

  it("refuse a run's next step once its release is revoked", async () => {
    const { admin, builder, app } = await twoStepApp();
    const ended = await changedBetween(admin, builder, app, async () => {
      await revokeRelease(
        env,
        await person("admin"),
        { app: appIdSchema.parse(app), version: 1 },
        "Compromised"
      );
    });
    expect(ended).toMatchObject({
      output: [
        { ok: true, value: "One." },
        { ok: false, error: { code: "version.revoked" } },
      ],
      asked: 1,
    });
  });

  it("refuse a run on a version no admin approved, even its App's own data, and record the refusal", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const title = `Unapproved ${crypto.randomUUID()}`;
    const count = { contractId: "mail.count", kind: "query" };
    const note = { contractId: "mail.note", kind: "mutation" };
    // Each version the same functions, told apart by a mark: the run waits
    // a day between counting and keeping a note in the App's own store,
    // which no connector permission covers.
    const version = (mark: string) => ({
      ...mailFiles(),
      ...callingWorkflow(
        "noter",
        [
          { name: "count", reference: count, input: {} },
          {
            name: "note",
            reference: note,
            input: { title },
            // Then how many notes there are: the attacked run's too, had it
            // written one.
            more: [{ reference: count, input: {} }],
            after: `// ${mark}`,
          },
        ],
        { between: aDay }
      ),
    });
    const app = await appWith(builder, version("First."));
    const connectionId = await connectShared(admin);
    const permission = await builder.api.permissions.request({
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId },
      actions: ["mail.send"],
      binding: "MAIL",
    });
    await admin.api.permissions.grant(permission.id, { version: 1 });
    // The attack: the builder's own version, which an admin's run starts
    // on and waits in; then a harmless one, which the admin grants again
    // for, so the App holds a permission that changes things once more.
    await release(builder, app, version("Writes whatever it likes."));
    const run = await admin.api.workflows.start(app, "noter");
    await sleeping(run.id, "go");
    await release(builder, app, version("Harmless."));
    await admin.api.permissions.grant(permission.id, { version: 3 });
    await woken(run.id);
    const attacked = await endedRun(admin, run.id);
    // A run on the version the admin granted for writes.
    const approved = await admin.api.workflows.start(app, "noter");
    await sleeping(approved.id, "go");
    await woken(approved.id);
    const events = await allEvents();
    const refusals = events.filter(
      ({ action, target }) =>
        action === "workflow.call.refused" && target?.id === run.id
    );
    expect({
      attacked,
      approved: await endedRun(admin, approved.id),
      refusals: refusals.map(({ actor, detail }) => ({ actor, detail })),
      // The call's input never reaches the log.
      leaked: JSON.stringify(refusals).includes(title),
    }).toMatchObject({
      attacked: {
        version: 2,
        status: "completed",
        output: [
          { ok: true, value: 0 },
          [
            { ok: false, error: { code: "permission.denied" } },
            { ok: false, error: { code: "permission.denied" } },
          ],
        ],
      },
      // Only its own note: the attacked run wrote none.
      approved: {
        version: 3,
        status: "completed",
        output: [
          { ok: true, value: 0 },
          [{ ok: true }, { ok: true, value: 1 }],
        ],
      },
      // Once for each call refused.
      refusals: ["mail.note", "mail.count"].map((call) => ({
        actor: { type: "workflow", appId: app, runId: run.id },
        detail: {
          app,
          version: 2,
          call,
          errorCode: "permission.denied",
          reason: "version.unapproved",
        },
      })),
      leaked: false,
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
        {
          name: "reshaped",
          reference: { ...draft, fingerprint: "0".repeat(64) },
          input: { prompt: "Hi" },
        },
        {
          name: "internal",
          reference: { contractId: "hidden.secret", kind: "query" },
          input: {},
        },
        {
          name: "kind",
          reference: { ...draft, kind: "query" },
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
          { ok: false, error: { code: "version.mismatch" } },
          // An internal function is refused as one that doesn't exist.
          { ok: false, error: { code: "operation.not_found" } },
          { ok: false, error: { code: "operation.kind_mismatch" } },
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

  it("do each of a step's calls, and make the same calls when the step runs again, so each effect happens once", async () => {
    const subject = `Invoice ${crypto.randomUUID()}`;
    const note = { contractId: "mail.note", kind: "mutation" };
    const { builder, app } = await mailerApp(
      callingWorkflow(
        "mailer",
        [
          {
            name: "work",
            // Two notes, and the same mail sent twice on purpose.
            reference: note,
            input: { title: "First" },
            more: [
              { reference: note, input: { title: "Second" } },
              { reference: send, input: { subject } },
              { reference: send, input: { subject } },
            ],
            // Runs out of time after the calls, every attempt: retried
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
      // Each attempt sent twice, under two keys: the second attempt got
      // the first's answers.
      calls: calls
        .map(({ detail }) => String(detail.outcome))
        .toSorted((one, other) => one.localeCompare(other)),
      keys: new Set(calls.map(({ detail }) => detail.idempotencyKeyHash)).size,
      notes: await callAs(builder, app, { contractId: "mail.count" }),
    }).toStrictEqual({
      status: "failed",
      sent: 2,
      calls: ["ok", "ok", "replayed", "replayed"],
      keys: 2,
      notes: { ok: true, value: 2 },
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

  it("keep a step waiting while any of more side effects than its marker keeps still waits", async () => {
    const prefix = `Batch ${crypto.randomUUID()}`;
    const sendMany = { contractId: "mail.sendMany", kind: "action" };
    const { builder, app } = await mailerApp(
      callingWorkflow("mailer", [
        {
          name: "send",
          reference: sendMany,
          input: { prefix: `${prefix} a`, count: 20 },
          more: [
            {
              reference: sendMany,
              input: { prefix: `${prefix} b`, count: 20 },
            },
          ],
        },
      ])
    );
    await appHost(env, appIdSchema.parse(app)).restrict();
    const run = await builder.api.workflows.start(app, "mailer");
    await runEvents(run.id, "workflow.run.waiting");
    const pending = builder.api.pendingActions;
    const held = await pending.list();
    // All but one confirmed: the step waits on, whichever was left.
    const [last, ...rest] = held;
    for (const action of rest) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await pending.confirm(action.id, action.inputHash);
    }
    await vi.waitFor(
      async () => {
        await expect(liveStatus(run.id)).resolves.toBe("waiting");
      },
      { timeout: 20_000, interval: 100 }
    );
    const { status: whileOneWaits } = await builder.api.workflows.status(
      run.id
    );
    if (last !== undefined) {
      await pending.confirm(last.id, last.inputHash);
    }
    const ended = await endedRun(builder, run.id);
    const sent = await Promise.all(
      ["a", "b"].flatMap((batch) =>
        Array.from(
          { length: 20 },
          async (_, index) => await sentCount(`${prefix} ${batch} ${index}`)
        )
      )
    );
    expect({
      held: held.length,
      whileOneWaits,
      ended: { status: ended.status, output: ended.output },
      sent: sent.every((count) => count === 1),
    }).toStrictEqual({
      held: 40,
      whileOneWaits: "waiting",
      ended: {
        status: "completed",
        output: [
          [
            { ok: true, value: 20 },
            { ok: true, value: 20 },
          ],
        ],
      },
      sent: true,
    });
  });

  it("refuse a streaming action: it runs only for a screen following it", async () => {
    const asleep = await sleepingRun(modelFiles());
    const result = await callRunFunction(
      env,
      stepOf(asleep, { holds: true }),
      { contractId: "assist.streamed", kind: "action" },
      {},
      `step:${crypto.randomUUID()}`
    );
    expect(result.ok ? null : result.error.code).toBe(
      "operation.mode_mismatch"
    );
  });

  it("refuse a resource request whose attempt was let go of while the gate read", async () => {
    const asleep = await sleepingRun(modelFiles());
    await bindWriter(asleep.admin, asleep.app);
    const lease = { holds: true };
    // The call's start reads the membership once, the request again.
    const { gateway, env: racing } = callEnv([answer("Never sent.")], {
      db: racingRead("members", 2, () => {
        lease.holds = false;
      }),
    });
    const result = await callRunFunction(
      racing,
      stepOf(asleep, lease),
      draft,
      { prompt: "Hi" },
      `step:${crypto.randomUUID()}`
    );
    expect({
      failed: result.ok ? null : result.error.code,
      asked: gateway.requests.length,
    }).toStrictEqual({ failed: "execution.stale_attempt", asked: 0 });
  });

  it("refuse a resource request whose attempt was let go of while its binding was read", async () => {
    const asleep = await sleepingRun(modelFiles());
    await bindWriter(asleep.admin, asleep.app);
    const lease = { holds: true };
    // After the gate: the request reads its binding, then asks.
    const { gateway, env: racing } = callEnv([answer("Never sent.")], {
      db: racingRead("app_resource_bindings", 1, () => {
        lease.holds = false;
      }),
    });
    const result = await callRunFunction(
      racing,
      stepOf(asleep, lease),
      draft,
      { prompt: "Hi" },
      `step:${crypto.randomUUID()}`
    );
    expect({
      failed: result.ok ? null : result.error.code,
      asked: gateway.requests.length,
    }).toStrictEqual({ failed: "execution.stale_attempt", asked: 0 });
  });

  it("commit nothing for an attempt let go of while the gate read", async () => {
    const asleep = await sleepingRun(mailFiles());
    const lease = { holds: true };
    // The call's start reads the membership once, the commit again.
    const { env: racing } = callEnv([], {
      db: racingRead("members", 2, () => {
        lease.holds = false;
      }),
    });
    const result = await callRunFunction(
      racing,
      stepOf(asleep, lease),
      { contractId: "mail.note", kind: "mutation" },
      { title: "Late" },
      `step:${crypto.randomUUID()}`
    );
    const counted = await callRunFunction(
      env,
      stepOf(asleep, { holds: true }),
      { contractId: "mail.count", kind: "query" },
      {},
      `step:${crypto.randomUUID()}`
    );
    expect({
      failed: result.ok ? null : result.error.code,
      counted,
    }).toStrictEqual({
      failed: "execution.stale_attempt",
      counted: { ok: true, value: 0 },
    });
  });

  it("count a run's requests through a binding against its run lineage's budget, which a screen's don't", async () => {
    const asleep = await sleepingRun(modelFiles());
    await bindWriter(asleep.admin, asleep.app);
    // The first answer costs far more than the run lineage may spend.
    const { gateway, env: budgeted } = callEnv(
      [
        { text: "Costly.", inputTokens: 10_000_000, outputTokens: 20 },
        // The run's second request never reaches it: the screen's does.
        answer("For the screen."),
      ],
      { rules: { budgets: { run: { limit: 0.01 } } } }
    );
    const step = stepOf(asleep, { holds: true });
    const call = async () =>
      await callRunFunction(
        budgeted,
        { ...step, requestId: crypto.randomUUID() },
        draft,
        { prompt: "Hi" },
        `step:${crypto.randomUUID()}`
      );
    const first = await call();
    const second = await call();
    const app = appIdSchema.parse(asleep.app);
    const released = await loadRelease(env, app, 1);
    const screen = await callAppFunction(
      budgeted,
      await asleep.builder.api.whoami(),
      app,
      JSON.stringify({
        reference: {
          resourceId: app,
          resourceVersion: 1,
          contractId: "assist.draft",
          fingerprint: released.fingerprints["assist.draft"] ?? "",
          kind: "action",
        },
        input: { prompt: "Hi" },
      })
    );
    expect({
      first,
      second: second.ok ? null : second.error.code,
      screen: screen.result,
      asked: gateway.requests.length,
    }).toMatchObject({
      first: { ok: true, value: "Costly." },
      second: "resource.budget_exhausted",
      screen: { ok: true, value: "For the screen." },
      asked: 2,
    });
  });

  it("send nothing through connect for an attempt let go of while the request was signed", async () => {
    const subject = `Invoice ${crypto.randomUUID()}`;
    const mailer = await mailerApp(sleeper);
    const run = await mailer.builder.api.workflows.start(mailer.app, "sleeper");
    await sleeping(run.id, "go");
    const lease = { holds: true };
    // The binding's grant is read as it is resolved, then the permission
    // again as the call is signed: the lease goes during the signing.
    const { env: racing } = callEnv([], {
      db: racingRead("permissions", 2, () => {
        lease.holds = false;
      }),
    });
    const result = await callRunFunction(
      racing,
      stepOf({ ...mailer, runId: run.id }, lease),
      send,
      { subject },
      `step:${crypto.randomUUID()}`
    );
    expect({
      failed: result.ok ? null : result.error.code,
      sent: await sentCount(subject),
    }).toStrictEqual({ failed: "execution.stale_attempt", sent: 0 });
  });

  it("send no provider request for an attempt let go of while the gateway admitted it", async () => {
    const asleep = await sleepingRun(modelFiles());
    await bindWriter(asleep.admin, asleep.app);
    const lease = { holds: true };
    // The gateway's rules read the run as they judge the request, after
    // the binding was resolved and before the request is sent.
    const { gateway, env: racing } = callEnv([answer("Never sent.")], {
      db: racingRead("workflow_runs", 1, () => {
        lease.holds = false;
      }),
    });
    const result = await callRunFunction(
      racing,
      stepOf(asleep, lease),
      draft,
      { prompt: "Hi" },
      `step:${crypto.randomUUID()}`
    );
    expect({
      failed: result.ok ? null : result.error.code,
      asked: gateway.requests.length,
    }).toStrictEqual({ failed: "execution.stale_attempt", asked: 0 });
  });

  it("retry a step that throws a function's failed answer as it came, when trying again may fix it", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...modelFiles(),
      ...callingWorkflow(
        "assist",
        [
          {
            name: "flaky",
            reference: { contractId: "assist.flaky", kind: "action" },
            input: {},
            // As the SDK says to: the answer's error, thrown as it is.
            after: "if (!answered[0].ok) throw answered[0].error;",
          },
        ],
        { options: `retries: { limit: 1, delay: "1 second" }` }
      ),
    });
    await bindWriter(admin, app);
    const gateway = gatewayAnswering(answer("One."), answer("Two."));
    const run = await builder.api.workflows.start(app, "assist");
    const ended = await endedRun(admin, run.id);
    expect({
      status: ended.status,
      code: ended.failure?.error.code,
      // Each attempt asked once before its function failed.
      asked: gateway.requests.length,
    }).toStrictEqual({
      status: "failed",
      code: "internal.unexpected",
      asked: 2,
    });
  });
});

describe(
  "a workflow run's calls of its App's functions, beside other callers'",
  { timeout: 120_000 },
  () => {
    afterEach(async () => {
      await endLiveRuns();
    });

    /** The functions of the App of `isolationFiles`, as callers name them. */
    const notes = {
      create: { contractId: "notes.create", kind: "mutation" },
      titles: { contractId: "notes.titles", kind: "query" },
      hold: { contractId: "notes.hold", kind: "action" },
      useKept: { contractId: "notes.useKept", kind: "mutation" },
      keepAfter: { contractId: "notes.keepAfter", kind: "action" },
      late: { contractId: "notes.late", kind: "action" },
    };

    /**
     * The App of `isolationFiles`, a builder's, with a workflow for each
     * function a run calls in these tests, and another person who uses it.
     */
    const isolatedApp = async () => {
      const builder = await personApi("builder");
      const other = await personApi("user");
      const app = await appWith(builder, {
        ...isolationFiles,
        ...callingWorkflow("holder", [
          { name: "hold", reference: notes.hold, input: {} },
        ]),
        ...callingWorkflow("user", [
          { name: "use", reference: notes.useKept, input: {} },
        ]),
        ...callingWorkflow("keeper", [
          { name: "keep", reference: notes.keepAfter, input: {} },
        ]),
        // Its step's attempt has 2 seconds; the function waits 4.
        ...callingWorkflow(
          "hurried",
          [{ name: "late", reference: notes.late, input: {} }],
          { options: 'retries: { limit: 0 }, timeout: "2 seconds"' }
        ),
      });
      await builder.api.apps.members.add(app, {
        type: "person",
        id: other.userId,
        role: "user",
      });
      return { builder, other, app };
    };

    it("never hand what a run's held call keeps to another person's run or screen", async () => {
      const { builder, other, app } = await isolatedApp();
      // GRA-383's held call, made by a run: A keeps its channel in module
      // state and holds its call open until a "release" note appears.
      const holding = await builder.api.workflows.start(app, "holder");
      await vi.waitFor(
        async () => {
          await expect(
            callAs(builder, app, notes.titles)
          ).resolves.toStrictEqual({ ok: true, value: ["A holding"] });
        },
        { timeout: 20_000, interval: 100 }
      );
      // B, another person, calls while A holds: from a run, and from a screen.
      const using = await other.api.workflows.start(app, "user");
      const fromRun = await endedRun(other, using.id);
      const fromScreen = await callAs(other, app, notes.useKept);
      // Only now is A let go.
      await callAs(builder, app, notes.create, { title: "release" });
      expect({
        fromRun,
        fromScreen,
        held: await endedRun(builder, holding.id),
        titles: await callAs(builder, app, notes.titles),
      }).toMatchObject({
        fromRun: {
          status: "completed",
          output: [{ ok: true, value: "nothing kept" }],
        },
        fromScreen: { ok: true, value: "nothing kept" },
        held: { status: "completed", output: [{ ok: true, value: null }] },
        titles: { ok: true, value: ["A holding", "release"] },
      });
    });

    it("end a run's call with it: work its code schedules past it never runs", async () => {
      const { builder, app } = await isolatedApp();
      const keeping = await builder.api.workflows.start(app, "keeper");
      await expect(endedRun(builder, keeping.id)).resolves.toMatchObject({
        status: "completed",
        output: [{ ok: true, value: null }],
      });
      await scheduler.wait(1000);
      await expect(callAs(builder, app, notes.titles)).resolves.toStrictEqual({
        ok: true,
        value: [],
      });
    });

    it("cut a run's call short at its step's deadline, after which it writes nothing", async () => {
      const { builder, app } = await isolatedApp();
      const hurried = await builder.api.workflows.start(app, "hurried");
      const ended = await endedRun(builder, hurried.id);
      // Past the function's own wait, had it gone on.
      await scheduler.wait(4000);
      expect({
        status: ended.status,
        titles: await callAs(builder, app, notes.titles),
      }).toStrictEqual({ status: "failed", titles: { ok: true, value: [] } });
    });

    it("hold a step's call to its attempt's deadline, while the attempt still holds its lease", async () => {
      const asleep = await sleepingRun(isolationFiles);
      const late = await callRunFunction(
        env,
        { ...stepOf(asleep, { holds: true }), deadline: Date.now() + 2000 },
        notes.late,
        {},
        `step:${crypto.randomUUID()}`
      );
      // Past the function's own wait, had it gone on.
      await scheduler.wait(4000);
      expect({
        late,
        titles: await callAs(asleep.builder, asleep.app, notes.titles),
      }).toMatchObject({
        late: { ok: false, error: { code: "operation.deadline_exceeded" } },
        titles: { ok: true, value: [] },
      });
    });
  }
);

describe(
  "a workflow run's call on a version no admin approved",
  { timeout: 120_000 },
  () => {
    afterEach(async () => {
      await endLiveRuns();
    });

    /**
     * A run asleep in its builder's App of `draftingMailFiles`, its first
     * version current and unapproved, with its model bound and a permission
     * on mail the builder asked for but nobody granted yet: nothing changes
     * things, so the version runs. `grant` makes it change things again: the
     * builder's second version, and an admin's grant for it.
     */
    const unapprovedRun = async () => {
      const asleep = await sleepingRun(draftingMailFiles());
      await bindWriter(asleep.admin, asleep.app);
      const connectionId = await connectShared(asleep.admin);
      const permission = await asleep.builder.api.permissions.request({
        subject: { type: "app", appId: asleep.app },
        object: { type: "connection", connectionId },
        actions: ["mail.send"],
        binding: "MAIL",
      });
      const files = draftingMailFiles();
      await release(asleep.builder, asleep.app, {
        ...files,
        ...sleeper,
        "operations/assist.ts": `${files["operations/assist.ts"] ?? ""}// The second version.\n`,
      });
      const grant = async () => {
        await asleep.admin.api.permissions.grant(permission.id, { version: 2 });
      };
      return { asleep, grant };
    };

    it("refuse the commit of a call started before an admin granted for a later version", async () => {
      const { asleep, grant } = await unapprovedRun();
      const result = await callRunFunction(
        env,
        startedBefore(stepOf(asleep, { holds: true }), grant),
        { contractId: "mail.note", kind: "mutation" },
        { title: "Too late" },
        `step:${crypto.randomUUID()}`
      );
      expect({
        failed: result.ok ? null : result.error.code,
        notes: await callAs(asleep.builder, asleep.app, {
          contractId: "mail.count",
          version: 2,
        }),
      }).toStrictEqual({
        failed: "permission.denied",
        notes: { ok: true, value: 0 },
      });
    });

    it("refuse the resource request of a call started before an admin granted for a later version", async () => {
      const { asleep, grant } = await unapprovedRun();
      const { gateway, env: calling } = callEnv([answer("Never sent.")]);
      const result = await callRunFunction(
        calling,
        startedBefore(stepOf(asleep, { holds: true }), grant),
        draft,
        { prompt: "Hi" },
        `step:${crypto.randomUUID()}`
      );
      expect({
        failed: result.ok ? null : result.error.code,
        asked: gateway.requests.length,
      }).toStrictEqual({ failed: "permission.denied", asked: 0 });
    });
  }
);
