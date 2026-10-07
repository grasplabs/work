// The Worker the tests run against: a run object whose host resolves the
// test definitions, and nothing of Grasp.
import type {
  DefinitionIdentity,
  WorkflowDefinition,
  WorkflowDuration,
} from "../src/contracts.ts";
import { namedError } from "../src/errors.ts";
import { WorkflowRun } from "../src/run.ts";
import { checkpoint, effect, witness } from "./outside.ts";

const errorOf = (error: unknown): { name: string; message: string } =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "not an error", message: String(error) };

const declinedCard = (): Error =>
  namedError("PaymentError", "The card was declined");

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
        await step.do("charge", async (context) => {
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
      await step.do("charge", async (context) => {
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
      await step.do("bare", () => {
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
      await step.do("huge", () => {
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
  // A configured step, which this profile refuses rather than ignores.
  configured: {
    run: async (_event, step) => {
      // Called as a Cloudflare definition with a step config would; the
      // contract doesn't offer that form yet.
      const result: unknown = await Reflect.apply(step.do, step, [
        "retrying",
        { retries: { limit: 3 } },
        () => "ran",
      ]);
      return result;
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
