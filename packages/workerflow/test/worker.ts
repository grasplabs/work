// The Worker the tests run against: a run object whose host resolves the
// test definitions, and nothing of Grasp.
import type {
  DefinitionIdentity,
  WorkflowDefinition,
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
      return await Promise.resolve("done");
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
