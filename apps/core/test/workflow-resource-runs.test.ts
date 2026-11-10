import type { EndedRuns } from "@grasp-os/shared/connect";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { generatedModule } from "../src/workflow-builds.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import { deleteWorkflowResource } from "../src/workflow-resources.ts";
import { runRetentionDays } from "../src/workflows/engine.ts";
import {
  sweepRunDetails,
  sweptPerBatch,
  sweepWorkflowStartDetails,
} from "../src/workflows/retention.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { artifactKey } from "./sealed-apps.ts";
import { moduleOf } from "./sealed-run-harness.ts";
import { outcome, unique } from "./sign-in.ts";
import {
  builder,
  definitionOf,
  greeting,
  waitingDefinition,
  failingDefinition,
  published,
  forgedModule,
  start,
  ended,
  waitingWorkflow,
  yearAgo,
  oldStarts,
  startsSwept,
} from "./workflow-resource-runs-harness.ts";

// Runs of independent workflows (workflows/resource-runs.ts and
// sealed-run.ts), from their threat model: a start's receipt admits a
// run of exactly the version's sealed build, which runs with the
// parameters the start froze, carries the definition's text only as
// data, refuses a build that isn't the one it was admitted for, and
// keeps its workflow from being deleted until it ends.
//
// Here: runs and the retention of what their starts kept; their bounds in
// workflow-resource-run-bounds.test.ts, whose word and clock a run's row
// takes in workflow-resource-run-clock.test.ts, lineage quotas in
// workflow-resource-run-quotas.test.ts.

describe("runs of JSON workflows", () => {
  afterEach(endLiveResourceRuns);

  it("ends with its output as the output schema takes it, defaults filled in", async () => {
    const by = await builder();
    const workflow = await published(
      by,
      // `note` is optional, with a default.
      definitionOf([], {
        output: {
          status: { kind: "string" },
          note: { kind: "string", default: "none" },
        },
      })
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
          status: { kind: "string" },
          texts: { kind: "array", item: { kind: "string" } },
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
      await artifactKey(compiled?.sha256 ?? ""),
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
