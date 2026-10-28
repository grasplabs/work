import { clockLeaseMs, clockPeriods } from "@grasp-os/workerflow/clock";
import type { ClockTaskState } from "@grasp-os/workerflow/clock";
import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { clock, clockStarter, clockTasks } from "../src/clock.ts";
import { deliver, invoiceMail } from "./email-triggers.ts";
import { whileLogDown } from "./maintenance.ts";

// The client's clock (src/clock.ts) runs core's maintenance on its own
// alarm: core has no cron. Tests run that alarm as Cloudflare does, and
// move the clock past slots by setting the time.
//
// How it can fail, and the case below that shows it doesn't:
// - Nothing ever arms it on a new deployment: a request, or the probe.
// - A duplicate or late alarm runs a task twice for one slot, or a long
//   outage makes it run every slot it missed.
// - One failing task holds up the rest, or leaves the clock unarmed.
// - An alarm evicted or crashed part way leaves its tasks claimed forever,
//   or runs them again while that activation might still be running them.

const stub = () => clock(env);

/** Each task's run count, by name. */
const runsByTask = async (): Promise<Record<string, number>> => {
  const tasks: ClockTaskState[] = await stub().tasks();
  return Object.fromEntries(tasks.map(({ name, runs }) => [name, runs]));
};

/** The tasks of `period`, by name. */
const namesOf = (period: keyof typeof clockPeriods): string[] =>
  clockTasks.filter((task) => task.period === period).map(({ name }) => name);

/** How many more runs each named task has in `after` than in `before`. */
const ranSince = (
  before: Record<string, number>,
  after: Record<string, number>,
  names: readonly string[]
): Record<string, number> =>
  Object.fromEntries(
    names.map((name) => [name, (after[name] ?? 0) - (before[name] ?? 0)])
  );

const each = (names: readonly string[], value: number) =>
  Object.fromEntries(names.map((name) => [name, value]));

/** Sets the time to `ms`: every later alarm sees that time. */
const at = (ms: number): void => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
};

/** When the clock's alarm is armed for; null when it isn't. */
const alarmAt = async (): Promise<number | null> =>
  await runInDurableObject(
    stub(),
    async (_, state) => await state.storage.getAlarm()
  );

/** Clears the clock's alarm, as anything that lost it would. */
const clearAlarm = async (): Promise<void> => {
  await runInDurableObject(stub(), async (_, state) => {
    await state.storage.deleteAlarm();
  });
};

/** The start of the next quarter hour's slot, a little into it. */
const nextQuarterHour = (from: number): number =>
  (Math.floor(from / clockPeriods.quarterHour) + 1) * clockPeriods.quarterHour +
  1000;

// The tests share the one clock: each starts past every slot one before
// it reached. It starts at the next UTC midnight, so the few hours the tests
// move it on never cross into a new day (where `signals.daily` would claim
// that day's run), whatever time of day the suite runs.
let reached = (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000;
/** A time in a quarter hour's slot no earlier test reached, a little into it. */
const freshTime = (): number => {
  reached = nextQuarterHour(reached + clockLeaseMs + clockPeriods.quarterHour);
  return reached;
};

const minutes = namesOf("minute");
const quarterHours = namesOf("quarterHour");
const all = [...minutes, ...quarterHours];

describe("the client's clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is armed by a request when nothing has armed it, for straight away", async () => {
    const now = freshTime();
    at(now);
    await clearAlarm();

    // A fresh isolate's first request arms it, in the background.
    const ctx = createExecutionContext();
    clockStarter()(env, ctx);
    await waitOnExecutionContext(ctx);

    await vi.waitFor(async () => {
      await expect(alarmAt()).resolves.not.toBeNull();
    });
    // Due now, not a period on: the tasks it missed run at once.
    expect(((await alarmAt()) ?? 0) - now).toBeLessThanOrEqual(1000);
  });

  it("is armed by mail when nothing has armed it, as a quiet deployment may get only mail", async () => {
    at(freshTime());
    await clearAlarm();

    await deliver(
      "nobody@grasp.test",
      invoiceMail({ to: "nobody@grasp.test" })
    );

    await vi.waitFor(async () => {
      await expect(alarmAt()).resolves.not.toBeNull();
    });
  });

  it("waits out a still-running task's lease rather than come back every second", async () => {
    const now = freshTime();
    at(now);
    // Every task ran this slot; one minute task is still running, started
    // by an alarm that may still be going.
    await stub().ensure();
    await runDurableObjectAlarm(stub());
    const [first = ""] = minutes;
    await runInDurableObject(stub(), (_, state) => {
      state.storage.sql.exec(
        "UPDATE clock_tasks SET running_since = ? WHERE name = ?",
        now,
        first
      );
    });

    // Past the next slots it's still running: the alarm runs the rest and
    // comes back at the next slot, not a second later.
    const later = now + 5 * clockPeriods.minute;
    at(later);
    await runDurableObjectAlarm(stub());
    const next =
      (Math.floor(later / clockPeriods.minute) + 1) * clockPeriods.minute;
    expect((await alarmAt()) ?? 0).toBeGreaterThanOrEqual(next);
  });

  it("leaves an armed alarm where it is, however often it's asked", async () => {
    at(freshTime());
    await runDurableObjectAlarm(stub());
    const armed = await alarmAt();

    await stub().ensure();
    await stub().ensure();

    await expect(alarmAt()).resolves.toBe(armed);
  });

  it("runs every task once for each slot of its period, however often or late its alarm comes", async () => {
    let now = freshTime();
    at(now);
    await clearAlarm();
    const before = await runsByTask();
    await stub().ensure();
    await runDurableObjectAlarm(stub());
    // A duplicate alarm in the same slots, as Cloudflare may deliver one.
    await runDurableObjectAlarm(stub());
    const first = await runsByTask();
    expect(ranSince(before, first, all)).toStrictEqual(each(all, 1));
    // Armed for the next minute's slot.
    const next =
      (Math.floor(now / clockPeriods.minute) + 1) * clockPeriods.minute;
    expect((await alarmAt()) ?? 0).toBeGreaterThanOrEqual(next);
    expect((await alarmAt()) ?? 0).toBeLessThanOrEqual(next + 1000);

    // A late alarm, two minutes on: the minute tasks once more, the
    // quarter hour's not yet.
    now += 2 * clockPeriods.minute;
    at(now);
    await runDurableObjectAlarm(stub());
    const late = await runsByTask();
    expect(ranSince(first, late, all)).toStrictEqual({
      ...each(minutes, 1),
      ...each(quarterHours, 0),
    });

    // Three hours with no alarm at all: each task once, not once for each
    // slot it missed.
    now += 3 * 60 * clockPeriods.minute;
    reached = now;
    at(now);
    await runDurableObjectAlarm(stub());
    expect(ranSince(late, await runsByTask(), all)).toStrictEqual(each(all, 1));
  });

  it("runs the rest when one task fails, records the failure and keeps its alarm armed", async () => {
    at(freshTime());
    // The audit log can't be reached while the alarm runs: arming its
    // retention fails (the drain leaves its events waiting, and says so).
    await whileLogDown(async () => {
      await runDurableObjectAlarm(stub());
    });
    const tasks = await stub().tasks();
    const failed = tasks
      .filter(({ outcome }) => outcome !== "ok")
      .map(({ name }) => name)
      .toSorted();

    expect(failed).toStrictEqual(["audit.retention"]);
    expect(
      tasks.find(({ name }) => name === "audit.retention")?.failures
    ).toBeGreaterThan(0);
    await expect(alarmAt()).resolves.not.toBeNull();

    // The next slot's alarm runs it again, and it recovers.
    at(freshTime());
    await runDurableObjectAlarm(stub());
    const settled = await stub().tasks();
    const recovered = settled.find(({ name }) => name === "audit.retention");
    expect([recovered?.outcome, recovered?.failures]).toStrictEqual(["ok", 0]);
  });

  it("takes over the tasks of an alarm that died part way, once its lease is over", async () => {
    const now = freshTime();
    at(now);
    // An alarm evicted right after it claimed the minute's tasks: they're
    // marked running for this slot, and only its watchdog alarm is armed.
    await runInDurableObject(stub(), async (_, state) => {
      for (const name of minutes) {
        state.storage.sql.exec(
          `INSERT INTO clock_tasks (name, last_slot, running_since) VALUES (?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET last_slot = excluded.last_slot, running_since = excluded.running_since`,
          name,
          Math.floor(now / clockPeriods.minute),
          now
        );
      }
      await state.storage.setAlarm(now + clockLeaseMs);
    });
    const claimed = await runsByTask();

    // A minute on, an alarm leaves them to it while its lease holds...
    at(now + clockPeriods.minute);
    await runDurableObjectAlarm(stub());
    const leased = await runsByTask();
    expect(ranSince(claimed, leased, minutes)).toStrictEqual(each(minutes, 0));

    // ...and the watchdog, once it's over, runs them.
    reached = now + clockLeaseMs;
    at(reached);
    await runDurableObjectAlarm(stub());
    expect(ranSince(leased, await runsByTask(), minutes)).toStrictEqual(
      each(minutes, 1)
    );
  });
});
