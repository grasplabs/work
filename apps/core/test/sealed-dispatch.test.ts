/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { kitModuleName } from "@grasp-os/compiler";
import { v } from "@grasp-os/sdk";
import { declaredWorkflows, workflowFingerprint } from "@grasp-os/sdk/host";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { fixtureHostFor } from "../src/app-tests.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { generatedModule } from "../src/workflow-builds.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-drafts.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import {
  candidateActivation,
  candidateRunFor,
  startCandidateRun,
} from "../src/workflows/candidate-runs.ts";
import { runModules } from "../src/workflows/code.ts";
import type { StepError } from "../src/workflows/code.ts";
import { fixtureDecisionLookMs } from "../src/workflows/fixture-decisions.ts";
import { fixtureActivation } from "../src/workflows/fixture-runs.ts";
import type { HostHooks, RunStep } from "../src/workflows/host.ts";
import {
  sealedActivation,
  sealedActivationOf,
} from "../src/workflows/resource-runs.ts";
import type { HostedActivation } from "../src/workflows/resource-runs.ts";
import type { SealedRunMemory } from "../src/workflows/sealed-run.ts";
import { allEvents } from "./audit-events.ts";
import { fakeProvider } from "./model-provider.ts";
import { engineOfTest } from "./run-host.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";

// Which engine runs a JSON workflow's run (resource-runs.ts,
// `runActivation`): a build generated for the run host runs there as a
// sealed run, whatever started it, an independent run, a test run of a
// draft's checkpoint or a run an App's test started; a build of the
// generator before it runs on resource-host.ts until GRA-1366 removes it.
//
// No stored build is generated for the run host until the new generator
// is wired into drafts and publishing (GRA-1535), so the sealed runs here
// are started for real, their activations loaded as the dispatcher loads
// them, and run on the run host with a module of the test's own, written
// as that generator writes one, in place of the build's generated one,
// through the same mapping `runActivation` takes for such a build
// (`sealedActivationOf`). Until then every stored build takes
// `runActivation`'s other branch, which the last test runs.
// What each must keep on the run host, from the threat model of its kind:
//
// - a test run of a checkpoint calls nothing: every call is answered from
//   its start's fixtures, and its waits are held short;
// - a run an App's test started reaches nothing of the organization's: its
//   model calls are answered by its fixture, never a model, and its store
//   calls run on its test's own store, never the App's, once whatever its
//   step's attempts; any other call is refused before it is audited.

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A definition of `name`: its bindings and tasks, input `who`, output `status`. */
const definitionOf = (
  name: string,
  tasks: unknown[],
  bindings: Record<string, unknown>
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
  });

/** A wait long enough that the run's own engine leaves it waiting. */
const linger = { linger: { wait: "PT10M" } };

/** Asks the `summary` model binding to greet the input's `who`. */
const summarize = {
  summarize: {
    call: "grasp.model",
    with: {
      binding: "summary",
      instructions: "Greet them.",
      input: { who: "${ $workflow.input.who }" },
      outputSchema: objectSchema({ line: { type: "string" } }),
    },
  },
};

/** Saves the input's `who` through the `save` operation binding. */
const save = {
  save: {
    call: "grasp.operation",
    with: { binding: "save", arguments: { who: "${ $workflow.input.who }" } },
  },
};

/** Mails the input's `who` through the `mail` connector binding. */
const send = {
  send: {
    call: "grasp.connector",
    with: {
      binding: "mail",
      operation: "mail.send",
      arguments: { to: "${ $workflow.input.who }", subject: "Hello" },
    },
  },
};

/** Asks the fixture's `approver` to approve, through binding `approval`. */
const review = {
  review: {
    call: "grasp.decision",
    with: {
      binding: "approval",
      recipients: ["person:approver"],
      prompt: "Approve?",
      input: { who: "${ $workflow.input.who }" },
    },
  },
};

/** Asks whom the input's `who` names to approve, through binding `approval`. */
const reviewWho = {
  review: {
    ...review.review,
    with: { ...review.review.with, recipients: ["${ $workflow.input.who }"] },
  },
};

/** Asks the fixture's `approver` about each of two items, in turn. */
const batch = {
  batch: {
    for: { each: "w", at: "i", in: '${ ["a", "b"] }' },
    do: [
      {
        sign: {
          call: "grasp.decision",
          with: {
            binding: "approval",
            recipients: ["person:approver"],
            prompt: "Approve this one?",
            input: { who: "${ $w }" },
          },
        },
      },
    ],
  },
};

/** The workflow SDK, by the flat name the sealed build has it. */
const sdkWorkflow = JSON.stringify(kitModuleName("@grasp-os/sdk/workflow"));

/** A task's own step, as the generator for the run host names it. */
const task = (id: string, body: string): string =>
  `await step.do(${JSON.stringify(id)}, { key: "task", description: "Its task" }, async () => ${body})`;

/**
 * The module the generator for the run host writes for `linger` then
 * `summarize` (then `save`, with `saves`): its run's output the greeting.
 */
const moduleOf = (saves: boolean): string => `
import { workflow, z } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: z.object({ who: z.string() }) }, async (step, { env, input }) => {
  await step.sleep("linger", { key: "task", description: "Its wait", duration: "10 minutes" });
  const greeting = ${task("summarize", 'await env.summary.call("grasp.model", { instructions: "Greet them.", input: { who: input.who } })')};
  ${saves ? `${task("save", 'await env.save.call("grasp.operation", { who: input.who })')};` : ""}
  return { status: greeting.line };
});
`;

/** The module the generator for the run host writes for `linger` then `send`. */
const sendModule = `
import { workflow, z } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: z.object({ who: z.string() }) }, async (step, { env, input }) => {
  await step.sleep("linger", { key: "task", description: "Its wait", duration: "10 minutes" });
  ${task("send", 'await env.mail.call("mail.send", { to: input.who, subject: "Hello" })')};
  return { status: "sent" };
});
`;

/**
 * The module the generator for the run host writes for `linger` then
 * `review`, its decision asking `asked` of `recipients` (code): its output the answer, and
 * how many people its code was told of, each time it asked.
 */
const reviewModuleOf = (
  asked = "{ who: input.who }",
  recipients = '["person:approver"]'
): string => `
import { workflow, z } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: z.object({ who: z.string() }) }, async (step, { input }) => {
  await step.sleep("linger", { key: "task", description: "Its wait", duration: "10 minutes" });
  const entered = await step.do("review", { key: "enter", description: "Its ask" }, async () => ({ recipients: ${recipients}, prompt: "Approve?", input: ${asked} }));
  const told = [];
  const decided = await step.decision("review", { key: "task", description: entered.prompt, from: entered.recipients[0], timeout: "365 days", ask: async ({ recipients }) => { told.push(recipients.length); } });
  return { status: \`\${decided.approved ? "approved" : "rejected"} by \${decided.by}, told \${told.join(",")}\` };
});
`;

/**
 * The module the generator for the run host writes for `linger` then
 * `batch`, one item after another: its output each item's answer.
 */
const batchModule = `
import { workflow, z } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: z.object({ who: z.string() }) }, async (step) => {
  await step.sleep("linger", { key: "task", description: "Its wait", duration: "10 minutes" });
  const { items } = await step.do("batch", { key: "enter", description: "Its items" }, async () => ({ items: ["a", "b"] }));
  const answers = [];
  for (let at = 0; at < items.length; at += 1) {
    await step.do("sign", { key: "enter@" + at, description: "Its ask" }, async () => ({ recipients: ["person:approver"], prompt: "Approve this one?", input: { who: items[at] } }));
    const decided = await step.decision("sign", { key: "task@" + at, description: "Approve this one?", from: "person:approver", timeout: "365 days", ask: async () => undefined });
    answers.push(decided.approved);
  }
  return { status: answers.join(",") };
});
`;

/** The organization's own decisions of run `runId`, and asks audited of it. */
const organizationsOf = async (runId: string) => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM workflow_decisions WHERE resource_run_id = ? OR run_id = ?"
  )
    .bind(runId, runId)
    .first<{ n: number }>();
  const events = await allEvents();
  return {
    decisions: row?.n,
    asked: events.filter(
      ({ action, detail }) =>
        action === "workflow.decision.asked" && detail?.run === runId
    ).length,
  };
};

/** Memory of a run's tried-once calls and model calls, this test's own. */
const memoryOfTest = (): Required<
  Pick<SealedRunMemory, "sentCalls" | "modelCalls">
> => {
  const sent = new Set<string>();
  const failures = new Map<string, StepError>();
  const models: string[] = [];
  return {
    sentCalls: {
      markSent: (key, attempt) => {
        sent.add(`${attempt}:${key}`);
      },
      unmarkSent: (key, attempt) => {
        sent.delete(`${attempt}:${key}`);
      },
      sent: (key, attempt) => sent.has(`${attempt}:${key}`),
      keepFailure: (key, attempt, error) => {
        failures.set(`${attempt}:${key}`, error);
      },
      failureOf: (key, attempt) => failures.get(`${attempt}:${key}`),
    },
    modelCalls: {
      count: () => models.length,
      keep: (key) => {
        models.push(key);
      },
    },
  };
};

interface Engine {
  step: RunStep;
  leaseOf: HostHooks["leaseOf"];
}

/**
 * `engineOfTest`, its attempts a newer activation's than the run's own
 * engine's, which is left waiting: a real admission would otherwise take
 * them for ones it superseded.
 */
const newerEngine = (): Engine => {
  const { step, leaseOf } = engineOfTest();
  return {
    step,
    leaseOf: (key, attempt) => {
      const lease = leaseOf(key, attempt);
      return lease === undefined ? undefined : { ...lease, generation: 1000 };
    },
  };
};

/**
 * An engine of the test's own that journals what each step answered, so a
 * later activation on it replays those steps, and that counts each step's
 * attempts on. With `evictAfter`, the activation is lost as soon as that
 * step's attempt returns, before anything of it is journaled, as an
 * evicted activation's is.
 */
const journalingEngine = (): Engine & { evictAfter?: string } => {
  const journal = new Map<string, unknown>();
  const attempts = new Map<string, number>();
  const leases = new Set<string>();
  const engine: Engine & { evictAfter?: string } = {
    step: {
      ...engineOfTest().step,
      do: async (name, _config, fn) => {
        if (journal.has(name)) {
          return journal.get(name);
        }
        const attempt = (attempts.get(name) ?? 0) + 1;
        attempts.set(name, attempt);
        const key = `key:${name}`;
        leases.add(`${attempt}:${key}`);
        try {
          const value = await fn({ attempt, idempotencyKey: key });
          if (engine.evictAfter === name) {
            throw new Error("The activation was evicted");
          }
          journal.set(name, value);
          return value;
        } finally {
          leases.delete(`${attempt}:${key}`);
        }
      },
    },
    leaseOf: (key, attempt) =>
      leases.has(`${attempt}:${key}`)
        ? { generation: 1000, deadline: Date.now() + 60_000 }
        : undefined,
  };
  return engine;
};

/**
 * Runs `activation` as `runActivation` runs a build generated for the run
 * host (`sealedActivationOf`, `sealedActivation`), with `source` in place
 * of the build's generated module, on `engine` with `memory`: its output,
 * or the code it failed with.
 */
const ranOnRunHost = async (
  activation: HostedActivation,
  source: string,
  { engine = newerEngine(), memory = memoryOfTest() } = {}
): Promise<unknown> => {
  const sealed = sealedActivationOf(activation);
  try {
    return await sealedActivation(
      env,
      engine.step,
      { leaseOf: engine.leaseOf, ...memory },
      sealed,
      () => ({
        ...sealed.run.build.sdk,
        [generatedModule]: source,
        ...runModules({ module: generatedModule, refusal: "No workflow." }),
      })
    );
  } catch (error) {
    const code: unknown =
      error instanceof Error ? Reflect.get(error, "code") : undefined;
    return { failed: typeof code === "string" ? code : String(error) };
  }
};

/** A model catalog contract and a store operation's, published by `admin`. */
const contracts = async (admin: Identity) => {
  const model = `summary-${unique()}`;
  await publishCatalogContract(env, admin, { key: model, kind: "model" });
  const operation = `save-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: operation,
    kind: "operation",
    input: JSON.stringify(v.object({ who: v.string() }).descriptor),
    output: JSON.stringify(v.null().descriptor),
  });
  const mail = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: mail,
    kind: "connector",
    operations: {
      "mail.send": {
        input: JSON.stringify(
          v.object({ to: v.string(), subject: v.string() }).descriptor
        ),
        output: JSON.stringify(v.object({ messageId: v.string() }).descriptor),
      },
    },
  });
  const approval = `approval-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: approval,
    kind: "decision",
    input: JSON.stringify(v.object({ who: v.string() }).descriptor),
    response: JSON.stringify(
      v.union(v.null(), v.object({ comment: v.string() })).descriptor
    ),
  });
  return { model, operation, mail, approval };
};

/** A workflow of `by`'s whose draft holds `tasks`, checked: its revision. */
const drafted = async (by: Identity, tasks: unknown[]) => {
  const admin = await person("admin");
  const { model, approval } = await contracts(admin);
  const workflow = await createWorkflowResource(env, by, `test-${unique()}`);
  const { revision: base } = await workflowDraft(env, by, workflow.id);
  const saved = await editWorkflowDraft(env, by, workflow.id, {
    expectedRevision: base,
    source: definitionOf(workflow.name, tasks, {
      summary: { kind: "model", contract: model },
      approval: { kind: "decision", contract: approval },
    }),
    modules: {},
  });
  expect(saved.problems).toStrictEqual([]);
  return { workflow, revision: saved.revision };
};

/** Test run `runId` of workflow `id` as `by` reads it, once `ready` says so. */
const candidateOnce = async (
  by: Identity,
  id: string,
  runId: string,
  ready: (status: string) => boolean
) =>
  await vi.waitFor(
    async () => {
      const run = await candidateRunFor(env, by, id, runId);
      if (!ready(run.status)) {
        throw new Error(`Test run ${runId} is ${run.status}`);
      }
      return run;
    },
    { timeout: 20_000, interval: 100 }
  );

/** The pin the engine runs test run `runId` by (engine.ts). */
const candidatePinOf = async (workflow: string, runId: string) => {
  const row = await env.DB.prepare(
    "SELECT manifest_hash AS manifest FROM workflow_candidate_runs WHERE id = ?"
  )
    .bind(runId)
    .first<{ manifest: string }>();
  if (row === null) {
    throw new Error(`No test run ${runId}`);
  }
  return {
    workflow: workflowResourceIdSchema.parse(workflow),
    manifest: row.manifest,
  };
};

/** The Requests App's files: it binds `followUp`, keeps requests, `desk`. */
const requestsFiles = (fixture: unknown): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  requests: defineTable({ who: v.string() }),
});
`,
  "operations/requests.ts": `import { permission, v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

export const followUp = permission.workflow("followUp", {
  input: v.object({ who: v.string().trim().min(1) }),
  output: v.object({ status: v.string() }),
});

export const add = mutation({
  args: { who: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("requests", { who: args.who });
    return null;
  },
});

export const list = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("requests").take(100)).map(({ who }) => who),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { add, followUp, list } from "./operations/requests.ts";
import schema from "./schema.ts";

export default app({
  name: "Requests",
  schema,
  access: { tables: { requests: { read: "appMembers", write: "appMembers" } } },
  operations: { requests: { add, list } },
  screens: [],
  permissions: { workflows: [followUp] },
});
`,
  "tests/fixtures/desk.json": JSON.stringify({
    principals: {
      "desk-user": { role: "user" },
      approver: { role: "user" },
    },
    workflows: { followUp: fixture },
  }),
});

/**
 * The Requests App binding a workflow of `tasks` as `followUp` (model
 * binding `summary`, operation binding `save`, connector binding `mail`),
 * `fixture` its test's.
 */
const requestsApp = async (tasks: unknown[], fixture: unknown) => {
  const admin = await person("admin");
  const keys = await contracts(admin);
  const builder = await person("builder");
  const files = requestsFiles(fixture);
  const app = await appWith(files, "Requests", builder);
  const resource = await createWorkflowResource(
    env,
    builder,
    `greet-${unique()}`
  );
  await publishWorkflowVersion(env, builder, resource.id, {
    definition: definitionOf(resource.name, tasks, {
      summary: { kind: "model", contract: keys.model },
      save: { kind: "operation", contract: keys.operation },
      mail: { kind: "connector", contract: keys.mail },
      approval: { kind: "decision", contract: keys.approval },
    }),
    basedOn: null,
  });
  await bindWorkflowToApp(env, builder, resource.id, {
    app: app.app,
    alias: "followUp",
    version: 1,
  });
  await seal(app);
  const release = await loadRelease(env, app.app, 1);
  return { app: app.app, resource: resource.id, release, files };
};

/** A start of `followUp` with `input`, as the SDK sends it. */
const startOf = async (release: Release, input: unknown): Promise<string> => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    ({ alias }) => alias === "followUp"
  );
  if (declared === undefined) {
    throw new Error("No followUp");
  }
  return JSON.stringify({
    workflow: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: "workflows.followUp",
      fingerprint: await workflowFingerprint(declared),
      kind: "workflow",
    },
    command: "start",
    input,
    idempotencyKey: "0".repeat(32),
  });
};

/** The test's run of an App, and the pin the engine runs it by. */
const fixtureRunOf = async (app: string) => {
  const row = await env.DB.prepare(
    "SELECT run_id AS id, workflow_resource_id AS workflow, version, manifest_hash AS manifest FROM app_test_runs WHERE app_id = ?"
  )
    .bind(app)
    .first<{
      id: string;
      workflow: string;
      version: number;
      manifest: string;
    }>();
  if (row === null) {
    throw new Error("No test run recorded");
  }
  return {
    runId: row.id,
    pin: {
      workflow: workflowResourceIdSchema.parse(row.workflow),
      version: row.version,
      manifest: row.manifest,
    },
  };
};

const listedSchema = z.object({ ok: z.literal(true), value: z.unknown() });

/** What the test's own store holds, as its session's user lists it. */
const savedIn = async (
  app: Awaited<ReturnType<typeof requestsApp>>,
  session: { call: (name: string, request: string) => Promise<string> }
): Promise<unknown> =>
  listedSchema.parse(
    JSON.parse(
      await session.call(
        "desk-user",
        JSON.stringify({
          reference: {
            resourceId: app.release.manifest.resourceId,
            resourceVersion: app.release.manifest.resourceVersion,
            contractId: "requests.list",
            fingerprint: app.release.fingerprints["requests.list"],
            kind: "query",
          },
          input: {},
        })
      )
    )
  ).value;

describe(
  "the engine a JSON workflow's run runs on",
  { timeout: 180_000 },
  () => {
    it("runs a test run of a draft's checkpoint generated for the run host there, every call answered from its start's fixtures", async () => {
      const provider = await fakeProvider({
        text: '{"line":"From a real model"}',
        inputTokens: 1,
        outputTokens: 1,
      });
      const ada = await person("builder");
      const { workflow, revision } = await drafted(ada, [linger, summarize]);
      const { runId } = await startCandidateRun(env, ada, workflow.id, {
        revision,
        input: { who: "Ada" },
        fixtures: { summary: { output: { line: "Hello Ada" } } },
      });
      // Its own engine leaves it waiting out its linger.
      await candidateOnce(
        ada,
        workflow.id,
        runId,
        (status) => status === "running"
      );
      const activation = await candidateActivation(
        env,
        await candidatePinOf(workflow.id, runId),
        runId
      );
      expect({
        ended: await ranOnRunHost(activation, moduleOf(false)),
        asked: provider.requests.length,
      }).toStrictEqual({ ended: { status: "Hello Ada" }, asked: 0 });
    });

    it("runs an App test's run of a version generated for the run host there, its model answered by its fixture and its store call on the test's own store", async () => {
      const provider = await fakeProvider({
        text: '{"line":"From a real model"}',
        inputTokens: 1,
        outputTokens: 1,
      });
      const app = await requestsApp([linger, summarize, save], {
        models: { summary: { line: "Hello from the fixture" } },
        operations: { save: "requests.add" },
      });
      const host = fixtureHostFor(env, app.release, app.files);
      const session = await host.open("desk", `test-${unique()}`);
      await session.start(
        "desk-user",
        await startOf(app.release, { who: "Ada" })
      );
      const { runId, pin } = await fixtureRunOf(app.app);
      const ended = await ranOnRunHost(
        await fixtureActivation(env, pin, runId),
        moduleOf(true)
      );
      const saved = await savedIn(app, session);
      await session.close();
      expect({
        ended,
        saved,
        asked: provider.requests.length,
      }).toStrictEqual({
        ended: { status: "Hello from the fixture" },
        saved: ["Ada"],
        asked: 0,
      });
    });

    it("sends an App test's store call once on the run host, whatever its step's attempts: an evicted activation's successor fails as tried", async () => {
      const app = await requestsApp([linger, summarize, save], {
        models: { summary: { line: "Hello" } },
        operations: { save: "requests.add" },
      });
      const host = fixtureHostFor(env, app.release, app.files);
      const session = await host.open("desk", `test-${unique()}`);
      await session.start(
        "desk-user",
        await startOf(app.release, { who: "Ada" })
      );
      const { runId, pin } = await fixtureRunOf(app.app);
      const activation = await fixtureActivation(env, pin, runId);
      // One run's engine and memory across its activations: the first is
      // evicted once its store call's attempt returned, nothing journaled.
      const engine = journalingEngine();
      const memory = memoryOfTest();
      engine.evictAfter = "save:task";
      const evicted = await ranOnRunHost(activation, moduleOf(true), {
        engine,
        memory,
      });
      engine.evictAfter = undefined;
      const resumed = await ranOnRunHost(activation, moduleOf(true), {
        engine,
        memory,
      });
      const saved = await savedIn(app, session);
      await session.close();
      expect({ evicted, resumed, saved }).toStrictEqual({
        evicted: { failed: "internal.unexpected" },
        // Not `{ status: "Hello" }`: its store call isn't sent again.
        resumed: { failed: "operation.deadline_exceeded" },
        saved: ["Ada"],
      });
    });

    it("refuses an App test's run on the run host a call its test doesn't serve, sending nothing", async () => {
      const app = await requestsApp([linger, send], {});
      const host = fixtureHostFor(env, app.release, app.files);
      const session = await host.open("desk", `test-${unique()}`);
      await session.start(
        "desk-user",
        await startOf(app.release, { who: "Ada" })
      );
      const { runId, pin } = await fixtureRunOf(app.app);
      const ended = await ranOnRunHost(
        await fixtureActivation(env, pin, runId),
        sendModule
      );
      await session.close();
      const events = await allEvents();
      const checked = events.filter(
        ({ action, target }) =>
          action === "workflow.call.checked" && target?.id === runId
      );
      expect({ ended, checked }).toStrictEqual({
        ended: { failed: "resource.unavailable" },
        checked: [],
      });
    });

    it("takes a draft's test run's decision on the run host from its start's fixture, as a real run asks it, opening none and asking nobody", async () => {
      const ada = await person("builder");
      const { workflow, revision } = await drafted(ada, [linger, reviewWho]);
      /** A test run of the draft for `who`, left waiting by its own engine. */
      const waiting = async (who = "person:approver") => {
        const { runId } = await startCandidateRun(env, ada, workflow.id, {
          revision,
          input: { who },
          fixtures: {
            approval: {
              output: {
                answered: true,
                approved: true,
                by: "person:pat",
                value: null,
              },
            },
          },
        });
        await candidateOnce(
          ada,
          workflow.id,
          runId,
          (status) => status === "running"
        );
        return {
          runId,
          activation: await candidateActivation(
            env,
            await candidatePinOf(workflow.id, runId),
            runId
          ),
        };
      };
      const answered = await waiting();
      const misasked = await waiting();
      const own = await waiting(`person:${ada.userId}`);
      const asking = reviewModuleOf(undefined, "[input.who]");
      expect({
        // Its engine waits for no event: the answer is there at its first look.
        ended: await ranOnRunHost(answered.activation, asking),
        // Asked as a real run's decision is, its fixture notwithstanding:
        // an input its contract doesn't take fails it, as a real run's.
        misasked: await ranOnRunHost(
          misasked.activation,
          reviewModuleOf("{ who: 5 }", "[input.who]")
        ),
        // Nor of the run's own person, who can't answer it.
        own: await ranOnRunHost(own.activation, asking),
        organization: [
          await organizationsOf(answered.runId),
          await organizationsOf(misasked.runId),
          await organizationsOf(own.runId),
        ],
      }).toStrictEqual({
        ended: { status: "approved by person:pat, told 0" },
        misasked: { failed: "workflow.call_invalid" },
        own: { failed: "workflow.call_invalid" },
        organization: [
          { decisions: 0, asked: 0 },
          { decisions: 0, asked: 0 },
          { decisions: 0, asked: 0 },
        ],
      });
    });

    it("waits on the run host for an App test's decision its fixture's principal answers, kept with the test and asking nobody", async () => {
      const app = await requestsApp([linger, review], {
        deciders: { approval: ["approver"] },
      });
      const host = fixtureHostFor(env, app.release, app.files);
      const session = await host.open("desk", `test-${unique()}`);
      const started = z
        .object({ ok: z.literal(true), value: z.object({ run: z.number() }) })
        .parse(
          JSON.parse(
            await session.start(
              "desk-user",
              await startOf(app.release, { who: "Ada" })
            )
          )
        );
      const { runId, pin } = await fixtureRunOf(app.app);
      // Its answer owes the run no wake: the run looks again after its
      // wait times out, and finds it.
      const answers: unknown[] = [];
      const timeouts: unknown[] = [];
      const { step, leaseOf } = newerEngine();
      const engine: Engine = {
        leaseOf,
        step: {
          ...step,
          waitForEvent: async (_name, options) => {
            timeouts.push(options.timeout);
            answers.push(
              JSON.parse(
                await session.respond(
                  "approver",
                  started.value.run,
                  JSON.stringify({ task: "review", approved: false })
                )
              )
            );
            const timedOut = new Error("Execution timed out");
            timedOut.name = "WorkflowTimeoutError";
            return await Promise.reject(timedOut);
          },
        },
      };
      const ended = await ranOnRunHost(
        await fixtureActivation(env, pin, runId),
        reviewModuleOf(),
        { engine }
      );
      const kept = await env.DB.prepare(
        "SELECT recipients, status, decided_by AS decidedBy FROM app_test_decisions WHERE run_id = ?"
      )
        .bind(runId)
        .all();
      await session.close();
      expect({
        ended,
        answers,
        // Each wait ends within a look's time, however far its deadline.
        timeouts,
        kept: kept.results,
        organization: await organizationsOf(runId),
      }).toStrictEqual({
        ended: { status: "rejected by fixture-approver, told 0" },
        answers: [{ ok: true, value: null }],
        timeouts: [fixtureDecisionLookMs],
        kept: [
          {
            recipients: '["approver"]',
            status: "rejected",
            decidedBy: "approver",
          },
        ],
        organization: { decisions: 0, asked: 0 },
      });
    });

    it("finds an App test's answer to a loop item's decision on the run host by its item, as `respond`'s `at` names it", async () => {
      const app = await requestsApp([linger, batch], {
        deciders: { approval: ["approver"] },
      });
      const host = fixtureHostFor(env, app.release, app.files);
      const session = await host.open("desk", `test-${unique()}`);
      const started = z
        .object({ ok: z.literal(true), value: z.object({ run: z.number() }) })
        .parse(
          JSON.parse(
            await session.start(
              "desk-user",
              await startOf(app.release, { who: "Ada" })
            )
          )
        );
      const { runId, pin } = await fixtureRunOf(app.app);
      // Each wait answers the item it waits for: the first approved, the
      // second declined, each found by its item alone.
      const answers: unknown[] = [];
      const { step, leaseOf } = newerEngine();
      const engine: Engine = {
        leaseOf,
        step: {
          ...step,
          waitForEvent: async () => {
            const at = answers.length;
            answers.push(
              JSON.parse(
                await session.respond(
                  "approver",
                  started.value.run,
                  JSON.stringify({ task: "sign", approved: at === 0, at: [at] })
                )
              )
            );
            const timedOut = new Error("Execution timed out");
            timedOut.name = "WorkflowTimeoutError";
            return await Promise.reject(timedOut);
          },
        },
      };
      const ended = await ranOnRunHost(
        await fixtureActivation(env, pin, runId),
        batchModule,
        { engine }
      );
      const kept = await env.DB.prepare(
        "SELECT step, status FROM app_test_decisions WHERE run_id = ? ORDER BY step"
      )
        .bind(runId)
        .all();
      await session.close();
      expect({ ended, answers, kept: kept.results }).toStrictEqual({
        ended: { status: "true,false" },
        answers: [
          { ok: true, value: null },
          { ok: true, value: null },
        ],
        kept: [
          { step: "sign:task@0", status: "approved" },
          { step: "sign:task@1", status: "rejected" },
        ],
      });
    });

    it("runs a build of the generator before it on resource-host.ts, as before", async () => {
      const ada = await person("builder");
      const { workflow, revision } = await drafted(ada, [
        {
          greet: {
            ...summarize.summarize,
            output: { as: "${ {status: .line} }" },
          },
        },
      ]);
      const { runId } = await startCandidateRun(env, ada, workflow.id, {
        revision,
        input: { who: "Ada" },
        fixtures: { summary: { output: { line: "Hello Ada" } } },
      });
      const run = await candidateOnce(
        ada,
        workflow.id,
        runId,
        (status) => status !== "starting" && status !== "running"
      );
      // On the run host its build, generated for another SDK, would load
      // nothing (sealed-run.ts, `sealedRunModules`), and the run would fail.
      expect({ status: run.status, output: run.output }).toStrictEqual({
        status: "completed",
        output: { status: "Hello Ada" },
      });
    });
  }
);
