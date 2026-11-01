import { runClockTasks } from "@grasp-os/workerflow/clock";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import { clockTasks, report } from "../src/clock.ts";

/**
 * Runs the clock's every-minute tasks once, as its alarm does, on an env
 * with `changes`, for the minute `at` (now by default).
 */
export const runMinuteTasks = async (
  changes: Partial<Env> = {},
  at = new Date()
): Promise<void> => {
  await runClockTasks(
    { ...env, ...changes },
    clockTasks,
    "minute",
    at.getTime(),
    report
  );
};

/**
 * Runs the clock's quarter-hour tasks once, as its alarm does, on an env
 * with `changes`, for the time `at` (now by default).
 */
export const runQuarterHourTasks = async (
  changes: Partial<Env> = {},
  at = new Date()
): Promise<void> => {
  await runClockTasks(
    { ...env, ...changes },
    clockTasks,
    "quarterHour",
    at.getTime(),
    report
  );
};

/**
 * How many events of `action` on target `targetId` wait in `database`'s
 * audit outbox.
 */
export const waitingInOutbox = async (
  database: D1Database,
  action: string,
  targetId: string
): Promise<number> => {
  const row = await database
    .prepare(
      "SELECT count(*) AS waiting FROM audit_outbox WHERE json_extract(event, '$.action') = ? AND json_extract(event, '$.target.id') = ?"
    )
    .bind(action, targetId)
    .first<{ waiting: number }>();
  return row?.waiting ?? 0;
};

/**
 * Runs `run` while the audit log can't be reached, as when it's down: what
 * `run` audits waits in the outbox until a drain reaches the log.
 */
export const whileLogDown = async <T>(run: () => Promise<T>): Promise<T> => {
  const down = vi.spyOn(env.AUDIT_LOG, "getByName").mockImplementation(() => {
    throw new Error("Audit log unavailable");
  });
  try {
    return await run();
  } finally {
    down.mockRestore();
  }
};
