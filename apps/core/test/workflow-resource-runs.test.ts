import type { EndedRuns } from "@grasp-os/shared/connect";
import { sha256Hex, sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { Role } from "@grasp-os/shared/roles";
import { maxLiveRunsPerPrincipal } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowResourceRun,
  WorkflowStart,
} from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { Acting } from "../src/auth/identity.ts";
import { generatedModule } from "../src/workflow-builds.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { runEngine, runRetentionDays } from "../src/workflows/engine.ts";
import { admitAttempt } from "../src/workflows/quotas.ts";
import {
  listResourceRuns,
  repairResourceStarts,
  repairResourceTerminations,
  resourceRunFor,
  runOf,
  settleControl,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import {
  removedText,
  sweepRunDetails,
  sweptPerBatch,
  sweepWorkflowStartDetails,
} from "../src/workflows/retention.ts";
import { allEvents } from "./audit-events.ts";
import { withCpuKills } from "./cpu-kills.ts";
import {
  endLiveResourceRuns,
  objectSchema,
  passing,
} from "./json-workflow-apps.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { configuredLimits } from "./quota-limits.ts";
import { aroundEngine, runObject, whileEngineRefuses } from "./runs.ts";
import { artifactKey } from "./sealed-apps.ts";
import { moduleOf } from "./sealed-run-harness.ts";
import { outcome, refusal, unique } from "./sign-in.ts";

// Runs of independent workflows (workflows/resource-runs.ts and
// sealed-run.ts), from their threat model: a start's receipt admits a
// run of exactly the version's sealed build, which runs with the
// parameters the start froze, carries the definition's text only as
// data, refuses a build that isn't the one it was admitted for, and
// keeps its workflow from being deleted until it ends.

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

/** The output most definitions here return: a status. */
const statusOutput = { status: { type: "string" } };

/**
 * A grasp-workflow/1 definition running `steps` on input `{ who }`, its
 * output `value` of `output`'s properties: `{ status: "done" }` unless said.
 */
const definitionOf = (
  steps: unknown[],
  {
    output = statusOutput,
    value = { status: "done" },
  }: { output?: Record<string, unknown>; value?: unknown } = {}
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectSchema({ who: { type: "string" } }),
    output: { schema: objectSchema(output), value },
    params: {
      greeting: {
        kind: "text",
        label: "Greeting",
        default: "Hello",
        sensitive: false,
      },
    },
    steps,
  });

/** The greeting `params.greeting + ", " + input.who`, as an expression. */
const greeting = { $expr: 'params.greeting + ", " + input.who' };

/** A run that waits an hour, then ends with `{ status: "done" }`. */
const waitingDefinition = definitionOf([
  { id: "pause", type: "wait", for: "1 hour" },
]);

/**
 * A run whose output's expression fails: it reads a letter its input's
 * `who` hasn't.
 */
const failingDefinition = definitionOf([], {
  value: { status: { $expr: 'input.who.split("")[9999].toUpperCase()' } },
});

/** A workflow of `by`'s, published once from `definition`. */
const published = async (by: Acting, definition: string) => {
  const workflow = await createWorkflowResource(env, by, `run-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition,
    basedOn: null,
  });
  return workflow;
};

/**
 * Seals `code` as version 1 of workflow `id`'s generated module, as if the
 * compiler had made it: its artifact, the build's identity and the
 * manifest's hash all made to match, past the records' immutability.
 */
const forgedModule = async (id: string, code: string): Promise<void> => {
  const row = await env.DB.prepare(
    "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(id)
    .first<{ manifest: string }>();
  const manifest = z
    .looseObject({
      build: z.looseObject({
        generator: z.string(),
        compilerVersion: z.string(),
        hash: z.string(),
        artifacts: z.array(
          z.looseObject({
            path: z.string(),
            sha256: z.string(),
            bytes: z.number(),
          })
        ),
      }),
    })
    .parse(JSON.parse(row?.manifest ?? "{}"));
  const bytes = new TextEncoder().encode(code);
  const sha256 = await sha256HexOfBytes(bytes);
  await env.FILES.put(artifactKey(sha256), bytes);
  const { build } = manifest;
  build.artifacts = build.artifacts.map((artifact) =>
    artifact.path === `modules/${generatedModule}`
      ? { ...artifact, sha256, bytes: bytes.byteLength }
      : artifact
  );
  build.hash = await sha256Hex(
    canonicalJson({
      generator: build.generator,
      compilerVersion: build.compilerVersion,
      artifacts: build.artifacts
        // As workflow-builds.ts names it: not the definition or source map.
        .filter(
          ({ path }) =>
            path !== "source/workflow.json" && path !== "source-map.json"
        )
        .map(({ path, sha256: hash, bytes: size }) => ({
          path,
          sha256: hash,
          bytes: size,
        })),
    })
  );
  const text = canonicalJson(z.json().parse(manifest));
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER workflow_resource_versions_immutable_update"),
    env.DB.prepare(
      "UPDATE workflow_resource_versions SET manifest = ?, manifest_hash = ? WHERE workflow_resource_id = ? AND version = 1"
    ).bind(text, await sha256Hex(text), id),
    env.DB.prepare(
      "CREATE TRIGGER workflow_resource_versions_immutable_update BEFORE UPDATE ON workflow_resource_versions BEGIN SELECT RAISE(ABORT, 'workflow_resource_versions are immutable'); END"
    ),
  ]);
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
    | "failure_code"
    | "summary_revision"
): Promise<unknown> => {
  const row = await env.DB.prepare(
    `SELECT ${column} AS value FROM workflow_resource_runs WHERE id = ?`
  )
    .bind(id)
    .first<{ value: unknown }>();
  return row?.value;
};

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

describe("runs of JSON workflows", () => {
  afterEach(endLiveResourceRuns);

  it("ends with its output as the output schema takes it, defaults filled in", async () => {
    const by = await builder();
    const workflow = await published(
      by,
      // `note` is optional, with a default.
      definitionOf([], {
        output: {
          status: { type: "string" },
          note: { type: "string", default: "none" },
        },
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
    const workflow = await published(
      by,
      definitionOf([{ id: "pause", type: "wait", for: "2 seconds" }], {
        value: { status: greeting },
      })
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

  it("carries the definition's text into the run's output only as data", async () => {
    const by = await builder();
    const texts = [
      '"); globalThis.escaped = true; ("',
      // oxlint-disable-next-line no-template-curly-in-string -- code-like text, carried as data
      "`${globalThis}` */ // \\ </script>",
      // oxlint-disable-next-line no-template-curly-in-string -- code-like text, carried as data
      "${ looks like an expression, but isn't one }x",
    ];
    const workflow = await published(
      by,
      definitionOf([], {
        output: {
          status: { type: "string" },
          texts: { type: "array", items: { type: "string" } },
        },
        value: { status: "done", texts },
      })
    );
    const { runId } = await start(by, workflow.id);
    const run = await ended(by, workflow.id, runId);
    expect(run.output).toStrictEqual({ status: "done", texts });
  });

  it("fails a run on an expression's failure, without the values it read", async () => {
    const by = await builder();
    const workflow = await published(by, failingDefinition);
    const { runId } = await start(by, workflow.id);
    const run = await ended(by, workflow.id, runId);
    expect({
      status: run.status,
      code: run.error?.code,
      quotes: JSON.stringify(run.error).includes("Ada"),
    }).toStrictEqual({
      status: "failed",
      code: "expression.failed",
      quotes: false,
    });
  });

  it("fails a run whose sealed build changed in storage, running none of it", async () => {
    const by = await builder();
    const workflow = await published(by, definitionOf([]));
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
      ({ path }) => path === `modules/${generatedModule}`
    );
    await env.FILES.put(
      artifactKey(compiled?.sha256 ?? ""),
      moduleOf('return { status: "forged" };')
    );
    const { runId } = await start(by, workflow.id);
    const run = await ended(by, workflow.id, runId);
    expect({ status: run.status, code: run.error?.code }).toStrictEqual({
      status: "failed",
      code: "workflow.version_corrupt",
    });
  });

  it("fails a run whose module answers more than a step's result may take, reading none of it", async () => {
    const by = await builder();
    const workflow = await published(by, definitionOf([]));
    // A module that misbehaves, sealed as if it were the generated one.
    await forgedModule(
      workflow.id,
      moduleOf(
        `return (await step.do("workflow", { key: "output", description: "workflow" }, async () => ({ output: { status: "x".repeat(${2 * platformLimits.stepPayloadBytes}) } }))).output;`
      )
    );
    const { runId } = await start(by, workflow.id);
    const run = await ended(by, workflow.id, runId);
    expect({ status: run.status, output: run.output }).toStrictEqual({
      status: "failed",
      output: undefined,
    });
  });

  it("keeps a workflow with a run that hasn't ended from being deleted, and lets it go after", async () => {
    const by = await builder();
    const waiting = await published(by, waitingDefinition);
    await start(by, waiting.id);
    const done = await published(by, definitionOf([]));
    const { runId } = await start(by, done.id);
    await ended(by, done.id, runId);
    expect({
      live: await outcome(deleteWorkflowResource(env, by, waiting.id)),
      ended: await outcome(deleteWorkflowResource(env, by, done.id)),
    }).toStrictEqual({ live: "workflow.resource_bound", ended: "ok" });
  });

  it("keeps what a run reads on its receipt until it ended a retention ago", async () => {
    const by = await builder();
    const waiting = await published(by, waitingDefinition);
    const started = await start(by, waiting.id);
    // Past the run retention (30 days) since it started.
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
  await published(by, waitingDefinition);

/** Runs the start repair at `when` while every engine lookup fails. */
const repairWhileLookupsFail = async (when: number): Promise<void> => {
  await whileEngineRefuses(
    (method) => method === "status",
    async () => {
      await repairResourceStarts(env, new Date(when));
    }
  );
};

/** `runId`'s audited events named `action`. */
const runEvents = async (runId: string | null, action: string) => {
  const events = await allEvents();
  return events.filter(
    (event) => event.action === action && event.target?.id === runId
  );
};

/** A year ago: long past any run retention. */
const yearAgo = (): number => Date.now() - 365 * 86_400_000;

/**
 * `count` starts of workflow `workflowId` by `by`, admitted a year ago:
 * each with a run that ended then (`ran`), or none (its version had no
 * executable build). Answers their IDs.
 */
const oldStarts = async (
  by: Acting,
  workflowId: string,
  count: number,
  ran: boolean
): Promise<string[]> => {
  const prefix = `old-${unique()}`;
  await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input, input_hash, params, params_revision, bindings, bindings_hash, created_at, restricted)
      SELECT ? || '-' || i, 'person', ?, ? || '-' || i, ?, 1, 'manifest', ?, 0, '{}', 'hash', '{}', 0, '[]', '', ?, 0 FROM n`
    ).bind(count, prefix, by.userId, prefix, workflowId, by.userId, yearAgo()),
    ...(ran
      ? [
          env.DB.prepare(
            `INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at, ended_at, restricted)
            SELECT id, workflow_resource_id, 1, 'manifest', 'build', principal_id, 'completed', created_at, created_at, 0
            FROM workflow_start_receipts WHERE id LIKE ? || '-%'`
          ).bind(prefix),
        ]
      : []),
  ]);
  return Array.from({ length: count }, (_, at) => `${prefix}-${at + 1}`);
};

/** Which of `ids` have their start's details removed. */
const startsSwept = async (ids: readonly string[]): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT id FROM workflow_start_receipts WHERE id IN (SELECT value FROM json_each(?)) AND details_removed_at IS NOT NULL"
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string }>();
  return results.map(({ id }) => id).toSorted();
};

describe("the retention of what starts of JSON workflows kept", () => {
  afterEach(endLiveResourceRuns);

  it("asks connect to drop only what runs that ended held, never about a start that ran nothing, though another run is live", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    const [ranNothing = ""] = await oldStarts(by, workflow.id, 1, false);
    const [endedLongAgo = ""] = await oldStarts(by, workflow.id, 1, true);
    // A run of the workflow live now, its start not yet due.
    const live = await start(by, workflow.id);
    const asked: string[] = [];
    const recording: Env = {
      ...env,
      CONNECT: new Proxy(env.CONNECT, {
        get: (target, name): unknown =>
          name === "dropForEndedRuns"
            ? async (request: EndedRuns) => {
                asked.push(...request.runs.map(({ runId }) => runId));
                await target.dropForEndedRuns(request);
              }
            : Reflect.get(target, name),
      }),
    };

    await sweepWorkflowStartDetails(
      recording,
      new Date(Date.now() - runRetentionDays * 86_400_000),
      new Date()
    );

    expect({
      asked,
      swept: await startsSwept([ranNothing, endedLongAgo, live.id]),
    }).toStrictEqual({
      asked: [endedLongAgo],
      swept: [ranNothing, endedLongAgo].toSorted(),
    });
  });

  it("finds the starts and parameter values to sweep by an index, a page at a time, reading no table whole and sorting nothing", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    // More than a page, so the sweep pages on from its first; and a
    // parameter revision replaced long ago.
    const starts = await oldStarts(by, workflow.id, sweptPerBatch + 3, true);
    await env.DB.prepare(
      "INSERT INTO workflow_resource_params (workflow_resource_id, revision, \"values\", set_by, set_at) VALUES (?, 1, '{}', ?, ?), (?, 2, '{}', ?, ?)"
    )
      .bind(
        workflow.id,
        by.userId,
        yearAgo(),
        workflow.id,
        by.userId,
        yearAgo() + 1
      )
      .run();
    // A fresh D1 has no statistics: SQLite goes by the queries alone.
    const stats = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'"
    ).all();

    const queries = await recordedQueries(async () => {
      await sweepWorkflowStartDetails(
        env,
        new Date(Date.now() - runRetentionDays * 86_400_000),
        new Date()
      );
    });
    const plans = await Promise.all(
      queries
        .filter(({ query }) =>
          /workflow_start_receipts|workflow_resource_params/u.test(query)
        )
        .map(async (recorded) => await planOf(recorded))
    );
    const steps = plans.flat();
    const replaced = await env.DB.prepare(
      "SELECT values_removed_at IS NOT NULL AS removed FROM workflow_resource_params WHERE workflow_resource_id = ? ORDER BY revision"
    )
      .bind(workflow.id)
      .all<{ removed: number }>();

    const swept = await startsSwept(starts);
    expect({
      stats: stats.results,
      swept: swept.length,
      removed: replaced.results.map(({ removed }) => removed),
      // The first page, and the next from past its last start.
      pages: steps.filter((step) =>
        step.includes("workflow_start_receipts_due_idx")
      ).length,
      params: steps.some((step) =>
        step.includes("workflow_resource_params_values_kept_idx")
      ),
      scans: steps.filter((step) => fullScan.test(step)),
      sorts: steps.filter((step) => step.includes("TEMP B-TREE")),
    }).toStrictEqual({
      stats: [],
      swept: sweptPerBatch + 3,
      // The revision replaced, never the one in force.
      removed: [1, 0],
      pages: 2,
      params: true,
      scans: [],
      sorts: [],
    });
  });
});

describe("the bounds on runs of JSON workflows", () => {
  afterEach(endLiveResourceRuns);

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

  it("audits a stop the engine took, though it couldn't say where the run is after", async () => {
    const ada = await builder();
    const workflow = await waitingWorkflow(ada);
    const { runId } = await start(ada, workflow.id);
    // The engine's, its row running: stopped by the engine.
    await settledInEngine(runId);
    await vi.waitFor(
      async () => {
        await expect(runColumn(runId, "status")).resolves.toBe("running");
      },
      { timeout: 10_000, interval: 50 }
    );
    // The engine takes the terminate, then can't answer the lookup.
    const stopped = await whileEngineRefuses(
      (method) => method === "status",
      async () =>
        await outcome(terminateResourceRun(env, ada, workflow.id, runId))
    );
    await settledInEngine(runId);
    const audited = await runEvents(runId, "workflow.run.terminated");
    expect({
      stopped,
      inEngine: await engineStatus(runId),
      audited: audited.map(({ actor }) => actor),
    }).toMatchObject({
      stopped: "ok",
      inEngine: "terminated",
      audited: [{ type: "person", userId: ada.userId }],
    });
  });

  it("stops a run the engine refuses to terminate from the stop on: it runs nothing more, and ends cancelled with no repair", async () => {
    const ada = await builder();
    // Its wait is over well before a minute's repair would come.
    const workflow = await published(
      ada,
      definitionOf([{ id: "pause", type: "wait", for: "2 seconds" }])
    );
    const { runId } = await start(ada, workflow.id);
    await settledInEngine(runId);
    await vi.waitFor(
      async () => {
        await expect(runColumn(runId, "status")).resolves.toBe("running");
      },
      { timeout: 10_000, interval: 50 }
    );
    const stopped = await whileEngineRefuses(
      (method) => method === "terminate",
      async () =>
        await outcome(terminateResourceRun(env, ada, workflow.id, runId))
    );
    const meanwhile = await engineStatus(runId);
    // No repair of core's runs: the run's own object ends it.
    const run = await ended(ada, workflow.id, runId);
    // And past its wait again: it never comes back.
    await scheduler.wait(2500);
    const after = await resourceRunFor(env, ada, workflow.id, runId);
    const asked = await runEvents(runId, "workflow.run.stop_requested");
    const terminated = await runEvents(runId, "workflow.run.terminated");
    const cancelled = await runEvents(runId, "workflow.run.cancelled");
    expect({
      stopped,
      meanwhile,
      status: run.status,
      after: after.status,
      inEngine: await engineStatus(runId),
      completed: await runEvents(runId, "workflow.run.completed"),
      asked: asked.map(({ actor }) => actor),
      terminated: terminated.length,
      cancelled: cancelled.map(({ actor }) => actor),
    }).toStrictEqual({
      // Answered: the stop is the run's, whatever the engine said.
      stopped: "ok",
      meanwhile: "waiting",
      status: "cancelled",
      after: "cancelled",
      inEngine: "terminated",
      completed: [],
      // The stop audited as asked, under Ada, never as a termination
      // before anything terminated; the termination as it happened, when
      // the run's object ended it.
      asked: [{ type: "person", userId: ada.userId }],
      terminated: 0,
      cancelled: [{ type: "system" }],
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

  it("lists a workflow's runs newest first: every run to its builders, a user's own to them, none to anyone without a role, and never what one returned", async () => {
    const ada = await builder();
    const reader = await builder("user");
    const other = await builder("user");
    const outsider = await builder("user");
    const workflow = await published(ada, definitionOf([]));
    for (const person of [reader, other]) {
      // oxlint-disable-next-line no-await-in-loop -- one share after another
      await shareWorkflowResource(env, ada, workflow.id, {
        type: "person",
        id: person.userId,
        role: "user",
      });
    }
    const first = await start(reader, workflow.id);
    const second = await start(ada, workflow.id);
    const third = await start(reader, workflow.id);
    // Ended with an output, which the list never carries.
    await vi.waitFor(
      async () => {
        const run = await resourceRunFor(env, reader, workflow.id, third.runId);
        expect(run.output).toStrictEqual({ status: "done" });
      },
      { timeout: 30_000, interval: 100 }
    );
    const idsOf = async (by: Acting) => {
      const runs = await listResourceRuns(env, by, workflow.id);
      return runs.map(({ id }) => id);
    };
    const listed = await listResourceRuns(env, ada, workflow.id);

    expect({
      builder: listed.map(({ id }) => id),
      reader: await idsOf(reader),
      other: await idsOf(other),
      outsider: await outcome(listResourceRuns(env, outsider, workflow.id)),
      details: listed.some((run) => "output" in run || "error" in run),
    }).toStrictEqual({
      builder: [third.runId, second.runId, first.runId],
      reader: [third.runId, first.runId],
      other: [],
      outsider: "workflow.resource_unavailable",
      details: false,
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
    // A start that was on its way all along reaches the engine after, and
    // its instance fails on the ended row: the row's reason stands.
    await runEngine(env).createResource({
      id: runId ?? "",
      pinned: {
        workflow: workflowResourceIdSchema.parse(workflow.id),
        version: 1,
        manifest: String(await runColumn(runId, "manifest_hash")),
      },
      input: { who: "Ada" },
    });
    await settledInEngine(runId);
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
    const workflow = await published(by, definitionOf([]));
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

describe("whose word a run's row takes, and whose clock", () => {
  afterEach(endLiveResourceRuns);

  it("audits a control settled once, though a page and the engine settle it in the same millisecond", async () => {
    const by = await builder();
    const waiting = await waitingWorkflow(by);
    const { runId } = await start(by, waiting.id);
    // Asleep, its row running: nothing but the settlers moves its snapshot.
    await settledInEngine(runId);
    await vi.waitFor(
      async () => {
        await expect(runColumn(runId, "status")).resolves.toBe("running");
      },
      { timeout: 10_000, interval: 50 }
    );
    const app = crypto.randomUUID();
    const control = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Desk', '', ?, ?)"
      ).bind(app, by.userId, now),
      env.DB.prepare(
        "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, created_at, next_at, generation) VALUES (?, ?, ?, ?, ?, 'pause', 'admitted', ?, ?, 1)"
      ).bind(control, runId, app, by.userId, "0".repeat(32), now, now),
    ]);
    const row = await runOf(env, runId ?? "");
    if (row === undefined) {
      throw new Error("No run");
    }
    const revision = async (): Promise<unknown> =>
      await runColumn(runId, "summary_revision");
    const before = await revision();
    // Both settlers read the same clock: the page's apply and the
    // engine's notification, landing together.
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      await Promise.all([
        settleControl(
          env,
          row,
          { id: control, kind: "pause", principalId: by.userId },
          "applied"
        ),
        settleControl(
          env,
          row,
          { id: control, kind: "pause", principalId: by.userId },
          "applied"
        ),
      ]);
    } finally {
      vi.useRealTimers();
    }
    const settled = await env.DB.prepare(
      "SELECT state FROM workflow_resource_run_controls WHERE id = ?"
    )
      .bind(control)
      .first<{ state: string }>();
    const audited = await runEvents(runId, "workflow.run.control_applied");
    const after = await revision();
    expect({
      state: settled?.state,
      audited: audited.length,
      // The snapshot moved on once, by the settler that changed the row.
      revisions: Number(after) - Number(before),
    }).toStrictEqual({
      state: "applied",
      audited: 1,
      revisions: 1,
    });
  });

  it("shows what a run returned only within its retention", async () => {
    const by = await builder();
    const done = await published(by, definitionOf([]));
    const failing = await published(by, failingDefinition);
    const completed = await start(by, done.id);
    const failed = await start(by, failing.id);
    await ended(by, done.id, completed.runId);
    await ended(by, failing.id, failed.runId);
    // A day before their retention is over, and a day after: the engine
    // still holds both, as it purges an ended run on its own clock.
    const within = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 29 * 86_400_000);
    let kept: WorkflowResourceRun;
    try {
      kept = await resourceRunFor(env, by, done.id, completed.runId);
    } finally {
      within.mockRestore();
    }
    const later = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 31 * 86_400_000);
    let reads: WorkflowResourceRun[];
    try {
      reads = [
        // Past its retention, read with the engine unreachable: the row
        // alone says it all.
        await whileEngineRefuses(
          () => true,
          async () => await resourceRunFor(env, by, done.id, completed.runId)
        ),
        await resourceRunFor(env, by, failing.id, failed.runId),
        // The engine's record of it gone too, its retention over there: the
        // code the row kept as it failed.
        await aroundEngine(
          async (method, call) =>
            method === "status" ? undefined : await call(),
          async () => await resourceRunFor(env, by, failing.id, failed.runId)
        ),
        // Or unreachable: the row alone says it.
        await whileEngineRefuses(
          () => true,
          async () => await resourceRunFor(env, by, failing.id, failed.runId)
        ),
      ];
    } finally {
      later.mockRestore();
    }
    const [removed, removedFailure, purgedFailure, unreachable] = reads;
    expect({
      kept: kept.output,
      removed: removed?.output,
      failure: removedFailure?.error,
      purged: purgedFailure?.error,
      unreachable: unreachable?.error,
    }).toStrictEqual({
      kept: { status: "done" },
      removed: undefined,
      failure: { code: "expression.failed", message: removedText },
      purged: { code: "expression.failed", message: removedText },
      unreachable: { code: "expression.failed", message: removedText },
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
    const inEngine = await engineStatus(runId);
    // Its person reads it cancelled, nothing of what the late start did.
    const read = await resourceRunFor(env, by, workflow.id, runId);
    expect({
      status: stopped.status,
      inEngine,
      read: { status: read.status, error: read.error, output: read.output },
    }).toStrictEqual({
      status: "cancelled",
      inEngine: "errored",
      read: { status: "cancelled", error: undefined, output: undefined },
    });
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

  it("moves a run whose engine lookup fails back in the repair's queue, neither sent again nor counted, until it is abandoned", async () => {
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
    await repairWhileLookupsFail(at);
    const meanwhile = {
      attempts: await runColumn(id, "start_attempts"),
      nextAt: Number(await runColumn(id, "next_start_at")) > at,
      status: await runColumn(id, "status"),
    };
    // Six hours on, the engine still can't say: failed, never left starting.
    await repairWhileLookupsFail(createdAt + 7 * 3_600_000);
    // Its person reads why while the engine still can't answer.
    const read = await whileEngineRefuses(
      (method) => method === "status",
      async () => await resourceRunFor(env, by, workflow.id, id)
    );
    expect({
      meanwhile,
      status: await runColumn(id, "status"),
      code: await runColumn(id, "failure_code"),
      read: { status: read.status, code: read.error?.code },
    }).toStrictEqual({
      meanwhile: { attempts: 0, nextAt: true, status: "starting" },
      status: "failed",
      code: "workflow.start_unconfirmed",
      read: { status: "failed", code: "workflow.start_unconfirmed" },
    });
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
    const workflow = await published(by, definitionOf([]));
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
    const workflow = await published(by, definitionOf([]));
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
});

// The lineage quotas of runs of JSON workflows (workflows/quotas.ts), as an
// App's runs have them: each run is the root of its own lineage, and each
// of its steps' attempts is admitted against it and the client's shares of
// attempts running at once, then settled with what it used. The engine,
// the isolate, the host and core's database are real; the Loader's CPU
// kill is stood in for (cpu-kills.ts), as plain workerd enforces none.

/**
 * What `run` returns with the quota limits `limits` lowered; the
 * deployment's own again after.
 */
const withQuotas = async <Result>(
  limits: Record<string, number>,
  run: () => Promise<Result>
): Promise<Result> => {
  env.TEST_QUOTA_LIMITS = limits;
  try {
    return await run();
  } finally {
    env.TEST_QUOTA_LIMITS = configuredLimits;
  }
};

const lineageSchema = z.object({
  createdAt: z.number(),
  used: z.number(),
  held: z.number(),
  hostCalls: z.number(),
  descendants: z.number(),
});

/** Run `id`'s lineage counters, as core's database has them. */
const lineageOf = async (id: string | null) =>
  lineageSchema
    .optional()
    .parse(
      (await env.DB.prepare(
        "SELECT created_at AS createdAt, active_used_ms AS used, active_held_ms AS held, host_calls AS hostCalls, descendants FROM run_lineages WHERE root_run_id = ?"
      )
        .bind(id)
        .first()) ?? undefined
    );

const receiptSchema = z.object({
  key: z.string(),
  attempt: z.number(),
  root: z.string(),
  settled: z.number(),
  reserved: z.number(),
  used: z.number().nullable(),
  admittedAt: z.number(),
  deadline: z.number(),
  hostCalls: z.number(),
  resource: z.string(),
});

/** The receipts of run `id`'s attempts, in the order they were admitted. */
const receiptsOf = async (id: string | null) => {
  const { results } = await env.DB.prepare(
    "SELECT step_key AS key, attempt, root_run_id AS root, settled_at IS NOT NULL AS settled, reserved_ms AS reserved, used_ms AS used, admitted_at AS admittedAt, deadline, host_calls AS hostCalls, resource FROM run_lineage_attempts WHERE run_id = ? ORDER BY admitted_at, attempt"
  )
    .bind(id)
    .all();
  return z.array(receiptSchema).parse(results);
};

/** An attempt key's step: `<engine run>:do:<count>:<step>`. */
const keyStep = /^.*?:do:\d+:/u;

/** The step of attempt key `key`. */
const stepOfKey = (key: string): string => key.replace(keyStep, "");

/** How many times run `id` waited for load, as its journal has it. */
const loadWaitsOf = async (id: string | null): Promise<number> =>
  await runInDurableObject(
    runObject(id ?? ""),
    (_object, state) =>
      state.storage.sql
        .exec<{ waits: number }>(
          "SELECT count(*) AS waits FROM steps WHERE type IN ('sleep', 'waitForEvent') AND name LIKE '%:busy:%'"
        )
        .one().waits
  );

/** An `if` step `id` deciding on its input: one step, and no call. */
const deciding = (id: string) => ({
  id,
  type: "if",
  condition: { $expr: 'input.who !== ""' },
  // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
  then: [],
});

/**
 * Two steps, `greet` and `call`, each deciding its `if`, then the
 * greeting called out.
 */
const greetThenCall = definitionOf([deciding("greet"), deciding("call")], {
  value: { status: { $expr: 'params.greeting + ", " + input.who + "!"' } },
});

/**
 * A module, sealed as the generated one, whose step of task `finish`
 * never returns: its attempt holds what it was admitted with until the
 * engine fences it.
 */
const hangingModule = moduleOf(`
await step.do("finish", { key: "task", description: "finish" }, async () => await new Promise(() => {}));
return { status: "never" };`);

/** The receipt of run `id`'s attempt at `hangingModule`'s step. */
const heldBy = async (id: string | null) => {
  const receipts = await receiptsOf(id);
  return receipts.find(({ key }) => stepOfKey(key) === "finish:task");
};

/**
 * An attempt of run `run` of workflow `workflowId`'s, of activation
 * `generation`, admitted late: how its admission came out.
 */
const late = async (
  run: string | null,
  workflowId: string,
  generation: number
) =>
  await outcome(
    admitAttempt(
      env,
      {
        run: run ?? "",
        root: run ?? "",
        resource: `workflow-resource:${workflowId}`,
      },
      {
        key: `late:${unique()}`,
        number: 1,
        generation,
        deadline: Date.now() + 60_000,
      }
    )
  );

describe(
  "the lineage quotas of runs of JSON workflows",
  { timeout: 90_000 },
  () => {
    afterEach(endLiveResourceRuns);

    it("admits each attempt against the run's own lineage and its workflow's slots, settling it with what it used", async () => {
      const by = await builder();
      const workflow = await published(by, greetThenCall);
      // One attempt at once for the workflow: each step's attempt is
      // admitted only once the one before it settled and gave its share
      // back.
      const { runId, run } = await withQuotas(
        { workflowAppAttempts: 1 },
        async () => {
          const started = await start(by, workflow.id);
          return {
            runId: started.runId,
            run: await ended(by, workflow.id, started.runId),
          };
        }
      );
      const receipts = await receiptsOf(runId);
      const lineage = await lineageOf(runId);
      expect({
        status: run.status,
        output: run.output,
        waitedForLoad: await loadWaitsOf(runId),
        lineage: { ...lineage, used: undefined },
        startedWithRun:
          lineage?.createdAt === (await runColumn(runId, "created_at")),
        usedAsSettled:
          lineage?.used ===
          receipts.reduce((sum, { used }) => sum + (used ?? 0), 0),
        receipts: receipts.map(
          ({ key, attempt, root, settled, hostCalls, resource }) => ({
            step: stepOfKey(key),
            attempt,
            root,
            settled,
            hostCalls,
            resource,
          })
        ),
      }).toStrictEqual({
        status: "completed",
        output: { status: "Hello, Ada!" },
        waitedForLoad: 0,
        // Its expressions run in its isolate: none is a host call.
        lineage: {
          createdAt: lineage?.createdAt,
          used: undefined,
          held: 0,
          hostCalls: 0,
          descendants: 0,
        },
        startedWithRun: true,
        usedAsSettled: true,
        // Its parameters' step, each of its own, and its output's.
        receipts: ["$params", "greet:task", "call:task", "workflow:output"].map(
          (step) => ({
            step,
            attempt: 1,
            root: runId,
            settled: 1,
            hostCalls: 0,
            resource: `workflow-resource:${workflow.id}`,
          })
        ),
      });
    });

    it("fails a step stopped past its CPU time in every activation once three of its attempts ran, however many more the engine allows", async () => {
      const by = await builder();
      const workflow = await published(by, greetThenCall);
      const result = await withCpuKills(
        "greet:task",
        () => true,
        async () => {
          const { runId } = await start(by, workflow.id);
          const run = await ended(by, workflow.id, runId);
          return { run, runId };
        },
        "end"
      );
      const receipts = await receiptsOf(result.runId);
      expect({
        status: result.run.status,
        // Each that ran, in its own activation: the third is the last.
        ran: new Set(receipts.map(({ attempt }) => attempt)).size,
        settled: receipts.every(({ settled }) => settled === 1),
      }).toStrictEqual({
        status: "failed",
        ran: 3,
        settled: true,
      });
    });

    it("refuses every attempt of a lineage past its age, evaluating none of its expressions", async () => {
      const by = await builder();
      const workflow = await published(by, greetThenCall);
      const run = await withQuotas({ workflowAgeMs: 1 }, async () => {
        const { runId } = await start(by, workflow.id);
        return await ended(by, workflow.id, runId);
      });
      const lineage = await lineageOf(run.id);
      expect({
        status: run.status,
        code: run.error?.code,
        hostCalls: lineage?.hostCalls,
        receipts: await receiptsOf(run.id),
      }).toStrictEqual({
        status: "failed",
        code: "workflow.lineage_limit",
        hostCalls: 0,
        receipts: [],
      });
    });

    it("removes an ended run's attempt receipts with its start's details once its retention is over, keeping its lineage as it was", async () => {
      const by = await builder();
      const workflow = await published(by, greetThenCall);
      const { runId } = await start(by, workflow.id);
      const run = await ended(by, workflow.id, runId);
      const receipts = await receiptsOf(runId);
      const kept = {
        receipts: receipts.length,
        lineage: await lineageOf(runId),
      };
      // Past the run retention (30 days) since it ended.
      await sweepRunDetails(env, new Date(Date.now() + 31 * 86_400_000));
      const receipt = await env.DB.prepare(
        "SELECT input FROM workflow_start_receipts WHERE id = ?"
      )
        .bind(runId)
        .first<{ input: string | null }>();
      expect({
        // What the run was as the sweep reached it: ended, with receipts.
        before: { status: run.status, receipts: kept.receipts },
        after: {
          input: receipt?.input,
          receipts: await receiptsOf(runId),
          lineage: await lineageOf(runId),
        },
      }).toStrictEqual({
        before: { status: "completed", receipts: 4 },
        after: { input: null, receipts: [], lineage: kept.lineage },
      });
    });

    it("settles a receipt still held as the sweep removes it, charging the run's lineage up to its deadline", async () => {
      const by = await builder();
      const workflow = await published(by, greetThenCall);
      const { runId } = await start(by, workflow.id);
      await ended(by, workflow.id, runId);
      const before = await lineageOf(runId);
      // A last attempt that never returned, as a run's whose activation
      // died before its receipt settled: it holds what it reserved.
      const reserved = 5000;
      const admittedAt = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO run_lineage_attempts (run_id, step_key, attempt, generation, root_run_id, reserved_ms, deadline, admitted_at) VALUES (?, 'call:task', 9, 1, ?, ?, ?, ?)"
        ).bind(runId, runId, reserved, admittedAt + reserved, admittedAt),
        env.DB.prepare(
          "UPDATE run_lineages SET active_held_ms = active_held_ms + ? WHERE root_run_id = ?"
        ).bind(reserved, runId),
      ]);
      await sweepRunDetails(env, new Date(Date.now() + 31 * 86_400_000));
      expect({
        receipts: await receiptsOf(runId),
        lineage: await lineageOf(runId),
      }).toStrictEqual({
        receipts: [],
        lineage: before && {
          ...before,
          used: before.used + reserved,
          held: 0,
        },
      });
    });

    it("holds an attempt while every slot is taken, and runs it once a stopped run's attempt gives its slot back, charged up to its deadline", async () => {
      const by = await builder();
      const hanging = await published(by, definitionOf([passing("finish")]));
      await forgedModule(hanging.id, hangingModule);
      const workflow = await published(by, greetThenCall);
      const result = await withQuotas(
        { workflowClientAttempts: 1 },
        async () => {
          const holder = await start(by, hanging.id);
          // Its attempt holds the deployment's only slot.
          await vi.waitFor(
            async () => {
              await expect(heldBy(holder.runId)).resolves.toBeDefined();
            },
            { timeout: 30_000, interval: 100 }
          );
          const { runId } = await start(by, workflow.id);
          const { runId: stopped } = await start(by, workflow.id);
          await vi.waitFor(
            async () => {
              await expect(loadWaitsOf(runId)).resolves.toBeGreaterThan(0);
              await expect(loadWaitsOf(stopped)).resolves.toBeGreaterThan(0);
            },
            { timeout: 30_000, interval: 200 }
          );
          // One is stopped while it waits; then the holder is.
          await terminateResourceRun(env, by, workflow.id, stopped);
          await terminateResourceRun(env, by, hanging.id, holder.runId);
          const run = await ended(by, workflow.id, runId);
          const held = await vi.waitFor(
            async () => {
              const receipt = await heldBy(holder.runId);
              expect(receipt?.settled).toBe(1);
              return receipt;
            },
            { timeout: 30_000, interval: 100 }
          );
          return {
            run,
            held,
            holder: await lineageOf(holder.runId),
          };
        }
      );
      expect({
        status: result.run.status,
        output: result.run.output,
        chargedToDeadline:
          result.held?.used ===
          (result.held?.deadline ?? 0) - (result.held?.admittedAt ?? 0),
        holderHolds: result.holder?.held,
      }).toStrictEqual({
        status: "completed",
        output: { status: "Hello, Ada!" },
        chargedToDeadline: true,
        holderHolds: 0,
      });
    });

    it("admits no attempt of an activation the engine fenced, nor of a run that ended, however late it lands", async () => {
      const by = await builder();
      const waiting = await waitingWorkflow(by);
      const { runId: sleepingRun } = await start(by, waiting.id);
      // Its first activation is over once it sleeps: its object records the
      // fence as the engine notifies the run waiting.
      const fenced = await vi.waitFor(
        async () => {
          const row = await env.DB.prepare(
            "SELECT shares_fenced_through AS through FROM workflow_resource_runs WHERE id = ?"
          )
            .bind(sleepingRun)
            .first<{ through: number }>();
          expect(row?.through).toBeGreaterThan(0);
          return row?.through ?? 0;
        },
        { timeout: 30_000, interval: 100 }
      );
      const done = await published(by, greetThenCall);
      const { runId: endedRun } = await start(by, done.id);
      await ended(by, done.id, endedRun);
      expect({
        fencedActivation: await late(sleepingRun, waiting.id, fenced),
        newerActivation: await late(sleepingRun, waiting.id, fenced + 1),
        endedRun: await late(endedRun, done.id, 100),
      }).toStrictEqual({
        fencedActivation: "execution.stale_attempt",
        newerActivation: "ok",
        endedRun: "execution.stale_attempt",
      });
    });

    it("fails a task that answers a value shaped as core's wait for load, rather than wait on it", async () => {
      const by = await builder();
      const workflow = await published(by, definitionOf([passing("finish")]));
      await forgedModule(
        workflow.id,
        moduleOf(
          'return await step.do("finish", { key: "task", description: "finish" }, async () => ({ "$grasp:busy": 1, "$grasp:busyMaxMs": 86400000 }));'
        )
      );
      const { runId } = await start(by, workflow.id);
      const run = await ended(by, workflow.id, runId);
      expect({
        status: run.status,
        waits: await loadWaitsOf(runId),
      }).toStrictEqual({
        status: "failed",
        waits: 0,
      });
    });

    it("keeps a lineage, and an attempt's receipt, to a run core has", async () => {
      const by = await builder();
      const workflow = await published(by, greetThenCall);
      const { runId } = await start(by, workflow.id);
      await ended(by, workflow.id, runId);
      const nobody = crypto.randomUUID();
      const lineageOfNobody = await outcome(
        env.DB.prepare(
          "INSERT INTO run_lineages (root_run_id, created_at) VALUES (?, ?)"
        )
          .bind(nobody, Date.now())
          .run()
      );
      const receiptOfNobody = await outcome(
        env.DB.prepare(
          "INSERT INTO run_lineage_attempts (run_id, step_key, attempt, generation, root_run_id, reserved_ms, deadline, admitted_at) VALUES (?, 'k', 1, 1, ?, 0, 0, 0)"
        )
          .bind(nobody, runId)
          .run()
      );
      const moved = await outcome(
        env.DB.prepare(
          "UPDATE run_lineage_attempts SET run_id = ? WHERE run_id = ?"
        )
          .bind(nobody, runId)
          .run()
      );
      const rooted = await outcome(
        env.DB.prepare(
          "UPDATE run_lineages SET root_run_id = ? WHERE root_run_id = ?"
        )
          .bind(nobody, runId)
          .run()
      );
      expect({
        lineageOfNobody: lineageOfNobody.includes(
          "run_lineages are of runs core has"
        ),
        receiptOfNobody: receiptOfNobody.includes(
          "run_lineage_attempts are of runs core has"
        ),
        moved: moved.includes("an attempt keeps its run"),
        rooted: rooted.includes("a run lineage keeps its root"),
      }).toStrictEqual({
        lineageOfNobody: true,
        receiptOfNobody: true,
        moved: true,
        rooted: true,
      });
    });
  }
);
