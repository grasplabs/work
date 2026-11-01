// Sleeps and event waits through the run object's real boundary: a wait
// that isn't due suspends the run with no activation alive, and every
// alarm and event after replays to it. Process death and eviction while
// waiting are in test/process.
//
// Waits across replays, pauses and kills, and what the author's handlers
// see while a run waits.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import {
  alarmOf,
  wakeOf,
  deliverAlarm,
  ended,
  journalOf,
  newId,
  runObject,
  suspendedOn,
  until,
  workflow,
} from "./helpers.ts";
import { effectsOf, hold } from "./outside.ts";
import { instance, send, statusOf, labels, witnessed } from "./waits.ts";

describe("a replay that strays from its journal", () => {
  it.each([
    ["the same wait for another event type", "type"],
    ["the same wait with another timeout", "timeout"],
  ])("ends the run with a WorkflowReplayMismatchError: %s", async (_, what) => {
    const id = newId();
    await workflow("drifts").create({ id, params: { what } });
    const { journal: before } = await suspendedOn("drifts", id, "held");

    // The next activation replays differently.
    await deliverAlarm("drifts", id);
    const status = await ended("drifts", id);

    expect(status).toMatchObject({
      status: "errored",
      error: { name: "WorkflowReplayMismatchError" },
    });
    // What the journal held is as the first activation left it, and
    // nothing is left to wake for: no alarm loops on the stale wait.
    const after = await journalOf("drifts", id);
    expect(after.steps).toStrictEqual(before.steps);
    expect(after.activations).toMatchObject([
      { ended: "suspended" },
      { ended: "settled" },
    ]);
    await expect(wakeOf("drifts", id)).resolves.toBeNull();
  });

  // A replay can't tell a wait it never reaches from one it reaches only
  // after I/O of its own, so neither halts the run: it wakes no later
  // than the wait it left.
  it("goes on the way it now takes, waking no later than a wait it left", async () => {
    const id = newId();
    await workflow("drifts").create({ id, params: { what: "new-wait" } });
    const { journal: before } = await suspendedOn("drifts", id, "first");
    const left = before.steps.find(({ name }) => name === "first");

    await deliverAlarm("drifts", id);
    const { journal } = await suspendedOn("drifts", id, "second");
    await send("drifts", id, { type: "x", payload: "taken" });
    const status = await ended("drifts", id);

    expect(journal.run.wake_at).toBeLessThanOrEqual(left?.deadline ?? 0);
    expect(status).toMatchObject({
      status: "complete",
      output: { payload: "taken" },
    });
    const after = await journalOf("drifts", id);
    expect(after.steps.find(({ name }) => name === "first")).toMatchObject({
      state: "waiting",
      deadline: left?.deadline,
    });
  });

  it("wakes at the retry of a step it no longer reaches, not at its new wait's deadline", async () => {
    const id = newId();
    await workflow("drifts").create({ id, params: { what: "retry" } });
    const before = await until("the run to wait for a retry", async () => {
      const journal = await journalOf("drifts", id);
      return journal.run.status === "waiting" &&
        journal.steps[0]?.state === "retrying"
        ? journal
        : undefined;
    });

    // The next activation reaches a wait where the first reached the step.
    await deliverAlarm("drifts", id);
    const { journal } = await suspendedOn("drifts", id, "second");

    const retryAt = before.attempts.at(-1)?.retry_at;
    const second = journal.steps.find(({ name }) => name === "second");
    expect(retryAt).toBeTypeOf("number");
    expect(journal.run.wake_at).toBe(retryAt);
    expect(journal.run.wake_at).toBeLessThan(second?.deadline ?? 0);
    expect(journal.attempts).toStrictEqual(before.attempts);
  });
});

describe("waits raced or awaited together", () => {
  it("pause a replay cut short at a sleep it already slept, rather than take the sleeps after it for a stray, and go on after resuming", async () => {
    const id = newId();
    await workflow("timer-naps").create({ id });
    await suspendedOn("timer-naps", id, "second");
    // A replay, out at the author's own timer when the pause comes: the
    // sleep it reaches next parks at the pause, and "second" isn't reached.
    const replay = deliverAlarm("timer-naps", id);
    await until("the replay to start", async () => {
      const { activations } = await journalOf("timer-naps", id);
      return activations.length === 3 ? true : undefined;
    });
    const run = await instance("timer-naps", id);
    await run.pause();
    await replay;

    await expect(statusOf("timer-naps", id)).resolves.toMatchObject({
      status: "paused",
    });
    await run.resume();
    const journal = await until("the run to replay to the sleep", async () => {
      const after = await journalOf("timer-naps", id);
      return after.activations.length === 4 &&
        after.activations[3]?.ended === "suspended"
        ? after
        : undefined;
    });

    expect(journal.run.status).toBe("waiting");
    expect(
      journal.steps.map(({ name, state }) => ({ name, state }))
    ).toStrictEqual([
      { name: "first", state: "succeeded" },
      { name: "second", state: "waiting" },
    ]);
  });

  it.each(["step", "sleep"])(
    "run a step started beside a sleep (%s first) to its outcome, once, before the run suspends on the sleep",
    async (first) => {
      const id = newId();
      await workflow("mixes").create({ id, params: { first } });

      const { journal } = await suspendedOn("mixes", id, "nap");

      expect(effectsOf(id, "work")).toHaveLength(1);
      expect(
        journal.steps.map(({ name, state }) => ({ name, state }))
      ).toStrictEqual(
        first === "sleep"
          ? [
              { name: "nap", state: "waiting" },
              { name: "work", state: "succeeded" },
            ]
          : [
              { name: "work", state: "succeeded" },
              { name: "nap", state: "waiting" },
            ]
      );
    }
  );

  it("wake for an event accepted while the activation still ran a step, not at the wait's deadline", async () => {
    const id = newId();
    const slow = hold(id, "slow");
    await workflow("listens").create({ id });
    await slow.held;
    // The wait for "go" is parked; the activation is still out at "slow".
    await until("the wait to be journaled", async () => {
      const { steps } = await journalOf("listens", id);
      return steps.some(({ name }) => name === "go") ? true : undefined;
    });
    await send("listens", id, { type: "go", payload: "now" });
    slow.release();

    const status = await ended("listens", id);

    expect(status).toMatchObject({
      status: "complete",
      output: { payload: "now" },
    });
    expect(effectsOf(id, "slow")).toHaveLength(1);
  });

  it("wake for a matching event accepted while the activation still ran a step, not at the wait's deadline", async () => {
    const id = newId();
    const slow = hold(id, "slow");
    await workflow("listens-for-match").create({ id });
    await slow.held;
    // The wait for a match is parked; the activation is still out at "slow".
    await until("the wait to be journaled", async () => {
      const { steps } = await journalOf("listens-for-match", id);
      return steps.some(({ name }) => name === "go") ? true : undefined;
    });
    await send("listens-for-match", id, {
      type: "go",
      payload: "now",
      attributes: { subject: "now" },
    });
    slow.release();

    const status = await ended("listens-for-match", id);

    expect(status).toMatchObject({
      status: "complete",
      output: { payload: "now" },
    });
  });

  it("resume each of several parked waits from its own deadline after the object is killed", async () => {
    const id = newId();
    await workflow("naps").create({
      id,
      params: { duration: 1500 },
    });
    const { journal: before } = await suspendedOn("naps", id, "second");
    // Killed with both waits journaled and the run suspended.
    await runInDurableObject(runObject("naps", id), (_, state) => {
      state.abort("killed");
    }).catch(() => null);

    const status = await ended("naps", id);

    const after = await journalOf("naps", id);
    expect(status).toStrictEqual({ status: "complete", output: "slept" });
    expect(
      after.steps.map(({ name, deadline }) => ({ name, deadline }))
    ).toStrictEqual(
      before.steps.map(({ name, deadline }) => ({ name, deadline }))
    );
  });

  it("pause with a wait parked beside a step once the step lands, and take the event after resuming", async () => {
    const id = newId();
    const slow = hold(id, "slow");
    await workflow("listens").create({ id });
    await slow.held;
    await until("the wait to be journaled", async () => {
      const { steps } = await journalOf("listens", id);
      return steps.some(({ name }) => name === "go") ? true : undefined;
    });
    const run = await instance("listens", id);
    await run.pause();
    slow.release();
    const paused = await until("the run to pause", async () => {
      const journal = await journalOf("listens", id);
      return journal.run.status === "paused" ? journal : undefined;
    });

    await run.resume();
    await send("listens", id, { type: "go", payload: "later" });
    const status = await ended("listens", id);

    expect(
      paused.steps.map(({ name, state }) => ({ name, state }))
    ).toStrictEqual([
      { name: "go", state: "waiting" },
      { name: "slow", state: "succeeded" },
    ]);
    expect(status).toMatchObject({
      status: "complete",
      output: { payload: "later" },
    });
    expect(effectsOf(id, "slow")).toHaveLength(1);
  });

  it("take no step called from inside another's callback, which a replay never reaches again, for a replay that strayed", async () => {
    const id = newId();
    await workflow("nested-retry").create({ id });

    const status = await ended("nested-retry", id);

    const { steps } = await journalOf("nested-retry", id);
    expect(status).toStrictEqual({ status: "complete", output: "done" });
    expect(steps.find(({ name }) => name === "inner")).toMatchObject({
      state: "retrying",
      nested: 1,
    });
  });

  it("end the run with a WorkflowParallelWaitError for a sleep reached inside a step's callback, which would hold its step out", async () => {
    const id = newId();
    await workflow("sleep-in-step").create({ id });

    const status = await ended("sleep-in-step", id);

    expect(status).toMatchObject({
      status: "errored",
      error: { name: "WorkflowParallelWaitError" },
    });
    await expect(wakeOf("sleep-in-step", id)).resolves.toBeNull();
  });

  it("wake for a retry parked beside a later sleep at the retry's time, and run the step's retry once", async () => {
    const id = newId();
    await workflow("retry-nap").create({ id });

    const status = await ended("retry-nap", id);

    const { activations } = await journalOf("retry-nap", id);
    // The step's second attempt's receipt, beside the sleep's nothing.
    const [secondAttempt] = effectsOf(id, "flaky").slice(1);
    expect(status).toStrictEqual({
      status: "complete",
      output: [secondAttempt?.receipt, undefined],
    });
    expect(effectsOf(id, "flaky").map(({ attempt }) => attempt)).toStrictEqual([
      1, 2,
    ]);
    // The retry's wake, then the sleep's: one activation for each.
    expect(activations.map(({ ended: how }) => how)).toStrictEqual([
      "suspended",
      "suspended",
      "settled",
    ]);
  });
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
  it("waits for it, its continuation and finally run once, before the run suspends on a sleep reached meanwhile", async () => {
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
    // parks: the run doesn't suspend while "work" is on its way back.
    work.release();
    await within(renewing.promise, "the renewal after the commit");
    nap.release();
    await until("the sleep to be journaled", async () => {
      const { steps } = await journalOf("step-then-sleep", id);
      return steps.some(({ name }) => name === "nap") ? true : undefined;
    });
    const parked = await journalOf("step-then-sleep", id);
    // The renewal answers; "work" is handed back, then the run suspends.
    gate.resolve(true);
    const { journal } = await suspendedOn("step-then-sleep", id, "nap");
    const after = await journalOf("step-then-sleep", id);
    await runInDurableObject(runObject("step-then-sleep", id), (_, state) => {
      if (patched.hadOwn) {
        Reflect.set(state.storage, "setAlarm", patched.setAlarm);
      } else {
        Reflect.deleteProperty(state.storage, "setAlarm");
      }
    });

    expect(parked.run.status).toBe("running");
    expect(journal.steps).toMatchObject([
      { name: "work", state: "succeeded", attempt: 1 },
      { name: "nap", state: "waiting" },
    ]);
    expect(after.activations).toMatchObject([{ ended: "suspended" }]);
    expect(witnessed(id)).toStrictEqual(["continued", "finally"]);
    expect(labels(id)).toStrictEqual(["work", "continued", "finally"]);
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

    // The wait's deadline was journaled as it was reached, before the
    // suspension that failed: the activation that reaches it next keeps it.
    expect(faulted.steps.map((step) => step.name)).toStrictEqual([
      "before",
      "held",
    ]);
    // The watchdog the last step armed, at the lease it journaled.
    expect(watchdog).toBe(faulted.run.lease_until);
    await expect(journalOf("guarded", id)).resolves.toMatchObject({
      run: { status: "waiting" },
      steps: [{ name: "before" }, { name: "held", state: "waiting" }],
    });
    expect(witnessed(id)).toStrictEqual([]);
  });
});
