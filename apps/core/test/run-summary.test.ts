/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { expectedMessageOf } from "@grasp-os/shared/errors";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

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
      hold: "PT1H",
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
    const paused = await run.once(({ status }) => status === "paused");
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
      // Fails on its input, which it reads: "Ada" isn't a number.
      definition: (name) =>
        definitionOf(name, [
          {
            greet: {
              set: { status: "${ $workflow.input.who | tonumber | tostring }" },
            },
          },
        ]),
    });
    const lease = await screenOf(builder, app);
    const { runId } = startedOf(
      await called(builder, app, lease, startCommand(reference))
    );
    const within = await followedRun(builder, app, lease, reference, runId);
    const failed = await within.once(({ status }) => status === "failed");
    await within.release();
    // Its details removed, as the retention sweep removes them.
    await env.DB.prepare(
      "UPDATE workflow_start_receipts SET details_removed_at = ?, input = NULL, params = NULL WHERE id = ?"
    )
      .bind(Date.now(), runId)
      .run();
    const past = await followedRun(builder, app, lease, reference, runId);
    const removed = await past.once(({ status }) => status === "failed");
    await past.release();
    const { error } = await runFor(builder.acting, workflow, runId);
    const platform = {
      code: "expression.failed",
      message: expectedMessageOf("expression.failed"),
    };

    expect({
      within: failed.error,
      removed: removed.error,
      run: error?.code,
      leaks: JSON.stringify(removed).includes("Ada"),
    }).toStrictEqual({
      within: platform,
      removed: platform,
      run: "expression.failed",
      leaks: false,
    });
  });
});
