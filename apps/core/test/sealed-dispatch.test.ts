import { v } from "@grasp-os/runtime/app";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { fixtureHostFor } from "../src/app-tests.ts";
import { releaseIdsOf } from "../src/apps.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-editor.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import {
  candidateActivation,
  candidateRunFor,
  startCandidateRun,
} from "../src/workflows/candidate-runs.ts";
import { fixtureDecisionLookMs } from "../src/workflows/fixture-decisions.ts";
import { fixtureActivation } from "../src/workflows/fixture-runs.ts";
import type { HostHooks, RunStep } from "../src/workflows/host.ts";
import {
  sealedActivation,
  sealedActivationOf,
} from "../src/workflows/resource-runs.ts";
import type { HostedActivation } from "../src/workflows/resource-runs.ts";
import type { StepError } from "../src/workflows/sealed-isolate.ts";
import { sealedRunModules } from "../src/workflows/sealed-run.ts";
import type { SealedRunMemory } from "../src/workflows/sealed-run.ts";
import { boundIn, testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { allEvents } from "./audit-events.ts";
import { fakeProvider } from "./model-provider.ts";
import { engineOfTest } from "./run-host.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// A JSON workflow's run on the run host (resource-runs.ts,
// `runActivation`), whatever started it: an independent run, a test run of
// a workflow's draft or a run an App's test started. Each is started for
// real, its activation loaded as the dispatcher loads it, and run on the
// run host with its build's own generated module (`sealedRunModules`).
// What each must keep there, from the threat model of its kind:
//
// - a test run of a draft calls nothing: every call is answered from
//   its start's fixtures, and its waits are held short;
// - a run an App's test started reaches nothing of the organization's: its
//   model calls are answered by its fixture, never a model, and its store
//   calls run on its test's own store, never the App's, once whatever its
//   step's attempts; any other call is refused before it is audited.

const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/**
 * A definition of `steps` with `permissions`: input `who`, output `status`,
 * `status` its value.
 */
const definitionOf = (
  steps: unknown[],
  permissions: Record<string, unknown>,
  status: unknown
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status },
    permissions,
    steps,
  });

/** A wait long enough that the run's own engine leaves it waiting. */
const linger = { id: "linger", type: "wait", for: "10 minutes" };

/** Asks the model, `ai`, to greet the input's `who`. */
const summarize = {
  id: "summarize",
  type: "generate",
  instructions: "Greet them.",
  input: { who: { $expr: "args.who" } },
  returns: objectSchema({ line: { kind: "string" } }),
};

/** The greeting `summarize` answered, as a run's status. */
const greeting = { $expr: "summarize.line" };

/** Mails the input's `who` through the `mail` connector binding. */
const send = {
  id: "send",
  type: "call",
  connection: "mail",
  action: "mail.send",
  args: { to: { $expr: "args.who" }, subject: "Hello" },
};

/** Asks `recipients` to approve the input's `who`, through binding `approval`. */
const reviewOf = (recipients: unknown[]) => ({
  id: "review",
  type: "decide",
  decision: "approval",
  recipients,
  prompt: "Approve?",
  input: { who: { $expr: "args.who" } },
});

/** Asks the fixture's `approver` to approve. */
const review = reviewOf(["person:approver"]);

/** Asks whom the input's `who` names to approve. */
const reviewWho = reviewOf([{ $expr: "args.who" }]);

/** How `review` was answered, and by whom, as a run's status. */
const reviewed = {
  $expr:
    'review.timedOut ? "timed out" : (review.approved ? "approved" : "rejected") + " by " + review.by',
};

/** Asks the fixture's `approver` about each of two items, in turn. */
const batch = {
  id: "batch",
  type: "forEach",
  items: { $expr: '["a", "b"]' },
  do: [
    {
      id: "sign",
      type: "decide",
      decision: "approval",
      recipients: ["person:approver"],
      prompt: "Approve this one?",
      input: { who: { $expr: "item" } },
    },
  ],
};

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
 * Runs `activation` as `runActivation` runs it (`sealedActivationOf`,
 * `sealedActivation`), its build's own modules, on `engine` with
 * `memory`: its output, or the code it failed with.
 */
const ranOnRunHost = async (
  activation: HostedActivation,
  { engine = newerEngine(), memory = memoryOfTest() } = {}
): Promise<unknown> => {
  const sealed = sealedActivationOf(activation);
  try {
    return await sealedActivation(
      env,
      engine.step,
      { leaseOf: engine.leaseOf, ...memory },
      sealed,
      () => sealedRunModules(sealed.run)
    );
  } catch (error) {
    const code: unknown =
      error instanceof Error ? Reflect.get(error, "code") : undefined;
    return { failed: typeof code === "string" ? code : String(error) };
  }
};

/** The catalog contracts the tests' workflows bind, published by `admin`. */
const contracts = async (admin: Identity) => {
  const model = `summary-${unique()}`;
  await publishCatalogContract(env, admin, { key: model, kind: "model" });
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
    response: JSON.stringify(v.null().descriptor),
  });
  return { model, mail, approval };
};

/** A workflow of `by`'s whose draft holds `steps`, checked: its revision. */
const drafted = async (by: Identity, steps: unknown[], status: unknown) => {
  const admin = await person("admin");
  const { model, approval } = await contracts(admin);
  const workflow = await createWorkflowResource(env, by, `test-${unique()}`);
  const { revision: base } = await workflowDraft(env, by, workflow.id);
  const saved = await editWorkflowDraft(env, by, workflow.id, {
    revision: base,
    source: definitionOf(
      steps,
      {
        ai: { contract: model },
        decisions: { approval: { contract: approval } },
      },
      status
    ),
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

/** The Requests App's files: it binds `followUp` and keeps requests. */
const requestsFiles = (): TestApp =>
  testApp(
    {
      name: "Requests",
      tables: {
        requests: {
          fields: { who: "v.string()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
      permissions: [
        'permission.workflow("followUp", {\n  args: v.object({ who: v.string().trim().min(1) }),\n  returns: v.object({ status: v.string() }),\n})',
      ],
    },
    {
      "server/requests.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const followUp = permissions.followUp;

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
    }
  );

/**
 * The Requests App binding a workflow of `steps` ending in `status` as
 * `followUp` (the model `ai`, connector binding `mail`),
 * `fixture` what its test starts it with (`TestStartOptions`).
 */
const requestsApp = async (
  steps: unknown[],
  status: unknown,
  fixture: unknown
) => {
  const admin = await person("admin");
  const keys = await contracts(admin);
  const builder = await person("builder");
  const files = requestsFiles();
  const resource = await createWorkflowResource(
    env,
    builder,
    `greet-${unique()}`
  );
  await publishDefinition(
    env,
    builder,
    resource.id,
    definitionOf(
      steps,
      {
        ai: { contract: keys.model },
        connections: { mail: { contract: keys.mail } },
        decisions: { approval: { contract: keys.approval } },
      },
      status
    )
  );
  const app = await appWith(
    boundIn(files, { followUp: resource.id }),
    "Requests",
    builder
  );
  await seal(app);
  const release = await loadRelease(env, app.app, 1);
  return { app: app.app, resource: resource.id, release, files, fixture };
};

/** A test's session of `app`, its two people named, as `t.withIdentity` names them. */
const sessionOf = async (app: { release: Release }) => {
  const host = fixtureHostFor(
    env,
    app.release,
    await releaseIdsOf(env, app.release)
  );
  const session = await host.open(`test-${unique()}`);
  for (const name of ["desk-user", "approver"]) {
    // oxlint-disable-next-line no-await-in-loop -- one after another, as a test names them
    await session.identify(JSON.stringify({ name, role: "user", teams: [] }));
  }
  return session;
};

/** A start of `followUp` with `args`, as the SDK sends it. */
const startOf = (args: unknown): string =>
  JSON.stringify({
    reference: {
      name: "workflows.followUp.mutations.start",
      kind: "mutation",
    },
    args: { args },
  });

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

describe(
  "the engine a JSON workflow's run runs on",
  { timeout: 180_000 },
  () => {
    it("runs a test run of a workflow's draft generated for the run host there, every call answered from its start's fixtures", async () => {
      const provider = await fakeProvider({
        text: '{"line":"From a real model"}',
        inputTokens: 1,
        outputTokens: 1,
      });
      const ada = await person("builder");
      const { workflow, revision } = await drafted(
        ada,
        [linger, summarize],
        greeting
      );
      const { runId } = await startCandidateRun(env, ada, workflow.id, {
        revision,
        args: { who: "Ada" },
        fixtures: { ai: { result: { line: "Hello Ada" } } },
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
        ended: await ranOnRunHost(activation),
        asked: provider.requests.length,
      }).toStrictEqual({ ended: { status: "Hello Ada" }, asked: 0 });
    });

    it("counts each step an App test's run completed on the run host once, by the step's ID", async () => {
      const app = await requestsApp([summarize], greeting, {
        models: { ai: { line: "Hello from the fixture" } },
      });
      const session = await sessionOf(app);
      await session.start(
        "desk-user",
        startOf({ who: "Ada" }),
        JSON.stringify(app.fixture)
      );
      // The test's first run, by its number in the test.
      const run = 0;
      const completed = await vi.waitFor(
        async () => {
          const summarized = await session.completedCount(run, "summarize");
          expect(summarized).toBe(1);
          return {
            summarize: summarized,
            never: await session.completedCount(run, "linger"),
          };
        },
        { timeout: 60_000, interval: 200 }
      );
      await session.close();
      expect(completed).toStrictEqual({ summarize: 1, never: 0 });
    });

    it("runs an App test's run of a version generated for the run host there, its model answered by its fixture", async () => {
      const provider = await fakeProvider({
        text: '{"line":"From a real model"}',
        inputTokens: 1,
        outputTokens: 1,
      });
      const app = await requestsApp([linger, summarize], greeting, {
        models: { ai: { line: "Hello from the fixture" } },
      });
      const session = await sessionOf(app);
      await session.start(
        "desk-user",
        startOf({ who: "Ada" }),
        JSON.stringify(app.fixture)
      );
      const { runId, pin } = await fixtureRunOf(app.app);
      const ended = await ranOnRunHost(
        await fixtureActivation(env, pin, runId)
      );
      await session.close();
      expect({ ended, asked: provider.requests.length }).toStrictEqual({
        ended: { status: "Hello from the fixture" },
        asked: 0,
      });
    });

    it("answers an App test's model call once on the run host, whatever its step's attempts: an evicted activation's successor fails as tried", async () => {
      const app = await requestsApp([linger, summarize], greeting, {
        models: { ai: { line: "Hello" } },
      });
      const session = await sessionOf(app);
      await session.start(
        "desk-user",
        startOf({ who: "Ada" }),
        JSON.stringify(app.fixture)
      );
      const { runId, pin } = await fixtureRunOf(app.app);
      const activation = await fixtureActivation(env, pin, runId);
      // One run's engine and memory across its activations: the first is
      // evicted once its model call's attempt returned, nothing journaled.
      const engine = journalingEngine();
      const memory = memoryOfTest();
      engine.evictAfter = "summarize:task";
      const evicted = await ranOnRunHost(activation, { engine, memory });
      engine.evictAfter = undefined;
      const resumed = await ranOnRunHost(activation, { engine, memory });
      await session.close();
      expect({ evicted, resumed }).toStrictEqual({
        evicted: { failed: "internal.unexpected" },
        // Not `{ status: "Hello" }`: its model call isn't answered again.
        resumed: { failed: "function.deadline_exceeded" },
      });
    });

    it("refuses an App test's run on the run host a call its test doesn't serve, sending nothing", async () => {
      const app = await requestsApp([linger, send], "sent", {});
      const session = await sessionOf(app);
      await session.start(
        "desk-user",
        startOf({ who: "Ada" }),
        JSON.stringify(app.fixture)
      );
      const { runId, pin } = await fixtureRunOf(app.app);
      const ended = await ranOnRunHost(
        await fixtureActivation(env, pin, runId)
      );
      await session.close();
      const events = await allEvents();
      const checked = events.filter(
        ({ action, target }) =>
          action === "workflow.call.checked" && target?.id === runId
      );
      expect({ ended, checked }).toStrictEqual({
        ended: { failed: "permission.unavailable" },
        checked: [],
      });
    });

    it("takes a draft's test run's decision on the run host from its start's fixture, as a real run asks it, opening none and asking nobody", async () => {
      const ada = await person("builder");
      const { workflow, revision } = await drafted(
        ada,
        [linger, reviewWho],
        reviewed
      );
      /** A test run of the draft for `who`, left waiting by its own engine. */
      const waiting = async (who = "person:approver") => {
        const { runId } = await startCandidateRun(env, ada, workflow.id, {
          revision,
          args: { who },
          fixtures: {
            approval: {
              result: {
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
      const own = await waiting(`person:${ada.userId}`);
      expect({
        // Its engine waits for no event: the answer is there at its first look.
        ended: await ranOnRunHost(answered.activation),
        // Asked as a real run's decision is, its fixture notwithstanding:
        // never of the run's own person, who can't answer it.
        own: await ranOnRunHost(own.activation),
        organization: [
          await organizationsOf(answered.runId),
          await organizationsOf(own.runId),
        ],
      }).toStrictEqual({
        ended: { status: "approved by person:pat" },
        own: { failed: "workflow.call_invalid" },
        organization: [
          { decisions: 0, asked: 0 },
          { decisions: 0, asked: 0 },
        ],
      });
    });

    it("waits on the run host for an App test's decision its fixture's principal answers, kept with the test and asking nobody", async () => {
      const app = await requestsApp([linger, review], reviewed, {
        deciders: { approval: ["approver"] },
      });
      const session = await sessionOf(app);
      const started = z
        .object({ ok: z.literal(true), value: z.object({ run: z.number() }) })
        .parse(
          JSON.parse(
            await session.start(
              "desk-user",
              startOf({ who: "Ada" }),
              JSON.stringify(app.fixture)
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
        ended: { status: "rejected by fixture-approver" },
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
      const app = await requestsApp([linger, batch], "signed", {
        deciders: { approval: ["approver"] },
      });
      const session = await sessionOf(app);
      const started = z
        .object({ ok: z.literal(true), value: z.object({ run: z.number() }) })
        .parse(
          JSON.parse(
            await session.start(
              "desk-user",
              startOf({ who: "Ada" }),
              JSON.stringify(app.fixture)
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
                  JSON.stringify({ task: "sign", approved: at === 0, run: at })
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
        { engine }
      );
      const kept = await env.DB.prepare(
        "SELECT step, status FROM app_test_decisions WHERE run_id = ? ORDER BY step"
      )
        .bind(runId)
        .all();
      await session.close();
      expect({ ended, answers, kept: kept.results }).toStrictEqual({
        ended: { status: "signed" },
        answers: [
          { ok: true, value: null },
          { ok: true, value: null },
        ],
        kept: [
          { step: "sign:task", status: "approved" },
          { step: "sign:task@1", status: "rejected" },
        ],
      });
    });
  }
);
