import { errorFields, log } from "@grasp-os/shared/log";
import { DurableObject } from "cloudflare:workers";

import { retryAccessRevocations } from "./access-revocations.ts";
import { sweepTestFixtures } from "./app-tests.ts";
import { auditLog } from "./audit-log.ts";
import { drainAuditOutboxes } from "./audit-outbox.ts";
import { sweepTokenKeys } from "./auth/app-tokens.ts";
import { refreshDailySignals } from "./daily-signals.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { sweepGuestChats } from "./guests.ts";
import { indexApps } from "./knowledge/apps-collection.ts";
import { sweepUploads } from "./knowledge/uploads.ts";
import { retryDisconnects } from "./members.ts";
import { sweepPackageFiles } from "./packages/cleanup.ts";
import { recordPlatformUpdate } from "./platform-updates.ts";
import { sweepReleases } from "./release-retention.ts";
import { sweepScreenFrames } from "./screen-frame.ts";
import { sweepScreenSubmissions } from "./screen-submissions.ts";
import { sweepBuilds } from "./screens.ts";
import { sweepPreviewStores } from "./sealed-previews.ts";
import { sweepStatistics } from "./statistics.ts";
import { sweepCandidateRuns } from "./workflows/candidate-runs.ts";
import { pumpConnectorEvents } from "./workflows/connector-events.ts";
import { repairControls } from "./workflows/controls.ts";
import { deleteExpiredEmail } from "./workflows/kept-email.ts";
import {
  repairResourceStarts,
  repairResourceTerminations,
} from "./workflows/resource-runs.ts";
import { sweepRunDetails } from "./workflows/retention.ts";
import { sweepRunFiles } from "./workflows/run-files.ts";
import { repairStarts } from "./workflows/runs.ts";
import { startDueSchedules } from "./workflows/triggers.ts";
import { repairWakes } from "./workflows/wakes.ts";

// The client's clock (spec 43.5): one object that runs core's maintenance,
// repair and schedule-admission tasks on its own alarm, so they keep
// running without a platform cron. Each task has its own durable state:
// the period slot it last ran for, whether it is running and since when,
// and how it last ended. So one that fails, hangs or is slow holds up no
// other, a duplicate or late alarm runs nothing twice, and an activation
// that dies part way is picked up by the next.
//
// The crons in wrangler.jsonc stay until the hard cut (spec 47) and are
// the same clock's explicit ticks: each runs its period's tasks at once,
// as before, and takes over a task whose tick died once its lease is
// over. While they tick, the alarm is their backup and runs nothing: it
// takes over once no cron has ticked for `clockCronGraceMs`. With the
// crons gone, it runs everything, half a period into each slot.

const minuteMs = 60_000;

/** How often each kind of task is due. */
export const clockPeriods = {
  minute: minuteMs,
  quarterHour: 15 * minuteMs,
} as const;

export type ClockPeriod = keyof typeof clockPeriods;

/** One task the clock runs once per slot of its period. */
interface ClockTask {
  name: string;
  period: ClockPeriod;
  run: (env: Env, at: Date) => Promise<unknown>;
}

/**
 * Every task, in the order each period starts them. Each runs concurrently
 * with the rest of its slot; its own failure is its own.
 */
export const clockTasks: readonly ClockTask[] = [
  { name: "audit.drain", period: "minute", run: drainAuditOutboxes },
  { name: "members.disconnects", period: "minute", run: retryDisconnects },
  {
    name: "access.revocations",
    period: "minute",
    run: retryAccessRevocations,
  },
  { name: "knowledge.uploads", period: "minute", run: sweepUploads },
  // Deploys apply migrations first (CI's db:migrate, and the console's
  // deploy), so `platform_versions` exists. A version running before it
  // does records nothing, and the first run after the migration records
  // the version then running: only a version that came and went in
  // between goes unrecorded.
  {
    name: "platform.updates",
    period: "minute",
    run: recordPlatformUpdate,
  },
  {
    name: "workflows.schedules",
    period: "minute",
    run: startDueSchedules,
  },
  {
    name: "workflows.starts",
    period: "minute",
    run: async (env) => {
      await repairStarts(env);
    },
  },
  {
    name: "workflows.resource_starts",
    period: "minute",
    run: repairResourceStarts,
  },
  {
    name: "workflows.resource_terminations",
    period: "minute",
    run: repairResourceTerminations,
  },
  { name: "workflows.controls", period: "minute", run: repairControls },
  { name: "workflows.wakes", period: "minute", run: repairWakes },
  {
    name: "workflows.connector_events",
    period: "minute",
    run: pumpConnectorEvents,
  },
  {
    name: "signals.daily",
    period: "quarterHour",
    run: refreshDailySignals,
  },
  {
    name: "knowledge.apps",
    period: "quarterHour",
    run: async (env) => {
      await indexApps(env);
    },
  },
  { name: "statistics.sweep", period: "quarterHour", run: sweepStatistics },
  {
    name: "email.kept",
    period: "quarterHour",
    run: deleteExpiredEmail,
  },
  { name: "guests.sweep", period: "quarterHour", run: sweepGuestChats },
  {
    name: "workflows.run_details",
    period: "quarterHour",
    run: sweepRunDetails,
  },
  {
    name: "workflows.candidate_runs",
    period: "quarterHour",
    run: sweepCandidateRuns,
  },
  // Its grace counts from real time, not the slot's.
  {
    name: "workflows.run_files",
    period: "quarterHour",
    run: async (env) => {
      await sweepRunFiles(env);
    },
  },
  {
    name: "screens.frames",
    period: "quarterHour",
    run: sweepScreenFrames,
  },
  {
    name: "screens.previews",
    period: "quarterHour",
    run: sweepPreviewStores,
  },
  { name: "screens.builds", period: "quarterHour", run: sweepBuilds },
  {
    name: "packages.files",
    period: "quarterHour",
    run: sweepPackageFiles,
  },
  { name: "apps.releases", period: "quarterHour", run: sweepReleases },
  {
    name: "apps.test_fixtures",
    period: "quarterHour",
    run: sweepTestFixtures,
  },
  {
    name: "screens.submissions",
    period: "quarterHour",
    run: sweepScreenSubmissions,
  },
  { name: "auth.token_keys", period: "quarterHour", run: sweepTokenKeys },
  // The audit log's retention alarm armed, if it isn't yet: retention
  // itself runs on that alarm (src/audit-log.ts), and a deployment that
  // appends nothing after a release still gets it.
  {
    name: "audit.retention",
    period: "quarterHour",
    run: async (env) => {
      await auditLog(env).armRetention();
    },
  },
];

/**
 * How long a task that started counts as running: an alarm in that time
 * leaves it to the activation that started it. After it, that activation
 * is taken for dead, and the task runs again.
 */
export const clockLeaseMs = 10 * minuteMs;

/**
 * How long after the last cron tick the alarm leaves the tasks to the
 * crons: well past a few missed ticks, so a cron that's late runs alone.
 */
export const clockCronGraceMs = 30 * minuteMs;

/**
 * How long after a deployment first starts the clock its alarm first
 * runs: the crons run meanwhile, and a clock that starts again after its
 * alarm was cleared catches up with what's due then.
 */
export const clockStartMs = 15 * minuteMs;

/**
 * How long a tick waits for its tasks before it settles what ended and
 * re-arms: one still running keeps its lease and is recorded when it ends.
 */
export const clockTickWaitMs = 4 * minuteMs;

/** What the clock records of a task. */
export interface ClockTaskState {
  name: string;
  /** The slot of its period it last started for; -1 before it ever did. */
  lastSlot: number;
  runs: number;
  /** How its latest run ended; null while it hasn't. */
  outcome: "ok" | "failed" | null;
  /** Its failures in a row. */
  failures: number;
  /** When its running activation started it; null when none runs it. */
  runningSince: number | null;
}

interface Row extends Record<string, SqlStorageValue> {
  name: string;
  last_slot: number;
  runs: number;
  outcome: "ok" | "failed" | null;
  failures: number;
  running_since: number | null;
}

const slotOf = (period: ClockPeriod, at: number): number =>
  Math.floor(at / clockPeriods[period]);

/** When the alarm runs `period`'s slot after `slot`: half a period into it, past its cron. */
const dueAt = (period: ClockPeriod, slot: number): number =>
  (slot + 1) * clockPeriods[period] + clockPeriods[period] / 2;

/**
 * Runs `tasks` concurrently on `env` for time `at`, calling `settle` as
 * each ends, and waits for them at most `clockTickWaitMs`: one still
 * running keeps its lease and settles when it ends.
 */
const runClaimed = async (
  env: Env,
  tasks: readonly ClockTask[],
  at: number,
  settle: (name: string, failed: boolean) => unknown,
  waitUntil: (promise: Promise<unknown>) => void
): Promise<void> => {
  const runs = tasks.map(async (task) => {
    let failed = false;
    try {
      await task.run(env, new Date(at));
    } catch (error) {
      failed = true;
      log.error("clock.task_failed", {
        task: task.name,
        ...errorFields(error),
      });
    }
    try {
      await settle(task.name, failed);
    } catch (error) {
      log.error("clock.settle_failed", {
        task: task.name,
        ...errorFields(error),
      });
    }
  });
  // Kept alive past the wait: a task that outlives it still ends, and
  // settles, on its own invocation.
  const all = Promise.allSettled(runs);
  waitUntil(all);
  const { promise: waited, resolve } = Promise.withResolvers<"waited">();
  const timer = setTimeout(() => {
    resolve("waited");
  }, clockTickWaitMs);
  await Promise.race([all, waited]);
  clearTimeout(timer);
};

/** What a claim hands its runner: the tasks it may run, and the claim's time. */
export interface ClockClaim {
  names: string[];
  started: number;
}

/** The client's one clock (see the header comment). */
export class Clock extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS clock_tasks (
      name TEXT PRIMARY KEY,
      last_slot INTEGER NOT NULL DEFAULT -1,
      runs INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      failures INTEGER NOT NULL DEFAULT 0,
      running_since INTEGER,
      ticked_at INTEGER
    )`);
  }

  /**
   * Arms the alarm if nothing is armed, `clockStartMs` from now: what a
   * request, or a deploy's first one, does, so the clock never depends on
   * already running.
   */
  async ensure(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + clockStartMs);
    }
  }

  /**
   * Claims `period`'s tasks for time `at` for a cron's explicit tick,
   * whatever slot they last ran for, but those another activation is
   * still running. The watchdog is armed first: a tick that dies is
   * recovered by the alarm once its lease is over.
   */
  async claim(period: ClockPeriod, at: number): Promise<ClockClaim> {
    const now = Date.now();
    await this.ctx.storage.setAlarm(now + clockLeaseMs);
    const tasks = clockTasks.filter((task) => task.period === period);
    const claimed = this.#claim(tasks, at, now);
    for (const task of tasks) {
      this.ctx.storage.sql.exec(
        `INSERT INTO clock_tasks (name, ticked_at) VALUES (?, ?)
         ON CONFLICT (name) DO UPDATE SET ticked_at = excluded.ticked_at`,
        task.name,
        now
      );
    }
    return { names: claimed.map(({ name }) => name), started: now };
  }

  /** Records how task `name`'s run of claim `started` ended. */
  settle(name: string, started: number, failed: boolean): void {
    this.#settle(name, started, failed);
  }

  /** Arms the alarm for the nearest slot a task is due for, once a tick settled. */
  async rearm(): Promise<void> {
    await this.ctx.storage.setAlarm(this.#nextAlarm(Date.now()));
  }

  /**
   * Runs every task whose period moved to a slot it hasn't run for, once
   * the crons stopped ticking.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastTick() < clockCronGraceMs) {
      await this.rearm();
      return;
    }
    await this.ctx.storage.setAlarm(now + clockLeaseMs);
    try {
      const state = this.#states();
      const claimed = this.#claim(
        clockTasks.filter(
          (task) =>
            slotOf(task.period, now) > (state.get(task.name)?.lastSlot ?? -1)
        ),
        now,
        now
      );
      await runClaimed(
        this.env,
        claimed,
        now,
        (name, failed) => {
          this.#settle(name, now, failed);
        },
        (promise) => {
          this.ctx.waitUntil(promise);
        }
      );
    } finally {
      await this.rearm();
    }
  }

  /** What the clock records of each task, for diagnostics and tests. */
  tasks(): ClockTaskState[] {
    return [...this.#states().values()];
  }

  #states(): Map<string, ClockTaskState> {
    const rows = this.ctx.storage.sql
      .exec<Row>("SELECT * FROM clock_tasks")
      .toArray();
    return new Map(
      rows.map((row) => [
        row.name,
        {
          name: row.name,
          lastSlot: row.last_slot,
          runs: row.runs,
          outcome: row.outcome,
          failures: row.failures,
          runningSince: row.running_since,
        },
      ])
    );
  }

  /**
   * Claims each of `tasks` this activation may run, in one transaction:
   * not one another live activation runs.
   */
  #claim(tasks: readonly ClockTask[], at: number, now: number): ClockTask[] {
    return this.ctx.storage.transactionSync(() =>
      tasks.filter((task) => {
        const [row] = this.ctx.storage.sql
          .exec<Pick<Row, "running_since">>(
            "SELECT running_since FROM clock_tasks WHERE name = ?",
            task.name
          )
          .toArray();
        const running = row?.running_since ?? null;
        if (running !== null && now - running < clockLeaseMs) {
          return false;
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO clock_tasks (name, last_slot, running_since) VALUES (?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET last_slot = max(last_slot, excluded.last_slot), running_since = excluded.running_since`,
          task.name,
          slotOf(task.period, at),
          now
        );
        return true;
      })
    );
  }

  /** Records how a run of `name` claimed at `started` ended, unless a later claim took it over. */
  #settle(name: string, started: number, failed: boolean): void {
    this.ctx.storage.sql.exec(
      `UPDATE clock_tasks SET running_since = NULL, runs = runs + 1, outcome = ?,
         failures = CASE WHEN ? THEN failures + 1 ELSE 0 END
       WHERE name = ? AND running_since = ?`,
      failed ? "failed" : "ok",
      failed ? 1 : 0,
      name,
      started
    );
  }

  /** When a cron last ticked any task; 0 when none ever did. */
  #lastTick(): number {
    const [row] = this.ctx.storage.sql
      .exec<{ last: number | null }>(
        "SELECT max(ticked_at) AS last FROM clock_tasks"
      )
      .toArray();
    return row?.last ?? 0;
  }

  /**
   * When the alarm should next run: the nearest slot any task is due for,
   * but not before the crons' grace is over.
   */
  #nextAlarm(now: number): number {
    const state = this.#states();
    const due = clockTasks.map((task) =>
      dueAt(
        task.period,
        state.get(task.name)?.lastSlot ?? slotOf(task.period, now) - 1
      )
    );
    return Math.max(
      now + 1000,
      this.#lastTick() + clockCronGraceMs,
      Math.min(...due)
    );
  }
}

/** The client's one clock. */
export const clock = (
  env: Pick<Env, "CLOCK" | "DURABLE_OBJECT_JURISDICTION">
): DurableObjectStub<Clock> =>
  inJurisdiction(env, env.CLOCK).getByName("clock");

/**
 * A cron's explicit tick: claims `period`'s tasks from the clock, runs them
 * here on this invocation's `env`, and records each as it ends. A clock
 * that can't be reached fails the tick: its alarm runs the tasks instead.
 */
export const tickClock = async (
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  period: ClockPeriod,
  at: number
): Promise<void> => {
  const stub = clock(env);
  const claim = await stub.claim(period, at);
  const byName = new Map(clockTasks.map((task) => [task.name, task]));
  const tasks = claim.names.flatMap((name) => {
    const task = byName.get(name);
    return task === undefined ? [] : [task];
  });
  try {
    await runClaimed(
      env,
      tasks,
      at,
      async (name, failed) => {
        await stub.settle(name, claim.started, failed);
      },
      (promise) => {
        ctx.waitUntil(promise);
      }
    );
  } finally {
    await stub.rearm();
  }
};

/**
 * Arms the clock once per isolate, in the background: the repair path that
 * starts it on a deployment's first request, and again after anything
 * cleared its alarm. A failure is logged and tried again by the next
 * isolate.
 */
export const clockStarter = () => {
  const isolate = { started: false };
  return (env: Env, ctx: Pick<ExecutionContext, "waitUntil">): void => {
    if (isolate.started) {
      return;
    }
    isolate.started = true;
    const start = async (): Promise<void> => {
      try {
        await clock(env).ensure();
      } catch (error) {
        isolate.started = false;
        log.error("clock.ensure_failed", errorFields(error));
      }
    };
    ctx.waitUntil(start());
  };
};

/** This isolate's starter, which the first request core serves runs. */
export const ensureClockOnce = clockStarter();
