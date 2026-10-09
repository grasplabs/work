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
  checkpointsReached,
  handled,
  effectsOf,
  eventOf,
  hold,
  notifiedOf,
  notifyFailures,
  notifyHangs,
  warningsDuring,
} from "./outside.ts";
import { budgetedHandlerMs, testNotifyTimeoutMs } from "./worker.ts";

const statusesOf = (id: string): string[] =>
  notifiedOf(id).map((notification) => notification.status);

/** Waits until the host has taken `status` of the run. */
const notifiedWith = async (id: string, status: string): Promise<void> => {
  await until(`the host to take ${status} of ${id}`, () =>
    statusesOf(id).includes(status) ? true : undefined
  );
};

/** Waits until the run's outbox is empty, and returns its journal then. */
const outboxEmpty = async (
  definition: string,
  id: string
): Promise<Awaited<ReturnType<typeof journalOf>>> =>
  await until(`the outbox of ${id} to empty`, async () => {
    const journal = await journalOf(definition, id);
    return journal.run.notify_at === null ? journal : undefined;
  });

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

  it("can't let a run terminated while its alarm hands the host the run's notifications run on", async () => {
    const id = newId();
    // The first alarm's delivery, before its activation reads the run.
    const delivery = hold(id, "notify", 1);
    await workflow("orders").create({ id });
    await within("the delivery to be held", delivery.held);
    const instance = await workflow("orders").get(id);

    await instance.terminate();
    delivery.release();
    await notifiedWith(id, "terminated");
    await outboxEmpty("orders", id);

    await expect(instance.status()).resolves.toStrictEqual({
      status: "terminated",
    });
    expect(statusesOf(id)).toStrictEqual(["queued", "terminated"]);
    expect(effectsOf(id)).toStrictEqual([]);
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

  it("before the activation leaves the activation its whole wall time, counted from the alarm", async () => {
    const id = newId();
    const delivery = hold(id, "notify", 1);
    await workflow("quick-pair", env.BUDGETED_RUNS).create({ id });
    await within("the first delivery to be held", delivery.held);
    // The alarm's delivery takes most of a handler's second.
    await within("a while", scheduler.wait(budgetedHandlerMs * 0.7));
    delivery.release();
    await ended("quick-pair", id, env.BUDGETED_RUNS);

    // "first" ran, its half second fitting; "second" didn't fit what was
    // left, and a fresh activation ran it.
    await expect(
      journalOf("quick-pair", id, env.BUDGETED_RUNS)
    ).resolves.toMatchObject({
      attempts: [
        { ordinal: 1, generation: 1 },
        { ordinal: 2, generation: 2 },
      ],
    });
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

/** How many times the run's object's alarm handler ran, so far. */
const alarmsOf = (definition: string, id: string): number => {
  const object = runObject(definition, id).id.toString();
  return handled.filter((handler) => handler === object).length;
};

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
