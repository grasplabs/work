import type {
  DefinitionIdentity,
  WorkflowDefinition,
} from "@grasp-os/workerflow/contracts";
/**
 * Runs whose steps register rollbacks (workerflow's compensation), on the
 * real engine, for tests of how core projects a compensation (spec
 * 10.7.3). No definition Grasp builds registers one yet (GRA-984): a test
 * names a run, and its next activation runs the test's definition in place
 * of the one core resolved, in the run's own object, with its journal,
 * statuses, notifications and core's projection of them as ever. The
 * engine's object class is the one the test's isolate loaded, so its
 * definition hook is replaced on its prototype, for the named runs alone.
 */
import { namedError } from "@grasp-os/workerflow/errors";
import { afterAll, beforeAll } from "vite-plus/test";

import { WorkflowRuns } from "../src/workflows/run-object.ts";

type Run = WorkflowDefinition["run"];

/** The test definitions, by the run they replace the definition of. */
const replaced = new Map<string, Run>();

/** The runs whose end the engine can't tell core of yet (`heldEnd`). */
const endsHeld = new Set<string>();

/** The statuses a run ends in, as the engine notifies them. */
const ends: ReadonlySet<string> = new Set([
  "complete",
  "errored",
  "terminated",
]);

/** What of a notification the hold reads. */
interface Notified {
  readonly instanceId: string;
  readonly status: string;
}

/**
 * Replaces the definition of the runs `rollingBackRun` names with theirs
 * for the test file's tests; every other run runs as ever.
 */
export const withRollbacks = (): void => {
  const original: unknown = Reflect.get(WorkflowRuns.prototype, "definition");
  const notify: unknown = Reflect.get(WorkflowRuns.prototype, "notify");
  beforeAll(() => {
    // A held run's end fails to reach core, as a host that can't take
    // it: the engine hands it over again after its backoff.
    Reflect.set(
      WorkflowRuns.prototype,
      "notify",
      async function notified(
        this: WorkflowRuns,
        notifications: readonly Notified[]
      ): Promise<void> {
        const latest = notifications.at(-1);
        if (
          latest !== undefined &&
          endsHeld.has(latest.instanceId) &&
          ends.has(latest.status)
        ) {
          throw new Error("The test holds this run's end back");
        }
        if (typeof notify === "function") {
          await Reflect.apply(notify, this, [notifications]);
        }
      }
    );
    Reflect.set(
      WorkflowRuns.prototype,
      "definition",
      function definition(
        this: WorkflowRuns,
        identity: DefinitionIdentity
      ): WorkflowDefinition | undefined {
        if (typeof original !== "function") {
          return undefined;
        }
        const resolved: unknown = Reflect.apply(original, this, [identity]);
        if (resolved === undefined) {
          return undefined;
        }
        // SAFETY: the engine's hook answers a definition, or none.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        const own = resolved as WorkflowDefinition;
        return {
          run: async (event, step) =>
            await (replaced.get(event.instanceId) ?? own.run)(event, step),
        };
      }
    );
  });
  afterAll(() => {
    Reflect.set(WorkflowRuns.prototype, "definition", original);
    Reflect.set(WorkflowRuns.prototype, "notify", notify);
    replaced.clear();
    endsHeld.clear();
  });
};

/**
 * Holds back the notification of run `run`'s end, whatever else of it the
 * engine tells core, until the answer is called: core hears of its end
 * late.
 */
export const heldEnd = (run: string): (() => void) => {
  endsHeld.add(run);
  return () => {
    endsHeld.delete(run);
  };
};

/** A gate a test opens: what a rollback waits on, so its run stays rolling back. */
export interface Gate {
  readonly open: () => void;
  readonly passed: Promise<null>;
}

export const gate = (): Gate => {
  const { promise, resolve } = Promise.withResolvers<null>();
  return {
    open: () => {
      resolve(null);
    },
    passed: promise,
  };
};

/** What the run's compensation does, and how its forward work ends. */
export interface Compensated {
  /**
   * The sleep the run's own code journaled before the test's definition
   * takes over, which the test passed (`woken`): replayed first, as a
   * definition that left it waiting couldn't wait anew.
   */
  readonly held: { readonly name: string; readonly ms: number };
  /** Waited on by the rollback before it ends: the run rolls back meanwhile. */
  readonly holds: Gate;
  /** Whether the rollback fails once it may end. */
  readonly rollbackFails?: boolean;
  /**
   * How the forward work ends past its step that registered the rollback:
   * failing with `code`, or sleeping an hour, for a terminate to end.
   */
  readonly ends: { readonly fails: string } | "sleeps";
}

/**
 * Makes run `run`'s next activation charge a card in a step whose
 * rollback refunds it, then fail or sleep (`compensated.ends`): its
 * failure, or a terminate with rollback, rolls the charge back, which
 * waits for `compensated.holds` and then succeeds or fails.
 */
export const rollingBackRun = (run: string, compensated: Compensated): void => {
  replaced.set(run, async (_event, step) => {
    await step.sleep(compensated.held.name, compensated.held.ms);
    await step.do("charge", async () => await Promise.resolve("charged"), {
      rollback: async () => {
        await compensated.holds.passed;
        if (compensated.rollbackFails === true) {
          throw namedError(
            "NonRetryableError",
            "The refund failed.",
            "connect.declined"
          );
        }
      },
      rollbackConfig: { retries: { limit: 0, delay: 1 }, timeout: "1 minute" },
    });
    if (compensated.ends === "sleeps") {
      await step.sleep("after-charge", "1 hour");
      return null;
    }
    const { fails } = compensated.ends;
    return await step.do(
      "ship",
      { retries: { limit: 0, delay: 1 } },
      async () =>
        await Promise.reject(
          namedError("NonRetryableError", "The order failed.", fails)
        )
    );
  });
};
