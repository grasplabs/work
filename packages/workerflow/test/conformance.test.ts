// The compatibility matrix, on plain workerd: every family of the profile
// (conformance-families.ts) runs the same fixtures on Workerflow and on the
// reference engine, through each one's public binding, and compares what
// each did. Where they agree, the test says so; where they differ, the
// discrepancy's own test observes both sides, as conformance-families.ts
// declares them. Process death, eviction and duplicate alarms on
// disk-backed workerd are the process suite's (test/process/death.test.ts),
// on Workerflow alone: the reference can't be killed mid-step from here.
import { env } from "cloudflare:workers";
import type {
  WorkflowEvent as ReferenceEvent,
  WorkflowInstanceStatus as ReferenceStatus,
  WorkflowStep as ReferenceStep,
  WorkflowStepContext as ReferenceContext,
} from "cloudflare:workers";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";

import type {
  InstanceStatus,
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepContext,
} from "../src/contracts.ts";
import {
  arrived,
  delivered,
  engineBinding,
  eventsOf,
  notes,
  onBoth,
  outcomeOf,
  ran,
  reached,
  settle,
  start,
  statusName,
  threwWith,
} from "./conformance-engines.ts";
import type { Instance, Pair } from "./conformance-engines.ts";
import {
  discrepancies,
  families,
  familyVerdict,
  profileId,
} from "./conformance-families.ts";
import type { DiscrepancyName, Family } from "./conformance-families.ts";
import { pausableSleepMs } from "./conformance-fixtures.ts";

const sameOnBoth = <T>(pair: Pair<T>): T => {
  expect(pair.engine).toStrictEqual(pair.reference);
  return pair.engine;
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const attemptDelays = (events: readonly Record<string, unknown>[]): unknown[] =>
  events
    .filter((event) => event.type === "attempt_errored")
    .map((event) => [event.stepName, event.attempt, event.retryDelayMs]);

const types = (events: readonly Record<string, unknown>[]): unknown[] =>
  events.map((event) => [event.type, event.stepName]);

const paused = new Set(["paused"]);

/** An output with its instance ID blanked: each engine's run has its own. */
const without = (output: unknown): unknown =>
  typeof output === "object" && output !== null
    ? { ...output, instanceId: "" }
    : output;

/** What a rollback of `label` notes when the run threw "end". */
const undoing = (label: string, output: string): unknown => ({
  undo: label,
  output,
  error: { name: "Error", message: "end" },
  stepName: `${label}-1`,
  step: { name: label, count: 1 },
});

/** Waits until both runs have got to their event wait. */
const atTheirWait = async (pair: Pair<Instance>): Promise<void> => {
  await onBoth(pair, async (instance) => {
    await arrived(instance, "wait_started");
  });
};

/** Sends `event` to both, after `ms`, as a caller would while they run. */
const sendBoth = async (
  pair: Pair<Instance>,
  event: { type: string; payload: unknown },
  ms = 100
): Promise<void> => {
  await scheduler.wait(ms);
  await onBoth(
    pair,
    async (instance) =>
      await settle(async () => {
        await instance.sendEvent(event);
      })
  );
};

const checks: Record<Family, () => void> = {
  "definition-event": () => {
    test("Workerflow's event type is Cloudflare's", () => {
      expectTypeOf<WorkflowEvent<{ order: number }>>().toExtend<
        ReferenceEvent<{ order: number }>
      >();
    });

    test("a run is given its params, a creation time that replays unchanged, its ID and its workflow's name", async () => {
      const { reference, engine, instances } = await ran("event", { order: 7 });
      expect(field(engine.output, "instanceId")).toBe(instances.engine.id);
      expect(field(reference.output, "instanceId")).toBe(
        instances.reference.id
      );
      expect(without(engine.output)).toStrictEqual(without(reference.output));
      expect(without(engine.output)).toStrictEqual({
        payload: { order: 7 },
        keys: ["instanceId", "payload", "timestamp", "workflowName"],
        timestampIsDate: true,
        stableTimestamp: true,
        instanceId: "",
      });
    });
  },
  "do-overloads": () => {
    test("do takes a callback alone, a config, a rollback without a config, and a step inside a step; a failure reaches the author's catch", async () => {
      const outcome = sameOnBoth(await ran("overloads"));
      expect(outcome).toStrictEqual({
        status: "complete",
        output: {
          bare: "bare",
          configured: "configured",
          withRollback: "with-rollback",
          nested: "inner",
          caught: { name: "RangeError", message: "out of range" },
        },
      });
    });
  },
  "step-context": () => {
    test("occurrences of a name count from 1, attempts count from 1 across retries, and a given config comes back resolved", async () => {
      const { reference, engine } = await ran("context");
      const shared = (output: unknown): unknown => ({
        first: field(output, "first"),
        second: field(output, "second"),
        attempts: field(output, "attempts"),
      });
      expect(shared(engine.output)).toStrictEqual(shared(reference.output));
      expect(shared(engine.output)).toStrictEqual({
        first: { name: "same", count: 1 },
        second: { name: "same", count: 2 },
        attempts: {
          attempt: 3,
          config: {
            retries: { limit: 2, delay: 10, backoff: "constant" },
            timeout: "10 minutes",
          },
        },
      });
    });
  },
  "retry-policy": () => {
    test("constant, linear and exponential delays are recorded alike, and the last attempt has none", async () => {
      const instances = await start("backoffs");
      const delays = sameOnBoth(
        await onBoth(instances, async (instance) =>
          attemptDelays(await eventsOf(instance))
        )
      );
      expect(delays).toStrictEqual([
        ["constant-1", 1, 10],
        ["constant-1", 2, 10],
        ["constant-1", 3, 10],
        ["constant-1", 4, undefined],
        ["linear-1", 1, 10],
        ["linear-1", 2, 20],
        ["linear-1", 3, 30],
        ["linear-1", 4, undefined],
        ["exponential-1", 1, 10],
        ["exponential-1", 2, 20],
        ["exponential-1", 3, 40],
        ["exponential-1", 4, undefined],
      ]);
    });

    test("a delay given as text is read as a duration", async () => {
      const instances = await start("string-delay");
      expect(
        sameOnBoth(
          await onBoth(instances, async (instance) =>
            attemptDelays(await eventsOf(instance))
          )
        )
      ).toStrictEqual([
        ["x-1", 1, 1000],
        ["x-1", 2, undefined],
      ]);
    });

    test("a delay function is asked once per failed attempt with a retry left", async () => {
      const { instances, ...outcomes } = await ran("dynamic-delay");
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "errored",
        error: { name: "Error", message: "dynamic" },
      });
      expect(sameOnBoth(notes(instances))).toStrictEqual([1, 2]);
    });

    test("a step whose retries are spent fails with its last attempt's error", async () => {
      const { instances, ...outcomes } = await ran("spent-retries");
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "errored",
        error: { name: "Error", message: "failed 3" },
      });
      expect(sameOnBoth(notes(instances))).toStrictEqual([1, 2, 3]);
    });

    test("an attempt past its timeout fails with the same message", async () => {
      const { reference, engine } = await ran("slow-step");
      expect(engine.status).toBe("errored");
      expect(reference.status).toBe("errored");
      expect(engine.error?.message).toBe(reference.error?.message);
      expect(engine.error?.message).toBe("Execution timed out after 50ms");
    });

    test("a timeout of 0 is refused", async () => {
      const { reference, engine } = await ran("zero-timeout");
      expect([engine.status, reference.status]).toStrictEqual([
        "errored",
        "errored",
      ]);
    });
  },
  "nonretryable-failure": () => {
    test("a NonRetryableError isn't retried, and ends the run", async () => {
      const { instances, reference, engine } = await ran("non-retryable");
      expect([engine.status, reference.status]).toStrictEqual([
        "errored",
        "errored",
      ]);
      expect(sameOnBoth(notes(instances))).toStrictEqual([1]);
    });

    test("a NonRetryableError isn't retried, and the author's catch gets it", async () => {
      const { instances, reference, engine } = await ran(
        "non-retryable-caught"
      );
      expect([engine.status, reference.status]).toStrictEqual([
        "complete",
        "complete",
      ]);
      expect(sameOnBoth(notes(instances))).toStrictEqual([1]);
    });
  },
  sleeps: () => {
    test("Workerflow's sleep and sleepUntil types are Cloudflare's", () => {
      expectTypeOf<WorkflowStep["sleep"]>().toExtend<ReferenceStep["sleep"]>();
      expectTypeOf<WorkflowStep["sleepUntil"]>().toExtend<
        ReferenceStep["sleepUntil"]
      >();
    });

    test("a relative sleep, in milliseconds or as text, and a sleep until a future Date or time", async () => {
      const { instances: _instances, ...outcomes } = await ran("sleeps");
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "complete",
        output: "slept",
      });
    });
  },
  events: () => {
    test("Workerflow's waitForEvent type is Cloudflare's", () => {
      expectTypeOf<WorkflowStep["waitForEvent"]>().toExtend<
        ReferenceStep["waitForEvent"]
      >();
    });

    test("events sent before their waits are buffered, and taken oldest first, one per wait", async () => {
      const instances = await start("buffered");
      await sendBoth(instances, { type: "item", payload: { n: 1 } }, 50);
      await sendBoth(instances, { type: "item", payload: { n: 2 } }, 0);
      const outcomes = await onBoth(instances, async (instance) =>
        outcomeOf(await reached(instance))
      );
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "complete",
        output: {
          payloads: [{ n: 1 }, { n: 2 }],
          type: "item",
          timestampIsDate: true,
        },
      });
    });

    test("a wait with no event by its timeout rejects, with the same message", async () => {
      const { reference, engine } = await ran("wait-timeout");
      expect(field(engine.output, "message")).toBe(
        field(reference.output, "message")
      );
      expect(field(engine.output, "message")).toBe(
        "Execution timed out after 50ms"
      );
    });
  },
  serialization: () => {
    test("every structured value a step returns comes back as it was", async () => {
      const { instances: _instances, ...outcomes } = await ran("values");
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "complete",
        output: {
          date: { date: 5 },
          bytes: { bytes: [1, 2] },
          map: { map: [[1, "one"]] },
          set: { set: ["s"] },
          regexp: { regexp: ["a+", "giu"] },
          error: { error: ["TypeError", "kept"] },
          bigint: { bigint: "10" },
          nan: { number: "NaN" },
          holes: { array: 3, holes: 1 },
          nested: { deep: [{ n: null }] },
          text: "é",
        },
      });
    });

    test("a step that returns a function ends the run, which the definition can't catch", async () => {
      const { instances: _instances, ...outcomes } =
        await ran("function-value");
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "errored",
        error: {
          name: "WorkflowFatalError",
          message:
            'The execution of the Workflow instance was terminated, as the step "value" returned a value which is not serialisable',
        },
      });
    });
  },
  streams: () => {
    test("a byte stream a step returns is replayed as fresh bytes after a suspension", async () => {
      const { instances: _instances, ...outcomes } = await ran("stream");
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "complete",
        output: "hi",
      });
    });
  },
  "sensitive-output": () => {
    test("a sensitive step's output is redacted for observers and given to the run", async () => {
      const instances = await start("sensitive");
      const seen = await onBoth(instances, async (instance) => {
        const events = await eventsOf(instance);
        return {
          outcome: outcomeOf(await instance.status()),
          completed: events.find((event) => event.type === "step_completed"),
          sensitivity: field(
            events.find((event) => event.type === "step_started")?.config,
            "sensitive"
          ),
        };
      });
      expect(sameOnBoth(seen)).toStrictEqual({
        outcome: { status: "complete", output: "s3cr3t" },
        completed: {
          type: "step_completed",
          stepName: "secret-1",
          output: "[REDACTED]",
        },
        sensitivity: "output",
      });
    });
  },
  "binding-create-get": () => {
    test("create draws an ID when none is given", async () => {
      const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;
      const [reference, engine] = await Promise.all([
        env.REFERENCE.create({ params: { fixture: "throws", params: {} } }),
        engineBinding("throws").create(),
      ]);
      expect(reference.id).toMatch(uuid);
      expect(engine.id).toMatch(uuid);
    });

    test("get of an ID with no run throws instance.not_found", async () => {
      const missing = `missing-${crypto.randomUUID().slice(0, 8)}`;
      const reference = await settle(async () => {
        const instance = await env.REFERENCE.get(missing);
        return await instance.status();
      });
      const engine = await settle(async () => {
        const instance = await engineBinding("throws").get(missing);
        return await instance.status();
      });
      expect(threwWith(reference, "instance.not_found")).toBeTruthy();
      expect(threwWith(engine, "instance.not_found")).toBeTruthy();
    });

    test("create refuses an ID outside the rule", async () => {
      const reference = await settle(
        async () =>
          await env.REFERENCE.create({
            id: "-not an id",
            params: { fixture: "throws", params: {} },
          })
      );
      const engine = await settle(
        async () => await engineBinding("throws").create({ id: "-not an id" })
      );
      expect(
        threwWith(reference, "Workflow instance has invalid id")
      ).toBeTruthy();
      expect(
        threwWith(engine, "Workflow instance has invalid id")
      ).toBeTruthy();
    });
  },
  "batch-operations": () => {
    test("deleteBatch deletes what exists and reports each missing ID with the reference's code", async () => {
      const instances = await start("gated");
      const results = await onBoth(instances, async (instance) => {
        const binding =
          instance === instances.reference
            ? env.REFERENCE
            : engineBinding("gated");
        const result = await binding.deleteBatch([instance.id, "missing-1"]);
        return {
          deleted: result.deleted.map(({ id }) => id === instance.id),
          errors: result.errors,
        };
      });
      expect(sameOnBoth(results)).toStrictEqual({
        deleted: [true],
        errors: [
          {
            id: "missing-1",
            code: 10_400,
            message: "workflows.api.error.instance.not_found",
          },
        ],
      });
    });

    test("createBatch refuses an empty batch", async () => {
      const reference = await settle(
        async () => await env.REFERENCE.createBatch([])
      );
      const engine = await settle(
        async () => await engineBinding("throws").createBatch([])
      );
      const message = "batchCreate should have at least 1 instance";
      expect(threwWith(reference, message)).toBeTruthy();
      expect(threwWith(engine, message)).toBeTruthy();
    });
  },
  status: () => {
    test("an errored run's status keeps its error's name and message", async () => {
      const { instances: _instances, ...outcomes } = await ran("throws");
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "errored",
        error: { name: "RangeError", message: "bad input" },
      });
    });
  },
  "pause-resume": () => {
    test("a run paused in a sleep stays paused past its deadline, and resumed, finishes without repeating a step; pause and resume are idempotent", async () => {
      const instances = await start("pausable");
      await onBoth(instances, async (instance) => {
        // Paused once it has got to its sleep.
        await arrived(instance, "sleep_started");
        await instance.pause();
        await reached(instance, paused);
        await instance.pause();
      });
      await scheduler.wait(pausableSleepMs + 200);
      expect(
        sameOnBoth(
          await onBoth(
            instances,
            async (instance) => await statusName(instance)
          )
        )
      ).toBe("paused");
      expect(sameOnBoth(notes(instances))).toStrictEqual(["one"]);
      const outcomes = await onBoth(instances, async (instance) => {
        await instance.resume();
        await instance.resume();
        return outcomeOf(await reached(instance));
      });
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "complete",
        output: "done",
      });
      expect(sameOnBoth(notes(instances))).toStrictEqual(["one", "two"]);
      const afterEnd = await onBoth(instances, async (instance) => [
        await settle(async () => {
          await instance.pause();
        }),
        await settle(async () => {
          await instance.resume();
        }),
        outcomeOf(await instance.status()),
      ]);
      expect(sameOnBoth(afterEnd)).toStrictEqual([
        { ok: true, value: undefined },
        { ok: true, value: undefined },
        { status: "complete", output: "done" },
      ]);
    });
  },
  "termination-deletion": () => {
    test("terminate ends a waiting run; an ended run can't be terminated; a deleted run is gone", async () => {
      const instances = await start("gated");
      await atTheirWait(instances);
      const terminated = await onBoth(instances, async (instance) => {
        await instance.terminate();
        return outcomeOf(await reached(instance));
      });
      expect(sameOnBoth(terminated)).toStrictEqual({ status: "terminated" });
      const again = await onBoth(
        instances,
        async (instance) =>
          await settle(async () => {
            await instance.terminate();
          })
      );
      expect(threwWith(again.reference, "cannot_terminate")).toBeTruthy();
      expect(threwWith(again.engine, "cannot_terminate")).toBeTruthy();
      const deleted = await onBoth(instances, async (instance) => {
        await instance.delete();
        return await settle(async () => await instance.status());
      });
      expect(threwWith(deleted.reference, "instance.not_found")).toBeTruthy();
      expect(threwWith(deleted.engine, "instance.not_found")).toBeTruthy();
    });
  },
  restart: () => {
    test("restart from a named wait keeps the steps before it; a step it never reached is refused", async () => {
      const instances = await start("gated");
      await atTheirWait(instances);
      const unknown = await onBoth(
        instances,
        async (instance) =>
          await settle(async () => {
            await instance.restart({ from: { name: "nowhere" } });
          })
      );
      expect(threwWith(unknown.reference, "cannot_restart")).toBeTruthy();
      expect(threwWith(unknown.engine, "cannot_restart")).toBeTruthy();
      await onBoth(instances, async (instance) => {
        await instance.restart({ from: { name: "go", type: "waitForEvent" } });
      });
      await sendBoth(instances, { type: "go", payload: 1 });
      const outcomes = await onBoth(instances, async (instance) =>
        outcomeOf(await reached(instance))
      );
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "complete",
        output: "done",
      });
      expect(sameOnBoth(notes(instances))).toStrictEqual(["one", "two"]);
    });
  },
  rollbacks: () => {
    test("a run that throws rolls back its steps in reverse order, each given its output, the error and its name", async () => {
      const { instances, ...outcomes } = await ran("compensated");
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "errored",
        error: { name: "Error", message: "end" },
      });
      expect(sameOnBoth(notes(instances))).toStrictEqual([
        undoing("b", "B"),
        undoing("a", "A"),
      ]);
    });

    test("a failed step with a rollback is rolled back, with no output", async () => {
      const { instances, ...outcomes } = await ran("compensated-failure");
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "errored",
        error: { name: "Error", message: "a failed" },
      });
      expect(sameOnBoth(notes(instances))).toStrictEqual([
        {
          undo: "a",
          output: undefined,
          error: { name: "Error", message: "a failed" },
          stepName: "a-1",
          step: { name: "a", count: 1 },
        },
      ]);
    });

    test("a rollback that fails leaves the run errored with its own error", async () => {
      const { instances: _instances, ...outcomes } =
        await ran("failed-rollback");
      expect(sameOnBoth(outcomes)).toStrictEqual({
        status: "errored",
        error: { name: "Error", message: "end" },
      });
    });

    test("terminate with rollback rolls back, and ends terminated", async () => {
      const instances = await start("terminated-rollback");
      await atTheirWait(instances);
      const outcomes = await onBoth(instances, async (instance) => {
        await instance.terminate({ rollback: true });
        return outcomeOf(await reached(instance));
      });
      expect(sameOnBoth(outcomes)).toStrictEqual({ status: "terminated" });
      const undone = notes(instances);
      expect(undone.engine).toHaveLength(1);
      expect(undone.reference).toHaveLength(1);
    });
  },
  subscriptions: () => {
    test("a run with no suspension delivers the same events in the same order, and a filter and a cursor apply alike", async () => {
      const instances = await start("overloads");
      const seen = await onBoth(instances, async (instance) => {
        await reached(instance);
        const all = await eventsOf(instance);
        const filtered = await delivered(instance, {
          filter: ["step_completed"],
        });
        const after = await delivered(instance, { cursor: all.length - 1 });
        return {
          types: types(all),
          filtered: filtered.map((event) => field(event, "stepName")),
          after: after.map((event) => field(event, "type")),
        };
      });
      expect(sameOnBoth(seen)).toMatchObject({
        filtered: [
          "bare-1",
          "configured-1",
          "with-rollback-1",
          "inner-1",
          "outer-1",
        ],
        after: ["workflow_completed"],
      });
      expect(seen.engine.types.at(0)).toStrictEqual([
        "workflow_queued",
        undefined,
      ]);
    });
  },
  schedules: () => {
    // No agreement to observe: the reference starts no run from a
    // schedule locally (the discrepancy says so).
  },
  "retention-limits": () => {
    test("a step name of 256 characters is taken, one of 257 refused", async () => {
      const kept = await ran("names");
      expect(
        sameOnBoth({ reference: kept.reference, engine: kept.engine })
      ).toStrictEqual({
        status: "complete",
        output: "kept",
      });
      const refused = await ran("long-name");
      expect([refused.engine.status, refused.reference.status]).toStrictEqual([
        "errored",
        "errored",
      ]);
    });
  },
};

const discrepancyChecks: Record<DiscrepancyName, () => Promise<void>> = {
  "context-type": async () => {
    expectTypeOf<WorkflowStepContext["step"]>().toExtend<
      ReferenceContext["step"]
    >();
    // A static delay's context always has its delay on Cloudflare's type;
    // Workerflow's one context type leaves it optional, for a delay
    // function's context. So its step type isn't Cloudflare's either.
    expectTypeOf<
      NonNullable<WorkflowStepContext["config"]["retries"]>
    >().not.toExtend<NonNullable<ReferenceContext["config"]["retries"]>>();
    expectTypeOf<WorkflowStep>().not.toExtend<ReferenceStep>();
    // At run time both give a static delay's context its delay.
    const { reference, engine } = await ran("context");
    const delayOf = (output: unknown): unknown =>
      field(
        field(field(field(output, "attempts"), "config"), "retries"),
        "delay"
      );
    expect(delayOf(engine.output)).toBe(10);
    expect(delayOf(reference.output)).toBe(10);
  },
  "default-retry-delay": async () => {
    const { reference, engine } = await ran("context");
    expect(
      field(field(field(engine.output, "defaults"), "retries"), "delay")
    ).toBe(10_000);
    expect(
      field(field(field(reference.output, "defaults"), "retries"), "delay")
    ).toBe(1000);
  },
  "idempotency-key": async () => {
    const { reference, engine } = await ran("context");
    expect(field(engine.output, "keys")).toStrictEqual([
      "attempt",
      "config",
      "idempotencyKey",
      "step",
    ]);
    expect(field(reference.output, "keys")).toStrictEqual([
      "attempt",
      "config",
      "step",
    ]);
  },
  "attempt-timeout-name": async () => {
    const { reference, engine } = await ran("slow-step");
    expect(engine.error?.name).toBe("WorkflowTimeoutError");
    expect(reference.error?.name).toBe("Error");
  },
  "caught-non-retryable": async () => {
    const { reference, engine } = await ran("non-retryable-caught");
    expect(engine.output).toStrictEqual({
      name: "NonRetryableError",
      message: "no point",
    });
    expect(reference.output).toStrictEqual({
      name: "Error",
      message: "NonRetryableError: no point",
    });
  },
  "past-sleep-until": async () => {
    const { reference, engine } = await ran("past-sleep");
    expect(engine).toStrictEqual({ status: "complete", output: "slept" });
    expect(reference.status).toBe("errored");
    expect(reference.error?.message).toContain("in the past");
  },
  "negative-sleep": async () => {
    const { reference, engine } = await ran("negative-sleep");
    expect(engine.status).toBe("errored");
    expect(reference).toStrictEqual({ status: "complete", output: "slept" });
  },
  "parallel-sleeps": async () => {
    const { reference, engine } = await ran("parallel-sleeps");
    expect(engine.error?.name).toBe("WorkflowParallelWaitError");
    expect(reference).toStrictEqual({ status: "complete", output: "slept" });
  },
  "wait-race": async () => {
    const instances = await start("wait-race");
    await sendBoth(instances, { type: "reply", payload: { n: 1 } });
    const outcomes = await onBoth(instances, async (instance) =>
      outcomeOf(await reached(instance))
    );
    expect(outcomes.engine.error?.name).toBe("WorkflowParallelWaitError");
    expect(outcomes.reference.status).toBe("complete");
    expect(field(outcomes.reference.output, "payload")).toStrictEqual({ n: 1 });
  },
  "wait-timeout-name": async () => {
    const { reference, engine } = await ran("wait-timeout");
    expect(field(engine.output, "name")).toBe("WorkflowTimeoutError");
    expect(field(reference.output, "name")).toBe("Error");
  },
  "event-type-rule": async () => {
    const { reference, engine, instances } = await ran("odd-event-type");
    expect(engine.output).toBe("TypeError");
    // The reference waited for the event, and timed out.
    expect(reference.output).toBe("Error");
    const sent = await onBoth(
      instances,
      async (instance) =>
        await settle(async () => {
          await instance.sendEvent({ type: "has space", payload: 1 });
        })
    );
    expect(sent.engine).toMatchObject({ ok: false, name: "TypeError" });
    // To an ended run, as the next discrepancy shows: taken all the same.
    expect(sent.reference).toStrictEqual({ ok: true, value: undefined });
  },
  "event-to-ended-run": async () => {
    const { instances } = await ran("throws");
    const sent = await onBoth(
      instances,
      async (instance) =>
        await settle(async () => {
          await instance.sendEvent({ type: "late", payload: 1 });
        })
    );
    expect(threwWith(sent.engine, "instance.not_running")).toBeTruthy();
    expect(sent.reference).toStrictEqual({ ok: true, value: undefined });
  },
  "class-instance-result": async () => {
    const instances = await start("class-value");
    expect(outcomeOf(await reached(instances.engine))).toStrictEqual({
      status: "complete",
      output: { id: 1 },
    });
    // The reference refuses each attempt's result, as a retryable error.
    const refused = await arrived(instances.reference, "attempt_errored");
    expect(refused).toMatchObject({
      stepName: "value-1",
      attempt: 1,
      error: { name: "DataCloneError" },
    });
    expect(field(refused, "retryDelayMs")).toBeGreaterThan(0);
  },
  "byob-stream": async () => {
    const { reference, engine } = await ran("byob-stream");
    expect(engine).toStrictEqual({
      status: "errored",
      error: {
        name: "TypeError",
        message: "This ReadableStream does not support BYOB reads.",
      },
    });
    expect(reference).toStrictEqual({ status: "complete", output: [104, 105] });
  },
  "invalid-stream-error": async () => {
    const locked = await ran("locked-stream");
    expect(locked.engine.error?.name).toBe("WorkflowFatalError");
    expect(locked.reference.error?.name).toBe("TypeError");
    const text = await ran("text-stream");
    expect(text.engine.error?.name).toBe("WorkflowFatalError");
    expect(text.reference.error?.name).toBe("DataCloneError");
  },
  "duplicate-create": async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const params = { fixture: "throws", params: {} };
    await env.REFERENCE.create({ id: `reference-${tag}`, params });
    await engineBinding("throws").create({ id: `engine-${tag}` });
    const reference = await settle(async () => {
      const instance = await env.REFERENCE.create({
        id: `reference-${tag}`,
        params,
      });
      return instance.id;
    });
    const engine = await settle(
      async () => await engineBinding("throws").create({ id: `engine-${tag}` })
    );
    expect(threwWith(engine, "instance.already_exists")).toBeTruthy();
    expect(reference).toStrictEqual({ ok: true, value: `reference-${tag}` });
  },
  "batch-limit": async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const params = { fixture: "throws", params: {} };
    const entries = Array.from(
      { length: 101 },
      (_, index) => `${tag}-${index}`
    );
    const engine = await settle(
      async () =>
        await engineBinding("throws").createBatch(
          entries.map((id) => ({ id: `e-${id}` }))
        )
    );
    const reference = await settle(async () => {
      const created = await env.REFERENCE.createBatch(
        entries.map((id) => ({ id: `r-${id}`, params }))
      );
      return created.length;
    });
    expect(threwWith(engine, "only supports 100 instances")).toBeTruthy();
    expect(reference).toStrictEqual({ ok: true, value: 101 });
  },
  "batch-duplicates": async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const params = { fixture: "throws", params: {} };
    await env.REFERENCE.create({ id: `r-existing-${tag}`, params });
    await engineBinding("throws").create({ id: `e-existing-${tag}` });
    const referenceCreated = await env.REFERENCE.createBatch([
      { id: `r-twice-${tag}`, params },
      { id: `r-twice-${tag}`, params },
      { id: `r-existing-${tag}`, params },
    ]);
    const engineCreated = await engineBinding("throws").createBatch([
      { id: `e-twice-${tag}` },
      { id: `e-twice-${tag}` },
      { id: `e-existing-${tag}` },
    ]);
    const reference = referenceCreated.map(({ id }) => id);
    const engine = engineCreated.map(({ id }) => id);
    expect(engine).toStrictEqual([`e-twice-${tag}`]);
    expect(reference).toStrictEqual([
      `r-twice-${tag}`,
      `r-twice-${tag}`,
      `r-existing-${tag}`,
    ]);
  },
  "rolling-back-status": async () => {
    expectTypeOf<"rollingBack">().toExtend<InstanceStatus["status"]>();
    expectTypeOf<"rollingBack">().not.toExtend<ReferenceStatus>();
    expectTypeOf<
      Exclude<InstanceStatus["status"], "rollingBack">
    >().toExtend<ReferenceStatus>();
    // Read through a rollback that takes 400 ms: Workerflow says so.
    const instances = await start("slow-rollback");
    const seen = await onBoth(instances, async (instance) => {
      const statuses = new Set<unknown>();
      const started = Date.now();
      while (Date.now() - started < 10_000) {
        // oxlint-disable-next-line no-await-in-loop -- polling, one read at a time
        const status = await statusName(instance);
        if (status === "errored") {
          return statuses;
        }
        statuses.add(status);
        // oxlint-disable-next-line no-await-in-loop -- polling, one read at a time
        await scheduler.wait(20);
      }
      throw new Error(
        `${instance.id} never ended: ${[...statuses].join(", ")}`
      );
    });
    expect(seen.engine.has("rollingBack")).toBeTruthy();
    expect(seen.reference.has("rollingBack")).toBeFalsy();
  },
  "waiting-status": async () => {
    const instances = await start("gated");
    await atTheirWait(instances);
    // Given the time to suspend, and more.
    await scheduler.wait(200);
    const statuses = await onBoth(instances, statusName);
    expect(statuses).toStrictEqual({ engine: "waiting", reference: "running" });
  },
  "status-fields": async () => {
    const instances = await start("compensated");
    const statuses = await onBoth(instances, async (instance) => {
      await reached(instance);
      return await instance.status();
    });
    expect(statuses.engine).not.toHaveProperty("output");
    expect(statuses.engine).toHaveProperty("rollback", { status: "complete" });
    expect(statuses.reference).toHaveProperty("output", null);
    expect(statuses.reference).not.toHaveProperty("rollback");
  },
  "terminate-rollback-error": async () => {
    const instances = await start("terminated-rollback");
    await atTheirWait(instances);
    await onBoth(instances, async (instance) => {
      await instance.terminate({ rollback: true });
      await reached(instance);
    });
    const errorName = (noted: unknown[]): unknown =>
      field(field(noted.at(0), "error"), "name");
    const undone = notes(instances);
    expect(errorName(undone.engine)).toBe("Terminated");
    expect(errorName(undone.reference)).toBe("Error");
  },
  "suspension-events": async () => {
    const instances = await start("stream");
    const sequences = await onBoth(instances, async (instance) => {
      const events = await eventsOf(instance);
      return events.map((event) => event.type);
    });
    // Each suspension is a workflow_waiting, then a workflow_running.
    const unsuspended = sequences.engine.filter(
      (type, index, all) =>
        type !== "workflow_waiting" &&
        !(type === "workflow_running" && all[index - 1] === "workflow_waiting")
    );
    expect(unsuspended).toStrictEqual(sequences.reference);
    expect(sequences.engine).toContain("workflow_waiting");
    expect(sequences.reference).not.toContain("workflow_waiting");
  },
  "event-config-timeout": async () => {
    const instances = await start("sensitive");
    const timeouts = await onBoth(instances, async (instance) => {
      const events = await eventsOf(instance);
      return field(
        events.find((event) => event.type === "step_started")?.config,
        "timeout"
      );
    });
    expect(timeouts).toStrictEqual({
      engine: 600_000,
      reference: "10 minutes",
    });
  },
  "schedule-oracle": async () => {
    // Nothing to run: what is observable is the bindings' surfaces.
    await Promise.resolve();
    expect(Reflect.get(engineBinding("throws"), "schedule")).toBeTypeOf(
      "function"
    );
    expect(Reflect.get(env.REFERENCE, "schedule")).toBeUndefined();
  },
  "empty-step-name": async () => {
    const { reference, engine } = await ran("empty-name");
    expect(engine.status).toBe("errored");
    expect(reference).toStrictEqual({ status: "complete", output: "kept" });
  },
};

const isDiscrepancyName = (name: string): name is DiscrepancyName =>
  name in discrepancies;

/** A family's discrepancies, each with its name, as its test titles them. */
const discrepanciesOf = (family: Family) =>
  Object.keys(discrepancies)
    .filter(isDiscrepancyName)
    .map((name) => ({ name, ...discrepancies[name] }))
    .filter((discrepancy) => discrepancy.family === family);

describe(`profile ${profileId} on plain workerd`, () => {
  describe.each(
    families.map((family) => ({ family, verdict: familyVerdict(family) }))
  )("$family: $verdict", ({ family }) => {
    checks[family]();

    test.each(discrepanciesOf(family))(
      "$verdict $name: Workerflow: $workerflow; reference: $reference",
      async ({ name }) => {
        expect.hasAssertions();
        await discrepancyChecks[name]();
      }
    );
  });
});
