// Subscriptions to a run's events, through the instance's real boundary:
// what a run tells its observers, in what order, from a cursor and through
// a filter, live and after the fact, and how a subscription ends. Process
// death and reconnecting across it are in test/process.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import type {
  WorkflowInstanceEvent,
  WorkflowInstanceSubscription,
} from "../src/contracts.ts";
import { maxSubscriptions, WorkflowRun } from "../src/run.ts";
import {
  deliverAlarm,
  ended,
  eventsOf,
  journalOf,
  newId,
  runObject,
  suspendedOn,
  until,
  within,
  workflow,
} from "./helpers.ts";
import { effectsOf, hold } from "./outside.ts";

const typesOf = (events: WorkflowInstanceEvent[]): string[] =>
  events.map((event) =>
    "stepName" in event ? `${event.type} ${event.stepName}` : event.type
  );

/** What a subscription's `next` failed with, or that it didn't. */
const refusalOf = async (
  subscription: WorkflowInstanceSubscription
): Promise<string> => {
  try {
    await subscription.next();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
};

const closed = `instance.subscription_closed: this run has more than ${maxSubscriptions} subscriptions open, and this, the oldest, was closed; subscribe again from the last event ID handled`;

/** How long a test lets a subscription wait before it acts on it. */
const waitedMs = 100;

const stepsOf = ["charge-1", "ship-1"].flatMap((step) => [
  `step_started ${step}`,
  `attempt_started ${step}`,
  `attempt_completed ${step}`,
  `step_completed ${step}`,
]);

describe("a subscription to a run", () => {
  it("delivers every event of the run in the order it happened, numbered from 1, and ends with its end", async () => {
    const id = newId();
    await workflow("orders").create({ id, params: { order: 7 } });
    const status = await ended("orders", id);

    const events = await eventsOf("orders", id);

    expect(typesOf(events)).toStrictEqual([
      "workflow_queued",
      "workflow_started",
      "workflow_running",
      ...stepsOf,
      "workflow_completed",
    ]);
    expect(events.map((event) => event.eventId)).toStrictEqual(
      events.map((_, index) => index + 1)
    );
    expect(events).toMatchObject([
      { instanceId: id },
      { params: { order: 7 } },
      {},
      {
        stepName: "charge-1",
        config: {
          retries: { limit: 5, delay: 10_000, backoff: "exponential" },
          timeout: 600_000,
        },
      },
      { attempt: 1 },
      { attempt: 1 },
      { output: effectsOf(id, "charge")[0]?.receipt },
      ...Array.from({ length: 4 }, () => ({})),
      {
        output: status.status === "complete" ? status.output : undefined,
      },
    ]);
  });

  it("delivers the events of a run still running as they happen, and is done after its end", async () => {
    const id = newId();
    const ship = hold(id, "ship");
    await workflow("orders").create({ id });
    const instance = await workflow("orders").get(id);
    using subscription = await instance.subscribe({
      filter: ["step_completed", "workflow_completed"],
    });

    const first = await within("charge", subscription.next());
    await within("ship to be held", ship.held);
    const next = subscription.next();
    ship.release();

    expect(first).toMatchObject({
      done: false,
      value: { type: "step_completed", stepName: "charge-1" },
    });
    await expect(within("ship", next)).resolves.toMatchObject({
      value: { type: "step_completed", stepName: "ship-1" },
    });
    await expect(within("the end", subscription.next())).resolves.toMatchObject(
      { done: false, value: { type: "workflow_completed" } }
    );
    await expect(subscription.next()).resolves.toStrictEqual({
      done: true,
      value: undefined,
    });
  });

  it("picks up after its cursor, with none of the events before it and none missing after", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);
    const all = await eventsOf("orders", id);

    const cursors = [0, 1, 5, all.length - 1, all.length, all.length + 10];
    const resumed = await Promise.all(
      cursors.map(async (cursor) => await eventsOf("orders", id, { cursor }))
    );

    expect(resumed).toStrictEqual(cursors.map((cursor) => all.slice(cursor)));
  });

  it("delivers only the types its filter names, and ends at the run's end even when the filter leaves it out", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);

    const completions = await eventsOf("orders", id, {
      filter: ["step_completed"],
    });
    const none = await eventsOf("orders", id, { filter: [] });
    const end = await eventsOf("orders", id, {
      filter: ["workflow_completed", "workflow_errored", "workflow_terminated"],
    });

    expect(typesOf(completions)).toStrictEqual([
      "step_completed charge-1",
      "step_completed ship-1",
    ]);
    expect(none).toStrictEqual([]);
    expect(typesOf(end)).toStrictEqual(["workflow_completed"]);
  });

  it("tells of a failed attempt with its error and the retry's delay, and of a step that failed", async () => {
    const id = newId();
    await workflow("retrying").create({
      id,
      params: {
        fails: 2,
        config: { retries: { limit: 1, delay: 50, backoff: "constant" } },
      },
    });
    await ended("retrying", id);

    const events = await eventsOf("retrying", id, {
      filter: ["attempt_errored", "step_errored", "workflow_completed"],
    });

    expect(events).toMatchObject([
      {
        type: "attempt_errored",
        stepName: "flaky-1",
        attempt: 1,
        retryDelayMs: 50,
        error: { name: "FlakyError", message: "attempt 1 failed" },
      },
      {
        type: "attempt_errored",
        stepName: "flaky-1",
        attempt: 2,
        error: { name: "FlakyError", message: "attempt 2 failed" },
      },
      { type: "step_errored", stepName: "flaky-1" },
      { type: "workflow_completed" },
    ]);
    expect(events[1]).not.toHaveProperty("retryDelayMs");
  });

  it("tells of a sleep, and of the run waiting and running again around it", async () => {
    const id = newId();
    await workflow("napper").create({ id, params: { duration: 200 } });
    await ended("napper", id);

    const events = await eventsOf("napper", id, {
      filter: [
        "sleep_started",
        "sleep_completed",
        "workflow_waiting",
        "workflow_running",
      ],
    });

    expect(events).toMatchObject([
      { type: "workflow_running" },
      { type: "sleep_started", stepName: "nap-1", durationMs: 200 },
      { type: "workflow_waiting" },
      { type: "workflow_running" },
      { type: "sleep_completed", stepName: "nap-1" },
    ]);
  });

  it("tells of an event wait that took its event, and of one that timed out", async () => {
    const approved = newId();
    const late = newId();
    await workflow("approval").create({ id: approved });
    await workflow("deadline").create({ id: late, params: { duration: 100 } });
    await suspendedOn("approval", approved, "approval");
    const instance = await workflow("approval").get(approved);
    await instance.sendEvent({ type: "approved", payload: "yes" });
    await ended("approval", approved);
    const deadline = await workflow("deadline").get(late);
    await suspendedOn("deadline", late, "later");
    await deadline.sendEvent({ type: "reply", payload: "late" });
    await ended("deadline", late);
    const waits = {
      filter: ["wait_started", "wait_completed", "wait_timed_out"],
    } as const;

    await expect(eventsOf("approval", approved, waits)).resolves.toMatchObject([
      { type: "wait_started", stepName: "approval-1", eventType: "approved" },
      { type: "wait_completed", stepName: "approval-1" },
    ]);
    await expect(eventsOf("deadline", late, waits)).resolves.toMatchObject([
      { type: "wait_started", stepName: "reply-1", eventType: "reply" },
      { type: "wait_timed_out", stepName: "reply-1" },
      { type: "wait_started", stepName: "later-1" },
      { type: "wait_completed", stepName: "later-1" },
    ]);
  });

  it("tells of a rolling back, step by step, before the run's error", async () => {
    const id = newId();
    await workflow("compensated").create({ id, params: { fail: true } });
    await ended("compensated", id);

    const events = await eventsOf("compensated", id);
    const after = events.slice(
      events.findIndex((event) => event.type === "rollback_started")
    );

    expect(typesOf(after)).toStrictEqual([
      "rollback_started",
      ...["ship-1", "charge-1", "reserve-1"].flatMap((step) => [
        `rollback_step_started ${step}`,
        `rollback_attempt_started ${step}`,
        `rollback_attempt_completed ${step}`,
        `rollback_step_completed ${step}`,
      ]),
      "rollback_completed",
      "workflow_errored",
    ]);
    expect(after.at(-1)).toMatchObject({
      error: { name: "ShippingError", message: "No courier came" },
    });
  });

  it("tells of a rollback that couldn't run, and of the rolling back's error", async () => {
    const id = newId();
    await workflow("nested-rollback").create({ id });
    await ended("nested-rollback", id);

    const events = await eventsOf("nested-rollback", id, {
      filter: [
        "rollback_started",
        "rollback_step_started",
        "rollback_step_errored",
        "rollback_completed",
        "rollback_errored",
        "workflow_errored",
      ],
    });

    expect(events).toMatchObject([
      { type: "rollback_started" },
      { type: "rollback_step_started", stepName: "inner-1" },
      {
        type: "rollback_step_errored",
        stepName: "inner-1",
        error: { name: "RollbackMissing" },
      },
      { type: "rollback_errored" },
      { type: "workflow_errored", error: { name: "ShippingError" } },
    ]);
  });

  it("tells of a pause, a resume and a termination, and ends with the termination", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    const instance = await workflow("napper").get(id);
    using subscription = await instance.subscribe({
      cursor: 0,
      filter: ["workflow_paused", "workflow_running", "workflow_terminated"],
    });
    const seen: WorkflowInstanceEvent[] = [];
    const read = async (count: number): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one event a call
        const result = await within("an event", subscription.next());
        if (result.done !== true) {
          seen.push(result.value);
        }
      }
    };
    await read(1);

    await instance.pause();
    await read(1);
    await instance.resume();
    await read(1);
    await suspendedOn("napper", id, "nap");
    await instance.terminate();
    await read(1);

    expect(seen.map((event) => event.type)).toStrictEqual([
      "workflow_running",
      "workflow_paused",
      "workflow_running",
      "workflow_terminated",
    ]);
    await expect(subscription.next()).resolves.toMatchObject({ done: true });
  });

  it("is done when the run is deleted while it waits", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    const instance = await workflow("napper").get(id);
    using subscription = await instance.subscribe({
      filter: ["workflow_completed"],
    });
    const waiting = subscription.next();

    await instance.delete();

    await expect(within("the end", waiting)).resolves.toStrictEqual({
      done: true,
      value: undefined,
    });
  });

  it("ends a wait when it is disposed, and every call after", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");

    // In the run object, where workerd disposes of it once its caller's
    // stub is released.
    const answers = await runInDurableObject(
      runObject("napper", id),
      async (run) => {
        const subscription =
          run instanceof WorkflowRun
            ? run.subscribe({ cursor: 0, filter: [] })
            : undefined;
        if (subscription === undefined) {
          throw new Error("no run");
        }
        const waiting = subscription.next();
        // Still waiting a while later: the run sleeps, and writes nothing.
        const before = await Promise.race([
          waiting,
          scheduler.wait(waitedMs).then(() => "waiting"),
        ]);
        subscription[Symbol.dispose]();
        return [before, await waiting, await subscription.next()];
      }
    );

    expect(answers).toStrictEqual([
      "waiting",
      { done: true, value: undefined },
      { done: true, value: undefined },
    ]);
  });

  it("is cut off, the oldest first, once the run has as many open as it keeps, and is taken up again from its cursor", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    const instance = await workflow("napper").get(id);
    using oldest = await instance.subscribe();
    const first = await oldest.next();
    const cursor = first.done === true ? 0 : first.value.eventId;
    const opened = await Promise.all(
      Array.from(
        { length: maxSubscriptions },
        async () => await instance.subscribe()
      )
    );

    // Cut off, and every call after: never taken for the run's end.
    const refusals = [await refusalOf(oldest), await refusalOf(oldest)];

    expect(refusals).toStrictEqual([closed, closed]);
    using again = await instance.subscribe({ cursor });
    await expect(again.next()).resolves.toMatchObject({
      value: { eventId: cursor + 1 },
    });
    for (const subscription of opened) {
      subscription[Symbol.dispose]();
    }
  });
});

describe("a run's events after a restart", () => {
  it("start again from the run's queueing, under IDs never handed out before, with one completion", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);
    const before = await eventsOf("orders", id);
    const instance = await workflow("orders").get(id);

    await instance.restart();
    await until("the run to end again", async () => {
      const events = await eventsOf("orders", id, {
        cursor: before.length,
        filter: ["workflow_completed"],
      });
      return events.length === 1 ? events : undefined;
    });
    const after = await eventsOf("orders", id);

    expect(typesOf(after)).toStrictEqual([
      "workflow_queued",
      "workflow_started",
      "workflow_running",
      ...stepsOf,
      "workflow_completed",
    ]);
    expect(after[0]?.eventId).toBeGreaterThan(before.at(-1)?.eventId ?? 0);
  });

  it("don't reach a subscription that delivered the end before the restart", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);
    const instance = await workflow("orders").get(id);
    using subscription = await instance.subscribe({
      filter: ["workflow_completed"],
    });
    const end = await subscription.next();

    await instance.restart();
    await ended("orders", id);

    expect(end).toMatchObject({ value: { type: "workflow_completed" } });
    await expect(subscription.next()).resolves.toStrictEqual({
      done: true,
      value: undefined,
    });
  });

  it("keep the events of the steps before the one restarted from", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);
    const instance = await workflow("orders").get(id);

    await instance.restart({ from: { name: "ship" } });
    await ended("orders", id);
    const events = await eventsOf("orders", id);

    expect(typesOf(events)).toStrictEqual([
      "workflow_queued",
      "workflow_started",
      ...stepsOf.slice(0, 4),
      "workflow_running",
      ...stepsOf.slice(4),
      "workflow_completed",
    ]);
  });
});

describe("an attempt whose answer came after another took over", () => {
  it("tells nothing more of itself: its step's events are the attempt that answered", async () => {
    const id = newId();
    const ship = hold(id, "ship");
    await workflow("orders").create({ id });
    await within("ship to be held", ship.held);

    // Another activation takes over, and runs ship again to the end.
    await deliverAlarm("orders", id);
    await ended("orders", id);
    ship.release();
    await until("the first activation to end", async () => {
      const journal = await journalOf("orders", id);
      return journal.activations[0]?.ended === null ? undefined : true;
    });
    const events = await eventsOf("orders", id);
    const end = events.at(-1)?.eventId ?? 0;

    expect(typesOf(events)).toStrictEqual([
      "workflow_queued",
      "workflow_started",
      "workflow_running",
      ...stepsOf.slice(0, 4),
      "step_started ship-1",
      "attempt_started ship-1",
      "attempt_started ship-1",
      "attempt_completed ship-1",
      "step_completed ship-1",
      "workflow_completed",
    ]);
    await expect(
      eventsOf("orders", id, { cursor: end })
    ).resolves.toStrictEqual([]);
  });
});

describe("a run's end", () => {
  it("is told once, however often its alarm is delivered again", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);

    await deliverAlarm("orders", id);
    await deliverAlarm("orders", id);
    const events = await eventsOf("orders", id);

    expect(
      events.filter((event) => event.type === "workflow_completed")
    ).toHaveLength(1);
  });
});

describe("the history observers are shown", () => {
  it("holds no output, so a run's values aren't kept twice", async () => {
    const id = newId();
    const secret = `secret-${id}`;
    await workflow("orders").create({ id, params: { secret } });
    await ended("orders", id);

    const rows = await runInDurableObject(runObject("orders", id), (_, state) =>
      state.storage.sql.exec("SELECT * FROM history").toArray()
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
});

describe("subscribe", () => {
  it("refuses options it doesn't take, before it reaches the run", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    const instance = await workflow("orders").get(id);
    const refused = [
      { cursor: -1 },
      { cursor: 1.5 },
      { cursor: "3" },
      { filter: "step_completed" },
      { filter: ["step_done"] },
      { since: 3 },
      "all",
      null,
    ];

    const outcomes = await Promise.all(
      refused.map(async (options) => {
        try {
          // SAFETY: the point is a value the types refuse; subscribe checks it.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          await instance.subscribe(options as never);
        } catch (error) {
          return error instanceof TypeError
            ? error.message
            : `not a TypeError: ${String(error)}`;
        }
        return "subscribed";
      })
    );

    expect(outcomes).toStrictEqual([
      "A subscription's cursor is an event ID, a whole number from 0: -1",
      "A subscription's cursor is an event ID, a whole number from 0: 1.5",
      'A subscription\'s cursor is an event ID, a whole number from 0: "3"',
      'A subscription\'s filter is a list of event types, not "step_completed"',
      'A subscription\'s filter takes event types, not "step_done"',
      'A subscription\'s options has no setting "since"',
      'A subscription\'s options are { cursor?, filter? }, not "all"',
      "A subscription's options are { cursor?, filter? }, not null",
    ]);
  });

  it("refuses an instance that no longer exists", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    const instance = await workflow("orders").get(id);
    await instance.delete();

    await expect(instance.subscribe()).rejects.toThrow("instance.not_found");
  });
});
