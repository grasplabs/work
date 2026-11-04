import { expectedMessageOf } from "@grasp-os/shared/errors";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { removedText, sweepRunDetails } from "../src/workflows/retention.ts";
import { mockIdp } from "./idp.ts";
import {
  called,
  controlCommand,
  definitionOf,
  following,
  jsonWorkflowAppsOf,
  runFor,
  screenOf,
  settles,
  startCommand,
  startedOf,
  wireOf,
} from "./json-workflow-apps.ts";
import type { Person, WorkflowReference } from "./json-workflow-apps.ts";

// A JSON workflow run's snapshot, as the App's screen that started it
// follows it (screen-workflows.ts `runSnapshot`): one read of one moment
// of the run, under a revision every change moves on. What could go wrong,
// tried below: what the run waits for lost while it is paused, a change
// that leaves the revision as it was, an ended run still offering
// controls, when it started and ended missing or out of order, the
// snapshot naming another run or version than the one started, and a
// failed run past its retention saying something else of why than the run
// itself, or anything of what it read. Waits, controls, pending controls,
// failures within retention, who sees a run and another App's runs are
// covered in screen-typed-workflows.test.ts.

const idp = mockIdp();

const { boundApp } = jsonWorkflowAppsOf(idp);

/** A day past a run's retention (30 days), in milliseconds. */
const pastRetention = 31 * 24 * 60 * 60 * 1000;

/** A run's snapshot, as much of it as the tests here read. */
const snapshotSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  workflowVersion: z.number(),
  status: z.string(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  waits: z.array(z.looseObject({ kind: z.string(), key: z.string() })),
  control: z.object({
    canPause: z.boolean(),
    canResume: z.boolean(),
    canCancel: z.boolean(),
    pendingControl: z.unknown(),
  }),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

type Snapshot = z.infer<typeof snapshotSchema> & { revision: number };

/** Follows run `runId` on `person`'s screen: each snapshot it was shown. */
const followedRun = async (
  person: Person,
  app: string,
  lease: string,
  reference: WorkflowReference,
  runId: string
) => {
  const followed = await following(person, app, lease, {
    workflow: wireOf(reference),
    watch: "run",
    runId,
  });
  const shown = (): Snapshot[] =>
    followed.received.flatMap(({ revision, outcome }) => {
      const parsed = snapshotSchema.safeParse(outcome);
      return parsed.success ? [{ ...parsed.data, revision }] : [];
    });
  /** The latest snapshot once `holds` says so of it. */
  const once = async (holds: (snapshot: Snapshot) => boolean) =>
    await vi.waitFor(() => {
      const latest = shown().at(-1);
      if (latest === undefined || !holds(latest)) {
        throw new Error(`The run is ${latest?.status ?? "unseen"}`);
      }
      return latest;
    }, settles);
  return {
    once,
    release: async () => {
      await followed.subscription.release();
    },
  };
};

/** What a snapshot says, without its times, IDs and revision. */
const shape = ({ status, waits, control }: Snapshot) => ({
  status,
  waits: waits.map(({ kind, key }) => ({ kind, key })),
  control,
});

const none = {
  canPause: false,
  canResume: false,
  canCancel: false,
  pendingControl: null,
};

describe("a JSON workflow run's snapshot", { timeout: 120_000 }, () => {
  it("says where a run is, what it waits for and when it started and ended, its sleep kept while paused, each change at a newer revision", async () => {
    const { builder, app, workflow, reference } = await boundApp({
      hold: "1 hour",
    });
    const lease = await screenOf(builder, app);
    const { runId } = startedOf(
      await called(builder, app, lease, startCommand(reference))
    );
    const run = await followedRun(builder, app, lease, reference, runId);
    const asleep = await run.once(
      ({ status, waits }) => status === "running" && waits.length === 1
    );
    await called(
      builder,
      app,
      lease,
      controlCommand(reference, "pause", runId)
    );
    // Paused once its pause has settled. The row says paused as the
    // engine's notification is projected; the pause is settled by
    // whichever of the screen's request or that notification first reads
    // from the engine that it took the pause (resource-runs.ts,
    // `settleResourceControls`), in a write of its own, so a snapshot may
    // show the run paused with its pause still applying.
    const paused = await run.once(
      ({ status, control }) =>
        status === "paused" && control.pendingControl === null
    );
    await called(
      builder,
      app,
      lease,
      controlCommand(reference, "cancel", runId)
    );
    const ended = await run.once(({ status }) => status === "cancelled");
    await run.release();

    expect({
      asleep: shape(asleep),
      paused: shape(paused),
      ended: shape(ended),
      newer:
        paused.revision > asleep.revision && ended.revision > paused.revision,
      started: asleep.startedAt !== null && asleep.finishedAt === null,
      finished:
        ended.finishedAt !== null &&
        ended.finishedAt >= (ended.startedAt ?? Infinity),
      identity: [asleep, ended].map(
        ({ runId: id, workflowId, workflowVersion }) => ({
          runId: id,
          workflowId,
          workflowVersion,
        })
      ),
    }).toStrictEqual({
      asleep: {
        status: "running",
        waits: [{ kind: "timer", key: "hold" }],
        control: {
          canPause: true,
          canResume: false,
          canCancel: true,
          pendingControl: null,
        },
      },
      // Pausing keeps what it waits for.
      paused: {
        status: "paused",
        waits: [{ kind: "timer", key: "hold" }],
        control: {
          canPause: false,
          canResume: true,
          canCancel: true,
          pendingControl: null,
        },
      },
      ended: { status: "cancelled", waits: [], control: none },
      newer: true,
      started: true,
      finished: true,
      identity: [
        { runId, workflowId: workflow, workflowVersion: 1 },
        { runId, workflowId: workflow, workflowVersion: 1 },
      ],
    });
  });

  it("says why a failed run failed past its retention as the run itself does, in the platform's words, never what it read", async () => {
    const { builder, app, workflow, reference } = await boundApp({
      // Fails on its input, which it reads: a text has no `toFixed`.
      definition: () =>
        definitionOf([], { status: { $expr: "input.who.toFixed(0)" } }),
    });
    const lease = await screenOf(builder, app);
    const { runId } = startedOf(
      await called(builder, app, lease, startCommand(reference))
    );
    const within = await followedRun(builder, app, lease, reference, runId);
    const failed = await within.once(({ status }) => status === "failed");
    await within.release();
    // The retention sweep, a day past the run's retention, removes its
    // details; read after at the real time, only the sweep's mark says so.
    await sweepRunDetails(env, new Date(Date.now() + pastRetention));
    const swept = await env.DB.prepare(
      "SELECT details_removed_at FROM workflow_start_receipts WHERE id = ?"
    )
      .bind(runId)
      .first<{ details_removed_at: number | null }>();
    const past = await followedRun(builder, app, lease, reference, runId);
    const removed = await past.once(({ status }) => status === "failed");
    await past.release();
    const run = await runFor(builder, workflow, runId);
    const platform = {
      code: "expression.failed",
      message: expectedMessageOf("expression.failed"),
    };

    expect({
      swept: swept?.details_removed_at !== null,
      within: failed.error,
      removed: removed.error,
      // The run read in full says why with the code its row kept, and that
      // its words are gone; the snapshot says the same code, in the
      // platform's own words, as it always does (`failureOf`).
      run: run.error,
      leaks: JSON.stringify(removed).includes("Ada"),
    }).toStrictEqual({
      swept: true,
      within: platform,
      removed: { code: run.error?.code, message: platform.message },
      run: { code: "expression.failed", message: removedText },
      leaks: false,
    });
  });
});
