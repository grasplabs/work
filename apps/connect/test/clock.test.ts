import { clockCronGraceMs, clockPeriods } from "@grasp-os/workerflow/clock";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { clock, clockTasks } from "../src/clock.ts";

// Connect's clock (src/clock.ts): its cleanup and rotation tasks, on
// connect's cron while it lasts and on the clock's alarm after.

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

describe("connect's clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs every task on the cron, then on its own alarm once the cron stops", async () => {
    const before = await runsByTask();
    await exports.default.scheduled();
    const ticked = await runsByTask();
    expect(ranSince(before, ticked)).toStrictEqual(each(1));
    const states = await clock(env).tasks();
    expect(states.filter(({ outcome }) => outcome !== "ok")).toStrictEqual([]);

    // A minute on, the cron still ticking: the alarm leaves it to the cron.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + clockPeriods.minute);
    await runDurableObjectAlarm(clock(env));
    const backup = await runsByTask();
    expect(ranSince(ticked, backup)).toStrictEqual(each(0));

    // No cron since, past its grace: the alarm runs them.
    vi.setSystemTime(Date.now() + clockCronGraceMs);
    await runDurableObjectAlarm(clock(env));
    expect(ranSince(backup, await runsByTask())).toStrictEqual(each(1));
  });

  it("is armed when core asks, if nothing armed it", async () => {
    await runInDurableObject(clock(env), async (_, state) => {
      await state.storage.deleteAlarm();
    });

    await exports.default.ensureClock();

    await runInDurableObject(clock(env), async (_, state) => {
      await expect(state.storage.getAlarm()).resolves.not.toBeNull();
    });
  });
});
