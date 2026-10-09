// Alarms delivered more than once, and storage that fails around an
// activation, through the run object's real boundary. Process death and
// eviction mid-step are in test/process, on plain workerd: the Workers
// test pool runs objects in the test's own isolate, where resetting one
// mid-request takes the pool down with it.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { defaultLeaseMs } from "../src/run.ts";
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
import { effectsOf, eventOf, hold, warningsDuring } from "./outside.ts";

const exec = async (
  definition: string,
  id: string,
  statement: string
): Promise<void> => {
  await runInDurableObject(runObject(definition, id), (_, state) => {
    state.storage.sql.exec(statement);
  });
};

/**
 * Makes the run object's storage call `name` fail, as storage that fails
 * would; the returned function puts it back.
 */
const failing = async (
  definition: string,
  id: string,
  name: "setAlarm" | "deleteAlarm"
): Promise<() => Promise<void>> => {
  const original = await runInDurableObject(
    runObject(definition, id),
    (_, state) => {
      const { storage } = state;
      const hadOwn = Object.hasOwn(storage, name);
      const call: unknown = Reflect.get(storage, name);
      Reflect.set(storage, name, async () => {
        await Promise.resolve();
        throw new Error("injected storage failure");
      });
      return { hadOwn, call };
    }
  );
  return async () => {
    await runInDurableObject(runObject(definition, id), (_, state) => {
      if (original.hadOwn) {
        Reflect.set(state.storage, name, original.call);
      } else {
        Reflect.deleteProperty(state.storage, name);
      }
    });
  };
};

/**
 * Makes the run object's `setAlarm` fail for a time past `after` only, as
 * storage that fails would; the returned function puts it back.
 */
const failingPast = async (
  definition: string,
  id: string,
  after: number
): Promise<() => Promise<void>> => {
  const original = await runInDurableObject(
    runObject(definition, id),
    (_, state) => {
      const { storage } = state;
      const hadOwn = Object.hasOwn(storage, "setAlarm");
      const call: unknown = Reflect.get(storage, "setAlarm");
      Reflect.set(storage, "setAlarm", async (time: number | Date) => {
        const at = typeof time === "number" ? time : time.getTime();
        if (at > after) {
          throw new Error("injected storage failure");
        }
        if (typeof call !== "function") {
          throw new TypeError("storage has no setAlarm");
        }
        await Reflect.apply(call, storage, [time]);
      });
      return { hadOwn, call };
    }
  );
  return async () => {
    await runInDurableObject(runObject(definition, id), (_, state) => {
      if (original.hadOwn) {
        Reflect.set(state.storage, "setAlarm", original.call);
      } else {
        Reflect.deleteProperty(state.storage, "setAlarm");
      }
    });
  };
};

const cutOff = {
  name: "WorkflowInternalError",
  message: "Attempt failed due to internal workflows error",
};

/** Waits until the journal shows generation 1's activation has ended. */
const firstActivationEnded = async (definition: string, id: string) =>
  await until("the first activation to end", async () => {
    const journal = await journalOf(definition, id);
    return journal.activations[0]?.ended === null ? undefined : journal;
  });

describe("an alarm delivered again", () => {
  it("takes the run over while an activation is out, and the first one's late answer is ignored", async () => {
    const id = newId();
    const first = hold(id, "held");
    await workflow("catcher").create({ id });
    await first.held;

    // The duplicate delivery: another activation while the first waits.
    await deliverAlarm("catcher", id);
    const status = await ended("catcher", id);
    first.release();
    const journal = await firstActivationEnded("catcher", id);

    expect(status).toStrictEqual({
      status: "complete",
      output: effectsOf(id, "after")[0]?.receipt,
    });
    expect(journal).toMatchObject({
      activations: [
        { generation: 1, ended: "superseded" },
        { generation: 2, ended: "settled" },
      ],
      steps: [
        { name: "held", state: "succeeded", attempt: 2 },
        { name: "after", state: "succeeded", attempt: 1 },
      ],
      attempts: [
        { attempt: 1, generation: 1, ended: "superseded" },
        { attempt: 2, generation: 2, ended: "succeeded" },
        { attempt: 1, generation: 2, ended: "succeeded" },
      ],
    });
    // Both attempts at "held" went out under one key. The first
    // activation's catch and finally never ran: its step never settled.
    const held = effectsOf(id, "held");
    expect(new Set(held.map((effect) => effect.key)).size).toBe(1);
    expect(
      effectsOf(id).map((effect) => [effect.label, effect.attempt])
    ).toStrictEqual([
      ["held", 1],
      ["held", 2],
      ["finally", 0],
      ["after", 1],
    ]);
  });

  it("refuses an activation taken over between steps at its next step", async () => {
    const id = newId();
    const between = hold(id, "between");
    await workflow("pauses").create({ id });
    await between.held;

    await deliverAlarm("pauses", id);
    const status = await ended("pauses", id);
    between.release();
    const journal = await firstActivationEnded("pauses", id);

    // The first activation, let go after the second ended the run, got no
    // answer at "second": no effect, no finally, and the output stands.
    expect(journal.activations).toMatchObject([
      { generation: 1, ended: "superseded" },
      { generation: 2, ended: "settled" },
    ]);
    expect(
      effectsOf(id).map((effect) => [effect.label, effect.attempt])
    ).toStrictEqual([
      ["first", 1],
      ["second", 1],
      ["finally", 0],
    ]);
    const instance = await workflow("pauses").get(id);
    await expect(instance.status()).resolves.toStrictEqual(status);
  });

  it("can't end the run again when the activation it took over returns", async () => {
    const id = newId();
    const end = hold(id, "end");
    await workflow("tail").create({ id });
    await end.held;

    // The second activation reaches the end second, and returns 2.
    await deliverAlarm("tail", id);
    const status = await ended("tail", id);
    // The first one then returns 1, too late to count.
    end.release();
    const journal = await firstActivationEnded("tail", id);

    expect(status).toStrictEqual({ status: "complete", output: 2 });
    expect(journal.activations).toMatchObject([
      { generation: 1, ended: "superseded" },
      { generation: 2, ended: "settled" },
    ]);
    const instance = await workflow("tail").get(id);
    await expect(instance.status()).resolves.toStrictEqual(status);
  });

  it("changes nothing once the run has ended", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);
    const before = await journalOf("orders", id);

    await deliverAlarm("orders", id);

    await expect(journalOf("orders", id)).resolves.toStrictEqual(before);
    expect(effectsOf(id)).toHaveLength(2);
  });
});

const answerFirst = "its answer comes back first";
const reachFirst = "the activation that took over reaches the step first";

/**
 * Runs "taken-over" with a limit of `limit` retries: its first attempt is
 * out when another activation takes the run over, and either its answer
 * comes back to the activation taken over first, or the one that took
 * over reaches the step first. Returns how the run ended, its journal
 * once both activations are done, and the step's effects.
 */
const takenOver = async (limit: number, order: string) => {
  const id = newId();
  const first = hold(id, "taken", 1);
  const takeover = hold(id, "activation", 2);
  await workflow("taken-over").create({
    id,
    params: { config: { retries: { limit, delay: 0 } } },
  });
  await first.held;
  // Another activation takes the run over, held before the step.
  const delivered = deliverAlarm("taken-over", id);
  await takeover.held;

  if (order === answerFirst) {
    first.release();
    await until("the late answer to be ignored", async () => {
      const journal = await journalOf("taken-over", id);
      return journal.attempts[0]?.ended === "superseded" ? true : undefined;
    });
  }
  takeover.release();
  await delivered;
  first.release();
  const journal = await firstActivationEnded("taken-over", id);
  const status = await ended("taken-over", id);
  return { status, journal, taken: effectsOf(id, "taken") };
};

describe("an attempt whose activation was taken over", () => {
  it.each([answerFirst, reachFirst])(
    "fails a step with no retry left the same whichever comes first, its answer dropped: %s",
    async (order) => {
      const { status, journal, taken } = await takenOver(0, order);

      expect(status).toStrictEqual({
        status: "complete",
        output: { caught: cutOff },
      });
      expect(taken).toHaveLength(1);
      expect(journal).toMatchObject({
        activations: [
          { generation: 1, ended: "superseded" },
          { generation: 2, ended: "settled" },
        ],
        steps: [{ state: "failed", attempt: 1 }],
        attempts: [
          {
            attempt: 1,
            generation: 1,
            ended: "failed",
            error: JSON.stringify(cutOff),
            retry_at: null,
          },
        ],
      });
    }
  );

  it.each([answerFirst, reachFirst])(
    "retries a step with a retry left at once, under its key, the same whichever comes first, its answer dropped: %s",
    async (order) => {
      const { status, journal, taken } = await takenOver(1, order);

      expect(status).toStrictEqual({
        status: "complete",
        output: taken[1]?.receipt,
      });
      expect({
        attempts: taken.map((effect) => effect.attempt),
        keys: new Set(taken.map((effect) => effect.key)).size,
      }).toStrictEqual({ attempts: [1, 2], keys: 1 });
      expect(journal).toMatchObject({
        activations: [
          { generation: 1, ended: "superseded" },
          { generation: 2, ended: "settled" },
        ],
        steps: [{ state: "succeeded", attempt: 2 }],
        attempts: [
          { attempt: 1, generation: 1, ended: "superseded" },
          { attempt: 2, generation: 2, ended: "succeeded" },
        ],
      });
    }
  );

  it("counts as timed out when its timeout ran out after it was taken over, and fails a step with no retry left", async () => {
    const id = newId();
    const first = hold(id, "taken", 1);
    const takeover = hold(id, "activation", 2);
    await workflow("taken-over").create({
      id,
      params: {
        config: { retries: { limit: 0, delay: 0 }, timeout: "2 seconds" },
      },
    });
    await first.held;
    const delivered = deliverAlarm("taken-over", id);
    await takeover.held;
    // Its timeout runs out in the activation that was taken over: ended
    // there as superseded, not as a failure of the step's.
    await until("the timed-out attempt to be ignored", async () => {
      const journal = await journalOf("taken-over", id);
      return journal.attempts[0]?.ended === "superseded" ? true : undefined;
    });

    takeover.release();
    await delivered;
    const status = await ended("taken-over", id);
    first.release();

    const timedOut = {
      name: "WorkflowTimeoutError",
      message: "Execution timed out after 2000ms",
    };
    expect(status).toStrictEqual({
      status: "complete",
      output: { caught: timedOut },
    });
    expect(effectsOf(id, "taken")).toHaveLength(1);
    await expect(journalOf("taken-over", id)).resolves.toMatchObject({
      steps: [{ state: "failed", attempt: 1 }],
      attempts: [
        {
          attempt: 1,
          ended: "timed_out",
          error: JSON.stringify(timedOut),
          retry_at: null,
        },
      ],
    });
  });
});

/** How a delivered alarm's handler came out: returned, or what it threw. */
const outcomeOf = async (delivered: Promise<void>): Promise<string> => {
  try {
    await delivered;
    return "returned";
  } catch (error) {
    return error instanceof Error ? error.message : "not an error";
  }
};

describe("storage that fails around an activation", () => {
  it("leaves a run whose end can't be written to the watchdog, the activation journaled as faulted", async () => {
    const id = newId();
    const first = hold(id, "end", 1);
    await workflow("tail").create({ id });
    await first.held;
    await exec(
      "tail",
      id,
      "CREATE TRIGGER fail_end BEFORE UPDATE OF status ON run WHEN NEW.status = 'complete' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END"
    );

    // An activation that reaches the end and can't write it.
    const outcome = await outcomeOf(deliverAlarm("tail", id));
    const faulted = await journalOf("tail", id);
    const watchdog = await alarmOf("tail", id);
    await exec("tail", id, "DROP TRIGGER fail_end");
    // The watchdog's activation, delivered now rather than a lease away.
    await deliverAlarm("tail", id);
    const status = await ended("tail", id);
    first.release();

    expect(outcome).toBe("returned");
    expect(faulted).toMatchObject({
      run: { status: "running", generation: 2 },
      activations: [
        { generation: 1, ended: null },
        { generation: 2, ended: "faulted" },
      ],
    });
    expect(watchdog).toBe(faulted.run.lease_until);
    expect(status).toStrictEqual({ status: "complete", output: 3 });
  });

  it("leaves a halted run whose end can't be written to the watchdog, the activation journaled as faulted, and the watchdog's replay halts the same way", async () => {
    const id = newId();
    await workflow("drifts").create({ id, params: { what: "type" } });
    await suspendedOn("drifts", id, "held");
    await exec(
      "drifts",
      id,
      "CREATE TRIGGER fail_end BEFORE UPDATE OF status ON run WHEN NEW.status = 'errored' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END"
    );

    // A replay that strays from its journal halts, and can't end the run.
    const outcome = await outcomeOf(deliverAlarm("drifts", id));
    const faulted = await journalOf("drifts", id);
    const watchdog = await alarmOf("drifts", id);
    await exec("drifts", id, "DROP TRIGGER fail_end");
    // The watchdog's activation, delivered now rather than a lease away.
    await deliverAlarm("drifts", id);
    const status = await ended("drifts", id);

    expect(outcome).toBe("returned");
    expect(faulted).toMatchObject({
      run: { status: "running", generation: 2 },
      activations: [
        { generation: 1, ended: "suspended" },
        { generation: 2, ended: "faulted" },
      ],
    });
    expect(watchdog).toBe(faulted.run.lease_until);
    expect(status).toMatchObject({
      status: "errored",
      error: { name: "WorkflowReplayMismatchError" },
    });
  });

  it("lets an activation taken over go when even its end as superseded can't be written", async () => {
    const id = newId();
    const first = hold(id, "end", 1);
    const second = hold(id, "end", 2);
    await workflow("tail").create({ id });
    await first.held;
    const delivered = deliverAlarm("tail", id);
    await second.held;
    // A third activation ends the run.
    await deliverAlarm("tail", id);
    const status = await ended("tail", id);
    await exec(
      "tail",
      id,
      "CREATE TRIGGER fail_superseded BEFORE UPDATE OF ended ON activations WHEN NEW.ended = 'superseded' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END"
    );

    second.release();
    const outcome = await outcomeOf(delivered);
    const journal = await journalOf("tail", id);
    await exec("tail", id, "DROP TRIGGER fail_superseded");
    first.release();

    expect(outcome).toBe("returned");
    expect(status).toStrictEqual({ status: "complete", output: 3 });
    expect(journal.activations).toMatchObject([
      { generation: 1, ended: null },
      { generation: 2, ended: null },
      { generation: 3, ended: "settled" },
    ]);
    await expect(wakeOf("tail", id)).resolves.toBeNull();
  });

  it("ends the run when its purge alarm can't be set, and the watchdog left behind keeps the end and sets the purge", async () => {
    const id = newId();
    const first = hold(id, "end", 1);
    await workflow("tail").create({ id });
    await first.held;
    // Only the purge's alarm fails, days away: the watchdog's, a lease
    // away, is set as ever.
    const restore = await failingPast("tail", id, Date.now() + 60 * 60_000);

    const warnings = await warningsDuring(async () => {
      await outcomeOf(deliverAlarm("tail", id));
    });
    const settled = await journalOf("tail", id);
    const leftOver = await alarmOf("tail", id);
    await restore();
    // The watchdog left behind comes.
    await deliverAlarm("tail", id);
    const after = await journalOf("tail", id);
    const purge = await alarmOf("tail", id);
    first.release();
    await firstActivationEnded("tail", id);

    expect({
      status: settled.run.status,
      events: warnings.map((warning) => eventOf(warning)),
      // What was left is a watchdog, a lease away, not the purge.
      watchdog: leftOver !== null && leftOver < (settled.run.purge_at ?? 0),
      purge: purge === settled.run.purge_at,
    }).toStrictEqual({
      status: "complete",
      events: ["workflow_alarm_set_failed"],
      watchdog: true,
      purge: true,
    });
    // The watchdog kept the end as it was, and replayed nothing.
    expect({ run: after.run, activations: after.activations }).toStrictEqual({
      run: settled.run,
      activations: settled.activations,
    });
  });

  it("leaves the run to a watchdog when a new generation can't be taken, and nothing of the run moves", async () => {
    const id = newId();
    const first = hold(id, "end", 1);
    await workflow("tail").create({ id });
    await first.held;
    const before = await journalOf("tail", id);
    await exec(
      "tail",
      id,
      "CREATE TRIGGER fail_activation BEFORE INSERT ON activations BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END"
    );

    const delivering = Date.now();
    const outcome = await outcomeOf(deliverAlarm("tail", id));
    const after = await journalOf("tail", id);
    const watchdog = await alarmOf("tail", id);
    await exec("tail", id, "DROP TRIGGER fail_activation");
    first.release();
    const status = await ended("tail", id);

    expect(outcome).toBe("returned");
    expect(after).toStrictEqual(before);
    expect(watchdog).toBeGreaterThanOrEqual(delivering + defaultLeaseMs);
    expect(status).toStrictEqual({ status: "complete", output: 1 });
  });

  it("leaves the run to a watchdog when it can't be read, and runs on once it can", async () => {
    const id = newId();
    const first = hold(id, "end", 1);
    await workflow("tail").create({ id });
    await first.held;
    await exec("tail", id, "ALTER TABLE run RENAME COLUMN wake_at TO moved");

    const delivering = Date.now();
    const outcome = await outcomeOf(deliverAlarm("tail", id));
    const watchdog = await alarmOf("tail", id);
    await exec("tail", id, "ALTER TABLE run RENAME COLUMN moved TO wake_at");
    first.release();
    const status = await ended("tail", id);

    expect(outcome).toBe("returned");
    expect(watchdog).toBeGreaterThanOrEqual(delivering + defaultLeaseMs);
    expect(status).toStrictEqual({ status: "complete", output: 1 });
    await expect(journalOf("tail", id)).resolves.toMatchObject({
      activations: [{ generation: 1, ended: "settled" }],
    });
  });

  it("journals an activation whose watchdog can't be set as faulted, runs none of the definition, and hands the alarm back to the host", async () => {
    const id = newId();
    const first = hold(id, "end", 1);
    await workflow("tail").create({ id });
    await first.held;
    const restore = await failing("tail", id, "setAlarm");

    const outcome = await outcomeOf(deliverAlarm("tail", id));
    const faulted = await journalOf("tail", id);
    await restore();
    // The host's retry of the alarm.
    await deliverAlarm("tail", id);
    const status = await ended("tail", id);
    first.release();

    expect(outcome).toBe("injected storage failure");
    expect(faulted).toMatchObject({
      run: { generation: 2 },
      activations: [
        { generation: 1, ended: null },
        { generation: 2, ended: "faulted" },
      ],
    });
    // The second activation never reached the end; the third did, second.
    expect(status).toStrictEqual({ status: "complete", output: 2 });
  });

  it("refuses a journal of another schema without throwing, though its alarm can't be removed", async () => {
    const id = newId();
    await workflow("echo").create({ id });
    await ended("echo", id);
    await exec("echo", id, "UPDATE run SET schema = 1");
    const restore = await failing("echo", id, "deleteAlarm");

    const outcome = await outcomeOf(deliverAlarm("echo", id));
    await restore();

    expect(outcome).toBe("returned");
  });
});
