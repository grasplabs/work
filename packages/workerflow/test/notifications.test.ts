// What a run tells its host of itself, through the run object's real
// boundary: each status it takes, in order, numbered, handed over again
// until the host has it, and never in the way of the run's own alarm.
// Process death between a status and its delivery is in test/process.
import { describe, expect, it } from "vite-plus/test";

import {
  alarmOf,
  deliverAlarm,
  ended,
  journalOf,
  newId,
  suspendedOn,
  until,
  within,
  workflow,
} from "./helpers.ts";
import {
  checkpointsReached,
  effectsOf,
  eventOf,
  hold,
  notifiedOf,
  notifyFailures,
  notifyHangs,
  warningsDuring,
} from "./outside.ts";

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
      notifications.map(({ workflow: name, version, instanceId, runId }) => ({
        name,
        version,
        instanceId,
        runId,
      }))
    ).toStrictEqual(
      notifications.map(() => ({
        name: "orders",
        version: undefined,
        instanceId: id,
        runId: run.run_uid,
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
        .map(({ runId, sequence }) => ({
          second: runId === run.run_uid,
          sequence,
        }))
    ).toStrictEqual([
      { second: false, sequence: 1 },
      { second: true, sequence: 1 },
    ]);
  });
});
