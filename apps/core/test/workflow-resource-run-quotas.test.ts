import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { terminateResourceRun } from "../src/workflows/resource-runs.ts";
import { sweepRunDetails } from "../src/workflows/retention.ts";
import { withCpuKills } from "./cpu-kills.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { moduleOf } from "./sealed-run-harness.ts";
import { outcome } from "./sign-in.ts";
import {
  builder,
  deciding,
  definitionOf,
  published,
  forgedModule,
  start,
  ended,
  runColumn,
  waitingWorkflow,
  withQuotas,
  lineageOf,
  receiptsOf,
  stepOfKey,
  loadWaitsOf,
  greetThenCall,
  hangingModule,
  heldBy,
  late,
} from "./workflow-resource-runs-harness.ts";

// Runs of independent workflows (workflows/resource-runs.ts and
// sealed-run.ts), from their threat model: a start's receipt admits a
// run of exactly the version's sealed build, which runs with the
// parameters the start froze, carries the definition's text only as
// data, refuses a build that isn't the one it was admitted for, and
// keeps its workflow from being deleted until it ends.
//
// Here: the lineage quotas of runs; the rest in the other
// workflow-resource-run*.test.ts files.

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
        receipts: [
          "$params",
          "greet:enter",
          "call:enter",
          "workflow:output",
        ].map((step) => ({
          step,
          attempt: 1,
          root: runId,
          settled: 1,
          hostCalls: 0,
          resource: `workflow-resource:${workflow.id}`,
        })),
      });
    });

    it("fails a step stopped past its CPU time in every activation once three of its attempts ran, however many more the engine allows", async () => {
      const by = await builder();
      const workflow = await published(by, greetThenCall);
      const result = await withCpuKills(
        "greet:enter",
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
          "INSERT INTO run_lineage_attempts (run_id, step_key, attempt, generation, root_run_id, reserved_ms, deadline, admitted_at) VALUES (?, 'call:enter', 9, 1, ?, ?, ?, ?)"
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
      const hanging = await published(by, definitionOf([deciding("finish")]));
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
      const workflow = await published(by, definitionOf([deciding("finish")]));
      await forgedModule(
        workflow.id,
        moduleOf(
          'return await step.do("finish", { key: "enter", description: "finish" }, async () => ({ "$grasp:busy": 1, "$grasp:busyMaxMs": 86400000 }));'
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
