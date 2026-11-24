// What a run tells its host of itself, through the run object's real
// boundary: each status it takes, in order, numbered, handed over again
// until the host has it, and never in the way of the run's own alarm.
// Process death between a status and its delivery is in test/process.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { Workflow } from "../src/binding.ts";
import { defaultLeaseMs } from "../src/run.ts";
import {
  alarmOf,
  ended,
  journalOf,
  newId,
  pastTime,
  runObject,
  suspendedOn,
  until,
  within,
  workflow,
} from "./helpers.ts";
import {
  alarmsOf,
  dueWithFailingAlarms,
  napMs,
  notifiedWith,
  outboxEmpty,
  pastWakeMs,
  ranInFreshAlarm,
} from "./notifications-harness.ts";
import {
  checkpointsReached,
  effectsOf,
  tick,
  eventOf,
  hold,
  notifiedOf,
  notifyFailures,
  warningsDuring,
} from "./outside.ts";

describe("a run whose delivery the host holds", () => {
  it("doesn't spin its alarm while the run is paused", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    await outboxEmpty("napper", id);
    const delivery = hold(id, "notify", checkpointsReached(id, "notify") + 1);
    const instance = await workflow("napper").get(id);
    await instance.pause();
    await within("the delivery to be held", delivery.held);
    const before = alarmsOf("napper", id);

    await within("a while", scheduler.wait(500));
    const during = alarmsOf("napper", id) - before;
    delivery.release();
    await notifiedWith(id, "paused");

    expect(during).toBeLessThanOrEqual(2);
  });

  it("doesn't spin its alarm while the run waits, and still wakes it on time", async () => {
    const id = newId();
    // The delivery of the run's start, which goes out as it runs.
    const delivery = hold(id, "notify", 2);
    await workflow("napper").create({ id, params: { duration: 1500 } });
    await within("the delivery to be held", delivery.held);
    await suspendedOn("napper", id, "nap");
    const before = alarmsOf("napper", id);

    await within("a while", scheduler.wait(500));
    const during = alarmsOf("napper", id) - before;
    delivery.release();
    await ended("napper", id);

    expect(during).toBeLessThanOrEqual(2);
  });
});

describe("a host that fails", () => {
  it("is not handed anything again before its backoff is over", async () => {
    const id = newId();
    notifyFailures.set(id, 50);

    await warningsDuring(async () => {
      await workflow("orders").create({ id });
      await within("a while", scheduler.wait(300));
    });
    const { run } = await journalOf("orders", id);
    notifyFailures.delete(id);

    expect(checkpointsReached(id, "notify")).toBe(1);
    expect(run.notify_at ?? 0).toBeGreaterThanOrEqual(run.created_at + 1000);
  });
});

describe("a delivery that fails after its run was deleted", () => {
  it("doesn't put off the run created again under the ID", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    await outboxEmpty("napper", id);
    const held = hold(id, "notify", checkpointsReached(id, "notify") + 1);
    const instance = await workflow("napper").get(id);
    await instance.pause();
    await within("the delivery to be held", held.held);
    await instance.delete();
    await workflow("napper").create({ id });
    // The held delivery, of the deleted run, fails once it is let go.
    notifyFailures.set(id, 1);
    const releasedAt = Date.now();
    await warningsDuring(async () => {
      held.release();
      await until("the new run's start to be taken", () =>
        notifiedOf(id).filter(
          (notification) => notification.status === "queued"
        ).length === 2
          ? true
          : undefined
      );
    });

    // At once: not after a backoff the deleted run's failure put on it.
    expect(Date.now() - releasedAt).toBeLessThan(500);
  });
});

describe("writes while a delivery is out", () => {
  it("lead to one more delivery after it, and one alarm write each", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    await outboxEmpty("napper", id);
    const held = hold(id, "notify", checkpointsReached(id, "notify") + 1);
    const instance = await workflow("napper").get(id);
    await instance.pause();
    await within("the delivery to be held", held.held);
    for (let write = 0; write < 10; write += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one write after another
      await instance.sendEvent({ type: "nudge", payload: write });
    }
    // The alarm writes from here on, in the run object.
    const writes = { count: 0 };
    await runInDurableObject(runObject("napper", id), (_, state) => {
      const { storage } = state;
      for (const name of ["setAlarm", "deleteAlarm"] as const) {
        const original: unknown = Reflect.get(storage, name);
        if (typeof original !== "function") {
          throw new TypeError(`storage has no ${name}`);
        }
        Reflect.set(storage, name, async (...args: unknown[]) => {
          writes.count += 1;
          await Reflect.apply(original, storage, args);
        });
      }
    });

    held.release();
    await notifiedWith(id, "paused");
    await within("a while", scheduler.wait(300));
    await runInDurableObject(runObject("napper", id), (_, state) => {
      Reflect.deleteProperty(state.storage, "setAlarm");
      Reflect.deleteProperty(state.storage, "deleteAlarm");
    });

    expect(writes.count).toBeLessThanOrEqual(2);
  });
});

describe("a run that comes due during an alarm's delivery", () => {
  it("runs in an alarm of its own when its wake passes during the delivery", async () => {
    const id = newId();
    notifyFailures.set(id, 1);
    // The delivery after the failure's backoff (`notifyRetryMs`, a second),
    // by an alarm the run's wake hasn't come for yet: the nap leaves that
    // backoff seconds to spare, however slowly the first delivery fails.
    const delivery = hold(id, "notify", 2);
    await warningsDuring(async () => {
      await workflow("budget-napper", env.BUDGETED_RUNS).create({
        id,
        params: { duration: napMs },
      });
      await delivery.held;
    });
    const journal = await journalOf("budget-napper", id, env.BUDGETED_RUNS);
    const wake = journal.run.wake_at ?? 0;
    // The delivery came first, its wake still ahead: otherwise the alarm
    // ran the run itself, and there is no delivery for the wake to pass.
    const heldBeforeWake = Date.now() < wake;
    // Held past the wake.
    await pastTime(wake + pastWakeMs);

    const releasedAt = tick();
    delivery.release();
    await ended("budget-napper", id, env.BUDGETED_RUNS);

    expect({
      heldBeforeWake,
      ...(await ranInFreshAlarm("budget-napper", id, "after", releasedAt)),
    }).toStrictEqual({ heldBeforeWake: true, separateAlarm: true, fits: true });
  });

  it("runs in an alarm of its own when it is resumed during the delivery", async () => {
    const id = newId();
    const first = hold(id, "first");
    await workflow("budget-pair", env.BUDGETED_RUNS).create({ id });
    await first.held;
    await until("the outbox to empty", async () => {
      const { run } = await journalOf("budget-pair", id, env.BUDGETED_RUNS);
      return run.notify_at === null ? true : undefined;
    });
    // The pause's delivery fails; the alarm's after the backoff is held.
    notifyFailures.set(id, 1);
    const delivery = hold(id, "notify", checkpointsReached(id, "notify") + 2);
    const instance = await workflow("budget-pair", env.BUDGETED_RUNS).get(id);
    await warningsDuring(async () => {
      await instance.pause();
      first.release();
      await delivery.held;
    });
    // A stub of its own: one made before the hold can't be used from here.
    const resumer = await workflow("budget-pair", env.BUDGETED_RUNS).get(id);
    await resumer.resume();

    const releasedAt = tick();
    delivery.release();
    await ended("budget-pair", id, env.BUDGETED_RUNS);

    await expect(
      ranInFreshAlarm("budget-pair", id, "second", releasedAt)
    ).resolves.toStrictEqual({ separateAlarm: true, fits: true });
  });

  it("runs in an alarm of its own when it is restarted during the delivery before its purge", async () => {
    const id = newId();
    notifyFailures.set(id, 2);
    const purging = new Workflow(env.BUDGETED_RUNS, "near-budget", {
      retentionLimits: { minMs: 1, maxMs: 60_000 },
      retention: { successRetention: 60_000, errorRetention: 60_000 },
    });
    // Two deliveries fail; the third, before the purge, is held.
    const beforePurge = hold(id, "notify", 3);
    await warningsDuring(async () => {
      await purging.create({ id, retention: { successRetention: 2500 } });
      await beforePurge.held;
    });
    // A stub of its own: one made before the hold can't be used from here.
    const restarter = await purging.get(id);
    await restarter.restart();

    const releasedAt = tick();
    beforePurge.release();
    await until("the restarted run to run its step", () =>
      effectsOf(id, "long").length === 2 ? true : undefined
    );
    await ended("near-budget", id, env.BUDGETED_RUNS);

    await expect(
      ranInFreshAlarm("near-budget", id, "long", releasedAt, 1)
    ).resolves.toStrictEqual({ separateAlarm: true, fits: true });
  });
});

describe("a paused run terminated during an alarm's delivery", () => {
  it("keeps its purge alarm, as the run read after the delivery says", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    await outboxEmpty("napper", id);
    const instance = await workflow("napper").get(id);
    // The pause's delivery fails; the alarm's after the backoff is held.
    notifyFailures.set(id, 1);
    const delivery = hold(id, "notify", checkpointsReached(id, "notify") + 2);
    await warningsDuring(async () => {
      await instance.pause();
      await delivery.held;
    });
    // A stub of its own: one made before the hold can't be used from here.
    const terminator = await workflow("napper").get(id);
    await terminator.terminate();

    delivery.release();
    await outboxEmpty("napper", id);

    const purge = await until("the purge alarm to be set", async () => {
      const { run } = await journalOf("napper", id);
      const alarm = await alarmOf("napper", id);
      return run.purge_at !== null && alarm === run.purge_at
        ? alarm
        : undefined;
    });
    expect(purge).toBeGreaterThan(Date.now());
  });
});

describe("a run due after an alarm's delivery whose alarm write failed", () => {
  it("still gets the alarm that runs it", async () => {
    const id = newId();

    // The delivery's end fails to set the alarm; the alarm's own write
    // after it doesn't.
    const { warnings, failuresLeft } = await dueWithFailingAlarms(
      id,
      1,
      async () => await ended("budget-napper", id, env.BUDGETED_RUNS)
    );

    expect(failuresLeft).toBe(0);
    expect(warnings.map((warning) => eventOf(warning))).toContain(
      "workflow_alarm_set_failed"
    );
    expect(effectsOf(id, "after")).toHaveLength(1);
  });

  it("is left to the watchdog when the alarm's own write fails too", async () => {
    const id = newId();

    // Both fail; the watchdog's, a lease away, is set.
    const { failuresLeft } = await dueWithFailingAlarms(
      id,
      2,
      async () =>
        await until("the second write to have failed", async () => {
          const alarm = await runInDurableObject(
            runObject("budget-napper", id, env.BUDGETED_RUNS),
            async (_, state) => await state.storage.getAlarm()
          );
          return alarm !== null && alarm > Date.now() + defaultLeaseMs / 2
            ? true
            : undefined;
        })
    );

    expect(failuresLeft).toBe(0);
    expect(effectsOf(id, "after")).toStrictEqual([]);
  });
});
