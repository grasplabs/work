import { expectedMessageOf } from "@grasp-os/shared/errors";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { terminateResourceRun } from "../src/workflows/resource-runs.ts";
import { WorkflowRuns } from "../src/workflows/run-object.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdpWith } from "./idp.ts";
import { endLiveResourceRuns, pageOf, settles } from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
import {
  boundApp,
  idp,
  pageRuns,
  refusalOf,
} from "./page-typed-workflows-harness.ts";
import { gate, heldEnd, rollingBackRun, withRollbacks } from "./rollbacks.ts";
import { runInstance, sleeping, woken } from "./runs.ts";
import { auditedDuring } from "./sign-in.ts";

// A page's typed `useWorkflow` through the real host (spec 10.4,
// page-workflows.ts; the threat model is on GRA-626): its starts and
// controls as calls of the workflow reference's mutations, relayed over
// core's function route, and its run and whether it may start one as the
// reference's `run` and `canStart` queries, followed live through the
// frame's own capability (`pages.frame`), each answer and push checked by
// the descriptors the SDK generates.

mockIdpWith(idp);

/**
 * A run of the Requests App's `followUp`, its next activation the
 * test's (`compensated`), followed through its compensation: what the
 * page saw while the engine rolled it back, and as it ended.
 */
const compensatedRun = async (
  compensated: Omit<Parameters<typeof rollingBackRun>[1], "holds" | "held">,
  end?: (runId: string) => Promise<void>,
  /** What is asked of it while it compensates: answered as `during`. */
  meanwhile?: (asked: {
    channel: ReturnType<typeof pageRuns>;
    runId: string;
    builder: Person;
    workflow: string;
  }) => Promise<unknown>
) => {
  const { builder, app, reference, workflow } = await boundApp({
    hold: "1 hour",
  });
  const lease = await pageOf(builder, app);
  const channel = pageRuns(builder, app, lease, reference);
  const handle = await channel.start({ who: "Ada" });
  await sleeping(handle.runId, "hold:task");
  const holds = gate();
  rollingBackRun(handle.runId, {
    ...compensated,
    holds,
    // Its `hold` task's hour.
    held: { name: "hold:task", ms: 3_600_000 },
  });
  const stop = channel.followRun(handle.runId, () => {
    // Read below.
  });
  await woken(handle.runId, "hold:task");
  await end?.(handle.runId);
  await vi.waitFor(() => {
    expect(channel.peekRun(handle.runId).value?.status).toBe("compensating");
  }, settles);
  const compensating = channel.peekRun(handle.runId);
  const during = await meanwhile?.({
    channel,
    runId: handle.runId,
    builder,
    workflow,
  });
  holds.open();
  await vi.waitFor(() => {
    expect(channel.peekRun(handle.runId).value?.finishedAt).not.toBeNull();
  }, settles);
  const ended = channel.peekRun(handle.runId);
  stop();
  return {
    during,
    compensating: {
      status: compensating.value?.status,
      compensation: compensating.value?.compensation,
      finishedAt: compensating.value?.finishedAt,
      canCancel: compensating.value?.control.canCancel,
      canPause: compensating.value?.control.canPause,
    },
    ended: {
      status: ended.value?.status,
      error: ended.value?.error?.code,
    },
  };
};

// A run whose engine rolls its steps back (spec 10.7.3), on the real
// engine with a test's definition (rollbacks.ts): no definition Grasp
// builds registers a rollback yet (GRA-984).
describe(
  "a page's typed workflow run while it compensates",
  { timeout: 120_000 },
  () => {
    afterEach(endLiveResourceRuns);

    withRollbacks();

    it("shows a failed run compensating with what it failed with, then failed with that once its compensation is done", async () => {
      await expect(
        compensatedRun({ ends: { fails: "permission.declined" } })
      ).resolves.toStrictEqual({
        during: undefined,
        compensating: {
          status: "compensating",
          compensation: {
            cause: "failure",
            activity: "running",
            originalError: {
              code: "permission.declined",
              message: expectedMessageOf("permission.declined"),
              category: "domain",
              retryable: false,
              requestId: null,
            },
          },
          // Not ended while its compensation runs.
          finishedAt: null,
          canCancel: false,
          canPause: false,
        },
        ended: { status: "failed", error: "permission.declined" },
      });
    });

    it("ends a run whose compensation failed as workflow.compensation_failed", async () => {
      const shown = await compensatedRun({
        ends: { fails: "permission.declined" },
        rollbackFails: true,
      });
      expect(shown.ended).toStrictEqual({
        status: "failed",
        error: "workflow.compensation_failed",
      });
    });

    it("shows a run cancelled with a rollback compensating for its cancellation, then cancelled", async () => {
      const shown = await compensatedRun({ ends: "sleeps" }, async (runId) => {
        await sleeping(runId, "after-charge");
        await runInstance(runId).terminate({ rollback: true });
      });
      expect({
        compensation: shown.compensating.compensation,
        ended: shown.ended,
      }).toStrictEqual({
        compensation: { cause: "cancellation", activity: "running" },
        ended: { status: "cancelled", error: undefined },
      });
    });

    it("ends a cancelled run whose compensation failed as workflow.compensation_failed, though a stop comes before its end is told", async () => {
      const { builder, app, reference, workflow } = await boundApp({
        hold: "1 hour",
      });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const { runId } = await channel.start({ who: "Ada" });
      await sleeping(runId, "hold:task");
      const holds = gate();
      rollingBackRun(runId, {
        ends: "sleeps",
        rollbackFails: true,
        holds,
        held: { name: "hold:task", ms: 3_600_000 },
      });
      await woken(runId, "hold:task");
      await sleeping(runId, "after-charge");
      const release = heldEnd(runId);
      await runInstance(runId).terminate({ rollback: true });
      holds.open();
      // Ended in the engine, its refund failed; core not told of it yet.
      await vi.waitFor(async () => {
        await expect(runInstance(runId).status()).resolves.toMatchObject({
          status: "terminated",
          rollback: { status: "errored" },
        });
      }, settles);
      const rowOf = async () =>
        await env.DB.prepare(
          "SELECT status, failure_code AS failureCode FROM workflow_resource_runs WHERE id = ?"
        )
          .bind(runId)
          .first<{ status: string; failureCode: string | null }>();
      const before = await rowOf();
      await terminateResourceRun(env, builder.acting, workflow, runId);
      const stopped = await rowOf();
      release();
      expect({ before: before?.status, stopped }).toStrictEqual({
        before: "running",
        // Ended as the engine has it: an ended row never changes again,
        // so the late end can't put a failed compensation right.
        stopped: {
          status: "failed",
          failureCode: "workflow.compensation_failed",
        },
      });
    });

    it("audits a cancel admitted just before its run began to compensate as nothing terminated, and notes no stop", async () => {
      let seen:
        | {
            answered: { kind: string; state: string } | undefined;
            terminated: number;
            runId: string;
          }
        | undefined;
      const shown = await compensatedRun(
        { ends: { fails: "permission.declined" } },
        undefined,
        async ({ channel, runId }) => {
          // The engine's word is lost as the cancel is admitted, as when
          // its rollback began right after: the cancel goes ahead, and the
          // engine answers that it rolls back.
          const spy = vi
            .spyOn(WorkflowRuns.prototype, "status")
            .mockImplementationOnce(() => {
              throw new Error("The engine couldn't say");
            });
          let answered: { kind: string; state: string } | undefined;
          const events = await auditedDuring(async () => {
            const { kind, state } = await channel.control(
              runId,
              "cancel",
              () => {
                // Never recovering.
              }
            );
            answered = { kind, state };
          });
          spy.mockRestore();
          seen = {
            answered,
            terminated: events.filter(
              ({ action }) => action === "workflow.run.terminated"
            ).length,
            runId,
          };
        }
      );
      const runId = seen?.runId ?? "";
      const receipt = await env.DB.prepare(
        "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
      )
        .bind(runId)
        .first<string>("state");
      const events = await allEvents();
      const terminated = events.filter(
        ({ action, target }) =>
          action === "workflow.run.terminated" && target?.id === runId
      ).length;
      expect({
        during: {
          answered: seen?.answered,
          terminated: seen?.terminated,
        },
        ended: shown.ended,
        receipt,
        terminated,
      }).toStrictEqual({
        // Admitted, its stop not taken: nothing recorded as terminated.
        during: {
          answered: { kind: "cancel", state: "admitted" },
          terminated: 0,
        },
        // Its compensation ran to its end, never cut short.
        ended: { status: "failed", error: "permission.declined" },
        // Settled by the run's end, which no stop of its brought about.
        receipt: "superseded",
        terminated: 0,
      });
    });

    it("refuses a cancel or a stop while a run compensates, with no receipt and nothing audited as terminated", async () => {
      const shown = await compensatedRun(
        { ends: { fails: "permission.declined" } },
        undefined,
        async ({ channel, runId, builder, workflow }) => {
          let cancel: unknown;
          let stop: unknown;
          const events = await auditedDuring(async () => {
            cancel = await refusalOf(
              channel.control(runId, "cancel", () => {
                // Never recovering.
              })
            );
            stop = await refusalOf(
              terminateResourceRun(env, builder.acting, workflow, runId)
            );
          });
          const receipts = await env.DB.prepare(
            "SELECT count(*) AS n FROM workflow_resource_run_controls WHERE run_id = ?"
          )
            .bind(runId)
            .first<{ n: number }>();
          return {
            cancel,
            stop,
            receipts: receipts?.n,
            terminated: events.filter(
              ({ action }) => action === "workflow.run.terminated"
            ).length,
          };
        }
      );
      expect({ during: shown.during, ended: shown.ended }).toStrictEqual({
        during: {
          // The engine's own word that it rolls back, as every control's.
          cancel: "workflow.control_rolling_back",
          stop: "workflow.control_refused",
          receipts: 0,
          terminated: 0,
        },
        // Its compensation ran to its end, its failure as it failed.
        ended: { status: "failed", error: "permission.declined" },
      });
    });
  }
);
