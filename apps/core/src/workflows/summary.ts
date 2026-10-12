import { appErrors } from "@grasp-os/shared/apps";
import { runIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { RunSummary } from "@grasp-os/shared/workflows";
import type { InstanceStatus } from "@grasp-os/workerflow/contracts";
import { z } from "zod";

import { requireAppRole } from "../app-access.ts";
import { findApp } from "../apps.ts";

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
  summary_revision: z.number(),
  waits: z.string(),
  pending: z.enum(["pause", "resume", "cancel"]).nullable(),
});

const waitsSchema = z.array(
  z.object({ name: z.string(), expiresAt: z.number() })
);

/** The run's status as the summary shows it. */
const statusOf = (
  status: z.infer<typeof rowSchema>["status"],
  engine: InstanceStatus["status"] | undefined
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
 * App) may see it; another App's run is `workflow.run_not_found`.
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
       r.failure, r.summary_revision,
       (SELECT json_group_array(json_object('name', d.step, 'expiresAt', d.expires_at))
          FROM workflow_decisions d
          WHERE d.run_id = r.id AND d.status = 'open') AS waits,
       (SELECT c.kind FROM workflow_run_controls c
          WHERE c.run_id = r.id AND c.state = 'admitted'
          ORDER BY CASE c.kind WHEN 'cancel' THEN 0 ELSE 1 END
          LIMIT 1) AS pending
     FROM workflow_runs r
     WHERE r.id = ? AND r.app_id = ?`
  )
    .bind(id.data, found.id)
    .first();
  if (read === null) {
    throw workflowErrors.create("workflow.run_not_found");
  }
  const row = rowSchema.parse(read);
  const status = statusOf(
    row.status,
    engineStatusSchema.safeParse(row.engine_status).data
  );
  const live = !ended.has(status);
  const error = status === "failed" ? errorOf(row.failure) : undefined;
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
          name,
          expiresAt,
        }))
      : [],
    control: controlOf(role, status, row),
  };
};
