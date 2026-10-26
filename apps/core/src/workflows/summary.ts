import { appErrors } from "@grasp-os/shared/apps";
import { runIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { reviewedTaskOf, workflowErrors } from "@grasp-os/shared/workflows";
import type { RunSummary, WorkflowCalls } from "@grasp-os/shared/workflows";
import type { InstanceStatus } from "@grasp-os/workerflow/contracts";
import { z } from "zod";

import { requireAppRole } from "../app-access.ts";
import { findApp } from "../apps.ts";
import { queueLiveMs } from "./admission.ts";
import { detailsRemoved, removedText } from "./retention.ts";

// A run's summary, as an App's screens observe it (spec 10.4.1, 10.4.5,
// 10.4.7, 10.7.3): its status, who it is, its times, the decisions it
// waits for, a compensation's cause and activity, and what the person
// asking may do with it now. Read in one statement, so every field is of
// one revision of the run: each write that changes any of them (the
// engine's status, core's projection, a control's admission or
// settlement, a decision opened, answered or closed) takes the run's next
// `summary_revision` in its own transaction. The summary shows that
// revision, so a reader can tell a newer snapshot from an older one.
//
// What a person may do (`can*`) is derived here, from the App role the
// host checks every control by (controls.ts: its builders), the engine's
// phase and the control still unresolved: never stored, and never more
// than the host would admit. During a compensation nothing may be paused,
// resumed or cancelled from an App.
//
// A run whose step waits in the client's queue for a share of the
// attempts running at once shows as `queued`, with the share and when it
// asks again (admission.ts): each time it joins, asks again or leaves the
// queue its revision moves on. One whose step stopped asking (its
// activation died while it waited) stops showing queued once its place
// lapses, a minute and a half on, before anything writes its row: the next
// admission that drops the place moves its revision on. A run whose step's
// model call waits for a share of the model requests in flight shows the
// same way (model-waits.ts).

/** What the one read of a run's summary returns. */
const rowSchema = z.object({
  id: z.string(),
  workflow_id: z.string(),
  version: z.number(),
  status: z.enum([
    "starting",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]),
  engine_status: z.string().nullable(),
  created_at: z.number(),
  started_at: z.number().nullable(),
  ended_at: z.number().nullable(),
  cancel_requested_at: z.number().nullable(),
  failure: z.string().nullable(),
  started_by: z.string().nullable(),
  details_removed_at: z.number().nullable(),
  summary_revision: z.number(),
  waits: z.string(),
  workflow_calls: z.string().nullable(),
  pending: z.enum(["pause", "resume", "cancel"]).nullable(),
  queued: z.string().nullable(),
});

/** A step of the run waiting in the client's queue (admission.ts). */
const queuedSchema = z.object({
  waitingFor: z.enum(["client", "person", "app"]),
  retryAt: z.number(),
});

const waitsSchema = z.array(
  z.object({ name: z.string(), expiresAt: z.number() })
);

/** What a version's row keeps of each workflow's review. */
const keptCallsSchema = z.record(
  z.string(),
  z.object({
    steps: z.record(z.string(), z.array(z.string())).nullable(),
    kinds: z.record(z.string(), z.enum(["exact", "ai", "decision", "wait"])),
    // Only for naming its steps, which neither changes: a row without them
    // names its steps all the same.
    models: z.record(z.string(), z.array(z.string())).default({}),
    keyed: z.array(z.string()).default([]),
    all: z.array(z.string()),
  })
);

/**
 * What the review of the run's version shows of workflow `workflow`, from
 * the row's text; none when it keeps none.
 */
const calls = (
  text: string | null,
  workflow: string
): WorkflowCalls | undefined => {
  if (text === null) {
    return undefined;
  }
  const kept = keptCallsSchema.safeParse(JSON.parse(text)).data;
  return kept !== undefined && Object.hasOwn(kept, workflow)
    ? kept[workflow]
    : undefined;
};

/**
 * The run's status as the summary shows it: `queued` while it is starting,
 * or while a step of a running run waits in the client's queue for a
 * share of the attempts running at once (`queued`).
 */
const statusOf = (
  status: z.infer<typeof rowSchema>["status"],
  engine: InstanceStatus["status"] | undefined,
  queued: boolean
): RunSummary["status"] => {
  switch (status) {
    case "starting": {
      return "queued";
    }
    case "paused":
    case "completed":
    case "failed":
    case "cancelled": {
      return status;
    }
    case "running": {
      if (engine === "rollingBack") {
        return "compensating";
      }
      if (queued) {
        return "queued";
      }
      if (engine === "queued" || engine === "waiting") {
        return engine;
      }
      return "running";
    }
    default: {
      return status satisfies never;
    }
  }
};

/** What a failed run's report gives its summary: its code and message. */
const failureSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const errorOf = (failure: string | null): RunSummary["error"] => {
  if (failure === null) {
    return undefined;
  }
  try {
    return failureSchema.safeParse(JSON.parse(failure)).data?.error;
  } catch {
    return undefined;
  }
};

const ended: ReadonlySet<RunSummary["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * What a person with the App role `role` may do with the run now, as the
 * host would admit it (controls.ts), and the control still applying.
 */
const controlOf = (
  role: "builder" | "user",
  status: RunSummary["status"],
  row: z.infer<typeof rowSchema>
): RunSummary["control"] => {
  // Nothing may be asked of a run that has ended, that compensates (what
  // undoes its effects isn't cut short from an App), or beside a cancel.
  const steady =
    role === "builder" &&
    !ended.has(status) &&
    status !== "compensating" &&
    row.cancel_requested_at === null;
  return {
    canPause: steady && status !== "paused" && row.pending === null,
    canResume: steady && status === "paused" && row.pending === null,
    canCancel: steady && row.pending !== "cancel",
    pendingControl:
      row.pending === null ? null : { kind: row.pending, stage: "applying" },
  };
};

const engineStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused",
  "rollingBack",
  "complete",
  "errored",
  "terminated",
]);

/**
 * The summary of `app`'s run `run`, as `by` (anyone with a role in the
 * App) may see it: a failed run's error only for its person and admins;
 * another App's run is `workflow.run_not_found`.
 */
export const runSummary = async (
  env: Env,
  by: Identity,
  app: unknown,
  run: unknown
): Promise<RunSummary> => {
  const found = await findApp(env, app);
  if (found === undefined) {
    throw appErrors.create("app.not_found");
  }
  const role = await requireAppRole(env, by, found, "user");
  const id = runIdSchema.safeParse(run);
  if (!id.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  const read = await env.DB.prepare(
    `SELECT r.id, r.workflow_id, r.version, r.status, r.engine_status,
       r.created_at, r.started_at, r.ended_at, r.cancel_requested_at,
       r.failure, r.started_by, r.details_removed_at, r.summary_revision,
       (SELECT json_group_array(json_object('name', d.step, 'expiresAt', d.expires_at))
          FROM workflow_decisions d
          WHERE d.run_id = r.id AND d.status = 'open') AS waits,
       (SELECT v.workflow_calls FROM app_versions v
          WHERE v.app_id = r.app_id AND v.version = r.version) AS workflow_calls,
       (SELECT c.kind FROM workflow_run_controls c
          WHERE c.run_id = r.id AND c.state = 'admitted'
          ORDER BY CASE c.kind WHEN 'cancel' THEN 0 ELSE 1 END
          LIMIT 1) AS pending,
       (SELECT json_object('waitingFor', q.waiting_for, 'retryAt', q.retry_at)
          FROM (
            SELECT p.waiting_for, p.retry_at FROM workflow_admission_queue p
              WHERE p.run_id = r.id AND p.seen_at > ?1
            UNION ALL
            SELECT m.waiting_for, m.retry_at FROM workflow_model_waits m
              WHERE m.run_id = r.id AND m.seen_at > ?1
                AND m.waiting_for IS NOT NULL
          ) q
          ORDER BY q.retry_at
          LIMIT 1) AS queued
     FROM workflow_runs r
     WHERE r.id = ?2 AND r.app_id = ?3`
  )
    // A place that stopped asking no longer holds the run in the queue
    // (admission.ts), nor does a step's model call that stopped asking
    // for a share (model-waits.ts): the run is no longer waiting there.
    .bind(Date.now() - queueLiveMs, id.data, found.id)
    .first();
  if (read === null) {
    throw workflowErrors.create("workflow.run_not_found");
  }
  const row = rowSchema.parse(read);
  const queued =
    row.queued === null
      ? undefined
      : queuedSchema.safeParse(JSON.parse(row.queued)).data;
  const status = statusOf(
    row.status,
    engineStatusSchema.safeParse(row.engine_status).data,
    queued !== undefined
  );
  const live = !ended.has(status);
  // What it failed with can hold what the run read for its person: only
  // they and admins see it, as on the run's status (runs.ts,
  // `seesDetails`), its message gone once its details are removed.
  const sees =
    by.role === "admin" || by.userId === (row.started_by ?? found.owner);
  const reported =
    status === "failed" && sees ? errorOf(row.failure) : undefined;
  // Removed once the run's retention is up, whether or not the sweep has
  // been by yet, as every reader of a run says (`detailsRemoved`).
  const removed = detailsRemoved(env, {
    endedAt: row.ended_at === null ? null : new Date(row.ended_at),
    detailsRemovedAt:
      row.details_removed_at === null ? null : new Date(row.details_removed_at),
  });
  const error =
    reported === undefined || !removed
      ? reported
      : { ...reported, message: removedText(env) };
  return {
    revision: row.summary_revision,
    runId: row.id,
    workflowId: row.workflow_id,
    workflowVersion: row.version,
    status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: live ? null : row.ended_at,
    ...(status === "compensating"
      ? {
          compensation: {
            cause:
              row.cancel_requested_at === null ? "failure" : "cancellation",
            activity: "running",
          },
        }
      : {}),
    ...(error === undefined ? {} : { error }),
    waits: live
      ? waitsSchema.parse(JSON.parse(row.waits)).map(({ name, expiresAt }) => ({
          kind: "decision" as const,
          // The decision's name as the version's review shows it, without
          // the key a keyed one's step adds (from the App's data); empty
          // for a name the review doesn't show, which can be made of what
          // the run read.
          name:
            reviewedTaskOf(calls(row.workflow_calls, row.workflow_id), name) ??
            "",
          expiresAt,
        }))
      : [],
    ...(status === "queued" && queued !== undefined ? { queued } : {}),
    control: controlOf(role, status, row),
  };
};
