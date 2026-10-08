// The Worker the tests run against: a run object whose host resolves the
// test definitions, and nothing of Grasp.
import type {
  DefinitionIdentity,
  WorkflowDefinition,
  WorkflowDuration,
  WorkflowStepContext,
} from "../src/contracts.ts";
import { NonRetryableError, namedError } from "../src/errors.ts";
import { WorkflowRun } from "../src/run.ts";
import { checkpoint, effect, witness } from "./outside.ts";

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

export const definitions: Record<string, WorkflowDefinition> = {
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
  // A step returning something the journal can't keep: a URL object.
  unkeepable: {
    run: async (_event, step) => {
      try {
        await step.do("link", () => new URL("https://example.com"));
        return "kept";
      } catch (error) {
        return errorOf(error);
      }
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
              delay: ({ ctx, error }) => {
                witness(instanceId, `asked-${ctx.attempt}-${error.name}`);
                if (said === "throw") {
                  throw new Error("no delay today");
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
  // its timeout.
  drifts: {
    run: async (event, step) => {
      const what = paramOf(event.payload, "what");
      const first = (await checkpoint(event.instanceId, "drift")) === 1;
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

export class TestRuns extends WorkflowRun {
  // oxlint-disable-next-line class-methods-use-this -- the host's hook; this host needs nothing of its own
  protected definition({
    definition,
  }: DefinitionIdentity): WorkflowDefinition | undefined {
    return definitions[definition];
  }
}

export default {
  fetch: (): Response => new Response(null, { status: 404 }),
};
