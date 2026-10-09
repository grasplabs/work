import { runInDurableObject } from "cloudflare:test";
// Lifecycle commands through the instance's real boundary: pause and
// resume, terminate, restart (from a step, too) and delete, alone and
// against each other, and what each leaves of a step still out.
import { describe, expect, it } from "vite-plus/test";

import { decode, encode } from "../src/codec.ts";
import type { InstanceStatus } from "../src/contracts.ts";
import type { WorkflowInstance } from "../src/instance.ts";
import { defaultRetentionMs } from "../src/retention.ts";
import { defaultLeaseMs, WorkflowRun } from "../src/run.ts";
import {
  alarmOf,
  wakeOf,
  deliverAlarm,
  ended,
  journalOf,
  newId,
  pastTime,
  runObject,
  suspendedOn,
  until,
  workflow,
} from "./helpers.ts";
import {
  effectsOf,
  eventOf,
  handled,
  hold,
  warningsDuring,
} from "./outside.ts";
import { slowStreamFirst, slowStreamRest } from "./result-definitions.ts";

const instance = async (
  definition: string,
  id: string
): Promise<WorkflowInstance> => await workflow(definition).get(id);

const statusOf = async (
  definition: string,
  id: string
): Promise<InstanceStatus> => {
  const run = await instance(definition, id);
  return await run.status();
};

/** Waits until the run's status is `status`, and returns it whole. */
const reaches = async (
  definition: string,
  id: string,
  status: InstanceStatus["status"]
): Promise<InstanceStatus> =>
  await until(`run ${id} to be ${status}`, async () => {
    const current = await statusOf(definition, id);
    return current.status === status ? current : undefined;
  });

/** What the outside world saw of `label`: how often, under how many keys. */
const seen = (
  id: string,
  label: string
): { times: number; keys: number; receipts: string[] } => {
  const all = effectsOf(id, label);
  return {
    times: all.length,
    keys: new Set(all.map((effect) => effect.key)).size,
    receipts: all.map((effect) => effect.receipt),
  };
};

/** Waits until the outside world has seen `label` `times` times or more. */
const seenTimes = async (
  id: string,
  label: string,
  times: number
): Promise<void> => {
  await until(`${label} to be seen ${times} times`, () =>
    effectsOf(id, label).length >= times ? true : undefined
  );
};

/** Waits until the step's attempt has ended in the journal: journaled, or ignored. */
const answered = async (
  definition: string,
  id: string,
  step: string,
  attempt: number
) =>
  await until(`${step}'s attempt ${attempt} to end`, async () => {
    const journal = await journalOf(definition, id);
    const ordinal = journal.steps.find((row) => row.name === step)?.ordinal;
    const row = journal.attempts.find(
      (candidate) =>
        candidate.ordinal === ordinal &&
        candidate.attempt === attempt &&
        candidate.ended !== null
    );
    return row === undefined ? undefined : journal;
  });

/** A command called with whatever a caller passed, unchecked. */
const unchecked = async (
  command: (options: never) => Promise<void>,
  options: unknown
): Promise<void> => {
  // SAFETY: the point is a value the types refuse; the command checks it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  await command(options as never);
};

describe("pause", () => {
  it("lets the step out finish, starts nothing after it, and leaves no alarm; resume runs the rest", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const run = await instance("orders", id);

    await run.pause();
    const pausing = await run.status();
    charge.release();
    await reaches("orders", id, "paused");

    expect({
      pausing,
      ship: seen(id, "ship").times,
      alarm: await alarmOf("orders", id),
    }).toStrictEqual({
      pausing: { status: "waitingForPause" },
      ship: 0,
      alarm: null,
    });
    await expect(journalOf("orders", id)).resolves.toMatchObject({
      run: { status: "paused", lease_until: null, wake_at: null },
      activations: [{ generation: 1, ended: "paused" }],
      steps: [{ name: "charge", state: "succeeded", attempt: 1 }],
    });

    await run.resume();
    const status = await ended("orders", id);
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        charge: seen(id, "charge").receipts[0],
        ship: seen(id, "ship").receipts[0],
      },
    });
    expect([seen(id, "charge").times, seen(id, "ship").times]).toStrictEqual([
      1, 1,
    ]);
  });

  it("pauses a sleeping run at once, and resume moves its deadline on by the time it was paused", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    const { deadline } = await suspendedOn("napper", id, "nap");
    const run = await instance("napper", id);

    await run.pause();
    const paused = await run.status();
    const alarm = await alarmOf("napper", id);
    const { run: row } = await journalOf("napper", id);
    const pausedAt = row.paused_at;
    if (pausedAt === null) {
      throw new Error("the paused run has no pause time");
    }
    const pauseMs = 20;
    await pastTime(pausedAt + pauseMs);
    await run.resume();
    const resumedBy = Date.now();
    const { deadline: moved } = await suspendedOn("napper", id, "nap");

    expect({ paused, alarm }).toStrictEqual({
      paused: { status: "paused" },
      alarm: null,
    });
    expect(moved - deadline).toBeGreaterThanOrEqual(pauseMs);
    expect(moved - deadline).toBeLessThanOrEqual(resumedBy - pausedAt);
    await expect(alarmOf("napper", id)).resolves.toBe(moved);
  });

  it("keeps events sent while paused for the wait, which takes them once resumed", async () => {
    const id = newId();
    await workflow("approval").create({ id });
    await suspendedOn("approval", id, "approval");
    const run = await instance("approval", id);
    await run.pause();

    await run.sendEvent({ type: "approved", payload: { by: "ada" } });
    expect({
      status: await run.status(),
      alarm: await alarmOf("approval", id),
    }).toStrictEqual({ status: { status: "paused" }, alarm: null });

    await run.resume();
    await expect(ended("approval", id)).resolves.toMatchObject({
      status: "complete",
      output: { approved: { payload: { by: "ada" }, type: "approved" } },
    });
  });

  it("is called off by a resume before it is reached: the run goes on as it was", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const run = await instance("orders", id);

    await run.pause();
    await run.resume();
    await expect(run.status()).resolves.toStrictEqual({ status: "running" });
    charge.release();

    await expect(ended("orders", id)).resolves.toMatchObject({
      status: "complete",
    });
    expect(seen(id, "ship").times).toBe(1);
  });

  it("is reached by an alarm that finds the pausing activation gone, which fences it", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const run = await instance("orders", id);
    await run.pause();

    // As the watchdog would, once the activation asked to pause had died.
    await deliverAlarm("orders", id);
    expect({
      status: await run.status(),
      alarm: await alarmOf("orders", id),
    }).toStrictEqual({ status: { status: "paused" }, alarm: null });
    charge.release();
    // The fenced activation's answer is ignored: the step stays out.
    await expect(answered("orders", id, "charge", 1)).resolves.toMatchObject({
      run: { status: "paused", generation: 2 },
      steps: [{ name: "charge", state: "running", attempt: 1 }],
      attempts: [{ attempt: 1, ended: "superseded" }],
    });

    // Resumed, the step's next attempt goes out under its one key.
    await run.resume();
    await expect(ended("orders", id)).resolves.toMatchObject({
      status: "complete",
    });
    expect({
      charge: seen(id, "charge"),
      ship: seen(id, "ship").times,
    }).toMatchObject({ charge: { times: 2, keys: 1 }, ship: 1 });
  });

  it("does nothing to a run that has ended, or is paused already; nor does resume to one that isn't paused", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    const complete = await ended("orders", id);
    const run = await instance("orders", id);
    await run.pause();
    await run.resume();
    await expect(run.status()).resolves.toStrictEqual(complete);

    const sleeper = newId();
    await workflow("napper").create({ id: sleeper });
    await suspendedOn("napper", sleeper, "nap");
    const napping = await instance("napper", sleeper);
    await napping.pause();
    const { run: first } = await journalOf("napper", sleeper);
    await napping.pause();
    const { run: second } = await journalOf("napper", sleeper);
    expect(second).toStrictEqual(first);
  });

  it("is taken where the run reaches a wait: the wait isn't journaled, and the run holds no alarm", async () => {
    const id = newId();
    const before = hold(id, "before");
    await workflow("napper").create({ id });
    await before.held;
    const run = await instance("napper", id);
    await run.pause();
    before.release();

    await reaches("napper", id, "paused");
    const journal = await journalOf("napper", id);
    expect({
      steps: journal.steps.map((step) => [step.name, step.state]),
      activations: journal.activations.map((row) => row.ended),
      alarm: await alarmOf("napper", id),
    }).toStrictEqual({
      steps: [["before", "succeeded"]],
      activations: ["paused"],
      alarm: null,
    });

    await run.resume();
    const { journal: resumed } = await suspendedOn("napper", id, "nap");
    expect(resumed.steps.map((step) => step.name)).toStrictEqual([
      "before",
      "nap",
    ]);
  });

  it("is kept by a start delivered again: a paused run gets no alarm from it", async () => {
    const id = newId();
    const key = `start-${id}`;
    await workflow("napper").admit({ id, key });
    await suspendedOn("napper", id, "nap");
    const run = await instance("napper", id);
    await run.pause();

    // What a start with no params is given: `{}`, as on the reference.
    const noParams = {};
    // The start again, and the alarm read, with no other event between:
    // an alarm it set can't have fired and gone first.
    const after = await runInDurableObject(
      runObject("napper", id),
      async (object, state) =>
        await state.blockConcurrencyWhile(async () => {
          if (!(object instanceof WorkflowRun)) {
            throw new TypeError("the object isn't a run object");
          }
          const outcome = await object.start({
            definition: "napper",
            version: null,
            instanceId: id,
            params: encode(noParams),
            key,
            schedule: null,
            redeliverable: true,
            retention: {
              successMs: defaultRetentionMs,
              errorMs: defaultRetentionMs,
            },
          });
          return { outcome, alarm: await state.storage.getAlarm() };
        })
    );
    expect(after).toStrictEqual({ outcome: "existing", alarm: null });
    await expect(run.status()).resolves.toStrictEqual({ status: "paused" });
  });

  it("moves a parked retry on by the time it was paused", async () => {
    const id = newId();
    await workflow("retrying").create({
      id,
      params: {
        fails: 1,
        config: { retries: { limit: 1, delay: "1 hour", backoff: "constant" } },
      },
    });
    const retryAt = async (): Promise<number | null | undefined> => {
      const { attempts } = await journalOf("retrying", id);
      return attempts[0]?.retry_at;
    };
    const due = await until("the retry to be parked", async () => {
      const { run } = await journalOf("retrying", id);
      const at = await retryAt();
      return run.status === "waiting" && typeof at === "number"
        ? at
        : undefined;
    });
    const run = await instance("retrying", id);
    await run.pause();
    const { run: paused } = await journalOf("retrying", id);
    const pausedAt = paused.paused_at ?? Number.NaN;
    const pauseMs = 20;
    await pastTime(pausedAt + pauseMs);
    await run.resume();
    const resumedBy = Date.now();
    await reaches("retrying", id, "waiting");
    const moved = (await retryAt()) ?? Number.NaN;

    expect(moved - due).toBeGreaterThanOrEqual(pauseMs);
    expect(moved - due).toBeLessThanOrEqual(resumedBy - pausedAt);
    await expect(alarmOf("retrying", id)).resolves.toBe(moved);
  });

  it("moves on the deadline of an attempt left open by the activation it took for dead", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const run = await instance("orders", id);
    await run.pause();
    // The pausing activation is taken for dead: its attempt stays open.
    await deliverAlarm("orders", id);
    const before = await journalOf("orders", id);
    const deadline = before.attempts[0]?.deadline ?? Number.NaN;
    const pausedAt = before.run.paused_at ?? Number.NaN;
    const pauseMs = 20;
    await pastTime(pausedAt + pauseMs);

    await run.resume();
    const resumedBy = Date.now();
    // Read before the held answer comes: the attempt is still open, and
    // the resumed run's alarm waits for the held handler.
    const { attempts } = await journalOf("orders", id);
    const [open] = attempts;
    charge.release();
    const moved = open?.deadline ?? Number.NaN;

    expect(open?.ended).toBeNull();
    expect(moved - deadline).toBeGreaterThanOrEqual(pauseMs);
    expect(moved - deadline).toBeLessThanOrEqual(resumedBy - pausedAt);
    await expect(ended("orders", id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("moves on the deadline of an attempt whose answer came back superseded, the step's latest still", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const run = await instance("orders", id);
    await run.pause();
    // The pausing activation is taken for dead, and its step's answer then
    // comes back to no one: the attempt is ended superseded, the step's
    // latest still, its deadline what the next activation judges it by.
    await deliverAlarm("orders", id);
    charge.release();
    const before = await until("the late answer to be ignored", async () => {
      const journal = await journalOf("orders", id);
      return journal.attempts[0]?.ended === "superseded" ? journal : undefined;
    });
    const deadline = before.attempts[0]?.deadline ?? Number.NaN;
    const pausedAt = before.run.paused_at ?? Number.NaN;
    const pauseMs = 20;
    await pastTime(pausedAt + pauseMs);

    await run.resume();
    const resumedBy = Date.now();
    await ended("orders", id);
    // What the resume moved it to: the attempt's row keeps it after.
    const { attempts } = await journalOf("orders", id);
    const moved = attempts[0]?.deadline ?? Number.NaN;

    expect(moved - deadline).toBeGreaterThanOrEqual(pauseMs);
    expect(moved - deadline).toBeLessThanOrEqual(resumedBy - pausedAt);
  });

  it("is reached by an alarm that can't write the pause, which leaves the run to its watchdog", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const run = await instance("orders", id);
    await run.pause();
    await runInDurableObject(runObject("orders", id), (_, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_pause BEFORE UPDATE OF status ON run WHEN NEW.status = 'paused' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END"
      );
    });
    const before = await journalOf("orders", id);

    const from = Date.now();
    const warnings = await warningsDuring(async () => {
      await deliverAlarm("orders", id);
    });
    const to = Date.now();
    const after = await journalOf("orders", id);
    const watchdog = (await alarmOf("orders", id)) ?? Number.NaN;
    await runInDurableObject(runObject("orders", id), (_, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_pause");
    });
    await deliverAlarm("orders", id);
    const paused = await run.status();
    charge.release();

    expect({
      run: after.run,
      activations: after.activations,
      events: warnings.map((warning) => eventOf(warning)),
      paused,
    }).toStrictEqual({
      run: before.run,
      activations: before.activations,
      events: ["workflow_pause_failed"],
      paused: { status: "paused" },
    });
    expect(watchdog).toBeGreaterThanOrEqual(from + defaultLeaseMs);
    expect(watchdog).toBeLessThanOrEqual(to + defaultLeaseMs);
  });

  it("is ignored by a resume of a run that isn't paused, which repairs an alarm it lost", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    const { deadline } = await suspendedOn("napper", id, "nap");
    await runInDurableObject(runObject("napper", id), async (_, state) => {
      await state.storage.deleteAlarm();
    });

    const run = await instance("napper", id);
    await run.resume();
    await until("the alarm to be set again", async () =>
      (await alarmOf("napper", id)) === deadline ? true : undefined
    );
    await expect(run.status()).resolves.toStrictEqual({ status: "waiting" });
  });
});

describe("terminate", () => {
  it("ends a run mid-step: the step's late answer is ignored, and nothing starts after it", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const run = await instance("orders", id);

    await run.terminate();
    expect({
      status: await run.status(),
      alarm: await wakeOf("orders", id),
    }).toStrictEqual({ status: { status: "terminated" }, alarm: null });
    charge.release();

    await expect(answered("orders", id, "charge", 1)).resolves.toMatchObject({
      run: { status: "terminated", generation: 2 },
      activations: [{ generation: 1, ended: "superseded" }],
      steps: [{ name: "charge", state: "running" }],
      attempts: [{ attempt: 1, generation: 1, ended: "superseded" }],
    });
    expect({
      ship: seen(id, "ship").times,
      status: await run.status(),
    }).toStrictEqual({ ship: 0, status: { status: "terminated" } });
    await expect(
      run.sendEvent({ type: "approved", payload: null })
    ).rejects.toThrow(/instance\.not_running/u);
  });

  it("ends a paused run with no alarm left, and a resume after does nothing", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    const run = await instance("napper", id);
    await run.pause();

    await run.terminate();
    const terminated = await run.status();
    await run.resume();

    expect({
      terminated,
      after: await run.status(),
      alarm: await wakeOf("napper", id),
    }).toStrictEqual({
      terminated: { status: "terminated" },
      after: { status: "terminated" },
      alarm: null,
    });
  });

  it("is refused once the run has ended, so of two at once one is refused", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    const run = await instance("napper", id);

    const both = await Promise.allSettled([run.terminate(), run.terminate()]);
    expect(both.map((one) => one.status).toSorted()).toStrictEqual([
      "fulfilled",
      "rejected",
    ]);
    const refused = both.find(
      (one): one is PromiseRejectedResult => one.status === "rejected"
    );
    expect(String(refused?.reason)).toMatch(/instance\.cannot_terminate: /u);

    const done = newId();
    await workflow("orders").create({ id: done });
    await ended("orders", done);
    const complete = await instance("orders", done);
    await expect(complete.terminate()).rejects.toThrow(
      /instance\.cannot_terminate/u
    );
  });

  it("refuses options it can't read", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    const run = await instance("napper", id);
    const terminate = async (options: unknown): Promise<void> => {
      await unchecked(async (given) => {
        await run.terminate(given);
      }, options);
    };

    await expect(terminate("rollback")).rejects.toThrow(TypeError);
    await expect(terminate({ rollback: "yes" })).rejects.toThrow(TypeError);
    await expect(terminate({ rolback: false })).rejects.toThrow(TypeError);
    await expect(run.status()).resolves.toStrictEqual({ status: "waiting" });
  });
});

describe("restart", () => {
  it("runs an ended run again from its start, each step under a new key", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);
    const run = await instance("orders", id);

    await run.restart();
    await seenTimes(id, "ship", 2);
    const status = await ended("orders", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: {
        charge: seen(id, "charge").receipts[1],
        ship: seen(id, "ship").receipts[1],
      },
    });
    expect([seen(id, "charge"), seen(id, "ship")]).toMatchObject([
      { times: 2, keys: 2 },
      { times: 2, keys: 2 },
    ]);
  });

  it("from a step keeps the outcomes before it, and runs that step and those after it again", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);
    const run = await instance("orders", id);

    await run.restart({ from: { name: "ship" } });
    await seenTimes(id, "ship", 2);
    const status = await ended("orders", id);

    const charge = seen(id, "charge");
    const ship = seen(id, "ship");
    expect({ charge, ship }).toMatchObject({
      charge: { times: 1 },
      ship: { times: 2, keys: 2 },
    });
    expect(status).toStrictEqual({
      status: "complete",
      output: { charge: charge.receipts[0], ship: ship.receipts[1] },
    });
    // The step kept is the one first journaled; the one run again is new.
    const keys = effectsOf(id).map((effect) => effect.key);
    const { steps } = await journalOf("orders", id);
    expect(
      steps.map((step) => [step.name, step.state, step.idempotency_key])
    ).toStrictEqual([
      ["charge", "succeeded", keys[0]],
      ["ship", "succeeded", keys[2]],
    ]);
  });

  it("goes out under a new key where a retry goes out under the same", async () => {
    const id = newId();
    await workflow("retrying").create({
      id,
      params: { fails: 1, config: { retries: { limit: 1, delay: 0 } } },
    });
    await ended("retrying", id);

    const run = await instance("retrying", id);
    await run.restart({ from: { name: "flaky" } });
    await seenTimes(id, "flaky", 3);

    const [first, retry, restarted] = effectsOf(id, "flaky");
    expect(retry?.key).toBe(first?.key);
    expect(restarted?.key).not.toBe(first?.key);
    // A rerun, not a retry: its attempts count afresh.
    expect(restarted?.attempt).toBe(1);
  });

  it("from a wait drops the event it took and those buffered, and waits again; from after it keeps the event", async () => {
    const id = newId();
    await workflow("approval").create({ id });
    await suspendedOn("approval", id, "approval");
    const run = await instance("approval", id);
    // One no wait takes, buffered: a restart drops it, as the reference
    // drops its buffer.
    await run.sendEvent({ type: "unasked", payload: "buffered" });
    await run.sendEvent({ type: "approved", payload: "first" });
    await ended("approval", id);

    await run.restart({ from: { name: "after" } });
    await seenTimes(id, "after", 2);
    await expect(ended("approval", id)).resolves.toMatchObject({
      output: { approved: { payload: "first" } },
    });
    const { events } = await journalOf("approval", id);
    expect(events.map((event) => decode(event.payload))).toStrictEqual([
      "first",
    ]);

    await run.restart({ from: { name: "approval", type: "waitForEvent" } });
    const { journal } = await suspendedOn("approval", id, "approval");
    expect({
      before: seen(id, "before").times,
      events: journal.events,
    }).toStrictEqual({ before: 1, events: [] });
    await run.sendEvent({ type: "approved", payload: "second" });
    await expect(ended("approval", id)).resolves.toMatchObject({
      output: { approved: { payload: "second" } },
    });
  });

  it("refuses a step called from inside another, whose outcome replay would return without calling it", async () => {
    const id = newId();
    await workflow("nesting").create({ id });
    const complete = await ended("nesting", id);
    const run = await instance("nesting", id);

    await expect(run.restart({ from: { name: "inner" } })).rejects.toThrow(
      /^instance\.cannot_restart: .*inside/u
    );
    await expect(run.status()).resolves.toStrictEqual(complete);
    // From the step it is called from, it runs again, with what it calls.
    await run.restart({ from: { name: "outer" } });
    await seenTimes(id, "last", 2);
    expect([seen(id, "inner"), seen(id, "last")]).toMatchObject([
      { times: 2, keys: 2 },
      { times: 2, keys: 2 },
    ]);
  });

  it("refuses a step the run hasn't started: a name, count or type it has none of", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    const complete = await ended("orders", id);
    const run = await instance("orders", id);

    await expect(run.restart({ from: { name: "refund" } })).rejects.toThrow(
      /^instance\.cannot_restart: /u
    );
    await expect(
      run.restart({ from: { name: "charge", count: 2 } })
    ).rejects.toThrow(/^instance\.cannot_restart: /u);
    await expect(
      run.restart({ from: { name: "charge", type: "sleep" } })
    ).rejects.toThrow(/^instance\.cannot_restart: /u);
    await expect(run.status()).resolves.toStrictEqual(complete);
  });

  it.each([
    ["options that aren't an object", "now"],
    ["a setting it doesn't have", { form: { name: "ship" } }],
    ["a step that isn't an object", { from: "ship" }],
    ["a name that isn't one", { from: { name: 7 } }],
    ["a count of 0", { from: { name: "ship", count: 0 } }],
    ["a count that isn't whole", { from: { name: "ship", count: 1.5 } }],
    ["a count that isn't a number", { from: { name: "ship", count: "1" } }],
    ["a count of null", { from: { name: "ship", count: null } }],
    ["a type there isn't", { from: { name: "ship", type: "rollback" } }],
  ])("rejects %s", async (_, options) => {
    const id = newId();
    await workflow("orders").create({ id });
    const complete = await ended("orders", id);
    const run = await instance("orders", id);

    await expect(
      unchecked(async (given) => {
        await run.restart(given);
      }, options)
    ).rejects.toThrow(TypeError);
    await expect(run.status()).resolves.toStrictEqual(complete);
  });

  it("fences the activation it takes over: its step's late answer is ignored, and it starts nothing more", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const run = await instance("orders", id);

    await run.restart();
    await expect(run.status()).resolves.toStrictEqual({ status: "queued" });
    charge.release();
    const status = await ended("orders", id);

    // The first charge's answer went to no one; the restart's ran apart.
    const charges = seen(id, "charge");
    const ships = seen(id, "ship");
    expect({ charges, ships }).toMatchObject({
      charges: { times: 2, keys: 2 },
      ships: { times: 1 },
    });
    expect(status).toStrictEqual({
      status: "complete",
      output: { charge: charges.receipts[1], ship: ships.receipts[0] },
    });
    await expect(journalOf("orders", id)).resolves.toMatchObject({
      activations: [
        { generation: 1, ended: "superseded" },
        { generation: 3, ended: "settled" },
      ],
    });
  });

  it("runs a paused run again, and a terminated one", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    const run = await instance("napper", id);
    await run.pause();

    await run.restart();
    await seenTimes(id, "before", 2);
    await suspendedOn("napper", id, "nap");
    await run.terminate();
    await run.restart({ from: { name: "before" } });
    await seenTimes(id, "before", 3);
    const { journal } = await suspendedOn("napper", id, "nap");

    expect(seen(id, "before")).toMatchObject({ times: 3, keys: 3 });
    expect(journal.steps.map((step) => [step.name, step.state])).toStrictEqual([
      ["before", "succeeded"],
      ["nap", "waiting"],
    ]);
  });
});

describe("delete", () => {
  it("removes a run mid-step: its late answer reaches no one, not even a run created again under its ID", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const run = await instance("orders", id);

    await run.delete();
    await expect(workflow("orders").get(id)).rejects.toThrow(
      /instance\.not_found/u
    );
    await expect(run.delete()).rejects.toThrow(/instance\.not_found/u);
    await expect(wakeOf("orders", id)).resolves.toBeNull();

    // Created again under the same ID, whose generations count afresh: the
    // first run's activation, generation 1 too, still can't act on it.
    await workflow("orders").create({ id });
    charge.release();
    const status = await ended("orders", id);

    const charges = seen(id, "charge");
    const ships = seen(id, "ship");
    expect(status).toStrictEqual({
      status: "complete",
      output: { charge: charges.receipts[1], ship: ships.receipts[0] },
    });
    expect({ charges, ships: ships.times }).toMatchObject({
      charges: { times: 2, keys: 2 },
      ships: 1,
    });
  });

  it("leaves a run created again under its ID alone when the first run's stray step answers late", async () => {
    const id = newId();
    const late = hold(id, "late");
    const firstEnd = hold(id, "end", 1);
    await workflow("stray").create({ id });
    await Promise.all([late.held, firstEnd.held]);
    // The first run ends while its step is still out, then is deleted.
    firstEnd.release();
    await ended("stray", id);
    const first = await instance("stray", id);
    await first.delete();

    // Created again, it is at its own checkpoint with its own step out
    // (the outside world withholds both answers under one hold).
    const end = hold(id, "end", 2);
    await workflow("stray").create({ id });
    await end.held;
    await seenTimes(id, "late", 2);
    late.release();

    // Both answer: the first run's goes to no one and marks nothing of the
    // second's, whose own step is journaled.
    const journal = await answered("stray", id, "late", 1);
    end.release();
    await expect(ended("stray", id)).resolves.toStrictEqual({
      status: "complete",
      output: "done",
    });
    expect(journal).toMatchObject({
      steps: [{ name: "late", state: "succeeded", attempt: 1 }],
      attempts: [{ attempt: 1, generation: 1, ended: "succeeded" }],
    });
  });
});

describe("a run deleted", () => {
  it("fences its activation still out, which faults on nothing when its step answers", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const run = await instance("orders", id);
    const object = runObject("orders", id).id.toString();

    const warnings = await warningsDuring(async () => {
      await run.delete();
      charge.release();
      // Its alarm handler returns once what came of the answer is decided.
      await until("the deleted run's activation to end", () =>
        handled.includes(object) ? true : undefined
      );
    });

    expect({
      faults: warnings
        .map((warning) => eventOf(warning))
        .filter((event) => event === "workflow_activation_faulted"),
      ship: effectsOf(id, "ship").length,
      alarm: await alarmOf("orders", id),
    }).toStrictEqual({ faults: [], ship: 0, alarm: null });
    await expect(workflow("orders").get(id)).rejects.toThrow(
      /instance\.not_found/u
    );
  });
});

describe("a run deleted and created again", () => {
  it("keeps its stream result whole when the first run's upload, still out, ends after it", async () => {
    const id = newId();
    const first = hold(id, "stream", 1);
    await workflow("held-stream").create({ id });
    await first.held;
    const object = runObject("held-stream", id).id.toString();
    const old = await instance("held-stream", id);
    await old.delete();

    // Created again: its own upload of the same step runs and commits, in
    // an alarm delivered beside the first run's handler, still out (alarms
    // are at least once: one may come while another runs).
    await workflow("held-stream").create({ id });
    await deliverAlarm("held-stream", id);
    const status = await ended("held-stream", id);
    const handledBefore = handled.filter((entry) => entry === object).length;
    // The first run's upload ends now, for no one.
    first.release();
    await until("the first run's activation to end", () =>
      handled.filter((entry) => entry === object).length > handledBefore
        ? true
        : undefined
    );

    const stored = await runInDurableObject(
      runObject("held-stream", id),
      (_, state) =>
        state.storage.sql
          .exec<{ chunks: number; bytes: number; counted: number }>(
            "SELECT COUNT(*) AS chunks, COALESCE(SUM(LENGTH(bytes)), 0) AS bytes, (SELECT stream_bytes FROM run) AS counted FROM stream_chunks"
          )
          .one()
    );
    expect(status).toMatchObject({ status: "complete" });
    expect(stored).toStrictEqual({
      chunks: 2,
      bytes: slowStreamFirst + slowStreamRest,
      counted: slowStreamFirst + slowStreamRest,
    });
  });

  it("can't be acted on by the first run's activation, though it holds the same generation", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const first = await instance("orders", id);
    const firstKey = effectsOf(id, "charge")[0]?.key;
    await first.delete();
    await workflow("orders").create({ id });

    // The first run's alarm handler still runs, so the new run's alarm
    // waits for it: an activation of the new run, generation 1 as the
    // first run's is, is started here, as a duplicate delivery would be.
    const duplicate = deliverAlarm("orders", id);
    await seenTimes(id, "charge", 2);
    charge.release();
    await duplicate;
    const status = await ended("orders", id);

    // The new run's charge is its own: the first run's answer, under the
    // first run's key, never became its outcome.
    const { steps } = await journalOf("orders", id);
    const kept = effectsOf(id, "charge").find(
      (effect) =>
        status.status === "complete" &&
        typeof status.output === "object" &&
        status.output !== null &&
        Reflect.get(status.output, "charge") === effect.receipt
    );
    expect(kept?.key).toBe(steps[0]?.idempotency_key);
    expect(kept?.key).not.toBe(firstKey);
  });
});

describe("commands at once", () => {
  it("are serialized: a pause, a terminate and a resume leave one consistent end", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("orders").create({ id });
    await charge.held;
    const run = await instance("orders", id);

    const results = await Promise.allSettled([
      run.pause(),
      run.terminate(),
      run.resume(),
    ]);
    charge.release();
    await answered("orders", id, "charge", 1);

    expect(results.map((result) => result.status)).toStrictEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect({
      status: await run.status(),
      ship: seen(id, "ship").times,
      alarm: await wakeOf("orders", id),
    }).toStrictEqual({
      status: { status: "terminated" },
      ship: 0,
      alarm: null,
    });
  });
});
