import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clock,
  clockLeaseMs,
  clockPeriods,
  clockStarter,
  clockTasks,
} from "../src/clock.ts";
import type { ClockTaskState } from "../src/clock.ts";
import { runCron, runQuarterHourCron, whileLogDown } from "./cron.ts";

// The client's clock (src/clock.ts) runs core's maintenance on its own
// alarm. Tests run that alarm as Cloudflare does, and move the clock past
// slots by setting the time.

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

/** Sets the clock `ms` from now: every later alarm sees that time. */
const at = (ms: number): void => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
};

/** The start of the next quarter hour's slot, a little into it. */
const nextQuarterHour = (from: number): number =>
  (Math.floor(from / clockPeriods.quarterHour) + 1) * clockPeriods.quarterHour +
  1000;

// The tests share the one clock: each starts past every slot one before
// it reached.
let reached = Date.now();
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

  it("runs every task once for each slot of its period, however often its alarm comes", async () => {
    let now = freshTime();
    at(now);
    const before = await runsByTask();
    // Armed as a deployment's first request arms it.
    await stub().ensure();
    await runDurableObjectAlarm(stub());
    // A duplicate alarm in the same slots, as Cloudflare may deliver one.
    await runDurableObjectAlarm(stub());
    const first = await runsByTask();
    expect(ranSince(before, first, all)).toStrictEqual(each(all, 1));

    // A late alarm, two minutes on: the minute tasks once more, the
    // quarter hour's not yet.
    now += 2 * clockPeriods.minute;
    at(now);
    await runDurableObjectAlarm(stub());
    expect(ranSince(first, await runsByTask(), all)).toStrictEqual({
      ...each(minutes, 1),
      ...each(quarterHours, 0),
    });
  });

  it("leaves to the alarm only what no cron ran in its slot", async () => {
    const now = freshTime();
    at(now);
    // The minute's cron first, as Cloudflare runs it at the slot's start.
    await runCron({}, new Date(now));
    const afterCron = await runsByTask();
    await runDurableObjectAlarm(stub());

    expect(ranSince(afterCron, await runsByTask(), all)).toStrictEqual({
      ...each(minutes, 0),
      ...each(quarterHours, 1),
    });
  });

  it("runs the rest when one task fails, records the failure and keeps its alarm armed", async () => {
    const now = freshTime();
    at(now);
    // The audit log can't be reached while the quarter hour's cron ticks:
    // arming its retention fails.
    await whileLogDown(async () => {
      await runQuarterHourCron({}, new Date(now));
    });
    const tasks = await stub().tasks();
    const outcomes = Object.fromEntries(
      tasks
        .filter(({ name }) => quarterHours.includes(name))
        .map(({ name, outcome }) => [name, outcome])
    );

    expect(outcomes["audit.retention"]).toBe("failed");
    expect(
      Object.entries(outcomes).filter(
        ([name, outcome]) => name !== "audit.retention" && outcome !== "ok"
      )
    ).toStrictEqual([]);
    expect(
      tasks.find(({ name }) => name === "audit.retention")?.failures
    ).toBeGreaterThan(0);
    await runInDurableObject(stub(), async (_, state) => {
      await expect(state.storage.getAlarm()).resolves.not.toBeNull();
    });

    // The next slot's alarm runs it again, and it recovers.
    at(freshTime());
    await runDurableObjectAlarm(stub());
    const settled = await stub().tasks();
    const recovered = settled.find(({ name }) => name === "audit.retention");
    expect([recovered?.outcome, recovered?.failures]).toStrictEqual(["ok", 0]);
  });

  it("takes over a tick that died after claiming its tasks, once its lease is over", async () => {
    const now = freshTime();
    at(now);
    // A cron's tick claims the minute's tasks, then its invocation dies.
    await stub().claim("minute", now);
    const claimed = await runsByTask();

    // The next minute's alarm leaves them to it while the lease holds.
    at(now + clockPeriods.minute);
    await runDurableObjectAlarm(stub());
    const leased = await runsByTask();
    expect(ranSince(claimed, leased, minutes)).toStrictEqual(each(minutes, 0));

    // Past the lease, it runs them.
    reached = now + clockLeaseMs + clockPeriods.minute;
    at(reached);
    await runDurableObjectAlarm(stub());
    expect(ranSince(leased, await runsByTask(), minutes)).toStrictEqual(
      each(minutes, 1)
    );
  });

  it("is started by a request when nothing has armed it", async () => {
    await runInDurableObject(stub(), async (_, state) => {
      await state.storage.deleteAlarm();
    });

    // A fresh isolate's first request arms it: the alarm runs at once,
    // and arms the next.
    const ctx = createExecutionContext();
    clockStarter()(env, ctx);
    await waitOnExecutionContext(ctx);

    await vi.waitFor(async () => {
      await runInDurableObject(stub(), async (_, state) => {
        await expect(state.storage.getAlarm()).resolves.not.toBeNull();
      });
    });
  });
});
