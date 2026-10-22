import { DurableObject } from "cloudflare:workers";

// A Worker's clock (spec 43.5): one Durable Object per client deployment
// that runs the Worker's maintenance, repair and admission tasks on its own
// alarm, so they keep running without a platform cron. Each task has its
// own durable state: the period slot it last ran for, whether it is running
// and since when, and how it last ended. So one that fails, hangs or is
// slow holds up no other, a duplicate or late alarm runs nothing twice, and
// an activation that dies part way is picked up by the next.
//
// While the Worker still has crons, each is the clock's explicit tick: it
// claims its period's tasks from the clock, runs them on its own
// invocation's env, as a cron always did, and records each as it ends. It
// takes over a task whose tick died once its lease is over. While crons
// tick, the alarm is their backup and runs nothing: it takes over once no
// cron has ticked for `clockCronGraceMs`. With the crons gone, it runs
// everything, half a period into each slot.
//
// Nothing of a task's own work is here: a Worker gives the clock its tasks
// (`ClockObject.clockTasks`) and how a failure is reported.

const minuteMs = 60_000;

/** How often each kind of task is due. */
export const clockPeriods = {
  minute: minuteMs,
  quarterHour: 15 * minuteMs,
} as const;

export type ClockPeriod = keyof typeof clockPeriods;

/** One task a clock runs once per slot of its period. */
export interface ClockTask<E> {
  name: string;
  period: ClockPeriod;
  run: (env: E, at: Date) => Promise<unknown>;
}

/** How a Worker reports a task that failed, or whose outcome couldn't be recorded. */
export type ClockReport = (
  event: "clock.task_failed" | "clock.settle_failed",
  task: string,
  error: unknown
) => void;

/**
 * How long a task that started counts as running: a tick or alarm in that
 * time leaves it to the activation that started it. After it, that
 * activation is taken for dead, and the task runs again.
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

/** What a claim hands its runner: the tasks it may run, and the claim's time. */
export interface ClockClaim {
  names: string[];
  started: number;
}

/** A clock as a Worker reaches it: its stub's methods. */
export interface ClockRpc {
  claim: (period: ClockPeriod, at: number) => Promise<ClockClaim>;
  settle: (name: string, started: number, failed: boolean) => Promise<void>;
  rearm: () => Promise<void>;
  ensure: () => Promise<void>;
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
const runClaimed = async <E>(
  env: E,
  tasks: readonly ClockTask<E>[],
  at: number,
  settle: (name: string, failed: boolean) => unknown,
  report: ClockReport,
  waitUntil: (promise: Promise<unknown>) => void
): Promise<void> => {
  const runs = tasks.map(async (task) => {
    let failed = false;
    try {
      await task.run(env, new Date(at));
    } catch (error) {
      failed = true;
      report("clock.task_failed", task.name, error);
    }
    try {
      await settle(task.name, failed);
    } catch (error) {
      report("clock.settle_failed", task.name, error);
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

/** A Worker's clock (see the header comment): it extends this with its tasks. */
export abstract class ClockObject<E> extends DurableObject<E> {
  /** Every task, in the order each period starts them. */
  protected abstract readonly clockTasks: readonly ClockTask<E>[];

  /** How the alarm's runs report a failure. */
  protected abstract report: ClockReport;

  constructor(ctx: DurableObjectState, env: E) {
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
   * recovered once its lease is over.
   */
  async claim(period: ClockPeriod, at: number): Promise<ClockClaim> {
    const now = Date.now();
    await this.ctx.storage.setAlarm(now + clockLeaseMs);
    const tasks = this.clockTasks.filter((task) => task.period === period);
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
        this.clockTasks.filter(
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
        this.report,
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
  #claim(
    tasks: readonly ClockTask<E>[],
    at: number,
    now: number
  ): ClockTask<E>[] {
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
    const due = this.clockTasks.map((task) =>
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

/**
 * A cron's explicit tick: claims `period`'s tasks from `clock`, runs them
 * here on this invocation's `env`, and records each as it ends. A clock
 * that can't be reached fails the tick: its alarm runs the tasks instead.
 */
export const tickClock = async <E>(
  clock: ClockRpc,
  tasks: readonly ClockTask<E>[],
  report: ClockReport,
  env: E,
  ctx: Pick<ExecutionContext, "waitUntil">,
  period: ClockPeriod,
  at: number
): Promise<void> => {
  const claim = await clock.claim(period, at);
  const byName = new Map(tasks.map((task) => [task.name, task]));
  const claimed = claim.names.flatMap((name) => {
    const task = byName.get(name);
    return task === undefined ? [] : [task];
  });
  try {
    await runClaimed(
      env,
      claimed,
      at,
      async (name, failed) => {
        await clock.settle(name, claim.started, failed);
      },
      report,
      (promise) => {
        ctx.waitUntil(promise);
      }
    );
  } finally {
    await clock.rearm();
  }
};

/**
 * Arms a clock once per isolate, in the background: the repair path that
 * starts it on a deployment's first request, and again after anything
 * cleared its alarm. A failure goes to `failed` and is tried again by the
 * next request.
 */
export const clockStarter = <E>(
  clockOf: (env: E) => Pick<ClockRpc, "ensure">,
  failed: (error: unknown) => void
) => {
  const isolate = { started: false };
  return (env: E, ctx: Pick<ExecutionContext, "waitUntil">): void => {
    if (isolate.started) {
      return;
    }
    isolate.started = true;
    const start = async (): Promise<void> => {
      try {
        await clockOf(env).ensure();
      } catch (error) {
        isolate.started = false;
        failed(error);
      }
    };
    ctx.waitUntil(start());
  };
};
