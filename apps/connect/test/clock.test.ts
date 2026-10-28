import { clockPeriods } from "@grasp-os/workerflow/clock";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { clock, clockTasks } from "../src/clock.ts";

// Connect's clock (src/clock.ts): its cleanup and rotation tasks, on the
// clock's own alarm. Connect has no cron; core's clock arms this one.

const names = clockTasks.map(({ name }) => name);

const runsByTask = async (): Promise<Record<string, number>> => {
  const tasks = await clock(env).tasks();
  return Object.fromEntries(tasks.map(({ name, runs }) => [name, runs]));
};

const ranSince = (
  before: Record<string, number>,
  after: Record<string, number>
): Record<string, number> =>
  Object.fromEntries(
    names.map((name) => [name, (after[name] ?? 0) - (before[name] ?? 0)])
  );

const each = (value: number) =>
  Object.fromEntries(names.map((name) => [name, value]));

/** Runs the clock's alarm, then waits for the tasks it started to settle. */
const alarm = async (): Promise<void> => {
  await runDurableObjectAlarm(clock(env));
  await vi.waitFor(
    async () => {
      const tasks = await clock(env).tasks();
      expect(
        tasks.filter(({ runningSince }) => runningSince !== null)
      ).toStrictEqual([]);
    },
    { timeout: 20_000, interval: 50 }
  );
};

describe("connect's clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs every task on its own alarm, once a minute however often the alarm comes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await exports.default.ensureClock();
    const before = await runsByTask();
    await alarm();
    // A duplicate alarm in the same minute runs nothing again.
    await alarm();
    const first = await runsByTask();
    expect(ranSince(before, first)).toStrictEqual(each(1));
    const states = await clock(env).tasks();
    expect(states.filter(({ outcome }) => outcome !== "ok")).toStrictEqual([]);

    // A minute on, the next alarm runs them again.
    vi.setSystemTime(Date.now() + clockPeriods.minute);
    await alarm();
    expect(ranSince(first, await runsByTask())).toStrictEqual(each(1));
  });

  it("is armed when core asks, if nothing armed it, and says so with its tasks", async () => {
    await runInDurableObject(clock(env), async (_, state) => {
      await state.storage.deleteAlarm();
    });

    await expect(exports.default.ensureClock()).resolves.toStrictEqual({
      armed: true,
      tasks: names,
    });

    await runInDurableObject(clock(env), async (_, state) => {
      await expect(state.storage.getAlarm()).resolves.not.toBeNull();
    });
  });
});
