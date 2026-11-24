// What a run tells its host of itself, through the run object's real
// boundary: each status it takes, in order, numbered, handed over again
// until the host has it, and never in the way of the run's own alarm.
// Process death between a status and its delivery is in test/process.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { Workflow } from "../src/binding.ts";
import { notificationBatch } from "../src/notifications.ts";
import {
  alarmOf,
  deliverAlarm,
  ended,
  journalOf,
  newId,
  runObject,
  suspendedOn,
  until,
  within,
  workflow,
} from "./helpers.ts";
import {
  lastOver,
  notifiedWith,
  outboxEmpty,
  statusesOf,
} from "./notifications-harness.ts";
import {
  checkpointsReached,
  eventOf,
  hold,
  notifiedOf,
  notifyFailures,
  notifyHangs,
  warningsDuring,
} from "./outside.ts";
import { budgetedHandlerMs, testNotifyTimeoutMs } from "./worker.ts";

describe("a run's host", () => {
  it("is told each status the run takes, in order, numbered from 1", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);
    await notifiedWith(id, "complete");
    const { run } = await outboxEmpty("orders", id);

    const notifications = notifiedOf(id);

    expect(notifications).toMatchObject([
      { status: "queued", sequence: 1 },
      { status: "running", sequence: 2 },
      { status: "complete", sequence: 3 },
    ]);
    expect(
      notifications.map(
        ({ workflow: name, version, instanceId, runId, createdAt }) => ({
          name,
          version,
          instanceId,
          runId,
          createdAt,
        })
      )
    ).toStrictEqual(
      notifications.map(() => ({
        name: "orders",
        version: undefined,
        instanceId: id,
        runId: run.run_uid,
        createdAt: run.created_at,
      }))
    );
    expect(notifications.map(({ generation }) => generation)).toStrictEqual([
      1, 1, 1,
    ]);
  });

  it("is told with every status when the run's first activation started, so the newest of a batch says it too", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);
    await notifiedWith(id, "complete");
    const { activations } = await outboxEmpty("orders", id);

    const notifications = notifiedOf(id);
    const first = activations[0]?.started_at;

    expect({
      queued: notifications[0]?.firstActivatedAt,
      later: notifications
        .slice(1)
        .map(({ firstActivatedAt }) => firstActivatedAt),
      started: typeof first,
    }).toStrictEqual({
      // Handed over before any activation, or with the batch after it.
      queued: notifications[0]?.firstActivatedAt === null ? null : first,
      later: notifications.slice(1).map(() => first),
      started: "number",
    });
  });

  it("is told a restart's statuses in a new generation, their sequences going on", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await notifiedWith(id, "complete");
    const instance = await workflow("orders").get(id);

    await instance.restart();
    await until("the restarted run to be taken to its end", () =>
      statusesOf(id).length === 6 ? true : undefined
    );

    expect(
      notifiedOf(id).map(({ status, generation, sequence }) => [
        status,
        generation,
        sequence,
      ])
    ).toStrictEqual([
      ["queued", 1, 1],
      ["running", 1, 2],
      ["complete", 1, 3],
      ["queued", 2, 4],
      ["running", 2, 5],
      ["complete", 2, 6],
    ]);
  });

  it("is handed what it failed to take again, after a backoff, in order, until it takes it", async () => {
    const id = newId();
    notifyFailures.set(id, 1);

    const warnings = await warningsDuring(async () => {
      await workflow("orders").create({ id });
      await ended("orders", id);
      await notifiedWith(id, "complete");
    });
    await outboxEmpty("orders", id);

    expect(statusesOf(id)).toStrictEqual(["queued", "running", "complete"]);
    expect(
      warnings
        .map((warning) => eventOf(warning))
        .filter((event) => event === "workflow_notify_failed")
    ).toStrictEqual(["workflow_notify_failed"]);
    // One that failed, then one with all three after the backoff: nothing
    // in between, though the run changed status twice meanwhile.
    expect(checkpointsReached(id, "notify")).toBe(2);
  });

  it("is handed a waiting run's statuses by its alarm after a failure, which doesn't wake the run", async () => {
    const id = newId();
    notifyFailures.set(id, 1);

    await warningsDuring(async () => {
      await workflow("napper").create({ id });
      await notifiedWith(id, "waiting");
    });
    const { deadline } = await suspendedOn("napper", id, "nap");
    await outboxEmpty("napper", id);
    const { activations } = await journalOf("napper", id);

    expect(statusesOf(id)).toStrictEqual(["queued", "running", "waiting"]);
    expect(activations).toMatchObject([{ ended: "suspended" }]);
    await expect(alarmOf("napper", id)).resolves.toBe(deadline);
  });

  it("is told each status once when another activation takes the run over", async () => {
    const id = newId();
    const ship = hold(id, "ship");
    await workflow("orders").create({ id });
    await within("ship to be held", ship.held);

    await deliverAlarm("orders", id);
    await ended("orders", id);
    ship.release();
    await notifiedWith(id, "complete");
    await outboxEmpty("orders", id);

    expect(statusesOf(id)).toStrictEqual(["queued", "running", "complete"]);
  });

  it("is told with each status the newest generation none of whose attempts holds: none while an attempt runs, its own once it lets go, past it once taken over", async () => {
    const shipped = newId();
    const ship = hold(shipped, "ship");
    await workflow("orders").create({ id: shipped });
    await within("ship to be held", ship.held);
    await notifiedWith(shipped, "running");
    await outboxEmpty("orders", shipped);
    const instance = await workflow("orders").get(shipped);
    await instance.terminate();
    await notifiedWith(shipped, "terminated");
    ship.release();

    const napped = newId();
    await workflow("napper").create({ id: napped });
    await suspendedOn("napper", napped, "nap");
    await notifiedWith(napped, "waiting");
    await outboxEmpty("napper", napped);
    const napper = await workflow("napper").get(napped);
    await napper.pause();
    await notifiedWith(napped, "paused");

    expect({
      running: lastOver(shipped, "running"),
      terminated: lastOver(shipped, "terminated"),
      waiting: lastOver(napped, "waiting"),
      paused: lastOver(napped, "paused"),
    }).toStrictEqual({ running: 0, terminated: 2, waiting: 1, paused: 1 });
  });

  it("can't leave a run resumed while its alarm hands the host the run's notifications without running it", async () => {
    const id = newId();
    await workflow("napper").create({ id, params: { duration: 300 } });
    await suspendedOn("napper", id, "nap");
    await outboxEmpty("napper", id);
    const instance = await workflow("napper").get(id);
    // The pause's delivery fails; the alarm's after the backoff is held.
    notifyFailures.set(id, 1);
    const alarmDelivery = hold(
      id,
      "notify",
      checkpointsReached(id, "notify") + 2
    );
    await warningsDuring(async () => {
      await instance.pause();
      await alarmDelivery.held;
    });

    // A stub of its own: one made before the hold, in another context,
    // can't be used from here.
    const resumer = await workflow("napper").get(id);
    await resumer.resume();
    alarmDelivery.release();

    await expect(ended("napper", id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("is given up on when it doesn't answer, and handed it all again", async () => {
    const id = newId();
    notifyHangs.add(id);

    const warnings = await warningsDuring(async () => {
      await workflow("orders").create({ id });
      await ended("orders", id);
      await notifiedWith(id, "complete");
    });

    expect(statusesOf(id)).toStrictEqual(["queued", "running", "complete"]);
    expect(warnings.map((warning) => eventOf(warning))).toContain(
      "workflow_notify_failed"
    );
  });

  it("is told of a pause the run makes while it fails, though a paused run has no alarm of its own", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    await outboxEmpty("napper", id);
    notifyFailures.set(id, 1);
    const instance = await workflow("napper").get(id);

    await warningsDuring(async () => {
      await instance.pause();
      await notifiedWith(id, "paused");
    });
    await outboxEmpty("napper", id);

    expect(statusesOf(id).at(-1)).toBe("paused");
    await expect(alarmOf("napper", id)).resolves.toBeNull();
  });

  it("doesn't wake a waiting run once it has taken the run's statuses", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    const { deadline } = await suspendedOn("napper", id, "nap");
    await notifiedWith(id, "waiting");
    await outboxEmpty("napper", id);

    // A while later, with nothing for the run to do until its wake.
    await within("a while", scheduler.wait(300));
    const { activations } = await journalOf("napper", id);

    expect(activations).toMatchObject([{ ended: "suspended" }]);
    await expect(alarmOf("napper", id)).resolves.toBe(deadline);
  });

  it("is not made to drop what a run created again under the ID hasn't handed over", async () => {
    const id = newId();
    const first = hold(id, "notify", 1);
    await workflow("orders").create({ id });
    await first.held;
    const instance = await workflow("orders").get(id);

    await instance.delete();
    await workflow("orders").create({ id });
    first.release();
    await until("the second run's start to be taken", () =>
      notifiedOf(id).filter((notification) => notification.status === "queued")
        .length === 2
        ? true
        : undefined
    );
    const { run } = await journalOf("orders", id);

    expect(
      notifiedOf(id)
        .filter((notification) => notification.status === "queued")
        .map(({ runId, sequence, createdAt }) => ({
          second: runId === run.run_uid,
          sequence,
          createdAt: createdAt === run.created_at ? "second's" : "earlier",
        }))
    ).toStrictEqual([
      { second: false, sequence: 1, createdAt: "earlier" },
      { second: true, sequence: 1, createdAt: "second's" },
    ]);
  });
});

describe("a delivery to the host", () => {
  it("goes out at once unless the host failed, whatever time the outbox says it is due", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    await outboxEmpty("napper", id);
    // As a trigger whose clock runs ahead of the run object's would.
    await runInDurableObject(runObject("napper", id), (_, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER ahead AFTER UPDATE OF notify_at ON run WHEN new.notify_at IS NOT NULL AND new.notify_failures = 0 BEGIN UPDATE run SET notify_at = new.notify_at + 3600000; END"
      );
    });
    const instance = await workflow("napper").get(id);

    await instance.pause();
    await notifiedWith(id, "paused");
    await runInDurableObject(runObject("napper", id), (_, state) => {
      state.storage.sql.exec("DROP TRIGGER ahead");
    });

    expect(statusesOf(id).at(-1)).toBe("paused");
  });

  it("goes out beside an activation, not before it: the activation keeps its handler's whole wall time", async () => {
    const id = newId();
    // The delivery of the run's start, held as long as the host likes.
    const delivery = hold(id, "notify", 1);
    await workflow("near-budget", env.BUDGETED_RUNS).create({ id });
    await within("the first delivery to be held", delivery.held);
    await ended("near-budget", id, env.BUDGETED_RUNS);
    delivery.release();

    // The step's 900 ms ran in the first activation, which started at once,
    // the delivery beside it: not after the delivery, held past its timeout.
    const journal = await journalOf("near-budget", id, env.BUDGETED_RUNS);
    expect(journal).toMatchObject({
      activations: [{ generation: 1, ended: "settled" }],
      attempts: [{ ordinal: 1, attempt: 1, generation: 1 }],
    });
    expect(
      (journal.activations[0]?.started_at ?? Number.POSITIVE_INFINITY) -
        journal.run.created_at
    ).toBeLessThan(budgetedHandlerMs);
  });

  it("from an alarm is one batch: the rest go out after it, not in its handler's time", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    await outboxEmpty("napper", id);
    notifyFailures.set(id, Number.MAX_SAFE_INTEGER);
    const instance = await workflow("napper").get(id);
    // More statuses than a batch holds, while the host fails.
    const cycles = Math.ceil(notificationBatch / 3) + 2;
    await warningsDuring(async () => {
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one cycle after another
        await instance.pause();
        // oxlint-disable-next-line no-await-in-loop -- one cycle after another
        await instance.resume();
        // oxlint-disable-next-line no-await-in-loop -- one cycle after another
        await suspendedOn("napper", id, "nap");
      }
    });
    await instance.pause();
    notifyFailures.delete(id);
    // The second delivery after the host is back, held.
    const before = notifiedOf(id).length;
    const second = hold(id, "notify", checkpointsReached(id, "notify") + 2);
    // Due now, and no alarm of the object's own until the test's: only the
    // alarm the test delivers hands anything over.
    await runInDurableObject(runObject("napper", id), async (_, state) => {
      state.storage.sql.exec("UPDATE run SET notify_at = 0");
      await state.storage.deleteAlarm();
    });

    const alarmEnded = (async (): Promise<number> => {
      await deliverAlarm("napper", id);
      return Date.now();
    })();
    await within("the rest to be under way", second.held);
    const heldAt = Date.now();
    const endedAt = await within("the alarm to end", alarmEnded);
    const taken = notifiedOf(id).length;
    second.release();
    await outboxEmpty("napper", id);

    // The alarm's handler ended with its one batch, not after the next
    // delivery, which the host holds (until its timeout).
    expect(endedAt - heldAt).toBeLessThan(testNotifyTimeoutMs / 2);
    expect(taken - before).toBe(notificationBatch);
    expect(notifiedOf(id).length - before).toBeGreaterThan(notificationBatch);
  });

  it("from an early alarm doesn't replay a run rolling back that waits for a rollback's retry", async () => {
    const id = newId();
    notifyFailures.set(id, 1);
    await warningsDuring(async () => {
      await workflow("compensated").create({
        id,
        params: { fail: true, flaky: "ship", undoDelay: "1 hour" },
      });
      await notifiedWith(id, "rollingBack");
    });
    await until("the rollback to wait for its retry", async () => {
      const { run } = await journalOf("compensated", id);
      return run.status === "rollingBack" &&
        run.wake_at !== null &&
        run.wake_at > Date.now() + 60_000
        ? true
        : undefined;
    });
    await outboxEmpty("compensated", id);
    await within("a while", scheduler.wait(300));
    const { activations } = await journalOf("compensated", id);

    expect(activations).toMatchObject([
      { generation: 1, ended: "settled" },
      { generation: 2, ended: "suspended" },
    ]);
    expect(activations).toHaveLength(2);
  });

  it("is tried once more before an ended run is purged, though the host's backoff isn't over", async () => {
    const id = newId();
    notifyFailures.set(id, 2);
    const purging = new Workflow(env.RUNS, "orders", {
      retentionLimits: { minMs: 1, maxMs: 60_000 },
      retention: { successRetention: 60_000, errorRetention: 60_000 },
    });

    await warningsDuring(async () => {
      await purging.create({ id, retention: { successRetention: 2500 } });
      await until("the run to be purged", async () =>
        (await runObject("orders", id).status()) === undefined
          ? true
          : undefined
      );
    });

    expect(statusesOf(id)).toStrictEqual(["queued", "running", "complete"]);
  });

  it("before a purge, doesn't let the purge remove a run restarted meanwhile", async () => {
    const id = newId();
    notifyFailures.set(id, 2);
    const purging = new Workflow(env.RUNS, "orders", {
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
    beforePurge.release();

    await expect(ended("orders", id)).resolves.toMatchObject({
      status: "complete",
    });
  });
});

describe("a host's notify timeout", () => {
  it("is a whole number of milliseconds from 1 to a minute: a run object given another starts no run", async () => {
    const outcome = await new Workflow(env.MISTIMED, "orders")
      .create({ id: newId() })
      .then(
        () => "created",
        (error: unknown) => (error instanceof Error ? error.message : "?")
      );

    expect(outcome).toBe(
      "A run's notifyTimeoutMs is a whole number of milliseconds from 1 to 60000: 0"
    );
  });

  it("over a minute fails each delivery under it, saying why, and hands nothing over", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    await outboxEmpty("napper", id);
    // As a host that set it so would have.
    const setTimeoutMs = async (ms: number): Promise<void> => {
      await runInDurableObject(runObject("napper", id), (run) => {
        Reflect.set(run, "notifyTimeoutMs", ms);
      });
    };
    await setTimeoutMs(60_001);
    const instance = await workflow("napper").get(id);

    const warnings = await warningsDuring(async () => {
      await instance.pause();
      await within("a while", scheduler.wait(300));
    });
    await setTimeoutMs(testNotifyTimeoutMs);

    expect(statusesOf(id)).not.toContain("paused");
    expect(warnings).toContainEqual(
      expect.objectContaining({
        event: "workflow_notify_failed",
        errorMessage:
          "A run's notifyTimeoutMs is a whole number of milliseconds from 1 to 60000: 60001",
      })
    );
  });
});

describe("an alarm that comes while a delivery is out", () => {
  it("leaves it to that delivery, and doesn't wait for the host", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    await outboxEmpty("napper", id);
    const delivery = hold(id, "notify", checkpointsReached(id, "notify") + 1);
    const instance = await workflow("napper").get(id);
    await instance.pause();
    await within("the delivery to be held", delivery.held);

    const startedAt = Date.now();
    await within("the alarm to end", deliverAlarm("napper", id));
    const took = Date.now() - startedAt;
    delivery.release();
    await notifiedWith(id, "paused");

    expect(took).toBeLessThan(testNotifyTimeoutMs / 2);
  });
});
