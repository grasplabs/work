// Runs that live through process death: plain workerd on disk-backed
// storage, killed with SIGKILL at each durable commit and started again on
// the same directory, and runs that sleep or wait for an event through it
// with no process alive. Every wait polls with a deadline; the journal each
// test reads back is what recovery had to go on.
import { describe, expect, it } from "vite-plus/test";

import {
  deliveriesOf,
  ended,
  errorMessageOf,
  journalOf,
  keysOf,
  observe,
  onDisk,
  outside,
  runOf,
  sequencesIn,
  startOf,
  statusOf,
  stepsOf,
  timeline,
  workerd,
} from "./death-harness.ts";
import type { ObservedEvent } from "./death-harness.ts";
import { until } from "./outside.ts";

describe("a run on disk-backed workerd", () => {
  onDisk();

  it("resumes rolling back after the process dies mid-rollback: no step runs again, nor a rollback that succeeded", async () => {
    const id = "mid-rollback";
    const undoReserveHeld = outside.hold(id, "undo-reserve", 1);
    await workerd.request("/start", startOf("compensated", id));
    // Killed while the second rollback is out, after the first's commit.
    await undoReserveHeld;
    const cutOff = await journalOf("compensated", id);
    await workerd.kill();
    await workerd.start();

    const status = await ended("compensated", id);

    expect({ status, cutOff }).toMatchObject({
      status: {
        status: "errored",
        error: { name: "ShippingError", message: "No courier came" },
        rollback: { status: "complete" },
      },
      cutOff: {
        run: { status: "rollingBack" },
        steps: [
          { type: "do", name: "charge", state: "succeeded" },
          { type: "do", name: "reserve", state: "succeeded" },
          { type: "do", name: "ship", state: "failed" },
          { type: "rollback", name: "ship", state: "succeeded" },
          { type: "rollback", name: "reserve", state: "running" },
        ],
      },
    });
    // Each forward effect once; the rollback cut off went out again under
    // its one key, which isn't its step's; the others once each.
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["reserve", 1],
      ["ship", 1],
      ["undo-ship", 1],
      ["undo-reserve", 1],
      ["undo-reserve", 2],
      ["undo-charge", 1],
    ]);
    expect(keysOf(id, "undo-reserve").size).toBe(1);
    expect(keysOf(id, "undo-reserve")).not.toStrictEqual(keysOf(id, "reserve"));
  });

  it("counts a replay the process died in, so replays cut off can't go on for ever", async () => {
    const id = "killed-replay";
    const replaysOf = async (): Promise<unknown> => {
      const journal = await journalOf("gated", id);
      return typeof journal === "object" &&
        journal !== null &&
        "run" in journal &&
        typeof journal.run === "object" &&
        journal.run !== null &&
        "rollback_replays" in journal.run
        ? journal.run.rollback_replays
        : undefined;
    };
    const forward = outside.hold(id, "gate");
    await workerd.request("/start", startOf("gated", id));
    await forward;
    // The replay's call outside any step is withheld next: the run fails,
    // rolls back, and its replay waits there.
    const replay = outside.hold(id, "gate");
    outside.release(id, "gate");
    await replay;
    const counted = await replaysOf();
    await workerd.kill();

    const again = outside.hold(id, "gate");
    await workerd.start();
    await again;
    const recounted = await replaysOf();
    // The killed replay's answer goes to no one; the live one's is let go.
    outside.release(id, "gate");
    outside.release(id, "gate");
    const status = await ended("gated", id);

    expect({ counted, recounted }).toStrictEqual({ counted: 1, recounted: 2 });
    expect(status).toMatchObject({
      status: "errored",
      rollback: { status: "complete" },
    });
    expect(timeline(id)).toStrictEqual([
      ["first", 1],
      ["undo-first", 1],
    ]);
  });

  it("doesn't run a completed step again after the process dies; the step cut off mid-effect runs again under its key", async () => {
    const id = "after-a-step-commit";
    const shipHeld = outside.hold(id, "ship", 1);
    const started = await workerd.request("/start", startOf("orders", id));
    await shipHeld;
    // Killed after charge's commit and before ship's, as the journal says.
    const cutOff = await journalOf("orders", id);
    await workerd.kill();
    await workerd.start();

    // The run resumes with no request reaching it: its alarm brings it back.
    await until("ship to go out again", () =>
      outside.of(id, "ship").find((effect) => effect.attempt === 2)
    );
    const status = await ended("orders", id);

    const [charge, , ship] = outside.of(id);
    expect({ started, cutOff }).toMatchObject({
      started: { status: 200, body: { created: true } },
      cutOff: {
        activations: [{ generation: 1, ended: null }],
        steps: [
          { name: "charge", state: "succeeded", attempt: 1 },
          { name: "ship", state: "running", attempt: 1 },
        ],
      },
    });
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["ship", 1],
      ["ship", 2],
    ]);
    expect(keysOf(id, "ship").size).toBe(1);
    // Replay returned charge's original receipt without calling it again.
    expect(status).toStrictEqual({
      status: "complete",
      output: { charge: charge?.receipt, ship: ship?.receipt },
    });
    await expect(journalOf("orders", id)).resolves.toMatchObject({
      activations: [
        { generation: 1, ended: null },
        { generation: 2, ended: "settled" },
      ],
      attempts: [
        { ordinal: 1, attempt: 1, generation: 1, ended: "succeeded" },
        { ordinal: 2, attempt: 1, generation: 1, ended: null },
        { ordinal: 2, attempt: 2, generation: 2, ended: "succeeded" },
      ],
    });
  });

  it.each(["renamed", "reordered"])(
    "fails a run whose steps a deploy %s while the process was dead mid-step, running no step again and none it never ran",
    async (definition) => {
      const id = `redeployed-${definition}`;
      const chargeHeld = outside.hold(id, "charge", 1);
      await workerd.request("/start", startOf(definition, id));
      await chargeHeld;
      // Killed after reserve's commit, with charge out at its effect.
      const cutOff = await journalOf(definition, id);
      await workerd.redeploy("2");

      // The run resumes under the new code with no request reaching it.
      const status = await ended(definition, id);

      expect(status).toMatchObject({
        status: "errored",
        error: { name: "WorkflowReplayMismatchError" },
      });
      // The error names the steps the journal was made on.
      expect(errorMessageOf(status)).toContain('"reserve > charge > ship"');
      // Nothing answered from another step's record, and nothing ran
      // again or for the first time: the effects are the first deploy's.
      expect(timeline(id)).toStrictEqual([
        ["reserve", 1],
        ["charge", 1],
      ]);
      expect(stepsOf(cutOff)).toMatchObject([
        { name: "reserve", state: "succeeded" },
        { name: "charge", state: "running" },
      ]);
      expect(stepsOf(await journalOf(definition, id))).toStrictEqual(
        stepsOf(cutOff)
      );
    }
  );

  it("goes on after a deploy that left its steps as they were, with no step run again but the one cut off", async () => {
    const id = "redeployed-kept";
    const chargeHeld = outside.hold(id, "charge", 1);
    await workerd.request("/start", startOf("kept", id));
    await chargeHeld;
    await workerd.redeploy("2");

    const status = await ended("kept", id);

    const [reserve, , charge, ship] = outside.of(id);
    expect(timeline(id)).toStrictEqual([
      ["reserve", 1],
      ["charge", 1],
      ["charge", 2],
      ["ship", 1],
    ]);
    expect(status).toStrictEqual({
      status: "complete",
      output: [reserve?.receipt, charge?.receipt, ship?.receipt],
    });
  });

  it("throws a journaled step error again after process death without running the step", async () => {
    const id = "after-a-failed-step";
    const notifyHeld = outside.hold(id, "notify", 1);
    await workerd.request("/start", startOf("declined", id));
    await notifyHeld;
    await workerd.restart();

    const status = await ended("declined", id);

    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["notify", 1],
      ["notify", 2],
    ]);
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        declined: "PaymentError: The card was declined",
        notified: outside.of(id, "notify")[1]?.receipt,
      },
    });
    await expect(journalOf("declined", id)).resolves.toMatchObject({
      steps: [
        { name: "charge", state: "failed", attempt: 1 },
        { name: "notify", state: "succeeded", attempt: 2 },
      ],
    });
  });

  it("has no run when the process dies before the start reaches the run object; the start delivered again creates it once", async () => {
    const id = "before-the-start-arrives";
    const announced = outside.hold(id, "announce");
    const lost = workerd
      .request("/start", startOf("orders", id, { announce: true }))
      .catch(() => "lost");
    await announced;
    await workerd.kill();
    const answer = await lost;
    await workerd.start();
    const afterRestart = {
      status: await statusOf("orders", id),
      journal: await journalOf("orders", id),
    };

    const again = await workerd.request("/start", startOf("orders", id));
    await ended("orders", id);

    expect(answer).toBe("lost");
    expect(afterRestart).toMatchObject({
      status: { status: 404 },
      journal: null,
    });
    expect(again).toStrictEqual({ status: 200, body: { created: true } });
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["ship", 1],
    ]);
  });

  it("keeps the run when the process dies after the start commits and before its answer; the start delivered again finds it", async () => {
    const id = "report-commit-before-the-answer";
    const committed = outside.hold(id, "committed");
    const lost = workerd
      .request("/start", startOf("orders", id))
      .catch(() => "lost");
    await committed;
    await workerd.kill();
    const answer = await lost;
    await workerd.start();

    const again = await workerd.request("/start", startOf("orders", id));
    const status = await ended("orders", id);

    // One run: every effect went out under the keys of one run ID.
    const runIds = new Set(
      outside.of(id).map((effect) => effect.key.split(":")[0])
    );
    expect({ answer, again, status }).toMatchObject({
      answer: "lost",
      again: { status: 200, body: { created: false } },
      status: { status: "complete" },
    });
    expect(runIds.size).toBe(1);
    await expect(journalOf("orders", id)).resolves.toMatchObject({
      steps: [
        { name: "charge", state: "succeeded" },
        { name: "ship", state: "succeeded" },
      ],
    });
  });

  it("keeps a deletion the process dies after: the run stays gone mid-step, and its start delivered again creates nothing", async () => {
    const id = "report-delete-mid-step";
    const chargeHeld = outside.hold(id, "charge", 1);
    await workerd.request("/start", startOf("orders", id));
    await chargeHeld;
    // Killed once the deletion committed, before its answer left.
    const deleted = outside.hold(id, "deleted");
    const lost = workerd
      .request(`/delete?definition=orders&id=${id}`, {})
      .catch(() => "lost");
    await deleted;
    await workerd.kill();
    const answer = await lost;
    await workerd.start();
    const afterRestart = {
      status: await statusOf("orders", id),
      journal: await journalOf("orders", id),
    };

    // The start delivered again finds its tombstone; a plain create under
    // the ID is another run, whose alarm would be any old one's too.
    const again = await workerd.request("/start", startOf("orders", id));
    const create = await workerd.request(
      "/start",
      startOf("orders", id, { key: undefined })
    );
    await ended("orders", id);

    expect({ answer, afterRestart, again, create }).toMatchObject({
      answer: "lost",
      afterRestart: { status: { status: 404 }, journal: null },
      again: { status: 200, body: { created: false } },
      create: { status: 200, body: { created: true } },
    });
    // The deleted run's charge went out once, and nothing after it: the
    // new run's steps are its own, under another run's keys.
    const [first, second] = outside.of(id, "charge");
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["charge", 1],
      ["ship", 1],
    ]);
    expect(first?.key).not.toBe(second?.key);
  });

  it("expires a tombstone after its horizon though the process died in between: the same start then creates a run", async () => {
    const id = "tombstone-across-death";
    await workerd.request("/start", startOf("orders", id));
    await ended("orders", id);
    const deleted = await workerd.request(
      `/delete?definition=orders&id=${id}`,
      {}
    );
    const within = await workerd.request("/start", startOf("orders", id));
    // Killed with the expiry still to come: only the alarm the deletion
    // set, stored with the tombstone, can bring it.
    await workerd.kill();
    await workerd.start();

    // Its alarm drops it, with no request: the object empties.
    const tablesAfterDeath = await workerd.request(
      `/tables?definition=orders&id=${id}`
    );
    await until("the tombstone to expire", async () => {
      const { body } = await workerd.request(
        `/tables?definition=orders&id=${id}`
      );
      return Array.isArray(body) && body.length === 0 ? true : undefined;
    });
    const after = await workerd.request("/start", startOf("orders", id));
    await ended("orders", id);

    expect({ deleted, within, tablesAfterDeath }).toMatchObject({
      deleted: { status: 200, body: { deleted: [{ id }], errors: [] } },
      within: { status: 200, body: { created: false } },
      tablesAfterDeath: { body: ["tombstones"] },
    });
    expect(after).toStrictEqual({ status: 200, body: { created: true } });
    // Two runs, one after the other, under keys of their own.
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["ship", 1],
      ["charge", 1],
      ["ship", 1],
    ]);
    expect(keysOf(id, "charge").size).toBe(2);
  });

  it("purges an ended run its retention after its end though the process died in between, tombstone kept", async () => {
    const id = "purged-after-death";
    const retentionMs = 2000;
    await workerd.request("/start", startOf("orders", id, { retentionMs }));
    await ended("orders", id);
    const journal = await journalOf("orders", id);
    // Killed with the purge still to come: only its alarm, stored with the
    // run, can bring it.
    await workerd.kill();
    await workerd.start();

    await until("the run to be purged", async () => {
      const { status } = await statusOf("orders", id);
      return status === 404 ? true : undefined;
    });
    const again = await workerd.request(
      "/start",
      startOf("orders", id, { retentionMs })
    );

    expect(journal).toMatchObject({
      run: { status: "complete", success_retention_ms: retentionMs },
    });
    expect(again).toStrictEqual({ status: 200, body: { created: false } });
    await expect(journalOf("orders", id)).resolves.toBeNull();
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["ship", 1],
    ]);
  });

  it("still runs the run, once, when the process dies after the start commits; the start delivered again finds it", async () => {
    const id = "after-the-start-commit";
    const chargeHeld = outside.hold(id, "charge", 1);
    await workerd.request("/start", startOf("orders", id));
    await chargeHeld;
    await workerd.restart();

    // Delivered again under its key: the same run, not a second one. A
    // plain create of the same ID collides.
    const again = await workerd.request("/start", startOf("orders", id));
    const create = await workerd.request(
      "/start",
      startOf("orders", id, { key: undefined })
    );
    await ended("orders", id);

    expect({ again, create: create.status }).toStrictEqual({
      again: { status: 200, body: { created: false } },
      create: 409,
    });
    expect(JSON.stringify(create.body)).toMatch(/instance\.already_exists/u);
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["charge", 2],
      ["ship", 1],
    ]);
    expect(keysOf(id, "charge").size).toBe(1);
    await expect(journalOf("orders", id)).resolves.toMatchObject({
      activations: [
        { generation: 1, ended: null },
        { generation: 2, ended: "settled" },
      ],
    });
  });

  it("lets a subscriber the process died under take up its events after the last it handled: none missed, none twice, one end", async () => {
    const id = "observed-through-death";
    const afterHeld = outside.hold(id, "after", 1);
    await workerd.request(
      "/start",
      startOf("napper", id, { params: { nap: 200 } })
    );
    const before: ObservedEvent[] = [];
    const cut = observe("napper", id, 0, (event) => {
      before.push(event);
    });
    await afterHeld;
    await until("the attempt at after to be delivered", () =>
      before.some(
        (event) =>
          event.type === "attempt_started" && event.stepName === "after-1"
      )
        ? true
        : undefined
    );

    await workerd.kill();
    const cutOff = await cut;
    await workerd.start();
    const after: ObservedEvent[] = [];
    const resumed = await observe(
      "napper",
      id,
      before.at(-1)?.eventId ?? 0,
      (event) => {
        after.push(event);
      }
    );
    const all: ObservedEvent[] = [];
    await observe("napper", id, 0, (event) => {
      all.push(event);
    });

    expect({ cutOff, resumed }).toStrictEqual({
      cutOff: "cut off",
      resumed: "done",
    });
    expect([...before, ...after]).toStrictEqual(all);
    expect(all.map((event) => event.eventId)).toStrictEqual(
      all.map((_, index) => index + 1)
    );
    expect(
      all
        .filter(
          (event) =>
            event.type === "step_completed" ||
            event.type === "workflow_completed"
        )
        .map((event) => event.stepName ?? event.type)
    ).toStrictEqual(["before-1", "after-1", "workflow_completed"]);
  });

  it("hands the host a run's end again after the process died before the host took it, and empties the outbox once it has", async () => {
    const id = "notified-through-death";
    const endHeld = outside.hold(id, "notify:complete", 1);
    await workerd.request("/start", startOf("orders", id));
    // The end reached the host; its answer hasn't left.
    await endHeld;
    const cutOff = await journalOf("orders", id);

    await workerd.kill();
    await workerd.start();
    await until("the end to reach the host again", () =>
      deliveriesOf(id, "notify:complete").length >= 2 ? true : undefined
    );
    const after = await until("the outbox to empty", async () => {
      const journal = await journalOf("orders", id);
      return runOf(journal)?.notify_at === null ? journal : undefined;
    });

    const [first, again] = deliveriesOf(id, "notify:complete");
    const delivered = deliveriesOf(id).flatMap((delivery) =>
      sequencesIn(delivery.key)
    );
    const cutOffRun = runOf(cutOff);
    expect({
      cutOff: {
        status: cutOffRun?.status,
        pending: typeof cutOffRun?.notify_at === "number",
      },
      after: runOf(after),
      again: again?.key,
    }).toStrictEqual({
      cutOff: { status: "complete", pending: true },
      after: { status: "complete", notify_at: null },
      again: first?.key,
    });
    // In order, each status at least once: only the held one twice.
    expect(delivered).toStrictEqual([1, 2, 3, 3]);
  });

  it("recovers an object evicted mid-step from its journal, with no request reaching it", async () => {
    const id = "evicted-mid-step";
    const shipHeld = outside.hold(id, "ship", 1);
    await workerd.request("/start", startOf("orders", id));
    await shipHeld;

    await workerd.request(`/evict?definition=orders&id=${id}`, {});
    await until("ship to go out again", () =>
      outside.of(id, "ship").find((effect) => effect.attempt === 2)
    );
    const status = await ended("orders", id);

    expect(status).toMatchObject({ status: "complete" });
    expect(timeline(id)).toStrictEqual([
      ["charge", 1],
      ["ship", 1],
      ["ship", 2],
    ]);
    await expect(journalOf("orders", id)).resolves.toMatchObject({
      steps: [
        { name: "charge", state: "succeeded", attempt: 1 },
        { name: "ship", state: "succeeded", attempt: 2 },
      ],
    });
  });
});
