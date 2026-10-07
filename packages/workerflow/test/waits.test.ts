// Sleeps and event waits through the run object's real boundary: a wait
// that isn't due suspends the run with no activation alive, and every
// alarm and event after replays to it. Process death and eviction while
// waiting are in test/process.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { SerializationError, encode } from "../src/codec.ts";
import type { InstanceEvent } from "../src/instance.ts";
import {
  maxEventPayloadBytes,
  maxInboxBytes,
  maxInboxEvents,
} from "../src/journal.ts";
import { WorkflowRun } from "../src/run.ts";
import {
  alarmOf,
  deliverAlarm,
  ended,
  holdAlarmUntil,
  journalOf,
  newId,
  pastTime,
  runObject,
  suspendedOn,
  until,
  workflow,
} from "./helpers.ts";
import { effectsOf, hold } from "./outside.ts";

/** Far enough ahead that no alarm the test holds back fires on its own. */
const heldBackMs = 60 * 60 * 1000;

const instance = async (definition: string, id: string) =>
  await workflow(definition).get(id);

const send = async (
  definition: string,
  id: string,
  event: InstanceEvent
): Promise<void> => {
  const run = await instance(definition, id);
  await run.sendEvent(event);
};

const statusOf = async (definition: string, id: string) => {
  const run = await instance(definition, id);
  return await run.status();
};

const labels = (id: string): string[] =>
  effectsOf(id).map((effect) => effect.label);

/** What the definition's own code did outside any step. */
const witnessed = (id: string): string[] =>
  effectsOf(id)
    .filter((effect) => effect.attempt === 0)
    .map((effect) => effect.label);

describe("a sleep", () => {
  it("suspends the run with its deadline journaled, and no alarm, early or duplicate, moves it", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    const { deadline } = await suspendedOn("napper", id, "nap");

    // Alarms before the deadline: each activation replays to the sleep and
    // lets go of the run again. Each returns: a waiting run holds nothing.
    await deliverAlarm("napper", id);
    await deliverAlarm("napper", id);

    const journal = await journalOf("napper", id);
    expect(journal).toMatchObject({
      run: { status: "waiting", wake_at: deadline, lease_until: null },
      activations: [
        { generation: 1, ended: "suspended" },
        { generation: 2, ended: "suspended" },
        { generation: 3, ended: "suspended" },
      ],
      steps: [
        { type: "do", name: "before", state: "succeeded" },
        { type: "sleep", name: "nap", state: "waiting", deadline },
      ],
    });
    await expect(alarmOf("napper", id)).resolves.toBe(deadline);
    await expect(statusOf("napper", id)).resolves.toStrictEqual({
      status: "waiting",
    });
    expect(labels(id)).toStrictEqual(["before"]);
  });

  it("wakes at its deadline by the alarm alone, and the run goes on from there", async () => {
    const id = newId();
    await workflow("napper").create({ id, params: { duration: "2 seconds" } });
    const { deadline } = await suspendedOn("napper", id, "nap");

    const status = await ended("napper", id);

    const [before, after] = effectsOf(id);
    expect(status).toStrictEqual({
      status: "complete",
      output: { before: before?.receipt, after: after?.receipt },
    });
    expect(after?.at).toBeGreaterThanOrEqual(deadline);
    await expect(journalOf("napper", id)).resolves.toMatchObject({
      activations: [
        { generation: 1, ended: "suspended" },
        { generation: 2, ended: "settled" },
      ],
      steps: [
        { name: "before", attempt: 1 },
        { name: "nap", state: "succeeded", deadline },
        { name: "after", attempt: 1 },
      ],
    });
  });

  it("goes on at once for a duration of 0 or a time already past, without suspending", async () => {
    const zero = newId();
    const past = newId();
    await workflow("napper").create({ id: zero, params: { duration: 0 } });
    await workflow("sleeps-until").create({
      id: past,
      params: { at: new Date(Date.now() - 1000) },
    });

    await expect(ended("napper", zero)).resolves.toMatchObject({
      status: "complete",
    });
    await expect(ended("sleeps-until", past)).resolves.toStrictEqual({
      status: "complete",
      output: "woke",
    });
    for (const [definition, id] of [
      ["napper", zero],
      ["sleeps-until", past],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- two runs, read in turn
      const { activations } = await journalOf(definition, id);
      expect(activations).toMatchObject([{ generation: 1, ended: "settled" }]);
    }
  });

  it("sleeps until a time given as a Date or as milliseconds", async () => {
    const asDate = newId();
    const asNumber = newId();
    const at = Date.now() + 300;
    await workflow("sleeps-until").create({
      id: asDate,
      params: { at: new Date(at) },
    });
    await workflow("sleeps-until").create({ id: asNumber, params: { at } });

    await expect(ended("sleeps-until", asDate)).resolves.toMatchObject({
      status: "complete",
    });
    await expect(ended("sleeps-until", asNumber)).resolves.toMatchObject({
      status: "complete",
    });
    for (const id of [asDate, asNumber]) {
      // oxlint-disable-next-line no-await-in-loop -- two runs, read in turn
      const { steps } = await journalOf("sleeps-until", id);
      expect(steps).toMatchObject([{ type: "sleep", deadline: at }]);
    }
  });

  it.each([
    ["a unit it doesn't know", "10 secs"],
    ["a negative duration", -1],
    ["more than 365 days", "366 days"],
    ["a bare numeric string", "1000"],
  ])("refuses %s with a TypeError", async (_, duration) => {
    const id = newId();
    await workflow("napper").create({ id, params: { duration } });

    await expect(ended("napper", id)).resolves.toMatchObject({
      status: "errored",
      error: { name: "TypeError" },
    });
  });

  it.each([
    ["a date as text", "2026-10-07"],
    ["an object that isn't a Date", { time: 0 }],
    ["more than 365 days ahead", Date.now() + 366 * 24 * 60 * 60 * 1000],
  ])("refuses a sleepUntil given %s", async (_, at) => {
    const id = newId();
    await workflow("sleeps-until").create({ id, params: { at } });

    await expect(ended("sleeps-until", id)).resolves.toMatchObject({
      status: "errored",
      error: { name: "TypeError" },
    });
  });
});

describe("an event wait", () => {
  it("takes an event sent before the wait was reached, without suspending", async () => {
    const id = newId();
    const before = hold(id, "before");
    await workflow("approval").create({ id });
    await before.held;

    await send("approval", id, {
      type: "approved",
      payload: { by: "ann" },
    });
    before.release();
    const status = await ended("approval", id);

    const journal = await journalOf("approval", id);
    const wait = journal.steps.find((step) => step.name === "approval");
    const [event] = journal.events;
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        approved: {
          payload: { by: "ann" },
          timestamp: new Date(event?.accepted_at ?? Number.NaN),
          type: "approved",
        },
        after: effectsOf(id, "after")[0]?.receipt,
      },
    });
    expect(journal.activations).toMatchObject([{ ended: "settled" }]);
    expect(journal.events).toMatchObject([
      { type: "approved", consumed_by: wait?.ordinal },
    ]);
  });

  it("wakes a suspended run when its event arrives", async () => {
    const id = newId();
    await workflow("approval").create({ id });
    await suspendedOn("approval", id, "approval");

    await send("approval", id, {
      type: "approved",
      payload: "yes",
    });
    const status = await ended("approval", id);

    expect(status).toMatchObject({
      status: "complete",
      output: { approved: { payload: "yes", type: "approved" } },
    });
    await expect(journalOf("approval", id)).resolves.toMatchObject({
      activations: [{ ended: "suspended" }, { ended: "settled" }],
    });
  });

  it("leaves an event of another type in the inbox, and the run asleep", async () => {
    const id = newId();
    await workflow("approval").create({ id });
    const { deadline } = await suspendedOn("approval", id, "approval");

    await send("approval", id, { type: "rejected" });

    const journal = await journalOf("approval", id);
    expect(journal).toMatchObject({
      run: { status: "waiting" },
      events: [{ type: "rejected", consumed_by: null }],
    });
    await expect(alarmOf("approval", id)).resolves.toBe(deadline);
  });

  it("gives each of two waits for one type its own event, in the order they were accepted", async () => {
    const id = newId();
    const before = hold(id, "before");
    await workflow("votes").create({ id });
    await before.held;

    const run = await instance("votes", id);
    await run.sendEvent({ type: "vote", payload: 1 });
    await run.sendEvent({ type: "vote", payload: 2 });
    await run.sendEvent({ type: "vote", payload: 3 });
    before.release();
    const status = await ended("votes", id);

    const { steps, events } = await journalOf("votes", id);
    const [, first, second] = steps;
    expect(status).toStrictEqual({ status: "complete", output: [1, 2] });
    expect(events.map((event) => event.consumed_by)).toStrictEqual([
      first?.ordinal,
      second?.ordinal,
      null,
    ]);
  });

  it("wakes the run when a delivery comes again after the first one's wake failed to be written", async () => {
    const id = newId();
    await workflow("approval").create({ id });
    const { deadline } = await suspendedOn("approval", id, "approval");
    const delivery = {
      type: "approved",
      payload: "retried",
      key: `delivery-${newId()}`,
    };

    // The event is journaled; the alarm write after it fails.
    const failed = await runInDurableObject(
      runObject("approval", id),
      async (run, state) => {
        if (!(run instanceof WorkflowRun)) {
          throw new TypeError("the object isn't a run object");
        }
        const { storage } = state;
        // The object's own storage, failing its next alarm write, then
        // put back as it was (an own property or the prototype's).
        const hadOwn = Object.hasOwn(storage, "setAlarm");
        const original: unknown = Reflect.get(storage, "setAlarm");
        Reflect.set(storage, "setAlarm", async () => {
          await Promise.resolve();
          throw new Error("injected alarm write failure");
        });
        try {
          await run.sendEvent({
            ...delivery,
            payload: encode(delivery.payload),
          });
          return false;
        } catch {
          return true;
        } finally {
          if (hadOwn) {
            Reflect.set(storage, "setAlarm", original);
          } else {
            Reflect.deleteProperty(storage, "setAlarm");
          }
        }
      }
    );
    const alarmAfterFailure = await alarmOf("approval", id);
    const run = await instance("approval", id);
    const retry = await run.deliverEvent(delivery);
    const status = await ended("approval", id);

    expect(failed).toBeTruthy();
    expect(alarmAfterFailure).toBe(deadline);
    expect(retry).toStrictEqual({ accepted: false });
    expect(status).toMatchObject({
      status: "complete",
      output: { approved: { payload: "retried" } },
    });
  });

  it("accepts a delivery sent again under its key once, whatever order its payload's keys are in", async () => {
    const id = newId();
    await workflow("approval").create({ id });
    await suspendedOn("approval", id, "approval");
    const run = await instance("approval", id);
    const key = `delivery-${newId()}`;

    const first = await run.deliverEvent({
      type: "approved",
      payload: { by: "ann", at: 1 },
      key,
    });
    const again = await run.deliverEvent({
      type: "approved",
      payload: { at: 1, by: "ann" },
      key,
    });
    await ended("approval", id);
    // After the run ended, the same delivery is still the same event.
    const late = await run.deliverEvent({
      type: "approved",
      payload: { by: "ann", at: 1 },
      key,
    });

    expect([first, again]).toStrictEqual([
      { accepted: true },
      { accepted: false },
    ]);
    expect(late).toStrictEqual({ accepted: false });
    await expect(
      run.deliverEvent({ type: "approved", payload: { by: "bob" }, key })
    ).rejects.toThrow(/another type or payload/u);
    const { events } = await journalOf("approval", id);
    expect(events).toHaveLength(1);
  });

  it("replays the event it took when an alarm takes the run over, though another of its type has arrived since", async () => {
    const id = newId();
    const after = hold(id, "after");
    await workflow("approval").create({ id });
    await suspendedOn("approval", id, "approval");

    await send("approval", id, { type: "approved", payload: "first" });
    await after.held;
    // A fresh instance: the held promise resolved in the run object's
    // context, and a stub from before can't be used from there.
    await send("approval", id, { type: "approved", payload: "second" });
    // Another activation, while the one that took "first" is out at a step.
    await deliverAlarm("approval", id);
    const status = await ended("approval", id);
    after.release();

    const journal = await journalOf("approval", id);
    const wait = journal.steps.find((step) => step.name === "approval");
    expect(status).toMatchObject({
      status: "complete",
      output: { approved: { payload: "first" } },
    });
    expect(journal.events).toMatchObject([
      { payload: encode("first"), consumed_by: wait?.ordinal },
      { payload: encode("second"), consumed_by: null },
    ]);
  });

  it("times out at its deadline by the alarm alone, with Cloudflare's WorkflowTimeoutError", async () => {
    const id = newId();
    await workflow("approval").create({
      id,
      params: { duration: "3 seconds" },
    });
    await suspendedOn("approval", id, "approval");

    const status = await ended("approval", id);

    expect(status).toStrictEqual({
      status: "errored",
      error: {
        name: "WorkflowTimeoutError",
        message: "Execution timed out after 3000ms",
      },
    });
    expect(labels(id)).toStrictEqual(["before"]);
  });

  it("takes an event accepted before its deadline even when the alarm that hands it over comes after", async () => {
    const id = newId();
    await workflow("deadline").create({
      id,
      params: { duration: "3 seconds" },
    });
    const { deadline } = await suspendedOn("deadline", id, "reply");

    // Accepted in time; the wake it sets is held back past the deadline.
    await holdAlarmUntil(
      "deadline",
      id,
      deadline + heldBackMs,
      async (run) =>
        await run.sendEvent({
          type: "reply",
          payload: encode("on time"),
          key: null,
        })
    );
    await pastTime(deadline);
    await deliverAlarm("deadline", id);
    const status = await ended("deadline", id);

    const { events } = await journalOf("deadline", id);
    expect(events[0]?.accepted_at).toBeLessThan(deadline);
    expect(status).toStrictEqual({
      status: "complete",
      output: { reply: "on time" },
    });
  });

  it("times out when its event is accepted after the deadline, though the alarm hasn't come yet; a later wait takes that event", async () => {
    const id = newId();
    await workflow("deadline").create({
      id,
      params: { duration: "3 seconds" },
    });
    const { deadline } = await suspendedOn("deadline", id, "reply");
    await holdAlarmUntil("deadline", id, deadline + heldBackMs);
    await pastTime(deadline);

    await send("deadline", id, {
      type: "reply",
      payload: "late",
    });
    // A late event wakes nothing: the wait it could have ended is over.
    const alarm = await alarmOf("deadline", id);
    await deliverAlarm("deadline", id);
    const status = await ended("deadline", id);

    expect(alarm).toBe(deadline + heldBackMs);
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        timedOut: {
          name: "WorkflowTimeoutError",
          message: "Execution timed out after 3000ms",
        },
        later: "late",
      },
    });
  });

  it("refuses an event type outside the rule, a payload the journal can't keep, and a run that isn't there or has ended", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    const run = await instance("orders", id);

    await expect(run.sendEvent({ type: "-dash" })).rejects.toThrow(TypeError);
    await expect(run.sendEvent({ type: "a.b" })).rejects.toThrow(TypeError);
    await expect(
      run.sendEvent({ type: "ok", payload: () => "live" })
    ).rejects.toThrow(SerializationError);
    await ended("orders", id);
    await expect(run.sendEvent({ type: "ok" })).rejects.toThrow(
      /^instance\.not_running/u
    );
    await expect(
      runObject("orders", newId()).sendEvent({
        type: "ok",
        payload: encode(null),
        key: null,
      })
    ).resolves.toBe("missing");
  });
});

describe("an event wait's timeout", () => {
  it.each([0, ""])(
    "is Cloudflare's 24-hour default when it is falsy (%j)",
    async (duration) => {
      const id = newId();
      await workflow("approval").create({ id, params: { duration } });

      const { journal } = await suspendedOn("approval", id, "approval");

      const wait = journal.steps.find((step) => step.name === "approval");
      expect(wait?.duration_ms).toBe(24 * 60 * 60 * 1000);
    }
  );
});

/** Encoded text of `bytes` bytes, as the binding would send it. */
const payloadOf = (bytes: number): string =>
  JSON.stringify([1, "x".repeat(bytes - '[1,""]'.length)]);

/** Sends straight to the run object, past the binding's own checks. */
const sendAll = async (id: string, payloads: string[]): Promise<string[]> =>
  await runInDurableObject(runObject("approval", id), async (run) => {
    if (!(run instanceof WorkflowRun)) {
      throw new TypeError("the object isn't a run object");
    }
    const outcomes: string[] = [];
    for (const payload of payloads) {
      // oxlint-disable-next-line no-await-in-loop -- in order, as a sender would
      const outcome = await run.sendEvent({ type: "spam", payload, key: null });
      outcomes.push(outcome);
    }
    return outcomes;
  });

describe("an inbox", () => {
  it("refuses a payload over the limit, measured on its encoded bytes", async () => {
    const id = newId();
    await workflow("approval").create({ id });

    // Characters of two bytes: within the limit in length, over it in bytes.
    const wide = JSON.stringify([1, "é".repeat(maxEventPayloadBytes / 2)]);
    const outcomes = await sendAll(id, [payloadOf(maxEventPayloadBytes), wide]);

    expect(wide.length).toBeLessThan(maxEventPayloadBytes);
    expect(outcomes).toStrictEqual(["accepted", "too_large"]);
  });

  it("stops taking events at its byte limit, and the caller hears why", async () => {
    const id = newId();
    await workflow("approval").create({ id });
    const bytes = 1_000_000;
    const fit = Math.floor(maxInboxBytes / bytes);

    const outcomes = await sendAll(
      id,
      Array.from({ length: fit + 1 }, () => payloadOf(bytes))
    );

    expect(outcomes.filter((outcome) => outcome === "accepted")).toHaveLength(
      fit
    );
    expect(outcomes.at(-1)).toBe("full");
    // The counters the limits are checked against, kept with each event.
    const { run } = await journalOf("approval", id);
    expect([run.event_count, run.event_bytes]).toStrictEqual([
      fit,
      fit * bytes,
    ]);
    // Through the binding: one more payload of that size doesn't fit.
    await expect(
      send("approval", id, { type: "spam", payload: "x".repeat(bytes) })
    ).rejects.toThrow(/^instance\.inbox_full/u);
  });

  it("stops taking events at its count limit", async () => {
    const id = newId();
    await workflow("approval").create({ id });

    const outcomes = await sendAll(
      id,
      Array.from({ length: maxInboxEvents + 1 }, () => encode(null))
    );

    expect(outcomes.lastIndexOf("accepted")).toBe(maxInboxEvents - 1);
    expect(outcomes.at(-1)).toBe("full");
  });
});

describe("a replay that strays from its journal", () => {
  it.each([
    ["a new wait while the one it suspended on still waits", "new-wait"],
    ["the same wait for another event type", "type"],
    ["the same wait with another timeout", "timeout"],
  ])("ends the run with a WorkflowReplayMismatchError: %s", async (_, what) => {
    const id = newId();
    await workflow("drifts").create({ id, params: { what } });
    const first = what === "new-wait" ? "first" : "held";
    const { journal: before } = await suspendedOn("drifts", id, first);

    // The next activation replays differently.
    await deliverAlarm("drifts", id);
    const status = await ended("drifts", id);

    expect(status).toMatchObject({
      status: "errored",
      error: { name: "WorkflowReplayMismatchError" },
    });
    // The journal is as the first activation left it, and nothing is
    // left to wake for: no alarm loops on the stale wait.
    const after = await journalOf("drifts", id);
    expect(after.steps).toStrictEqual(before.steps);
    expect(after.activations).toMatchObject([
      { ended: "suspended" },
      { ended: "settled" },
    ]);
    await expect(alarmOf("drifts", id)).resolves.toBeNull();
  });
});

describe("waits raced against each other", () => {
  it("end the run with a WorkflowParallelWaitError, and the author's handlers hear nothing", async () => {
    const id = newId();
    await workflow("races").create({ id });

    const status = await ended("races", id);

    expect(status).toMatchObject({
      status: "errored",
      error: { name: "WorkflowParallelWaitError" },
    });
    expect(witnessed(id)).toStrictEqual([]);
    await expect(alarmOf("races", id)).resolves.toBeNull();
  });

  it.each(["step", "sleep"])(
    "end the run with a WorkflowParallelWaitError when a step and a sleep start together (%s first), and the step's callback never runs",
    async (first) => {
      const id = newId();
      await workflow("mixes").create({ id, params: { first } });

      const status = await ended("mixes", id);

      expect(status).toMatchObject({
        status: "errored",
        error: { name: "WorkflowParallelWaitError" },
      });
      expect(effectsOf(id, "work")).toStrictEqual([]);
      await expect(alarmOf("mixes", id)).resolves.toBeNull();
    }
  );
});

/** `promise`, or a failure if it hasn't settled by the deadline. */
const within = async <T>(promise: Promise<T>, what: string): Promise<T> => {
  const timer = new AbortController();
  const timedOut = async (): Promise<never> => {
    await scheduler.wait(5000, { signal: timer.signal });
    throw new Error(`timed out waiting for ${what}`);
  };
  try {
    return await Promise.race([promise, timedOut()]);
  } finally {
    timer.abort();
  }
};

describe("a step on its way back when its activation ends", () => {
  it("never hands the definition its outcome: no continuation or finally runs after the run suspended", async () => {
    const id = newId();
    const work = hold(id, "work");
    const nap = hold(id, "nap");
    await workflow("step-then-sleep").create({ id });
    await work.held;
    await nap.held;
    // The next alarm write, the watchdog renewal after "work" commits, is
    // issued in its real order, but its answer waits for the gate.
    const renewing = Promise.withResolvers<true>();
    const gate = Promise.withResolvers<true>();
    const patched = await runInDurableObject(
      runObject("step-then-sleep", id),
      (_, state) => {
        const { storage } = state;
        const setAlarm: unknown = Reflect.get(storage, "setAlarm");
        if (typeof setAlarm !== "function") {
          throw new TypeError("storage has no setAlarm");
        }
        const hadOwn = Object.hasOwn(storage, "setAlarm");
        let first = true;
        Reflect.set(storage, "setAlarm", async (time: number) => {
          const written: unknown = Reflect.apply(setAlarm, storage, [time]);
          if (first) {
            first = false;
            renewing.resolve(true);
            await gate.promise;
          }
          return await written;
        });
        return { hadOwn, setAlarm };
      }
    );

    // "work" commits; its renewal is out. Then the sleep is reached, and
    // suspends the run.
    work.release();
    await within(renewing.promise, "the renewal after the commit");
    nap.release();
    const { journal } = await suspendedOn("step-then-sleep", id, "nap");
    // The renewal answers; "work" would be handed back now.
    gate.resolve(true);
    const after = await journalOf("step-then-sleep", id);
    await runInDurableObject(runObject("step-then-sleep", id), (_, state) => {
      if (patched.hadOwn) {
        Reflect.set(state.storage, "setAlarm", patched.setAlarm);
      } else {
        Reflect.deleteProperty(state.storage, "setAlarm");
      }
    });

    expect(journal.steps).toMatchObject([
      { name: "work", state: "succeeded", attempt: 1 },
      { name: "nap", state: "waiting" },
    ]);
    expect(after.activations).toMatchObject([{ ended: "suspended" }]);
    expect(witnessed(id)).toStrictEqual([]);
    expect(labels(id)).toStrictEqual(["work"]);
  });
});

describe("a run waiting", () => {
  it.each([
    ["catch and finally around a sleep", "sleep"],
    ["catch and finally around an event wait", "try"],
    ["a transport that turns rejections into values", "settled"],
    ["a sibling that rejects, under Promise.allSettled", "children"],
  ])(
    "runs none of the author's handlers while it waits: %s",
    async (_, how) => {
      const id = newId();
      await workflow("guarded").create({ id, params: { how } });
      await suspendedOn("guarded", id, "held");

      await deliverAlarm("guarded", id);
      await deliverAlarm("guarded", id);

      // Three activations reached the wait; none of them went past it.
      await expect(journalOf("guarded", id)).resolves.toMatchObject({
        run: { status: "waiting" },
        activations: [
          { ended: "suspended" },
          { ended: "suspended" },
          { ended: "suspended" },
        ],
      });
      expect(witnessed(id)).toStrictEqual([]);
    }
  );

  it.each([
    ["try", ["returned", "finally"]],
    ["settled", ["settled-ok"]],
    ["children", ["all-settled"]],
  ])(
    "runs the author's handlers once, as for any value, when the wait ends (%s)",
    async (how, expected) => {
      const id = newId();
      await workflow("guarded").create({ id, params: { how } });
      await suspendedOn("guarded", id, "held");
      await deliverAlarm("guarded", id);

      await send("guarded", id, { type: "go" });
      await ended("guarded", id);

      expect(witnessed(id)).toStrictEqual(expected);
    }
  );
});

const failSuspension = async (
  definition: string,
  id: string
): Promise<void> => {
  await runInDurableObject(runObject(definition, id), (_, state) => {
    state.storage.sql.exec(
      "CREATE TRIGGER fail_suspension BEFORE UPDATE OF status ON run WHEN NEW.status = 'waiting' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END"
    );
  });
};
const healStorage = async (definition: string, id: string): Promise<void> => {
  await runInDurableObject(runObject(definition, id), (_, state) => {
    state.storage.sql.exec("DROP TRIGGER fail_suspension");
  });
};

describe("a journal write that fails while a run reaches a wait", () => {
  it("never reaches the author's handlers, and recovery keeps the deadline journaled before", async () => {
    const id = newId();
    await workflow("guarded").create({ id, params: { how: "sleep" } });
    const { deadline } = await suspendedOn("guarded", id, "held");

    // An early alarm whose suspension can't be written.
    await failSuspension("guarded", id);
    await deliverAlarm("guarded", id);
    const faulted = await journalOf("guarded", id);
    const watchdog = await alarmOf("guarded", id);
    await healStorage("guarded", id);
    // The watchdog's activation, delivered now rather than a lease away.
    await deliverAlarm("guarded", id);

    expect(faulted).toMatchObject({
      run: { status: "running" },
      activations: [{ ended: "suspended" }, { ended: "faulted" }],
      steps: [{ name: "before" }, { name: "held", state: "waiting", deadline }],
    });
    expect(watchdog).toBe(faulted.run.lease_until);
    await expect(journalOf("guarded", id)).resolves.toMatchObject({
      run: { status: "waiting", wake_at: deadline },
      activations: [
        { ended: "suspended" },
        { ended: "faulted" },
        { ended: "suspended" },
      ],
      steps: [{ name: "before" }, { name: "held", state: "waiting", deadline }],
    });
    await expect(alarmOf("guarded", id)).resolves.toBe(deadline);
    expect(witnessed(id)).toStrictEqual([]);
  });

  it("leaves the watchdog to recover a run whose first suspension failed, and the author never hears of it", async () => {
    const id = newId();
    const before = hold(id, "before");
    await workflow("guarded").create({ id, params: { how: "try" } });
    await before.held;
    await failSuspension("guarded", id);

    before.release();
    const faulted = await until("the activation to fault", async () => {
      const journal = await journalOf("guarded", id);
      return journal.activations[0]?.ended === "faulted" ? journal : undefined;
    });
    const watchdog = await alarmOf("guarded", id);
    await healStorage("guarded", id);
    // The watchdog's activation, delivered now rather than a lease away.
    await deliverAlarm("guarded", id);

    // The failed write took the wait's row with it: no deadline was
    // journaled, so the activation that reaches it next journals one.
    expect(faulted.steps.map((step) => step.name)).toStrictEqual(["before"]);
    // The watchdog the last step armed, a lease after its journal write.
    expect(watchdog).toBeGreaterThanOrEqual(faulted.run.lease_until ?? 0);
    expect(watchdog).toBeLessThan((faulted.run.lease_until ?? 0) + 1000);
    await expect(journalOf("guarded", id)).resolves.toMatchObject({
      run: { status: "waiting" },
      steps: [{ name: "before" }, { name: "held", state: "waiting" }],
    });
    expect(witnessed(id)).toStrictEqual([]);
  });
});
