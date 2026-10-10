import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
// Rollbacks through the run object's real boundary: registered with a
// step, run when the definition throws or the run is terminated with
// `rollback: true`, latest started step first, each journaled and retried
// as a step of its own under its own key. Process death mid-rollback is in
// test/process.
import { describe, expect, it } from "vite-plus/test";

import { Workflow } from "../src/binding.ts";
import { rollbackReplayCapMs } from "../src/config.ts";
import type { InstanceStatus } from "../src/contracts.ts";
import type { WorkflowInstance } from "../src/instance.ts";
import { defaultLeaseMs, WorkflowRun } from "../src/run.ts";
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
import {
  checkpointsReached,
  effectsOf,
  eventOf,
  hold,
  warningsDuring,
} from "./outside.ts";
import type { Effect } from "./outside.ts";
import { budgetedHandlerMs, testRollbackReplayMs } from "./worker.ts";

const instance = async (id: string): Promise<WorkflowInstance> =>
  await workflow("compensated").get(id);

/** Waits until the run has ended, terminated too, and returns how. */
const over = async (id: string): Promise<InstanceStatus> => {
  const run = await instance(id);
  return await until(`run ${id} to end`, async () => {
    const status = await run.status();
    return ["complete", "errored", "terminated"].includes(status.status)
      ? status
      : undefined;
  });
};

/** The labels the outside world saw, in order. */
const labels = (id: string): string[] =>
  effectsOf(id).map((effect) => effect.label);

const only = (id: string, label: string): Effect => {
  const [first, ...rest] = effectsOf(id, label);
  if (first === undefined || rest.length > 0) {
    throw new Error(`${label} was seen ${effectsOf(id, label).length} times`);
  }
  return first;
};

describe("a definition that throws", () => {
  it("rolls back its steps, latest started first, each under its own key, then ends errored", async () => {
    const id = newId();
    await workflow("compensated").create({ id, params: { fail: true } });
    const status = await over(id);

    expect(status).toStrictEqual({
      status: "errored",
      error: { name: "ShippingError", message: "No courier came" },
      rollback: { status: "complete" },
    });
    expect(labels(id)).toStrictEqual([
      "reserve",
      "charge",
      "notify",
      "ship",
      "undo-ship",
      "undo-charge",
      "undo-reserve",
    ]);
    // Each rollback was given its step's key, result and the run's error,
    // and went out under a key of its own.
    const charge = only(id, "charge");
    const undo = only(id, "undo-charge");
    expect(undo).toMatchObject({
      attempt: 1,
      undoing: {
        stepKey: charge.key,
        step: { name: "charge", count: 1 },
        output: charge.receipt,
        error: { name: "ShippingError", message: "No courier came" },
      },
    });
    expect(
      new Set(effectsOf(id).map((effect) => effect.key)).size
    ).toStrictEqual(effectsOf(id).length);
    expect(only(id, "undo-ship").undoing).toMatchObject({ output: undefined });
  });

  it("ends its rolling back at the first rollback that fails, which its status shows apart from its error", async () => {
    const id = newId();
    await workflow("compensated").create({
      id,
      params: { fail: true, undo: "charge" },
    });
    const status = await over(id);

    expect(status).toStrictEqual({
      status: "errored",
      error: { name: "ShippingError", message: "No courier came" },
      rollback: {
        status: "errored",
        error: {
          name: "NonRetryableError",
          message: "charge can't be undone",
        },
      },
    });
    // The reserve, started before, was never undone.
    expect(
      labels(id).filter((label) => label.startsWith("undo-"))
    ).toStrictEqual(["undo-ship", "undo-charge"]);
    await expect(wakeOf("compensated", id)).resolves.toBeNull();
  });

  it("retries a rollback under its one key, and refuses it the step API", async () => {
    const flaky = newId();
    await workflow("compensated").create({
      id: flaky,
      params: { fail: true, flaky: "charge" },
    });
    const nested = newId();
    await workflow("compensated").create({
      id: nested,
      params: { fail: true, nested: "ship" },
    });

    await expect(over(flaky)).resolves.toMatchObject({
      rollback: { status: "complete" },
    });
    const retried = effectsOf(flaky, "undo-charge");
    expect(retried.map((effect) => [effect.attempt, effect.key])).toStrictEqual(
      [
        [1, retried[0]?.key],
        [2, retried[0]?.key],
      ]
    );
    await expect(over(nested)).resolves.toMatchObject({
      rollback: {
        status: "errored",
        error: {
          name: "WorkflowFatalError",
          message: "Cannot execute steps during rollback phase",
        },
      },
    });
  });

  it("waits for a rollback's retry still rolling back, with no activation alive and its alarm at the retry", async () => {
    const id = newId();
    await workflow("compensated").create({
      id,
      params: { fail: true, flaky: "charge", undoDelay: "1 hour" },
    });
    const journal = await until(
      "the rollback to wait for its retry",
      async () => {
        const current = await journalOf("compensated", id);
        return current.steps.some(
          (step) => step.type === "rollback" && step.state === "retrying"
        ) && current.activations.every((row) => row.ended !== null)
          ? current
          : undefined;
      }
    );
    const retryAt = journal.attempts.at(-1)?.retry_at;

    expect(journal.run).toMatchObject({
      status: "rollingBack",
      wake_at: retryAt,
    });
    await expect(alarmOf("compensated", id)).resolves.toBe(retryAt);
    expect(
      labels(id).filter((label) => label.startsWith("undo-"))
    ).toStrictEqual(["undo-ship", "undo-charge"]);
  });

  it("replays again later when the replay is held outside any step, running no rollback and journaling nothing missing", async () => {
    const id = newId();
    const gate = hold(id, "gate", 2);
    await workflow("gated-rollback").create({ id });
    await gate.held;

    // The replay is held before it reached the second step: when its time
    // is up, the run waits, still rolling back, for another to try.
    const waited = await until("the held replay to give up", async () => {
      const journal = await journalOf("gated-rollback", id);
      return journal.activations.some((row) => row.ended === "suspended")
        ? journal
        : undefined;
    });
    const status = await ended("gated-rollback", id);

    expect(waited).toMatchObject({
      run: { status: "rollingBack" },
      activations: [{ ended: "settled" }, { ended: "suspended" }],
    });
    expect(
      waited.steps.filter((step) => step.type === "rollback")
    ).toStrictEqual([]);
    expect(status).toMatchObject({
      status: "errored",
      rollback: { status: "complete" },
    });
    expect(labels(id)).toStrictEqual([
      "first",
      "second",
      "undo-second",
      "undo-first",
    ]);
  });

  it("runs the rollbacks as soon as the replay has them all, though it is held outside any step", async () => {
    const id = newId();
    const gate = hold(id, "gate", 2);
    await workflow("gated-rollback").create({
      id,
      params: { plainSecond: true },
    });
    await gate.held;
    const status = await ended("gated-rollback", id);

    const { activations } = await journalOf("gated-rollback", id);
    expect(status).toMatchObject({ rollback: { status: "complete" } });
    expect(activations.map((row) => row.ended)).toStrictEqual([
      "settled",
      "settled",
    ]);
    expect(labels(id)).toStrictEqual(["first", "second", "undo-first"]);
  });

  it("replays again when code outside any step fails on the replay, journaling nothing missing", async () => {
    const id = newId();
    await workflow("gated-rollback").create({
      id,
      params: { throwOnReplay: true },
    });
    const status = await ended("gated-rollback", id);

    const { activations, steps, run } = await journalOf("gated-rollback", id);
    // The replay that got the rollbacks back started the count again.
    expect({ status, replays: run.rollback_replays }).toMatchObject({
      status: { rollback: { status: "complete" } },
      replays: 0,
    });
    expect(activations.map((row) => row.ended)).toStrictEqual([
      "settled",
      "suspended",
      "settled",
    ]);
    expect(
      steps
        .filter((step) => step.type === "rollback")
        .map((step) => [step.name, step.state])
    ).toStrictEqual([
      ["second", "succeeded"],
      ["first", "succeeded"],
    ]);
  });

  it("ends its rolling back as errored after as many replays as it allows that never get the rollbacks back", async () => {
    const id = newId();
    const gates = [2, 3, 4].map((reached) => hold(id, "gate", reached));
    await workflow("gated-rollback").create({ id });
    await Promise.all(gates.map(async (gate) => await gate.held));
    const status = await ended("gated-rollback", id);

    const { steps, run } = await journalOf("gated-rollback", id);
    expect(status).toMatchObject({
      status: "errored",
      error: { name: "ShippingError" },
      rollback: {
        status: "errored",
        error: { name: "RollbackReplayTimedOut" },
      },
    });
    expect({
      rollbacks: steps.filter((step) => step.type === "rollback"),
      replays: run.rollback_replays,
      undone: labels(id).filter((label) => label.startsWith("undo-")),
    }).toStrictEqual({ rollbacks: [], replays: 3, undone: [] });
  });

  it("skips the replay once every rollback ran, as when the run's end was cut off after them", async () => {
    const id = newId();
    await workflow("gated-rollback").create({ id });
    const first = await ended("gated-rollback", id);
    const reached = checkpointsReached(id, "gate");
    // As if the write that ended it hadn't come: rolling back still, its
    // rollbacks all journaled.
    await runInDurableObject(
      runObject("gated-rollback", id),
      async (_, state) => {
        state.storage.sql.exec(
          "UPDATE run SET status = 'rollingBack', rollback = NULL, ended_at = NULL"
        );
        await state.storage.setAlarm(Date.now());
      }
    );
    await until("the run to be ended again", async () => {
      const { run } = await journalOf("gated-rollback", id);
      return run.status === "errored" ? run : undefined;
    });

    await expect(ended("gated-rollback", id)).resolves.toStrictEqual(first);
    expect(checkpointsReached(id, "gate")).toBe(reached);
  });

  it("refuses a host's replay bound no replay could keep, before any run exists", async () => {
    await expect(
      new Workflow(env.MISCONFIGURED, "orders").create({ id: newId() })
    ).rejects.toThrow(/rollbackReplayMs is a time above 0/u);
  });

  it("leaves a run as it was when the host's replay bound is wrong at an alarm, reports it, and tries again a lease later", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    const before = await journalOf("napper", id);
    const object = runObject("napper", id);

    // The host's setting, wrong by the time this alarm comes.
    let window: { from: number; to: number; alarm: number | null } = {
      from: 0,
      to: 0,
      alarm: null,
    };
    const warnings = await warningsDuring(async () => {
      window = await runInDurableObject(object, async (run, state) => {
        if (!(run instanceof WorkflowRun) || run.alarm === undefined) {
          throw new TypeError("the object isn't a run object");
        }
        const setting: unknown = Reflect.get(run, "rollbackReplayMs");
        Reflect.set(run, "rollbackReplayMs", 0);
        try {
          const from = Date.now();
          await run.alarm();
          return {
            from,
            to: Date.now(),
            alarm: await state.storage.getAlarm(),
          };
        } finally {
          Reflect.set(run, "rollbackReplayMs", setting);
        }
      });
    });
    const after = await journalOf("napper", id);

    expect({
      run: after.run,
      activations: after.activations,
      events: warnings.map((warning) => eventOf(warning)),
    }).toStrictEqual({
      run: before.run,
      activations: before.activations,
      events: ["workflow_settings_invalid"],
    });
    expect(window.alarm).toBeGreaterThanOrEqual(window.from + defaultLeaseMs);
    expect(window.alarm).toBeLessThanOrEqual(window.to + defaultLeaseMs);
  });

  it("ends its rolling back as errored when the replay can't get a rollback back, and journals why", async () => {
    const id = newId();
    await workflow("nested-rollback").create({ id });
    const status = await ended("nested-rollback", id);

    expect(status).toMatchObject({
      error: { name: "ShippingError" },
      rollback: { status: "errored", error: { name: "RollbackMissing" } },
    });
    expect(labels(id)).toStrictEqual(["inner"]);
    await expect(journalOf("nested-rollback", id)).resolves.toMatchObject({
      steps: [
        { type: "do", name: "outer", nested: 0 },
        { type: "do", name: "inner", nested: 1, has_rollback: 1 },
        { type: "do", name: "fail", state: "failed" },
        { type: "rollback", name: "inner", state: "failed" },
      ],
    });
  });

  it("rolls back nothing when the run ends on what its definition can't run on", async () => {
    const id = newId();
    await workflow("compensated").create({ id, params: { fatal: true } });
    const status = await over(id);

    expect(status).toMatchObject({
      status: "errored",
      error: { name: "WorkflowFatalError" },
    });
    expect(status).not.toHaveProperty("rollback");
    expect(labels(id)).toStrictEqual(["reserve", "charge", "notify"]);
  });

  it("with no step that registered a rollback, ends errored at once, with no rollback in its status", async () => {
    const id = newId();
    await workflow("uncaught").create({ id });
    await expect(ended("uncaught", id)).resolves.toStrictEqual({
      status: "errored",
      error: { name: "PaymentError", message: "The card was declined" },
    });
  });
});

describe("terminate with rollback", () => {
  it("rolls back the steps that started, then ends terminated", async () => {
    const id = newId();
    await workflow("compensated").create({ id, params: { wait: true } });
    await suspendedOn("compensated", id, "confirm");
    const run = await instance(id);

    await run.terminate({ rollback: true });
    const status = await over(id);

    expect(status).toStrictEqual({
      status: "terminated",
      rollback: { status: "complete" },
    });
    expect(labels(id)).toStrictEqual([
      "reserve",
      "charge",
      "notify",
      "undo-charge",
      "undo-reserve",
    ]);
    expect(only(id, "undo-reserve").undoing?.error).toStrictEqual({
      name: "Terminated",
      message: "Instance terminated during rollback",
    });
  });

  it("rolls back a step still out, with no output, and ignores its late answer", async () => {
    const id = newId();
    const charge = hold(id, "charge");
    await workflow("compensated").create({ id });
    await charge.held;
    const run = await instance(id);

    await run.terminate({ rollback: true });
    const rolling = await run.status();
    // The rolling back starts once the fenced activation's handler is done,
    // as no alarm comes while one runs: once the step's attempt answered,
    // to no one, or timed out.
    charge.release();
    const status = await over(id);

    expect([rolling, status]).toStrictEqual([
      { status: "rollingBack" },
      { status: "terminated", rollback: { status: "complete" } },
    ]);
    expect(only(id, "undo-charge").undoing).toMatchObject({
      output: undefined,
      stepKey: only(id, "charge").key,
    });
    expect(labels(id)).toStrictEqual([
      "reserve",
      "charge",
      "undo-charge",
      "undo-reserve",
    ]);
    await expect(journalOf("compensated", id)).resolves.toMatchObject({
      steps: [
        { type: "do", name: "reserve", state: "succeeded" },
        { type: "do", name: "charge", state: "running" },
        { type: "rollback", name: "charge", state: "succeeded" },
        { type: "rollback", name: "reserve", state: "succeeded" },
      ],
    });
  });

  it("is a plain termination when no step registered a rollback", async () => {
    const id = newId();
    await workflow("napper").create({ id });
    await suspendedOn("napper", id, "nap");
    const run = await workflow("napper").get(id);

    await run.terminate({ rollback: true });
    await expect(run.status()).resolves.toStrictEqual({
      status: "terminated",
    });
  });
});

describe("rolling back", () => {
  it("isn't cut short by a pause, a terminate or a restart", async () => {
    const id = newId();
    const undoCharge = hold(id, "undo-charge");
    await workflow("compensated").create({ id, params: { fail: true } });
    await undoCharge.held;
    const run = await instance(id);

    await run.pause();
    const paused = await run.status();
    const refused = await Promise.allSettled([run.terminate(), run.restart()]);
    undoCharge.release();

    expect(paused).toStrictEqual({ status: "rollingBack" });
    expect(
      refused.map((one) => String(Reflect.get(one, "reason")))
    ).toStrictEqual([
      expect.stringMatching(/instance\.cannot_terminate: .* rolling back/u),
      expect.stringMatching(/instance\.cannot_restart: .* rolling back/u),
    ]);
    await expect(over(id)).resolves.toMatchObject({
      status: "errored",
      rollback: { status: "complete" },
    });
  });

  it("resumes where it was when another activation takes over: no rollback that succeeded runs again, nor any step", async () => {
    const id = newId();
    const undoCharge = hold(id, "undo-charge");
    await workflow("compensated").create({ id, params: { fail: true } });
    await undoCharge.held;

    // As the watchdog would, had the activation rolling back died.
    await deliverAlarm("compensated", id);
    const status = await over(id);
    undoCharge.release();

    expect(status).toMatchObject({
      status: "errored",
      rollback: { status: "complete" },
    });
    expect(labels(id)).toStrictEqual([
      "reserve",
      "charge",
      "notify",
      "ship",
      "undo-ship",
      "undo-charge",
      "undo-charge",
      "undo-reserve",
    ]);
    const [first, second] = effectsOf(id, "undo-charge");
    expect([second?.attempt, second?.key]).toStrictEqual([2, first?.key]);
  });
});

describe("storage that fails around a rolling back", () => {
  it("leaves a run whose rolling back's end can't be written to the watchdog, which ends it with no rollback run again", async () => {
    const id = newId();
    const undoCharge = hold(id, "undo-charge");
    await workflow("compensated").create({ id, params: { fail: true } });
    await undoCharge.held;
    await runInDurableObject(runObject("compensated", id), (_, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_end BEFORE UPDATE OF rollback ON run WHEN NEW.rollback IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END"
      );
    });

    const warnings = await warningsDuring(async () => {
      undoCharge.release();
      await until("the end's write to fail", async () => {
        const { activations } = await journalOf("compensated", id);
        return activations.at(-1)?.ended === "faulted" ? true : undefined;
      });
    });
    const faulted = await journalOf("compensated", id);
    const watchdog = await alarmOf("compensated", id);
    await runInDurableObject(runObject("compensated", id), (_, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_end");
    });
    // The watchdog's activation, delivered now rather than a lease away.
    await deliverAlarm("compensated", id);
    const status = await over(id);

    expect({
      status: faulted.run.status,
      events: warnings.map((warning) => eventOf(warning)),
      watchdog: watchdog === faulted.run.lease_until,
    }).toStrictEqual({
      status: "rollingBack",
      events: ["workflow_activation_faulted"],
      watchdog: true,
    });
    expect(status).toMatchObject({
      status: "errored",
      rollback: { status: "complete" },
    });
    expect(
      labels(id).filter((label) => label.startsWith("undo-"))
    ).toStrictEqual(["undo-ship", "undo-charge", "undo-reserve"]);
  });

  it("leaves a run whose rolling back's alarm can't be set to the watchdog, which rolls it back", async () => {
    const id = newId();
    const ship = hold(id, "ship");
    await workflow("compensated").create({ id, params: { fail: true } });
    await ship.held;
    // Alarms set to come at once fail; the watchdog's, a lease away, don't.
    await runInDurableObject(runObject("compensated", id), (_, state) => {
      const { storage } = state;
      const set: unknown = Reflect.get(storage, "setAlarm");
      if (typeof set !== "function") {
        throw new TypeError("storage has no setAlarm");
      }
      Reflect.set(storage, "setAlarm", async (time: number) => {
        if (time - Date.now() < defaultLeaseMs / 2) {
          throw new Error("injected storage failure");
        }
        await Reflect.apply(set, storage, [time]);
      });
    });

    const warnings = await warningsDuring(async () => {
      ship.release();
      await until("the run to roll back", async () => {
        const { run } = await journalOf("compensated", id);
        return run.status === "rollingBack" ? true : undefined;
      });
    });
    const left = await journalOf("compensated", id);
    const watchdog = (await alarmOf("compensated", id)) ?? Number.NaN;
    const undone = labels(id).filter((label) => label.startsWith("undo-"));
    await runInDurableObject(runObject("compensated", id), (_, state) => {
      Reflect.deleteProperty(state.storage, "setAlarm");
    });
    await deliverAlarm("compensated", id);
    const status = await over(id);

    // The activation's alarm write failed, and so did the one the host's
    // delivery of the run's new status sets as it ends (run.ts): each is
    // logged, and neither leaves anything but the watchdog.
    expect({
      events: [...new Set(warnings.map((warning) => eventOf(warning)))],
      undone,
    }).toStrictEqual({ events: ["workflow_alarm_set_failed"], undone: [] });
    expect(watchdog).toBeGreaterThan(
      (left.activations.at(-1)?.ended_at ?? Number.NaN) + defaultLeaseMs / 2
    );
    expect(status).toMatchObject({ rollback: { status: "complete" } });
  });
});

describe("a host with shorter handlers", () => {
  it("gives a compensating replay a shorter bound, as its budget is shorter", async () => {
    const id = newId();
    const gate = hold(id, "gate", 2);
    await workflow("quick-gated", env.BUDGETED_RUNS).create({ id });
    await gate.held;
    const journal = await until("the held replay to give up", async () => {
      const current = await journalOf("quick-gated", id, env.BUDGETED_RUNS);
      return current.run.status === "rollingBack" &&
        current.activations.at(-1)?.ended === "suspended"
        ? current
        : undefined;
    });
    gate.release();
    await ended("quick-gated", id, env.BUDGETED_RUNS);
    const suspendedAt = journal.activations.at(-1)?.ended_at ?? Number.NaN;

    // A second of budget, where Cloudflare's is 14 minutes: its replay
    // gets as much less than the 200 ms this host asks for.
    expect(
      (journal.run.wake_at ?? Number.NaN) - suspendedAt
    ).toBeLessThanOrEqual(rollbackReplayCapMs(budgetedHandlerMs));
    expect(rollbackReplayCapMs(budgetedHandlerMs)).toBeLessThan(
      testRollbackReplayMs
    );
  });
});

describe("delete", () => {
  it("rolls back nothing, mid-step or waiting, nor does a terminate without rollback", async () => {
    const waiting = newId();
    await workflow("compensated").create({
      id: waiting,
      params: { wait: true },
    });
    await suspendedOn("compensated", waiting, "confirm");
    const midStep = newId();
    const charge = hold(midStep, "charge");
    await workflow("compensated").create({ id: midStep });
    await charge.held;
    const terminated = newId();
    await workflow("compensated").create({
      id: terminated,
      params: { wait: true },
    });
    await suspendedOn("compensated", terminated, "confirm");

    const runs = await Promise.all(
      [waiting, midStep, terminated].map(async (id) => await instance(id))
    );
    await runs[0]?.delete();
    await runs[1]?.delete();
    await runs[2]?.terminate();
    charge.release();
    await until("the deleted run's late answer", () =>
      effectsOf(midStep, "charge").length === 1 ? true : undefined
    );

    expect(
      [waiting, midStep, terminated].flatMap((id) =>
        labels(id).filter((label) => label.startsWith("undo-"))
      )
    ).toStrictEqual([]);
    await expect(over(terminated)).resolves.toStrictEqual({
      status: "terminated",
    });
  });
});

describe("a step's rollback options", () => {
  it.each([
    "null",
    "text",
    "no rollback",
    "rollback not a function",
    "unknown setting",
    "sensitive rollback",
    "zero timeout",
    "config not an object",
  ])(
    "are refused when they are %s, before anything is journaled",
    async (shape) => {
      const id = newId();
      await workflow("rollback-shapes").create({ id, params: { shape } });
      await expect(ended("rollback-shapes", id)).resolves.toMatchObject({
        status: "complete",
        output: { caught: { name: "TypeError" } },
      });
      await expect(journalOf("rollback-shapes", id)).resolves.toMatchObject({
        steps: [],
      });
    }
  );
});
