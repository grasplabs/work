import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { Role } from "@grasp-os/shared/roles";
import {
  maxLiveRunsPerPrincipal,
  workflowNamespace,
} from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowResourceRun,
  WorkflowStart,
} from "@grasp-os/shared/workflow-resources";
import type { AttemptLease } from "@grasp-os/workerflow/run";
import { jqProvenance } from "@grasp-os/workflow-expressions/provenance";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { Acting } from "../src/auth/identity.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import type { Settled } from "../src/workflows/code.ts";
import { runEngine } from "../src/workflows/engine.ts";
import type { RunStep } from "../src/workflows/host.ts";
import { ResourceRunHost } from "../src/workflows/resource-host.ts";
import {
  repairResourceStarts,
  repairResourceTerminations,
  resourceRunFor,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import { removedText, sweepRunDetails } from "../src/workflows/retention.ts";
import { allEvents } from "./audit-events.ts";
import { aroundEngine, runObject, whileEngineRefuses } from "./runs.ts";
import { artifactKey } from "./sealed-apps.ts";
import { outcome, refusal, unique } from "./sign-in.ts";

// Runs of independent workflows (workflows/resource-runs.ts and
// resource-host.ts), from their threat model: a start's receipt admits a
// run of exactly the version's sealed build, which runs with the
// parameters the start froze, replays what it recorded, carries the
// definition's text only as data, refuses a build that isn't the one it
// was admitted for, and keeps its workflow from being deleted until it
// ends.

/** A builder of the organization, as their session has them. */
const builder = async (role: Role = "builder"): Promise<Acting> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return { userId, role, teams: [], staff: false };
};

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** The output most definitions here return: a status. */
const statusOutput = { status: { type: "string" } };

/** A definition of `name` running `tasks`, its output `output`'s properties. */
const definitionOf = (
  name: string,
  tasks: unknown[],
  output: Record<string, unknown> = statusOutput
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {
            greeting: {
              schema: { type: "string", maxLength: 200 },
              label: "Greeting",
              default: "Hello",
              sensitive: false,
            },
          },
          bindings: {},
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema(output) },
    do: tasks,
  });

/** A workflow of `by`'s, published once from `definition`. */
const published = async (by: Acting, definition: (name: string) => string) => {
  const workflow = await createWorkflowResource(env, by, `run-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definition(workflow.name),
    basedOn: null,
  });
  return workflow;
};

/** `by` starts version 1 of workflow `id` for Ada, under `key`. */
const start = async (
  by: Acting,
  id: string,
  key = unique()
): Promise<WorkflowStart> =>
  await startWorkflow(env, { type: "person", person: by }, id, {
    version: 1,
    input: { who: "Ada" },
    key,
  });

/** Run `runId` of workflow `id`, once it has ended. */
const ended = async (
  by: Acting,
  id: string,
  runId: string | null
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );

const statusSchema = z.object({ status: z.string() });

describe("runs of JSON workflows", () => {
  it("fails a run of a version published for another expression evaluator, evaluating nothing", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: '${ "done" }' } } }])
    );
    // A deploy that ships another evaluator than the version was sealed for.
    const deployed = jqProvenance.sha256;
    Reflect.set(jqProvenance, "sha256", "0".repeat(64));
    try {
      const { runId } = await start(by, workflow.id);
      const run = await ended(by, workflow.id, runId);
      expect({ status: run.status, code: run.error?.code }).toStrictEqual({
        status: "failed",
        code: "workflow.evaluator_changed",
      });
    } finally {
      Reflect.set(jqProvenance, "sha256", deployed);
    }
  });

  it("ends with its output as the output schema takes it, defaults filled in", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      // `note` is optional, with a default.
      definitionOf(name, [{ finish: { set: { status: "done" } } }], {
        status: { type: "string" },
        note: { type: "string", default: "none" },
      }).replace('"required":["status","note"]', '"required":["status"]')
    );
    const { runId } = await start(by, workflow.id);
    const run = await ended(by, workflow.id, runId);
    expect({ status: run.status, output: run.output }).toStrictEqual({
      status: "completed",
      output: { status: "done", note: "none" },
    });
  });

  it("runs a start's sealed build with the parameters the start froze, once per key", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [
        { pause: { wait: "PT2S" } },
        {
          greet: {
            set: {
              status: '${ $params.greeting + ", " + $workflow.input.who }',
            },
          },
        },
      ])
    );
    const key = unique();
    const first = await start(by, workflow.id, key);
    // Changed while the run waits: the run keeps what its start froze.
    await setWorkflowParams(env, by, workflow.id, {
      expectedRevision: 0,
      values: { greeting: "Goodbye" },
    });
    const again = await start(by, workflow.id, key);
    const run = await ended(by, workflow.id, first.runId);
    expect({
      sameRun: again.runId === first.runId,
      runIsReceipt: first.runId === first.id,
      status: run.status,
      output: run.output,
    }).toStrictEqual({
      sameRun: true,
      runIsReceipt: true,
      status: "completed",
      output: { status: "Hello, Ada" },
    });
  });

  it("replays a task's recorded output after a wait, never running it again", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [
        { stamp: { set: { at: "${ $task.startedAt }" } } },
        // Suspends the run: the next activation replays from the start.
        { pause: { wait: "PT1S" } },
        { finish: { set: { status: "${ .at | tostring }" } } },
      ])
    );
    const { runId } = await start(by, workflow.id);
    const run = await ended(by, workflow.id, runId);
    const stamped = Number(statusSchema.parse(run.output).status);
    // Run again after the wait, the stamp would be at least a second later.
    expect(Date.parse(run.endedAt ?? "") - stamped).toBeGreaterThanOrEqual(
      1000
    );
  });

  it("carries the definition's text into the run's output only as data", async () => {
    const by = await builder();
    const texts = [
      '"); globalThis.escaped = true; ("',
      "`${globalThis}` */ // \\ </script>",
      "${ looks like an expression, but isn't one }x",
    ];
    const workflow = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done", texts } } }], {
        status: { type: "string" },
        texts: { type: "array", items: { type: "string" } },
      })
    );
    const { runId } = await start(by, workflow.id);
    const run = await ended(by, workflow.id, runId);
    expect(run.output).toStrictEqual({ status: "done", texts });
  });

  it("fails a run on an expression's failure, without the values it read", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [
        {
          finish: {
            set: { status: "${ $params.greeting | tonumber | tostring }" },
          },
        },
      ])
    );
    const { runId } = await start(by, workflow.id);
    const run = await ended(by, workflow.id, runId);
    expect({
      status: run.status,
      code: run.error?.code,
      quotes: JSON.stringify(run.error).includes("Hello"),
    }).toStrictEqual({
      status: "failed",
      code: "expression.failed",
      quotes: false,
    });
  });

  it("admits a start of a version without an executable build, and runs nothing", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [
        {
          stop: {
            raise: {
              error: {
                type: "urn:grasp:error:test.stopped",
                status: 400,
                title: "Stopped.",
              },
            },
          },
        },
      ])
    );
    const started = await start(by, workflow.id);
    expect(started.runId).toBeNull();
    await expect(
      outcome(resourceRunFor(env, by, workflow.id, started.id))
    ).resolves.toBe("workflow.run_unavailable");
  });

  it("fails a run whose sealed build changed in storage, running none of it", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done" } } }])
    );
    const row = await env.DB.prepare(
      "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ?"
    )
      .bind(workflow.id)
      .first<{ manifest: string }>();
    const { build } = z
      .object({
        build: z.object({
          artifacts: z.array(
            z.object({ path: z.string(), sha256: z.string() })
          ),
        }),
      })
      .parse(JSON.parse(row?.manifest ?? "{}"));
    const compiled = build.artifacts.find(
      ({ path }) => path === "modules/app~.grasp~workflow.js"
    );
    await env.FILES.put(
      artifactKey(compiled?.sha256 ?? ""),
      'export default { metadata: { profile: "grasp-open-workflow/1" }, run: async () => ({ status: "forged" }) };'
    );
    const { runId } = await start(by, workflow.id);
    const run = await ended(by, workflow.id, runId);
    expect({ status: run.status, code: run.error?.code }).toStrictEqual({
      status: "failed",
      code: "workflow.version_corrupt",
    });
  });

  it("keeps a workflow with a run that hasn't ended from being deleted, and lets it go after", async () => {
    const by = await builder();
    const waiting = await published(by, (name) =>
      definitionOf(name, [
        { pause: { wait: "PT1H" } },
        { finish: { set: { status: "done" } } },
      ])
    );
    await start(by, waiting.id);
    const done = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done" } } }])
    );
    const { runId } = await start(by, done.id);
    await ended(by, done.id, runId);
    expect({
      live: await outcome(deleteWorkflowResource(env, by, waiting.id)),
      ended: await outcome(deleteWorkflowResource(env, by, done.id)),
    }).toStrictEqual({ live: "workflow.resource_bound", ended: "ok" });
  });

  it("keeps what a run reads on its receipt until it ended a retention ago", async () => {
    const by = await builder();
    const waiting = await published(by, (name) =>
      definitionOf(name, [
        { pause: { wait: "PT1H" } },
        { finish: { set: { status: "done" } } },
      ])
    );
    const started = await start(by, waiting.id);
    // Past the deployment's run retention (30 days) since it started.
    await sweepRunDetails(env, new Date(Date.now() + 31 * 86_400_000));
    const receipt = await env.DB.prepare(
      "SELECT input, params FROM workflow_start_receipts WHERE id = ?"
    )
      .bind(started.id)
      .first<{ input: string | null; params: string | null }>();
    expect({
      input: receipt?.input,
      params: receipt?.params,
    }).toStrictEqual({
      input: JSON.stringify({ who: "Ada" }),
      params: JSON.stringify({ greeting: "Hello" }),
    });
  });
});

/** A workflow of `by`'s whose run waits an hour before it finishes. */
const waitingWorkflow = async (by: Acting) =>
  await published(by, (name) =>
    definitionOf(name, [
      { pause: { wait: "PT1H" } },
      { finish: { set: { status: "done" } } },
    ])
  );

/** Run `id`'s row's `column`, as the repair and the trigger see it. */
const runColumn = async (
  id: string | null,
  column:
    | "status"
    | "start_attempts"
    | "created_at"
    | "ended_at"
    | "manifest_hash"
    | "next_start_at"
): Promise<unknown> => {
  const row = await env.DB.prepare(
    `SELECT ${column} AS value FROM workflow_resource_runs WHERE id = ?`
  )
    .bind(id)
    .first<{ value: unknown }>();
  return row?.value;
};

/** `runId`'s audited events named `action`. */
const runEvents = async (runId: string | null, action: string) => {
  const events = await allEvents();
  return events.filter(
    (event) => event.action === action && event.target?.id === runId
  );
};

describe("the bounds on runs of JSON workflows", () => {
  it("fails an attempt whose expressions spend more than its budget together, each one within its own", async () => {
    const by = await builder();
    // Each runs well within one evaluation's fuel; together they are over
    // the attempt's.
    const burns = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `n${index}`,
        `\${ reduce range(0; ${150_000 + index}) as $i (0; . + 1) }`,
      ])
    );
    const workflow = await published(by, (name) =>
      definitionOf(name, [
        { burn: { set: burns } },
        { finish: { set: { status: "done" } } },
      ])
    );
    const { runId } = await start(by, workflow.id);
    const run = await ended(by, workflow.id, runId);
    expect({ status: run.status, code: run.error?.code }).toStrictEqual({
      status: "failed",
      code: "expression.budget_exhausted",
    });
  });

  it("refuses a person's start past their live runs of the workflow, audited as refused", async () => {
    const ada = await builder();
    const reader = await builder("user");
    const workflow = await waitingWorkflow(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    for (let index = 0; index < maxLiveRunsPerPrincipal; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one start after another
      await start(reader, workflow.id);
    }
    const refused = await refusal(start(reader, workflow.id));
    // The cap is each person's: Ada's start still runs.
    const own = await start(ada, workflow.id);
    const logged = await allEvents();
    const events = logged.filter(({ target }) => target?.id === workflow.id);
    expect({
      refused,
      own: own.runId === null ? "none" : "run",
      admitted: events.filter(
        ({ action }) => action === "workflow.start.admitted"
      ).length,
      refusals: events
        .filter(({ action }) => action === "workflow.start.refused")
        .map(({ detail }) => detail?.reason),
    }).toMatchObject({
      refused: {
        code: "workflow.run_limit",
        details: { limit: maxLiveRunsPerPrincipal },
      },
      own: "run",
      admitted: maxLiveRunsPerPrincipal + 1,
      refusals: ["workflow.run_limit"],
    });
  });

  it("says a start refused at the cap on live runs as such, whatever ends after", async () => {
    const ada = await builder();
    const workflow = await waitingWorkflow(ada);
    const runs: (string | null)[] = [];
    for (let index = 0; index < maxLiveRunsPerPrincipal; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one start after another
      const started = await start(ada, workflow.id);
      runs.push(started.runId);
    }
    const real = env.DB;
    const seen = { batches: 0 };
    // One of Ada's runs ends just after the refused admission commits, as
    // anything asked afterwards would read it.
    const db: D1Database = {
      prepare: (statement) => real.prepare(statement),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        const results = await real.batch<T>(statements);
        seen.batches += 1;
        if (seen.batches === 1) {
          await real
            .prepare(
              "UPDATE workflow_resource_runs SET status = 'completed', ended_at = ? WHERE id = ?"
            )
            .bind(Date.now(), runs[0] ?? "")
            .run();
        }
        return results;
      },
      exec: async (statement) => await real.exec(statement),
      // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
      dump: async () => await real.dump(),
      withSession: (constraint) => real.withSession(constraint),
    };
    const refused = await refusal(
      startWorkflow(
        { ...env, DB: db },
        { type: "person", person: ada },
        workflow.id,
        {
          version: 1,
          input: { who: "Ada" },
          key: unique(),
        }
      )
    );
    expect(refused).toMatchObject({ code: "workflow.run_limit" });
  });

  it("lets a builder stop a run, audited under them, and the workflow go after", async () => {
    const ada = await builder();
    const reader = await builder("user");
    const workflow = await waitingWorkflow(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    const { runId } = await start(ada, workflow.id);
    const byReader = await outcome(
      terminateResourceRun(env, reader, workflow.id, runId)
    );
    const stopped = await terminateResourceRun(env, ada, workflow.id, runId);
    const again = await outcome(
      terminateResourceRun(env, ada, workflow.id, runId)
    );
    const audited = await runEvents(runId, "workflow.run.terminated");
    expect({
      byReader,
      status: stopped.status,
      ended: stopped.endedAt !== null,
      again,
      audited: audited.map(({ actor }) => actor),
      deleted: await outcome(deleteWorkflowResource(env, ada, workflow.id)),
    }).toMatchObject({
      byReader: "role.forbidden",
      status: "cancelled",
      ended: true,
      again: "workflow.run_ended",
      audited: [{ type: "person", userId: ada.userId }],
      deleted: "ok",
    });
  });

  it("shows a person's run to them and the workflow's builders, never to its other users", async () => {
    const ada = await builder();
    const reader = await builder("user");
    const other = await builder("user");
    const workflow = await waitingWorkflow(ada);
    for (const person of [reader, other]) {
      // oxlint-disable-next-line no-await-in-loop -- one share after another
      await shareWorkflowResource(env, ada, workflow.id, {
        type: "person",
        id: person.userId,
        role: "user",
      });
    }
    const { runId } = await start(reader, workflow.id);
    expect({
      own: await outcome(resourceRunFor(env, reader, workflow.id, runId)),
      builder: await outcome(resourceRunFor(env, ada, workflow.id, runId)),
      other: await outcome(resourceRunFor(env, other, workflow.id, runId)),
    }).toStrictEqual({
      own: "ok",
      builder: "ok",
      other: "workflow.run_unavailable",
    });
  });

  it("sends a start the engine refused again, backing off, then fails the run and lets the workflow go", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const createdAt = Number(await runColumn(runId, "created_at"));
    const at = (minutes: number) => new Date(createdAt + minutes * 60_000);
    // The engine still refuses every start; it only says it has no run.
    const attemptsAt = async (minutes: number) =>
      await whileEngineRefuses(
        (method) => method !== "status",
        async () => {
          await repairResourceStarts(env, at(minutes));
          return await runColumn(runId, "start_attempts");
        }
      );
    const attempts = [
      await attemptsAt(2),
      // Within the minute it backs off for after its first try.
      await attemptsAt(2.5),
      await attemptsAt(3.1),
    ];
    // Six hours on, it hasn't started: failed, and its workflow free to go.
    await attemptsAt(7 * 60);
    const failed = await runEvents(runId, "workflow.run.failed");
    // Its person reads why, though the engine never had it.
    const read = await resourceRunFor(env, by, workflow.id, runId);
    expect({
      attempts,
      status: read.status,
      code: read.error?.code,
      reason: failed.map(({ detail }) => detail?.reason),
      deleted: await outcome(deleteWorkflowResource(env, by, workflow.id)),
    }).toStrictEqual({
      attempts: [1, 1, 2],
      status: "failed",
      code: "workflow.start_unconfirmed",
      reason: ["workflow.start_unconfirmed"],
      deleted: "ok",
    });
  });

  it("keeps an ended run as it ended", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done" } } }])
    );
    const { runId } = await start(by, workflow.id);
    await ended(by, workflow.id, runId);
    const reopened = await outcome(
      env.DB.prepare(
        "UPDATE workflow_resource_runs SET status = 'running', ended_at = NULL WHERE id = ?"
      )
        .bind(runId)
        .run()
    );
    expect({
      reopened: reopened.includes("an ended run stays ended"),
      status: await runColumn(runId, "status"),
    }).toStrictEqual({ reopened: true, status: "completed" });
  });
});

/** Where the engine has run `id` now; none before it has the run. */
const engineStatus = async (id: string | null) => {
  const live = await runEngine(env).status(id ?? "");
  return live?.status;
};

/** Once the engine has run `id` somewhere other than `running` or `queued`. */
const settledInEngine = async (id: string | null) =>
  await vi.waitFor(
    async () => {
      const status = await engineStatus(id);
      expect(["waiting", "complete", "errored", "terminated"]).toContain(
        status
      );
      return status;
    },
    { timeout: 30_000, interval: 100 }
  );

/**
 * Holds the notifications run `id`'s object hands core until `released`
 * settles: as late as delivery may be, the engine on with the run.
 */
const holdNotifications = async (
  id: string,
  released: Promise<null>
): Promise<void> => {
  await runInDurableObject(runObject(id), (instance: object) => {
    const notify: unknown = Reflect.get(instance, "notify");
    if (typeof notify !== "function") {
      throw new TypeError("The run's object takes no notifications");
    }
    Reflect.set(instance, "notify", async (...args: unknown[]) => {
      await released;
      const taken: unknown = await Reflect.apply(notify, instance, args);
      return taken;
    });
  });
};

/** The code `settled` failed with, or "ok" with its value. */
const settledCode = (settled: Settled<unknown>): unknown =>
  settled.ok ? { ok: settled.value } : settled.error.code;

/** What a step of task `greet` captures, as generated code asks. */
const adaCaptured = { input: { input: { who: "Ada" }, context: {} } };

/**
 * Evaluates the first expression of the first task of workflow `id`'s
 * version 1, as its run's host does for an attempt, with the attempt's
 * lease as `lease` has it at each of the host's reads of it, by count.
 */
const evaluatedWith = async (
  by: Acting,
  id: string,
  lease: (read: number) => AttemptLease | undefined,
  slot = 0,
  captured: unknown = adaCaptured,
  ran?: { module: boolean }
): Promise<unknown> => {
  const manifest = await env.DB.prepare(
    "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(id)
    .first<{ hash: string }>();
  const build = await loadWorkflowBuild(env, id, 1, manifest?.hash ?? "");
  const step: RunStep = {
    do: async (name, _config, fn) =>
      await fn({ attempt: 1, idempotencyKey: `key:${name}` }),
    sleep: async () => {
      await Promise.resolve();
    },
    waitForEvent: async () => await Promise.reject(new Error("No waits here")),
  };
  let reads = 0;
  const host = new ResourceRunHost(
    env,
    step,
    {
      runId: crypto.randomUUID(),
      workflowId: id,
      version: 1,
      principal: by.userId,
      input: { who: "Ada" },
      params: { greeting: "Hello" },
      createdAt: Date.now(),
      build,
    },
    {
      leaseOf: () => {
        reads += 1;
        return lease(reads);
      },
      tampered: () => {},
    }
  );
  let evaluated: unknown;
  const settled = await host.do("task:greet", captured, async (attempt) => {
    if (ran !== undefined) {
      ran.module = true;
    }
    evaluated = settledCode(await attempt.evaluate(slot));
    return null;
  });
  // What it evaluated, or, refused before it could, why.
  return evaluated === undefined && !settled.ok
    ? settledCode(settled)
    : evaluated;
};

/** Whether an attempt of task `greet` on `host` got to run its module's code. */
const attempted = async (
  host: ResourceRunHost,
  task: "greet" | "again",
  slot: number
): Promise<boolean> => {
  const ran = { module: false };
  await host.do(
    `task:${task}`,
    { input: { input: { who: "Ada" }, context: {} } },
    async (attempt) => {
      ran.module = true;
      const value = await attempt.evaluate(slot);
      return value.ok ? { ok: true, value: value.value } : value;
    }
  );
  return ran.module;
};

describe("an activation's share of core's CPU", () => {
  it("cuts off an attempt the activation's expression fuel can't fund, as a CPU stop the next activation retries", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [
        {
          greet: {
            set: {
              status: '${ $params.greeting + ", " + $workflow.input.who }',
            },
          },
        },
        {
          again: {
            set: {
              status: '${ $params.greeting + ", " + $workflow.input.who }',
            },
          },
        },
      ])
    );
    const manifest = await env.DB.prepare(
      "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ hash: string }>();
    const build = await loadWorkflowBuild(
      env,
      workflow.id,
      1,
      manifest?.hash ?? ""
    );
    // What each step's attempt failed with, as the engine would hear it.
    const failures: string[] = [];
    const step: RunStep = {
      do: async (name, _config, fn) => {
        try {
          return await fn({
            attempt: 1,
            idempotencyKey: `key:${name}:${unique()}`,
          });
        } catch (error) {
          failures.push(error instanceof Error ? error.name : "unknown");
          throw error;
        }
      },
      sleep: async () => {
        await Promise.resolve();
      },
      waitForEvent: async () =>
        await Promise.reject(new Error("No waits here")),
    };
    // Room for one attempt's worth: the first runs and spends some of it.
    const hostWithOneShare = () =>
      new ResourceRunHost(
        env,
        step,
        {
          runId: crypto.randomUUID(),
          workflowId: workflow.id,
          version: 1,
          principal: by.userId,
          input: { who: "Ada" },
          params: { greeting: "Hello" },
          createdAt: Date.now(),
          build,
        },
        {
          leaseOf: () => ({ generation: 1, deadline: Date.now() + 60_000 }),
          tampered: () => {},
          activationFuel: 2 ** 27,
        }
      );
    // A module that leaves an evaluation running as its attempt returns:
    // the attempt's fuel goes back only once it settled, and it never runs.
    const leftRunning: Promise<unknown>[] = [];
    const settledFirst: string[] = [];
    await hostWithOneShare().do(
      "task:greet",
      { input: { input: { who: "Ada" }, context: {} } },
      async (attempt) => {
        leftRunning.push(
          attempt.evaluate(0).then((settled) => {
            settledFirst.push("evaluation");
            return settledCode(settled);
          })
        );
        return await Promise.resolve({ ok: true, value: null });
      }
    );
    settledFirst.push("attempt");
    const [late] = await Promise.all(leftRunning);
    const host = hostWithOneShare();
    const first = await attempted(host, "greet", 0);
    const second = await attempted(host, "again", 1);
    // A step asked for again in the activation: refused before any read.
    const askedAgain = await attempted(host, "greet", 0);
    // Two at once on a fresh activation: one holds the share from its start.
    const fresh = hostWithOneShare();
    const atOnce = await Promise.all([
      attempted(fresh, "greet", 0),
      attempted(fresh, "again", 1),
    ]);
    expect({
      late,
      settledFirst,
      first,
      second,
      askedAgain,
      atOnce: atOnce.filter(Boolean).length,
      // A retryable timeout, as for an isolate stopped past its CPU time.
      failures,
    }).toStrictEqual({
      late: "execution.stale_attempt",
      settledFirst: ["evaluation", "attempt"],
      first: true,
      second: false,
      askedAgain: false,
      atOnce: 1,
      failures: ["TimeoutError", "TimeoutError"],
    });
  });
});

describe("a run's host, against a forged module", () => {
  it("refuses a capture past what a step records before its step runs", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [
        {
          greet: {
            set: {
              status: '${ $params.greeting + ", " + $workflow.input.who }',
            },
          },
        },
      ])
    );
    const ran = { module: false };
    const refused = await evaluatedWith(
      by,
      workflow.id,
      () => ({ generation: 1, deadline: Date.now() + 60_000 }),
      0,
      {
        input: {
          input: { who: "x".repeat(3 * platformLimits.stepPayloadBytes) },
          context: {},
        },
      },
      ran
    );
    expect({ refused, ran: ran.module }).toStrictEqual({
      refused: "workflow.invalid",
      ran: false,
    });
  });
});

describe("whose word a run's row takes, and whose clock", () => {
  it("shows what a run returned only within the retention the deployment has now", async () => {
    const by = await builder();
    const done = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done" } } }])
    );
    const failing = await published(by, (name) =>
      definitionOf(name, [
        {
          finish: {
            set: { status: "${ $params.greeting | tonumber | tostring }" },
          },
        },
      ])
    );
    const completed = await start(by, done.id);
    const failed = await start(by, failing.id);
    await ended(by, done.id, completed.runId);
    await ended(by, failing.id, failed.runId);
    // Two days on, the deployment's retention shortened to one: the engine
    // still holds both, under the retention they were admitted with.
    const shorter = { ...env, RUN_RETENTION_DAYS: "1" };
    const later = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 2 * 86_400_000);
    let reads: WorkflowResourceRun[];
    try {
      reads = [
        await resourceRunFor(env, by, done.id, completed.runId),
        // Past its retention, read with the engine unreachable: the row
        // alone says it all.
        await whileEngineRefuses(
          () => true,
          async () =>
            await resourceRunFor(shorter, by, done.id, completed.runId)
        ),
        await resourceRunFor(shorter, by, failing.id, failed.runId),
      ];
    } finally {
      later.mockRestore();
    }
    const [kept, removed, removedFailure] = reads;
    expect({
      kept: kept?.output,
      removed: removed?.output,
      failure: removedFailure?.error,
    }).toStrictEqual({
      kept: { status: "done" },
      removed: undefined,
      failure: { code: "expression.failed", message: removedText(shorter) },
    });
  });

  it("cancels a run still starting before the engine hears, so a start already on its way runs nothing", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const manifest = String(await runColumn(runId, "manifest_hash"));
    // A start sent before the terminate reaches the engine just after the
    // engine was told of it.
    const stopped = await aroundEngine(
      async (method, call) => {
        const answer = await call();
        if (method === "terminate") {
          await runEngine(env).createResource({
            id: runId ?? "",
            pinned: {
              workflow: workflowResourceIdSchema.parse(workflow.id),
              version: 1,
              manifest,
            },
            input: { who: "Ada" },
          });
          await settledInEngine(runId);
        }
        return answer;
      },
      async () => await terminateResourceRun(env, by, workflow.id, runId)
    );
    expect({
      status: stopped.status,
      waitingInEngine: (await engineStatus(runId)) === "waiting",
    }).toStrictEqual({ status: "cancelled", waitingInEngine: false });
  });

  it("keeps telling the engine to terminate a run cancelled while starting until the engine takes it", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const id = runId ?? "";
    const manifest = String(await runColumn(id, "manifest_hash"));
    // A start sent before the cancel made an instance, asleep now; its
    // first notification is still on its way to core.
    const released = Promise.withResolvers<null>();
    await holdNotifications(id, released.promise);
    await runEngine(env).createResource({
      id,
      pinned: {
        workflow: workflowResourceIdSchema.parse(workflow.id),
        version: 1,
        manifest,
      },
      input: { who: "Ada" },
    });
    await settledInEngine(id);
    const stopped = await whileEngineRefuses(
      (method) => method === "terminate",
      async () => await terminateResourceRun(env, by, workflow.id, id)
    );
    const meanwhile = await engineStatus(id);
    await repairResourceTerminations(env, new Date(Date.now() + 60_000));
    released.resolve(null);
    expect({
      status: stopped.status,
      meanwhile,
      inEngine: await engineStatus(id),
    }).toStrictEqual({
      status: "cancelled",
      meanwhile: "waiting",
      inEngine: "terminated",
    });
  });

  it("moves a run whose engine lookup fails back in the repair's queue, neither sent again nor counted", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const id = runId ?? "";
    const createdAt = Number(await runColumn(id, "created_at"));
    const at = createdAt + 2 * 60_000;
    // The engine can't say where the run is: every lookup fails.
    await whileEngineRefuses(
      (method) => method === "status",
      async () => {
        await repairResourceStarts(env, new Date(at));
      }
    );
    expect({
      attempts: await runColumn(id, "start_attempts"),
      nextAt: Number(await runColumn(id, "next_start_at")) > at,
      status: await runColumn(id, "status"),
    }).toStrictEqual({ attempts: 0, nextAt: true, status: "starting" });
  });

  it("terminates a run the repair abandons when a start sent again made an instance after the repair asked", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const id = runId ?? "";
    const manifest = String(await runColumn(id, "manifest_hash"));
    const createdAt = Number(await runColumn(id, "created_at"));
    const released = Promise.withResolvers<null>();
    await holdNotifications(id, released.promise);
    // The repair finds no instance; a start sent again makes one just
    // after, which reads the row (still starting) before the repair ends it.
    const raced = { done: false };
    await aroundEngine(
      async (method, call) => {
        const answer = await call();
        if (method === "status" && !raced.done) {
          raced.done = true;
          await runEngine(env).createResource({
            id,
            pinned: {
              workflow: workflowResourceIdSchema.parse(workflow.id),
              version: 1,
              manifest,
            },
            input: { who: "Ada" },
          });
          await settledInEngine(id);
        }
        return answer;
      },
      async () => {
        await repairResourceStarts(env, new Date(createdAt + 7 * 3_600_000));
      }
    );
    const abandoned = await runColumn(id, "status");
    const meanwhile = await engineStatus(id);
    await repairResourceTerminations(env, new Date(createdAt + 8 * 3_600_000));
    released.resolve(null);
    expect({
      abandoned,
      meanwhile,
      inEngine: await engineStatus(id),
    }).toStrictEqual({
      abandoned: "failed",
      meanwhile: "waiting",
      inEngine: "terminated",
    });
  });

  it("leaves a run that ended in the engine before its terminate to its end's notification, at the engine's time", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done" } } }])
    );
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const id = runId ?? "";
    const createdAt = Number(await runColumn(id, "created_at"));
    const released = Promise.withResolvers<null>();
    await holdNotifications(id, released.promise);
    // The engine runs it to its end and tells core nothing of it yet; the
    // repair finds the engine has it.
    await repairResourceStarts(env, new Date(createdAt + 2 * 60_000));
    await settledInEngine(id);
    await repairResourceStarts(env, new Date(createdAt + 4 * 60_000));
    const asked = Date.now();
    await terminateResourceRun(env, by, workflow.id, id);
    const meanwhile = await runColumn(id, "status");
    released.resolve(null);
    const run = await ended(by, workflow.id, id);
    expect({
      meanwhile,
      status: run.status,
      atEngineTime: Date.parse(run.endedAt ?? "") < asked,
    }).toStrictEqual({
      meanwhile: "running",
      status: "completed",
      atEngineTime: true,
    });
  });

  it("ends a run the repair finds ended in the engine at the engine's time, not the repair's", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done" } } }])
    );
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const id = runId ?? "";
    const createdAt = Number(await runColumn(id, "created_at"));
    const released = Promise.withResolvers<null>();
    await holdNotifications(id, released.promise);
    // The repair sends its start; the engine runs it to its end, and tells
    // core nothing of it yet.
    await repairResourceStarts(env, new Date(createdAt + 2 * 60_000));
    await settledInEngine(id);
    // The next repair, minutes on, finds the engine has it.
    await repairResourceStarts(env, new Date(createdAt + 4 * 60_000));
    const meanwhile = await runColumn(id, "status");
    released.resolve(null);
    const run = await ended(by, workflow.id, id);
    expect({
      meanwhile,
      status: run.status,
      atEngineTime: Date.parse(run.endedAt ?? "") < createdAt + 2 * 60_000,
    }).toStrictEqual({
      meanwhile: "running",
      status: "completed",
      atEngineTime: true,
    });
  });

  it("gives an attempt nothing once its lease's deadline has passed, or it lost its lease while evaluating", async () => {
    const by = await builder();
    const workflow = await published(by, (name) =>
      definitionOf(name, [
        {
          greet: {
            set: {
              status: '${ $params.greeting + ", " + $workflow.input.who }',
            },
          },
        },
      ])
    );
    const holding = { generation: 1, deadline: Date.now() + 60_000 };
    expect({
      holding: await evaluatedWith(by, workflow.id, () => holding),
      // The engine hasn't noted the timeout yet: it still hands out the
      // lease, past its deadline.
      pastDeadline: await evaluatedWith(by, workflow.id, () => ({
        generation: 1,
        deadline: Date.now() - 1,
      })),
      // Held as it was claimed and as evaluating began, taken over by a
      // newer activation as it returned.
      takenOver: await evaluatedWith(by, workflow.id, (read) =>
        read < 3 ? holding : { ...holding, generation: 2 }
      ),
      // Let go of, still running, it asks for an expression it has none
      // of: stale, never a forged module that fails the run.
      lostThenForged: await evaluatedWith(
        by,
        workflow.id,
        (read) => (read < 2 ? holding : undefined),
        999
      ),
    }).toStrictEqual({
      holding: { ok: "Hello, Ada" },
      pastDeadline: "execution.stale_attempt",
      takenOver: "execution.stale_attempt",
      lostThenForged: "execution.stale_attempt",
    });
  });
});
