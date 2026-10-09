// oxlint-disable max-classes-per-file -- the run object classes the test Worker exports, one per host configuration
// The Worker the tests run against: a run object whose host resolves the
// test definitions, and nothing of Grasp.
import type {
  DefinitionIdentity,
  WorkflowDefinition,
  WorkflowDuration,
  WorkflowStep,
  WorkflowStepContext,
  WorkflowStepRollbackOptions,
} from "../src/contracts.ts";
import { NonRetryableError, namedError } from "../src/errors.ts";
import { WorkflowRun } from "../src/run.ts";
import {
  busyFor,
  checkpoint,
  effect,
  handled,
  measuredClock,
  undone,
  witness,
} from "./outside.ts";
import {
  resultDefinitions,
  testMaxRunStreamBytes,
  testMaxStreamBytes,
} from "./result-definitions.ts";

const errorOf = (error: unknown): { name: string; message: string } =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "not an error", message: String(error) };

const declinedCard = (): Error =>
  namedError("PaymentError", "The card was declined");

/**
 * For steps whose failure is the point: no retry, so the failure is the
 * step's at once. Without it a failing step retries five times, over
 * minutes, as on Cloudflare.
 */
const once = { retries: { limit: 0, delay: 0 } };

/** A field of a run's params, as the test passed it. */
const paramOf = (params: unknown, field: string): unknown =>
  typeof params === "object" && params !== null && field in params
    ? Reflect.get(params, field)
    : undefined;

/** The `duration` in a run's params, or `fallback`. */
const durationIn = (
  params: unknown,
  fallback: WorkflowDuration
): WorkflowDuration => {
  const duration = paramOf(params, "duration");
  if (typeof duration !== "number" && typeof duration !== "string") {
    return fallback;
  }
  // SAFETY: whatever the test passed, unchecked here: the engine is what
  // checks it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return duration as WorkflowDuration;
};

/** Grasp's transport shape: a call's rejection, turned into a value. */
const settled = async (
  call: () => Promise<unknown>
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> => {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error };
  }
};

/** An object with no prototype: `String()` of it throws. */
const unprintableValue = (): unknown => {
  const value: unknown = Object.create(null);
  return value;
};

/** Larger than a SQLite value, with a name that isn't a string. */
export const oversizedMessageBytes = 3 * 1024 * 1024;
const oversizedError = (): Error => {
  const error = new Error("é".repeat(oversizedMessageBytes / 2));
  Reflect.set(error, "name", 7);
  return error;
};

/**
 * A step's rollback that undoes it outside, as the params say: `undo`
 * names the one whose every attempt fails, `flaky` the one whose first
 * attempt fails (it gets one retry, at once, or an hour later with
 * `undoDelay: "1 hour"`), `nested` the one that calls the step API.
 */
const undoing = (
  instanceId: string,
  payload: unknown,
  label: string,
  step: WorkflowStep
): WorkflowStepRollbackOptions => ({
  rollback: async (context) => {
    await undone(instanceId, label, context);
    if (paramOf(payload, "undo") === label) {
      throw new NonRetryableError(`${label} can't be undone`);
    }
    if (paramOf(payload, "flaky") === label && context.attempt === 1) {
      throw namedError("FlakyError", `undoing ${label} failed once`);
    }
    if (paramOf(payload, "nested") === label) {
      await step.do("inside", () => "never");
    }
  },
  rollbackConfig: {
    retries: {
      limit: 1,
      delay: paramOf(payload, "undoDelay") === "1 hour" ? "1 hour" : 0,
    },
  },
});

/** Rollback options a definition passes, as the params' `shape` names. */
const rollbackShapes: Record<string, unknown> = {
  null: null,
  text: "undo",
  "no rollback": { rollbackConfig: {} },
  "rollback not a function": { rollback: "undo" },
  "unknown setting": { rollback: () => "undone", undo: true },
  "sensitive rollback": {
    rollback: () => "undone",
    rollbackConfig: { sensitive: "output" },
  },
  "zero timeout": { rollback: () => "undone", rollbackConfig: { timeout: 0 } },
  "config not an object": { rollback: () => "undone", rollbackConfig: 5 },
};

export const definitions: Record<string, WorkflowDefinition> = {
  // Steps that register rollbacks, and one that doesn't. With `wait`, the
  // run then waits for a "confirm" event; with `fail`, a last step fails,
  // uncaught, after its effect. Each rollback undoes its step outside.
  compensated: {
    run: async (event, step) => {
      const { instanceId, payload } = event;
      const undo = (label: string): WorkflowStepRollbackOptions =>
        undoing(instanceId, payload, label, step);
      const reserve = await step.do(
        "reserve",
        async (context) => await effect(instanceId, "reserve", context),
        undo("reserve")
      );
      const charge = await step.do(
        "charge",
        once,
        async (context) => await effect(instanceId, "charge", context),
        undo("charge")
      );
      await step.do(
        "notify",
        async (context) => await effect(instanceId, "notify", context)
      );
      if (paramOf(payload, "wait") === true) {
        await step.waitForEvent("confirm", { type: "confirm" });
      }
      if (paramOf(payload, "fatal") === true) {
        // A result no journal can keep: the run ends at once, as on
        // Cloudflare, rolling back nothing.
        await step.do("fatal", () => Symbol("unkeepable"));
      }
      if (paramOf(payload, "fail") === true) {
        await step.do(
          "ship",
          once,
          async (context) => {
            await effect(instanceId, "ship", context);
            throw namedError("ShippingError", "No courier came");
          },
          undo("ship")
        );
      }
      return { reserve, charge };
    },
  },
  // A step with a rollback called from inside another step's callback,
  // then a step that fails, uncaught: a replay returns the outer step's
  // result without calling its callback, so it never gets that rollback
  // back.
  "nested-rollback": {
    run: async (event, step) => {
      const { instanceId, payload } = event;
      await step.do(
        "outer",
        async () =>
          await step.do(
            "inner",
            async (context) => await effect(instanceId, "inner", context),
            undoing(instanceId, payload, "inner", step)
          )
      );
      await step.do("fail", once, () => {
        throw namedError("ShippingError", "No courier came");
      });
    },
  },
  // Two steps with rollbacks, a wait outside any step between them that the
  // test can hold, then a step that fails, uncaught: a replay held there
  // hasn't got the second's rollback back. With `throwOnReplay`, the wait
  // throws the second time it is reached: the first replay's. With
  // `plainSecond`, the second registers none, so a replay held there has
  // every rollback back.
  "gated-rollback": {
    run: async (event, step) => {
      const { instanceId, payload } = event;
      await step.do(
        "first",
        async (context) => await effect(instanceId, "first", context),
        undoing(instanceId, payload, "first", step)
      );
      const reached = await checkpoint(instanceId, "gate");
      if (paramOf(payload, "throwOnReplay") === true && reached === 2) {
        // Code outside any step that fails this once: a fetch, say.
        throw new Error("The gate failed this time");
      }
      const second = async (context: WorkflowStepContext): Promise<string> =>
        await effect(instanceId, "second", context);
      await (paramOf(payload, "plainSecond") === true
        ? step.do("second", second)
        : step.do(
            "second",
            second,
            undoing(instanceId, payload, "second", step)
          ));
      await step.do("fail", once, () => {
        throw namedError("ShippingError", "No courier came");
      });
    },
  },
  // A wait outside any step the test can hold (a replay can't get the
  // rollback back before it), a step with a rollback, then a step that
  // fails, uncaught; both steps time out in 100 ms, so each fits in a
  // short handler budget beside the other.
  "quick-gated": {
    run: async (event, step) => {
      const { instanceId, payload } = event;
      const quick = { retries: { limit: 0, delay: 0 }, timeout: 100 };
      await checkpoint(instanceId, "gate");
      await step.do(
        "first",
        quick,
        async (context) => await effect(instanceId, "first", context),
        undoing(instanceId, payload, "first", step)
      );
      await step.do("fail", quick, () => {
        throw namedError("ShippingError", "No courier came");
      });
    },
  },
  // A step whose rollback options are the params' `shape`; the author
  // catches what the call throws.
  "rollback-shapes": {
    run: async (event, step) => {
      const shape = paramOf(event.payload, "shape");
      try {
        const result: unknown = await Reflect.apply(step.do, step, [
          "shaped",
          () => "ran",
          rollbackShapes[String(shape)],
        ]);
        return result;
      } catch (error) {
        return { caught: errorOf(error) };
      }
    },
  },
  // Two steps, each an outside effect; the run returns both receipts.
  orders: {
    run: async (event, step) => {
      const charge = await step.do(
        "charge",
        async (context) => await effect(event.instanceId, "charge", context)
      );
      const ship = await step.do(
        "ship",
        async (context) => await effect(event.instanceId, "ship", context)
      );
      return { charge, ship };
    },
  },
  // A step that fails after its effect; the author catches the failure.
  declined: {
    run: async (event, step) => {
      let declined: { name: string; message: string } | undefined;
      try {
        await step.do("charge", once, async (context) => {
          await effect(event.instanceId, "charge", context);
          throw declinedCard();
        });
      } catch (error) {
        declined = errorOf(error);
      }
      const notified = await step.do(
        "notify",
        async (context) => await effect(event.instanceId, "notify", context)
      );
      return { declined, notified };
    },
  },
  // A step's failure the author doesn't catch ends the run.
  uncaught: {
    run: async (event, step) => {
      await step.do("charge", once, async (context) => {
        await effect(event.instanceId, "charge", context);
        throw declinedCard();
      });
      return "unreachable";
    },
  },
  // The same name twice: two occurrences, two keys.
  repeats: {
    run: async (event, step) => {
      const first = await step.do(
        "send",
        async (context) => await effect(event.instanceId, "send", context)
      );
      const second = await step.do(
        "send",
        async (context) => await effect(event.instanceId, "send", context)
      );
      return [first, second];
    },
  },
  // An author who catches everything and acts in catch and finally.
  catcher: {
    run: async (event, step) => {
      try {
        await step.do(
          "held",
          async (context) => await effect(event.instanceId, "held", context)
        );
      } catch {
        witness(event.instanceId, "caught");
      } finally {
        witness(event.instanceId, "finally");
      }
      return await step.do(
        "after",
        async (context) => await effect(event.instanceId, "after", context)
      );
    },
  },
  // A definition that waits between two steps on something unjournaled.
  pauses: {
    run: async (event, step) => {
      await step.do(
        "first",
        async (context) => await effect(event.instanceId, "first", context)
      );
      await checkpoint(event.instanceId, "between");
      try {
        return await step.do(
          "second",
          async (context) => await effect(event.instanceId, "second", context)
        );
      } finally {
        witness(event.instanceId, "finally");
      }
    },
  },
  // A definition that waits after its last step, then returns how many
  // times any activation reached that point.
  tail: {
    run: async (event, step) => {
      await step.do(
        "only",
        async (context) => await effect(event.instanceId, "only", context)
      );
      return await checkpoint(event.instanceId, "end");
    },
  },
  // Thrown values that can't be printed, or are far too long to keep, in
  // a step and in the definition's own body.
  "bare-in-step": {
    run: async (_event, step) =>
      await step.do("bare", once, () => {
        throw unprintableValue();
      }),
  },
  "bare-in-body": {
    run: async () => {
      await Promise.resolve();
      throw unprintableValue();
    },
  },
  "huge-in-step": {
    run: async (_event, step) =>
      await step.do("huge", once, () => {
        throw oversizedError();
      }),
  },
  "huge-in-body": {
    run: async () => {
      await Promise.resolve();
      throw oversizedError();
    },
  },
  // What the definition is given, as it saw it.
  echo: {
    run: async (event) =>
      await Promise.resolve({
        payload: event.payload,
        timestamp: event.timestamp,
        instanceId: event.instanceId,
      }),
  },
  // A step called with the config in the params, as an author passing
  // whatever they were given would: refused or run, never run otherwise.
  misconfigured: {
    run: async (event, step) => {
      const config: unknown = paramOf(event.payload, "config");
      const result: unknown = await Reflect.apply(step.do, step, [
        "configured",
        config,
        () => "ran",
      ]);
      return result;
    },
  },
  // A step configured by the params' `config` (or with none) that fails
  // its first `fails` attempts, as `failure` says; the author catches what
  // it throws in the end.
  retrying: {
    run: async (event, step) => {
      const { instanceId, payload } = event;
      const fails = paramOf(payload, "fails");
      const failure = paramOf(payload, "failure");
      const config: unknown = paramOf(payload, "config");
      const work = async (context: WorkflowStepContext): Promise<unknown> => {
        const receipt = await effect(instanceId, "flaky", context);
        if (typeof fails === "number" && context.attempt <= fails) {
          if (failure === "non-retryable") {
            throw new NonRetryableError(`attempt ${context.attempt} failed`);
          }
          if (failure === "prefixed") {
            throw new Error(
              `NonRetryableError: attempt ${context.attempt} failed`
            );
          }
          throw namedError("FlakyError", `attempt ${context.attempt} failed`);
        }
        return { receipt, attempt: context.attempt, config: context.config };
      };
      try {
        const result: unknown = await Reflect.apply(
          step.do,
          step,
          config === undefined ? ["flaky", work] : ["flaky", config, work]
        );
        return result;
      } catch (error) {
        return { caught: errorOf(error) };
      }
    },
  },
  // A step whose retry delay a function says: what the params' `delay`
  // holds, or a throw for "throw".
  "dynamic-delay": {
    run: async (event, step) => {
      const { instanceId, payload } = event;
      const said: unknown = paramOf(payload, "delay");
      try {
        return await step.do(
          "flaky",
          {
            retries: {
              limit: 3,
              backoff: "constant",
              delay: async ({ ctx, error }) => {
                witness(instanceId, `asked-${ctx.attempt}-${error.name}`);
                if (said === "throw") {
                  throw new Error("no delay today");
                }
                if (said === "hold") {
                  // Held by the test: as long as it likes.
                  await checkpoint(instanceId, "delay");
                  witness(instanceId, "delay-answered");
                  return "1 second";
                }
                // SAFETY: whatever the test passed, unchecked here: the
                // engine is what checks it.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                return said as WorkflowDuration;
              },
            },
          },
          async (context) => {
            await effect(instanceId, "flaky", context);
            throw namedError("FlakyError", `attempt ${context.attempt} failed`);
          }
        );
      } catch (error) {
        return { caught: errorOf(error) };
      }
    },
  },
  // A step whose config the params give: `first` in the first activation,
  // `later` in every later one. It always fails.
  reconfigured: {
    run: async (event, step) => {
      const { instanceId, payload } = event;
      const first = (await checkpoint(instanceId, "config")) === 1;
      const config: unknown = paramOf(payload, first ? "first" : "later");
      const result: unknown = await Reflect.apply(step.do, step, [
        "flaky",
        config,
        async (context: WorkflowStepContext) => {
          await effect(instanceId, "flaky", context);
          throw namedError("FlakyError", `attempt ${context.attempt} failed`);
        },
      ]);
      return result;
    },
  },
  // A step that times out after a second and retries a second later. Each
  // activation passes a checkpoint first, so the test can hold the one
  // the retry's alarm starts.
  hung: {
    run: async (event, step) => {
      const { instanceId } = event;
      await checkpoint(instanceId, "activation");
      return await step.do(
        "hung",
        {
          retries: { limit: 1, delay: "1 second", backoff: "constant" },
          timeout: "1 second",
        },
        async (context) => {
          const receipt = await effect(instanceId, "hung", context);
          // The callback's own code, once its answer came: it runs for an
          // attempt that timed out too, and is seen to.
          witness(instanceId, `answered-${context.attempt}`);
          return receipt;
        }
      );
    },
  },
  // A step whose callback, held past its timeout, then calls the step API
  // itself; the author catches the timeout and, once the test lets it,
  // makes a step of the same name of its own.
  lingers: {
    run: async (event, step) => {
      const { instanceId } = event;
      let caught: { name: string; message: string } | undefined;
      try {
        await step.do(
          "lingering",
          { retries: { limit: 0, delay: 0 }, timeout: "1 second" },
          async (context) => {
            await effect(instanceId, "lingering", context);
            const late = Promise.all([
              step.do(
                "nested",
                async (inner) => await effect(instanceId, "nested", inner)
              ),
              step.sleep("nested-nap", "1 hour"),
            ]);
            witness(instanceId, "called");
            await late;
            witness(instanceId, "late-answered");
          }
        );
      } catch (error) {
        caught = errorOf(error);
      }
      await checkpoint(instanceId, "after");
      const nested = await step.do(
        "nested",
        async (context) => await effect(instanceId, "nested", context)
      );
      return { caught, nested };
    },
  },
  // A step whose callback runs past its 1 ms timeout without awaiting
  // anything, so no timer can fire before it answers.
  busy: {
    run: async (_event, step) => {
      try {
        return await step.do(
          "busy",
          { retries: { limit: 0, delay: 0 }, timeout: 1 },
          () => {
            busyFor(5);
            return "answered";
          }
        );
      } catch (error) {
        return { caught: errorOf(error) };
      }
    },
  },
  // Two steps at once: one fails its first attempt and retries a second
  // later, while the other is out at its effect.
  "retry-beside": {
    run: async (event, step) => {
      const { instanceId } = event;
      return await Promise.all([
        step.do(
          "flaky",
          { retries: { limit: 1, delay: "1 second", backoff: "constant" } },
          async (context) => {
            const receipt = await effect(instanceId, "flaky", context);
            if (context.attempt === 1) {
              throw namedError("FlakyError", "attempt 1 failed");
            }
            return receipt;
          }
        ),
        step.do(
          "steady",
          async (context) => await effect(instanceId, "steady", context)
        ),
      ]);
    },
  },
  // Two steps at once that both fail their first attempt: "slow" retries
  // an hour later, and "fast", after a step "lead" that succeeds, a
  // second later.
  "staggered-retries": {
    run: async (event, step) => {
      const { instanceId } = event;
      const failsOnce =
        (label: string) =>
        async (context: WorkflowStepContext): Promise<string> => {
          const receipt = await effect(instanceId, label, context);
          if (context.attempt === 1) {
            throw namedError("FlakyError", "attempt 1 failed");
          }
          return receipt;
        };
      return await Promise.all([
        step.do(
          "slow",
          { retries: { limit: 1, delay: "1 hour", backoff: "constant" } },
          failsOnce("slow")
        ),
        (async (): Promise<string> => {
          await step.do(
            "lead",
            async (context) => await effect(instanceId, "lead", context)
          );
          return await step.do(
            "fast",
            { retries: { limit: 1, delay: "1 second", backoff: "constant" } },
            failsOnce("fast")
          );
        })(),
      ]);
    },
  },
  // Two steps at once, for a host whose handlers have little wall time.
  pair: {
    run: async (event, step) => {
      const { instanceId } = event;
      return await Promise.all([
        step.do(
          "first",
          async (context) => await effect(instanceId, "first", context)
        ),
        step.do(
          "second",
          async (context) => await effect(instanceId, "second", context)
        ),
      ]);
    },
  },
  // A step configured by the params, after a checkpoint each activation
  // passes, so the test can hold the activation that takes the run over
  // before it reaches the step.
  "taken-over": {
    run: async (event, step) => {
      const { instanceId, payload } = event;
      await checkpoint(instanceId, "activation");
      const config: unknown = paramOf(payload, "config");
      try {
        const result: unknown = await Reflect.apply(step.do, step, [
          "taken",
          config,
          async (context: WorkflowStepContext) =>
            await effect(instanceId, "taken", context),
        ]);
        return result;
      } catch (error) {
        return { caught: errorOf(error) };
      }
    },
  },
  // A step whose callback calls a step of its own, which answers only
  // after the outer attempt timed out; the author catches the timeout and,
  // once the test lets it, makes one more step.
  outlived: {
    run: async (event, step) => {
      const { instanceId } = event;
      let caught: { name: string; message: string } | undefined;
      try {
        await step.do(
          "outer",
          { retries: { limit: 0, delay: 0 }, timeout: "1 second" },
          async () => {
            const inner = await step.do(
              "inner",
              async (context) => await effect(instanceId, "inner", context)
            );
            witness(instanceId, "inner-answered");
            return inner;
          }
        );
      } catch (error) {
        caught = errorOf(error);
      }
      await checkpoint(instanceId, "after");
      const final = await step.do(
        "final",
        async (context) => await effect(instanceId, "final", context)
      );
      return { caught, final };
    },
  },
  // A run whose definition ends while one of its steps is still out.
  stray: {
    run: async (event, step) => {
      // Not awaited on purpose: its answer comes after the run ended.
      const late = async (): Promise<void> => {
        try {
          await step.do(
            "late",
            async (context) => await effect(event.instanceId, "late", context)
          );
        } catch {
          witness(event.instanceId, "late-caught");
        } finally {
          witness(event.instanceId, "late-finally");
        }
      };
      void late();
      // Held by the test until the step's effect is out: the run ends
      // while it is.
      await checkpoint(event.instanceId, "end");
      return "done";
    },
  },
  // A step whose callback calls another step, then a last step.
  nesting: {
    run: async (event, step) => {
      const { instanceId } = event;
      const outer = await step.do(
        "outer",
        async () =>
          await step.do(
            "inner",
            async (context) => await effect(instanceId, "inner", context)
          )
      );
      const last = await step.do(
        "last",
        async (context) => await effect(instanceId, "last", context)
      );
      return { outer, last };
    },
  },
  // A step, a sleep of the duration in the params, another step.
  napper: {
    run: async (event, step) => {
      const before = await step.do(
        "before",
        async (context) => await effect(event.instanceId, "before", context)
      );
      await step.sleep("nap", durationIn(event.payload, "1 hour"));
      const after = await step.do(
        "after",
        async (context) => await effect(event.instanceId, "after", context)
      );
      return { before, after };
    },
  },
  // A sleep until the time in the params.
  "sleeps-until": {
    run: async (event, step) => {
      const at: unknown = paramOf(event.payload, "at");
      // As an author passing whatever they were given would.
      await Reflect.apply(step.sleepUntil, step, ["until", at]);
      return "woke";
    },
  },
  // A step, a wait for an "approved" event, another step.
  approval: {
    run: async (event, step) => {
      await step.do(
        "before",
        async (context) => await effect(event.instanceId, "before", context)
      );
      const approved = await step.waitForEvent("approval", {
        type: "approved",
        timeout: durationIn(event.payload, "1 hour"),
      });
      const after = await step.do(
        "after",
        async (context) => await effect(event.instanceId, "after", context)
      );
      return { approved, after };
    },
  },
  // Two waits for the same event type.
  votes: {
    run: async (event, step) => {
      await step.do(
        "before",
        async (context) => await effect(event.instanceId, "before", context)
      );
      const first = await step.waitForEvent("first", { type: "vote" });
      const second = await step.waitForEvent("second", { type: "vote" });
      return [first.payload, second.payload];
    },
  },
  // A wait with the timeout in the params; when it runs out, the author
  // catches that and waits again for the same type.
  deadline: {
    run: async (event, step) => {
      try {
        const reply = await step.waitForEvent("reply", {
          type: "reply",
          timeout: durationIn(event.payload, "1 hour"),
        });
        return { reply: reply.payload };
      } catch (error) {
        const later = await step.waitForEvent("later", { type: "reply" });
        return { timedOut: errorOf(error), later: later.payload };
      }
    },
  },
  // A definition whose replay strays from its first activation, on
  // something outside any step: the wait it reaches, its event type, or
  // its timeout; or a wait where it first reached a step that retries.
  drifts: {
    run: async (event, step) => {
      const what = paramOf(event.payload, "what");
      const first = (await checkpoint(event.instanceId, "drift")) === 1;
      if (what === "retry") {
        if (first) {
          return await step.do(
            "flaky",
            { retries: { limit: 1, delay: "1 hour" } },
            () => {
              throw namedError("FlakyError", "attempt failed");
            }
          );
        }
        return await step.waitForEvent("second", { type: "x" });
      }
      if (what === "new-wait") {
        return await step.waitForEvent(first ? "first" : "second", {
          type: "x",
        });
      }
      if (what === "type") {
        return await step.waitForEvent("held", { type: first ? "a" : "b" });
      }
      return await step.waitForEvent("held", {
        type: "x",
        timeout: first ? "1 hour" : "2 hours",
      });
    },
  },
  // A step and a sleep at once, in the order the params say.
  mixes: {
    run: async (event, step) => {
      const work = async (): Promise<string> =>
        await step.do(
          "work",
          async (context) => await effect(event.instanceId, "work", context)
        );
      const nap = async (): Promise<void> => {
        await step.sleep("nap", "1 hour");
      };
      return paramOf(event.payload, "first") === "sleep"
        ? await Promise.all([nap(), work()])
        : await Promise.all([work(), nap()]);
    },
  },
  // A step, and a sleep the definition reaches while that step is still
  // on its way back (the test decides when, by the checkpoint).
  "step-then-sleep": {
    run: async (event, step) => {
      const { instanceId } = event;
      const doing = (async (): Promise<string> => {
        try {
          const receipt = await step.do(
            "work",
            async (context) => await effect(instanceId, "work", context)
          );
          witness(instanceId, "continued");
          return receipt;
        } finally {
          witness(instanceId, "finally");
        }
      })();
      await checkpoint(instanceId, "nap");
      await step.sleep("nap", "1 hour");
      return await doing;
    },
  },
  // A wait raced against a sleep, inside the author's own handlers.
  races: {
    run: async (event, step) => {
      try {
        return await Promise.race([
          step.waitForEvent("reply", { type: "reply" }),
          step.sleep("give-up", "1 hour"),
        ]);
      } catch {
        witness(event.instanceId, "caught");
        return "caught";
      } finally {
        witness(event.instanceId, "finally");
      }
    },
  },
  // An author who tries every way there is to hear of a wait that hasn't
  // ended: catch and finally, a transport that turns rejections into
  // values, and a sibling that rejects under Promise.allSettled.
  guarded: {
    run: async (event, step) => {
      const { instanceId } = event;
      const how: unknown = paramOf(event.payload, "how");
      await step.do(
        "before",
        async (context) => await effect(instanceId, "before", context)
      );
      const wait = async (): Promise<unknown> => {
        if (how === "sleep") {
          await step.sleep("held", "1 hour");
          return undefined;
        }
        return await step.waitForEvent("held", { type: "go" });
      };
      if (how === "settled") {
        const outcome = await settled(wait);
        witness(instanceId, outcome.ok ? "settled-ok" : "settled-error");
        return outcome.ok;
      }
      if (how === "children") {
        const results = await Promise.allSettled([
          wait(),
          Promise.reject(namedError("ChildError", "a child failed")),
        ]);
        witness(instanceId, "all-settled");
        return results.map((result) => result.status);
      }
      try {
        await wait();
        witness(instanceId, "returned");
      } catch {
        witness(instanceId, "caught");
      } finally {
        witness(instanceId, "finally");
      }
      return "done";
    },
  },
};

/** How long a test run's compensating replay may take. */
export const testRollbackReplayMs = 200;
/** How many test replays in a row may end without the rollbacks. */
export const testRollbackReplays = 3;

export class TestRuns extends WorkflowRun {
  protected override readonly maxStreamOutputBytes = testMaxStreamBytes;
  protected override readonly maxRunStreamBytes = testMaxRunStreamBytes;
  /** Short, so a replay held outside any step is tried again soon. */
  protected override readonly rollbackReplayMs = testRollbackReplayMs;
  /** Few, so replays that never get the rollbacks back end soon. */
  protected override readonly rollbackReplays = testRollbackReplays;

  // oxlint-disable-next-line class-methods-use-this -- the host's hook; this host needs nothing of its own
  protected definition({
    definition,
  }: DefinitionIdentity): WorkflowDefinition | undefined {
    return definitions[definition] ?? resultDefinitions[definition];
  }

  // oxlint-disable-next-line class-methods-use-this -- the test's clock, shared by every run
  protected override clock(): number {
    return measuredClock();
  }

  override async alarm(): Promise<void> {
    try {
      await super.alarm();
    } finally {
      handled.push(this.ctx.id.toString());
    }
  }
}

/**
 * Run objects whose alarm handlers give attempts a second of wall time:
 * an activation's first attempt still runs, and any later one with the
 * default timeout is left for a fresh activation.
 */
/** The wall time BudgetedRuns give attempts. */
export const budgetedHandlerMs = 1000;

export class BudgetedRuns extends TestRuns {
  protected override readonly handlerBudgetMs = budgetedHandlerMs;
}

// The run object of a host that misconfigured it, bound as MISCONFIGURED.
export { MisconfiguredRuns } from "./misconfigured.ts";

export default {
  fetch: (): Response => new Response(null, { status: 404 }),
};
