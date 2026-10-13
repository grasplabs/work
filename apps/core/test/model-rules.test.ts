import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, newTeam, readCollection } from "./knowledge.ts";
import { mailConnection } from "./mail-connection.ts";
import { finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import {
  appWith as serverAppWith,
  bindModel,
  grantMail,
  modelRegistration,
  workflowFiles,
} from "./workflow-apps.ts";

// The client's rules for model calls, checked on every call before
// anything is sent. AI Gateway is the outside system: a fake behind the AI
// binding. Everything else is real, down to the audit log and, for the
// rules a workflow run meets, the run.

/**
 * A new App with the sample server and `files`, declaring the model
 * resources its workflows' AI steps go through, which a test binds.
 */
const appWith = async (
  builder: Parameters<typeof serverAppWith>[0],
  files: Record<string, string>
): Promise<string> =>
  await serverAppWith(builder, {
    ...modelRegistration({ reader: 32_768, anywhere: 12_000, eu: 32_768 }),
    ...files,
  });

/** An AI step reading a total through the App's `reader`, with `retries`. */
const llm = (retries: string) => `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    ${retries}
  });`;

const idp = mockIdp();

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const anthropic = "anthropic/claude-sonnet-4-5";
/** Hosted in the EU, as the tests' config says: its provider's EU region. */
const euModel = "openai/gpt-5.4";

const gateway = "grasp-os-test";
const allowed = [workersAi, anthropic, euModel];

/** An answer that costs next to nothing. */
const cheapAnswer = { text: "Hi.", inputTokens: 10, outputTokens: 5 };

let monthsUsed = 0;

/**
 * A month no other test counts budgets in, so none depends on the real
 * month or another test's spend.
 */
const newMonth = (): string => {
  monthsUsed += 1;
  const year = 2100 + Math.floor(monthsUsed / 12);
  return `${year}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * Core's env with the fake gateway answering up to eight calls with
 * `answer`, and the rules `config` adds; budgets count in `month`.
 */
const withRules = (
  config: Record<string, unknown>,
  answer: GatewayReply = cheapAnswer,
  month = newMonth()
) => {
  const fake = fakeGateway(...Array.from({ length: 8 }, () => answer));
  const rulesEnv: ModelsEnv = {
    ...env,
    AI: fake.binding,
    MODEL_GATEWAY: { gateway, models: allowed, ...config },
    MODEL_BUDGET_MONTH: month,
  };
  const { call, agent } = models(rulesEnv);
  return { fake, call, agent };
};

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/**
 * Where the calls here work unless a test says otherwise: an App of its
 * own, never restricted, made before the first test (once the IdP mock
 * is up) and kept for the rest.
 */
let appWork: ModelCall<undefined>["work"] | undefined;

const requireWork = (): ModelCall<undefined>["work"] => {
  if (appWork === undefined) {
    throw new Error("The tests' App isn't made yet");
  }
  return appWork;
};

const hello = (
  model: string,
  more: Partial<ModelCall<undefined>> = {}
): ModelCall<undefined> => ({
  model,
  input: "Hello.",
  purpose: "chat.turn",
  trigger: newPerson(),
  work: requireWork(),
  ...more,
});

/**
 * What `run` returns, with `config` as the deployment's gateway config for
 * the workflow runs it starts, and the fake gateway answering with
 * `replies`.
 */
const withDeploymentRules = async <Result>(
  config: unknown,
  replies: GatewayReply[],
  run: () => Promise<Result>
) => {
  const { MODEL_GATEWAY: before, MODEL_BUDGET_MONTH: month } = env;
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const sending = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  try {
    env.MODEL_GATEWAY = config;
    env.MODEL_BUDGET_MONTH = newMonth();
    return { fake, result: await run() };
  } finally {
    env.MODEL_GATEWAY = before;
    env.MODEL_BUDGET_MONTH = month;
    sending.mockRestore();
  }
};

/** The model gateway's actions among `events`, in order. */
const modelActions = (events: AuditEvent[]): string[] =>
  events
    .map(({ action }) => action)
    .filter((action) => action.startsWith("model."));

/** A run of `workflow` in `app` no other test uses. */
const runOf = (app: string, workflow: string) =>
  runActorOf({ runId: `run-${crypto.randomUUID()}`, app, workflow });

/**
 * The audit events `actor` triggered, the model ledger's alerts included:
 * its alarm delivers what its outbox holds.
 */
const eventsOf = async (actor: unknown): Promise<AuditEvent[]> => {
  await runDurableObjectAlarm(modelLedger(env));
  const events = await allEvents();
  return events.filter(
    (event) => JSON.stringify(event.actor) === JSON.stringify(actor)
  );
};

// The tests that run a workflow release an App of their own, which runs
// its workflow tests to activate it, have permissions granted where they
// need them, and wait for up to two runs to end, one after another
// (`finished` gives each up to 20 seconds). On a loaded CI runner that
// takes longer than Vitest's default five seconds: the sensitive-collection
// test, with two workflows to activate and two runs, timed out there.
// Sixty seconds fits two runs' waits with room for the setup, as
// app-roles.test.ts and knowledge-access.test.ts give theirs.
describe("model rules", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    if (appWork !== undefined) {
      return;
    }
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Model rules" });
    const appId = appIdSchema.parse(id);
    appWork = {
      authority: {
        subject: { type: "app", appId },
        onBehalfOf: builder.userId,
        mode: "interactive",
        appVersion: 1,
      },
      context: { type: "app", appId },
    };
  });

  it("keep every call of an EU-only deployment with a model hosted in the EU, still through AI Gateway, and audit each refusal", async () => {
    const { fake, call } = withRules({
      eu: { models: [euModel], deployment: true },
    });
    const refused = hello(anthropic, { provenance: ["doc-1"] });
    const answered = hello(euModel);

    await expect(call(refused)).rejects.toMatchObject({
      code: "model.eu_only",
      message:
        "This call must stay in the EU, and that model isn't hosted in the EU. Choose one that is.",
      details: { model: anthropic, because: "deployment" },
    });
    await expect(
      Promise.all([outcome(call(hello(workersAi))), outcome(call(answered))])
    ).resolves.toStrictEqual(["model.eu_only", "ok"]);

    // Only the EU model's call was sent, to the deployment's gateway.
    expect(fake.requests.map(({ url }) => new URL(url).pathname)).toStrictEqual(
      [`/ai-gateway/gateways/${gateway}/openai/responses`]
    );
    await expect(eventsOf(refused.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        provenance: ["doc-1"],
        detail: {
          purpose: "chat.turn",
          reason: "model.eu_only",
          because: "deployment",
          model: anthropic,
        },
      },
    ]);
    await expect(eventsOf(answered.trigger)).resolves.toMatchObject([
      { action: "model.call", detail: { euOnly: "deployment" } },
    ]);
  });

  it("keep a listed workflow's AI steps in the EU, and no other caller's", async () => {
    const eu = {
      models: [euModel],
      workflows: [{ app: "app-1", workflow: "invoices" }],
    };
    const { call } = withRules({ eu });
    const step = async (
      model: string,
      trigger: ModelCall<undefined>["trigger"]
    ) =>
      await outcome(call(hello(model, { purpose: "workflow.step", trigger })));

    await expect(
      Promise.all([
        step(anthropic, runOf("app-1", "invoices")),
        step(euModel, runOf("app-1", "invoices")),
        // The same workflow name in another App, and another workflow.
        step(anthropic, runOf("app-2", "invoices")),
        step(anthropic, runOf("app-1", "orders")),
      ])
    ).resolves.toStrictEqual(["model.eu_only", "ok", "ok", "ok"]);
  });

  it("keep a call in the EU when an EU-only connection's data fed it or may have", async () => {
    const { call } = withRules({
      eu: { models: [euModel], connections: ["connection-eu"] },
    });

    await expect(
      Promise.all([
        outcome(call(hello(anthropic, { provenance: ["connection-eu"] }))),
        outcome(call(hello(anthropic, { connections: ["connection-eu"] }))),
        outcome(call(hello(euModel, { connections: ["connection-eu"] }))),
        outcome(
          call(
            hello(anthropic, {
              provenance: ["doc-1"],
              connections: ["connection-other"],
            })
          )
        ),
      ])
    ).resolves.toStrictEqual(["model.eu_only", "model.eu_only", "ok", "ok"]);
  });

  it("audit a model the deployment doesn't allow as refused", async () => {
    const { call } = withRules({});
    const refused = hello("anthropic/claude-opus-4-1");

    await expect(outcome(call(refused))).resolves.toBe("model.not_allowed");
    await expect(eventsOf(refused.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: {
          reason: "model.not_allowed",
          because: null,
          model: "anthropic/claude-opus-4-1",
          provenanceDropped: 0,
        },
      },
    ]);
  });

  it("record a refusal whose provenance is too large for the audit log, with as much of it as fits", async () => {
    const { call } = withRules({});
    // A hundred identifiers of 256 three-byte characters: 77 KB.
    const provenance = Array.from({ length: 100 }, (_, index) =>
      `${index}`.padEnd(256, "€")
    );
    const refused = hello("anthropic/claude-opus-4-1", { provenance });

    await expect(outcome(call(refused))).resolves.toBe("model.not_allowed");
    const [event, ...more] = await eventsOf(refused.trigger);
    const kept = event?.provenance.length ?? 0;
    expect({
      more: more.length,
      kept: kept > 0 && kept < 100,
      provenance: event?.provenance,
      dropped: event?.detail.provenanceDropped,
    }).toStrictEqual({
      more: 0,
      kept: true,
      provenance: provenance.slice(0, kept),
      dropped: 100 - kept,
    });
  });

  it.each([
    ["eu", { eu: { models: "all of them" } }],
    ["sensitive", { sensitive: { models: [euModel], connections: 7 } }],
    ["budgets", { budgets: { user: { limit: -5 } } }],
  ])("refuse every call while a %s rule is malformed", async (_, malformed) => {
    const { fake, call } = withRules(malformed);

    await expect(outcome(call(hello(anthropic)))).resolves.toBe(
      "model.unconfigured"
    );
    expect(fake.requests).toStrictEqual([]);
  });

  it.each([
    ["an EU model", { eu: { models: [euModel], deployment: true } }],
    ["a model for sensitive data", { sensitive: { models: [euModel] } }],
  ])(
    "refuse every call when %s isn't an allowed one: the config is invalid",
    async (_, rules) => {
      const { fake, call } = withRules({ models: [workersAi], ...rules });

      await expect(outcome(call(hello(workersAi)))).resolves.toBe(
        "model.unconfigured"
      );
      expect(fake.requests).toStrictEqual([]);
    }
  );

  it("send a prompt holding a sensitive collection's content only to a model the data rule lists, such as an EU one", async () => {
    const admin = await signedInApi(idp, "admin");
    const teamId = await newTeam(admin, []);
    const [payroll, handbook] = await Promise.all([
      collectionWithNote(admin.api, {
        name: "Payroll",
        access: "teams",
        teams: [teamId],
        sensitive: true,
      }),
      collectionWithNote(admin.api, { name: "Handbook", access: "everyone" }),
    ]);
    const { fake, call } = withRules({ sensitive: { models: [euModel] } });
    const refused = hello(anthropic, {
      provenance: [handbook.noteId, payroll.collectionId],
    });
    const answered = hello(euModel, { provenance: [payroll.noteId] });

    await expect(
      Promise.all([
        outcome(call(refused)),
        // Named by one of its documents.
        outcome(call(hello(anthropic, { provenance: [payroll.noteId] }))),
        outcome(call(answered)),
        // Nothing sensitive: any allowed model.
        outcome(call(hello(anthropic, { provenance: [handbook.noteId] }))),
      ])
    ).resolves.toStrictEqual([
      "model.sensitive_data",
      "model.sensitive_data",
      "ok",
      "ok",
    ]);
    expect(fake.requests).toHaveLength(2);
    await expect(eventsOf(refused.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: { reason: "model.sensitive_data", because: "collection" },
      },
    ]);
    await expect(eventsOf(answered.trigger)).resolves.toMatchObject([
      { action: "model.call", detail: { sensitive: "collection" } },
    ]);
  });

  it("send a sensitive connection's data only to a model the data rule lists", async () => {
    const { call } = withRules({
      sensitive: { models: [euModel], connections: ["connection-hr"] },
    });

    await expect(
      Promise.all([
        outcome(call(hello(anthropic, { connections: ["connection-hr"] }))),
        outcome(call(hello(anthropic, { provenance: ["connection-hr"] }))),
        outcome(call(hello(euModel, { connections: ["connection-hr"] }))),
        outcome(call(hello(anthropic, { connections: ["connection-crm"] }))),
      ])
    ).resolves.toStrictEqual([
      "model.sensitive_data",
      "model.sensitive_data",
      "ok",
      "ok",
    ]);
  });

  it.each([
    ["no data rule", {}, []],
    [
      "a data rule its connection alone would refuse it by",
      { sensitive: { models: [euModel], connections: ["connection-hr"] } },
      ["connection-hr"],
    ],
    [
      "a data rule its model is listed in",
      { sensitive: { models: [anthropic] } },
      [],
    ],
  ])(
    "refuse and audit a call that claims to work in another App's context, with %s",
    async (_, rules, connections) => {
      const { fake, call } = withRules(rules);
      const app = appIdSchema.parse(`app-${crypto.randomUUID()}`);
      const other = appIdSchema.parse(`app-${crypto.randomUUID()}`);
      const claimed = hello(anthropic, {
        connections,
        work: {
          authority: {
            subject: { type: "app", appId: app },
            onBehalfOf: "person-1",
            mode: "workflow",
            appVersion: 1,
          },
          context: { type: "app", appId: other },
        },
      });

      await expect(outcome(call(claimed))).resolves.toBe(
        "permission.context_invalid"
      );
      expect(fake.requests).toStrictEqual([]);
      await expect(eventsOf(claimed.trigger)).resolves.toMatchObject([
        {
          action: "model.refused",
          detail: { reason: "permission.context_invalid", because: null },
        },
      ]);
    }
  );

  it("refuse and audit a call that comes without a work context", async () => {
    const { fake, call } = withRules({});
    const { work: _, ...withoutWork } = hello(anthropic);
    // SAFETY: missing on purpose, as from a caller that isn't type-checked;
    // every typed caller must pass `work`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const contextless = withoutWork as ModelCall<undefined>;

    await expect(outcome(call(contextless))).resolves.toBe(
      "permission.context_invalid"
    );
    expect(fake.requests).toStrictEqual([]);
    await expect(eventsOf(contextless.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: { reason: "permission.context_invalid", because: null },
      },
    ]);
  });

  it("retry a workflow's AI step the budget turned away while other calls hold it, no sooner than 15 seconds on, however tight its retries", async () => {
    const builder = await signedInApi(idp, "builder");
    // One retry, a millisecond on: the step's own delay.
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    retries: { limit: 1, delay: 1 },
  });`,
        { extract: { total: 1234 } }
      )
    );
    const release = Promise.withResolvers<boolean>();
    const actor = (runId: string) =>
      runActorOf({ runId, app, workflow: "reader" });

    // Sonnet 4.5 reserves some $0.56: another of the workflow's runs holds
    // its $1 budget while it answers, until released.
    const { result } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, anthropic],
        budgets: { workflow: { limit: 1 } },
      },
      [
        { ...cheapAnswer, pause: { at: 1, until: release.promise } },
        { text: '{ "total": 1234 }', inputTokens: 10, outputTokens: 5 },
      ],
      async () => {
        await bindModel(app, "reader", anthropic);
        const holding = outcome(
          models(env).call(
            hello(anthropic, {
              purpose: "workflow.step",
              trigger: actor(`run-${crypto.randomUUID()}`),
            })
          )
        );
        await vi.waitFor(async () => {
          const read = await modelLedger(env).spendOf(
            env.MODEL_BUDGET_MONTH ?? "",
            ["workflow"],
            10
          );
          expect(read.workflow?.[0]?.reservedMicros).toBeGreaterThan(0);
        });
        const run = await builder.api.workflows.start(app, "reader");
        await vi.waitFor(
          async () => {
            const events = await eventsOf(actor(run.id));
            expect(events.map(({ action }) => action)).toContain(
              "model.refused"
            );
          },
          { timeout: 10_000, interval: 200 }
        );
        // Still held a while after the refusal: a retry a millisecond on
        // would be turned away again, and spend the step's last.
        await scheduler.wait(3000);
        release.resolve(true);
        await finished(run.id);
        return {
          held: await holding,
          run: await builder.api.workflows.status(run.id),
          events: await eventsOf(actor(run.id)),
        };
      }
    );

    const timeOf = (action: string) =>
      Date.parse(
        result.events.find((event) => event.action === action)?.at ?? ""
      );
    expect({
      held: result.held,
      run: result.run,
      refused: result.events
        .filter(({ action }) => action === "model.refused")
        .map(({ detail }) => detail),
      waited: timeOf("model.call") - timeOf("model.refused") >= 15_000,
    }).toMatchObject({
      held: "ok",
      run: { status: "completed", output: { total: 1234 } },
      // A shared budget: a fixed wait, nothing of the other run's timing.
      refused: [
        {
          reason: "model.budget_busy",
          because: "workflow",
          retryAfterSeconds: 60,
        },
      ],
      waited: true,
    });
  });

  it("ask the ledger for a busy step at most every 15 seconds, however short its attempts' timeout, and fail a step with no retry left at once", async () => {
    const builder = await signedInApi(idp, "builder");
    // Attempts that time out after a second, retried a millisecond on; and
    // a step with no retry at all.
    const app = await appWith(builder, {
      ...workflowFiles(
        "reader",
        llm("timeout: 1000, retries: { limit: 40, delay: 1 },"),
        {
          extract: { total: 1234 },
        }
      ),
      ...workflowFiles("once", llm("retries: { limit: 0 },"), {
        extract: { total: 1234 },
      }),
    });
    const release = Promise.withResolvers<boolean>();
    const actor = (runId: string, workflow = "reader") =>
      runActorOf({ runId, app, workflow });

    // Another run of each workflow holds its $1 budget while it answers,
    // until released.
    const { result } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, anthropic],
        budgets: { workflow: { limit: 1 } },
      },
      [
        { ...cheapAnswer, pause: { at: 1, until: release.promise } },
        { ...cheapAnswer, pause: { at: 1, until: release.promise } },
        { text: '{ "total": 1234 }', inputTokens: 10, outputTokens: 5 },
      ],
      async () => {
        await bindModel(app, "reader", anthropic);
        const holding = Promise.all(
          ["reader", "once"].map(
            async (workflow) =>
              await outcome(
                models(env).call(
                  hello(anthropic, {
                    purpose: "workflow.step",
                    trigger: actor(`run-${crypto.randomUUID()}`, workflow),
                  })
                )
              )
          )
        );
        await vi.waitFor(async () => {
          const read = await modelLedger(env).spendOf(
            env.MODEL_BUDGET_MONTH ?? "",
            ["workflow"],
            10
          );
          expect(
            read.workflow?.filter(({ reservedMicros }) => reservedMicros > 0)
          ).toHaveLength(2);
        });
        const once = await builder.api.workflows.start(app, "once");
        const startedOnce = Date.now();
        await finished(once.id);
        const onceTook = Date.now() - startedOnce;
        const run = await builder.api.workflows.start(app, "reader");
        // Eight seconds of attempts a second apart, all while held.
        await scheduler.wait(8000);
        const whileHeld = await eventsOf(actor(run.id));
        release.resolve(true);
        await finished(run.id);
        return {
          held: await holding,
          onceTook,
          once: await builder.api.workflows.status(once.id),
          whileHeld,
          run: await builder.api.workflows.status(run.id),
          events: await eventsOf(actor(run.id)),
        };
      }
    );

    expect({
      held: result.held,
      once: result.once,
      onceQuick: result.onceTook < 10_000,
      whileHeld: modelActions(result.whileHeld),
      run: result.run,
      after: modelActions(result.events),
    }).toMatchObject({
      held: ["ok", "ok"],
      // No retry left: it fails at once, with the reason.
      once: {
        status: "failed",
        error: {
          message:
            "Model calls still under way hold what's left of this month's model budget. Try again once they finish.",
        },
      },
      onceQuick: true,
      // Asked once in eight seconds of attempts; the rest answered by the
      // host from that refusal.
      whileHeld: ["model.refused"],
      run: { status: "completed", output: { total: 1234 } },
      after: ["model.refused", "model.call"],
    });
  });

  it("give an AI step's next attempt the answer its timed-out attempt was still waiting for, asking and paying once", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    timeout: 1000,
    retries: { limit: 3, delay: 1 },
  });`,
        { extract: { total: 1234 } }
      )
    );
    const release = Promise.withResolvers<boolean>();

    // The gateway answers the first attempt only after its second.
    const { result } = await withDeploymentRules(
      { gateway, models: [workersAi, anthropic] },
      [
        {
          text: '{ "total": 1234 }',
          inputTokens: 10,
          outputTokens: 5,
          pause: { at: 1, until: release.promise },
        },
        { text: '{ "total": 9999 }', inputTokens: 10, outputTokens: 5 },
      ],
      async () => {
        await bindModel(app, "reader", anthropic);
        const run = await builder.api.workflows.start(app, "reader");
        await scheduler.wait(2500);
        release.resolve(true);
        await finished(run.id);
        return {
          run: await builder.api.workflows.status(run.id),
          events: await eventsOf(
            runActorOf({ runId: run.id, app, workflow: "reader" })
          ),
        };
      }
    );

    expect({
      run: result.run,
      models: modelActions(result.events),
    }).toMatchObject({
      run: { status: "completed", output: { total: 1234 } },
      models: ["model.call"],
    });
  });

  it("ask the ledger again once 15 seconds passed since a busy step's refusal, on its last attempt too, when the budget freed meanwhile", async () => {
    const builder = await signedInApi(idp, "builder");
    // Attempts at about 0, 6 and 12 seconds: the third, the last, runs
    // past the 15 seconds since the first was turned away.
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    timeout: 6000,
    retries: { limit: 2, delay: 1 },
  });`,
        { extract: { total: 1234 } }
      )
    );
    const release = Promise.withResolvers<boolean>();
    const actor = (runId: string) =>
      runActorOf({ runId, app, workflow: "reader" });

    const { result } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, anthropic],
        budgets: { workflow: { limit: 1 } },
      },
      [
        { ...cheapAnswer, pause: { at: 1, until: release.promise } },
        { text: '{ "total": 1234 }', inputTokens: 10, outputTokens: 5 },
      ],
      async () => {
        await bindModel(app, "reader", anthropic);
        const holding = outcome(
          models(env).call(
            hello(anthropic, {
              purpose: "workflow.step",
              trigger: actor(`run-${crypto.randomUUID()}`),
            })
          )
        );
        await vi.waitFor(async () => {
          const read = await modelLedger(env).spendOf(
            env.MODEL_BUDGET_MONTH ?? "",
            ["workflow"],
            10
          );
          expect(read.workflow?.[0]?.reservedMicros).toBeGreaterThan(0);
        });
        const run = await builder.api.workflows.start(app, "reader");
        await vi.waitFor(
          async () => {
            const events = await eventsOf(actor(run.id));
            expect(modelActions(events)).toContain("model.refused");
          },
          { timeout: 10_000, interval: 100 }
        );
        // Free half a second after the refusal, well within the 15 seconds.
        await scheduler.wait(500);
        release.resolve(true);
        await finished(run.id);
        return {
          held: await holding,
          run: await builder.api.workflows.status(run.id),
          events: await eventsOf(actor(run.id)),
        };
      }
    );

    expect({
      held: result.held,
      run: result.run,
      actions: modelActions(result.events),
    }).toMatchObject({
      held: "ok",
      run: { status: "completed", output: { total: 1234 } },
      actions: ["model.refused", "model.call"],
    });
  });

  it("stop a workflow's AI steps with a readable error once its budget is used up, and alert admins", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
  });`,
        { extract: { total: 1234 } }
      )
    );

    // One answer of a million tokens in costs $3: well past the budget.
    const { result: runs } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, anthropic],
        budgets: { workflow: { limit: 1 } },
      },
      [{ text: '{ "total": 1234 }', inputTokens: 1_000_000, outputTokens: 10 }],
      async () => {
        await bindModel(app, "reader", anthropic);
        const paid = await builder.api.workflows.start(app, "reader");
        await finished(paid.id);
        const stopped = await builder.api.workflows.start(app, "reader");
        await finished(stopped.id);
        return { paid: paid.id, stopped: stopped.id };
      }
    );

    await expect(
      Promise.all([
        builder.api.workflows.status(runs.paid),
        builder.api.workflows.status(runs.stopped),
      ])
    ).resolves.toMatchObject([
      { status: "completed", output: { total: 1234 } },
      {
        status: "failed",
        error: {
          message:
            "This month's model budget is used up, so no more model calls can be made for this. Ask your admin to have Grasp raise the budget.",
        },
      },
    ]);
    const alerts = await eventsOf(
      runActorOf({ runId: runs.paid, app, workflow: "reader" })
    );
    expect(
      alerts.filter(({ action }) => action.startsWith("model.budget."))
    ).toMatchObject([
      {
        action: "model.budget.alert",
        detail: { scope: "workflow", app, workflow: "reader", limit: 1 },
      },
      {
        action: "model.budget.exhausted",
        detail: { scope: "workflow", app, workflow: "reader", limit: 1 },
      },
    ]);
  });

  it("fail a run's AI step with the reason when its App has an EU-only connection, once: it isn't retried", async () => {
    const builder = await signedInApi(idp, "builder");
    const mail = await mailConnection();
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
  });`,
        { extract: { total: 1234 } }
      )
    );
    await grantMail(idp, builder, app, mail.id);

    const { fake, result: run } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, euModel],
        eu: { models: [euModel], connections: [mail.id] },
      },
      [],
      async () => {
        await bindModel(app, "reader", workersAi);
        const started = await builder.api.workflows.start(app, "reader");
        await finished(started.id);
        return started;
      }
    );

    await expect(builder.api.workflows.status(run.id)).resolves.toMatchObject({
      status: "failed",
      error: {
        message:
          "This call must stay in the EU, and that model isn't hosted in the EU. Choose one that is.",
      },
    });
    expect(fake.requests).toStrictEqual([]);
    const events = await eventsOf(
      runActorOf({ runId: run.id, app, workflow: "reader" })
    );
    expect(
      events.filter(({ action }) => action === "model.refused")
    ).toMatchObject([
      { detail: { reason: "model.eu_only", because: "connection" } },
    ]);
  });

  it("fail the AI steps of an App that read a sensitive collection, unless their model is one the data rule lists", async () => {
    const admin = await signedInApi(idp, "admin");
    const teamId = await newTeam(admin, []);
    const payroll = await collectionWithNote(admin.api, {
      name: "Payroll",
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    // Reads the note, then asks a model about it: the prompt holds it.
    const summarizer = (id: string) =>
      workflowFiles(
        id,
        `  const note = await step.do("read", { description: "Read the note" }, async () => await env.HANDBOOK.getDocument("${payroll.noteId}"));
  return await step.llm("summarize", {
    description: "Summarize the note",
    binding: "${id}",
    instructions: "Summarize the note.",
    input: note.version.text,
    schema: z.object({ summary: z.string() }),
  });`,
        {
          read: { version: { text: "Note" } },
          summarize: { summary: "A note." },
        }
      );
    const app = await appWith(admin, {
      ...summarizer("anywhere"),
      ...summarizer("eu"),
    });
    await requestGranted(
      idp,
      admin,
      readCollection(
        { type: "app", appId: appIdSchema.parse(app) },
        payroll.collectionId
      )
    );

    const { fake, result: runs } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, euModel],
        sensitive: { models: [euModel] },
      },
      [{ text: '{ "summary": "A note." }', inputTokens: 10, outputTokens: 5 }],
      async () => {
        await bindModel(app, "anywhere", workersAi);
        await bindModel(app, "eu", euModel);
        // One after another: the second starts restricted.
        const refused = await admin.api.workflows.start(app, "anywhere");
        await finished(refused.id);
        const answered = await admin.api.workflows.start(app, "eu");
        await finished(answered.id);
        return { refused: refused.id, answered: answered.id };
      }
    );

    await expect(
      Promise.all([
        admin.api.workflows.status(runs.refused),
        admin.api.workflows.status(runs.answered),
      ])
    ).resolves.toMatchObject([
      {
        status: "failed",
        error: {
          message:
            "This call carries sensitive data, and that model may not take it. Choose one this deployment allows for sensitive data.",
        },
      },
      { status: "completed", output: { summary: "A note." } },
    ]);
    // Only the EU model's call was sent, and it held the note.
    expect(fake.requests.map(({ url }) => new URL(url).pathname)).toStrictEqual(
      [`/ai-gateway/gateways/${gateway}/openai/responses`]
    );
    expect(JSON.stringify(fake.requests[0]?.body)).toContain("See [[note.md]]");
    // No provenance named the collection: the App's restricted mode did.
    const refusals = await eventsOf(
      runActorOf({ runId: runs.refused, app, workflow: "anywhere" })
    );
    expect(
      refusals.filter(({ action }) => action === "model.refused")
    ).toMatchObject([
      { detail: { reason: "model.sensitive_data", because: "restricted" } },
    ]);
  });

  it("refuse a workflow's AI step through an alias no admin bound, or one its App doesn't declare, before any model is asked", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("reader", llm("retries: { limit: 2, delay: 1 },"), {
        extract: { total: 1234 },
      }),
      ...workflowFiles(
        "stranger",
        llm("retries: { limit: 2, delay: 1 },").replace(
          'binding: "reader"',
          'binding: "missing"'
        ),
        { extract: { total: 1234 } }
      ),
    });
    const { fake, result: runs } = await withDeploymentRules(
      { gateway, models: [workersAi, anthropic] },
      [],
      async () => {
        const unbound = await builder.api.workflows.start(app, "reader");
        const undeclared = await builder.api.workflows.start(app, "stranger");
        await finished(unbound.id);
        await finished(undeclared.id);
        return { unbound: unbound.id, undeclared: undeclared.id };
      }
    );
    const refused = {
      status: "failed",
      failure: { error: { code: "resource.unavailable" } },
    };
    await expect(
      Promise.all([
        builder.api.workflows.status(runs.unbound),
        builder.api.workflows.status(runs.undeclared),
      ])
    ).resolves.toMatchObject([refused, refused]);
    // Not retried, and nothing reached the gateway or its ledger.
    expect(fake.requests).toStrictEqual([]);
    const events = await eventsOf(
      runActorOf({ runId: runs.unbound, app, workflow: "reader" })
    );
    expect(modelActions(events)).toStrictEqual([]);
  });

  it("stop a workflow's AI steps once their binding's cap for the day is used up, at once and with the reason", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles("reader", llm("retries: { limit: 2, delay: 1 },"), {
        extract: { total: 1234 },
      })
    );
    // A million tokens in costs $3: well past the binding's dollar a day.
    const { fake, result: runs } = await withDeploymentRules(
      { gateway, models: [workersAi, anthropic] },
      [{ text: '{ "total": 1234 }', inputTokens: 1_000_000, outputTokens: 10 }],
      async () => {
        await bindModel(app, "reader", anthropic, { perDay: 1 });
        const paid = await builder.api.workflows.start(app, "reader");
        await finished(paid.id);
        const stopped = await builder.api.workflows.start(app, "reader");
        await finished(stopped.id);
        return { paid: paid.id, stopped: stopped.id };
      }
    );

    await expect(
      Promise.all([
        builder.api.workflows.status(runs.paid),
        builder.api.workflows.status(runs.stopped),
      ])
    ).resolves.toMatchObject([
      { status: "completed", output: { total: 1234 } },
      { status: "failed", failure: { error: { code: "model.over_budget" } } },
    ]);
    const refusals = await eventsOf(
      runActorOf({ runId: runs.stopped, app, workflow: "reader" })
    );
    expect({
      // The second run's step was refused once, not retried, unsent.
      sent: fake.requests.length,
      refused: refusals
        .filter(({ action }) => action === "model.refused")
        .map(({ detail }) => [detail.reason, detail.because]),
    }).toStrictEqual({
      sent: 1,
      refused: [["model.over_budget", "binding_day"]],
    });
  });

  it("retry a workflow's AI step its binding turned away while other calls hold its cap, and answer once they finish", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles("reader", llm("retries: { limit: 1, delay: 1 },"), {
        extract: { total: 1234 },
      })
    );
    const release = Promise.withResolvers<boolean>();
    const actor = (runId: string) =>
      runActorOf({ runId, app, workflow: "reader" });

    // Another call through the same binding holds most of its dollar a
    // day while it answers, until released.
    const { result } = await withDeploymentRules(
      { gateway, models: [workersAi, anthropic] },
      [
        { ...cheapAnswer, pause: { at: 1, until: release.promise } },
        { text: '{ "total": 1234 }', inputTokens: 10, outputTokens: 5 },
      ],
      async () => {
        await bindModel(app, "reader", anthropic, { perDay: 1 });
        const holding = outcome(
          models(env).call(
            hello(anthropic, {
              purpose: "workflow.step",
              trigger: actor(`run-${crypto.randomUUID()}`),
              binding: {
                app: appIdSchema.parse(app),
                alias: "reader",
                budget: { perDay: 1, alertAt: 80 },
              },
            })
          )
        );
        await vi.waitFor(async () => {
          const read = await modelLedger(env).spendOf(
            env.MODEL_BUDGET_MONTH ?? "",
            ["binding_day"],
            10
          );
          expect(read.binding_day?.[0]?.reservedMicros).toBeGreaterThan(0);
        });
        const run = await builder.api.workflows.start(app, "reader");
        await vi.waitFor(
          async () => {
            const events = await eventsOf(actor(run.id));
            expect(modelActions(events)).toContain("model.refused");
          },
          { timeout: 10_000, interval: 200 }
        );
        release.resolve(true);
        await finished(run.id);
        return {
          held: await holding,
          run: await builder.api.workflows.status(run.id),
          events: await eventsOf(actor(run.id)),
        };
      }
    );

    expect({
      held: result.held,
      run: result.run,
      refused: result.events
        .filter(({ action }) => action === "model.refused")
        .map(({ detail }) => [detail.reason, detail.because]),
      actions: modelActions(result.events),
    }).toMatchObject({
      held: "ok",
      run: { status: "completed", output: { total: 1234 } },
      refused: [["model.budget_busy", "binding_day"]],
      actions: ["model.refused", "model.call"],
    });
  });
});
