import type { argsType } from "./function-references.ts";
import type { PaginationResult } from "./query-reads.ts";
import type { JsonValue } from "./value-descriptor.ts";
import type { WorkflowEventReference } from "./workflow-events.ts";

/**
 * What a run of a workflow is, once the host admitted its start: its ID,
 * its workflow and that workflow's exact version and manifest. Holding
 * one grants nothing: the host checks every watch and control again.
 */
export interface RunHandle {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly manifestHash: string;
}

/** Who classifies a failure as what (spec 32.1). */
export type AppErrorCategory =
  | "source"
  | "contract"
  | "domain"
  | "authorization"
  | "operational"
  | "uncertain"
  | "safety";

/**
 * A failure as the host answers it, sanitized: its code to branch on, its
 * message for people, its category, whether trying again may help, the
 * request to quote (null for a run's own failure, which no request made)
 * and, when the failing code gave them, its details.
 */
export interface AppErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly category: AppErrorCategory;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details?: JsonValue;
}

/** What every wait a run is held at has (spec 10.7.2). */
interface WaitFields<Key extends string> {
  /** This exact wait: its run, step, branch, iteration and generation. */
  readonly id: string;
  /** The source task it waits in, by its canonical path. */
  readonly taskId: string;
  /**
   * A decision's binding alias; the task path for any other kind; `$run`
   * for a hold on the whole run.
   */
  readonly key: Key;
  /** Plain text, bounded: never HTML. */
  readonly title: string;
  /** When it opened, in Unix milliseconds. */
  readonly openedAt: number;
  /** When it closes on its own, in Unix milliseconds; null if never. */
  readonly deadline: number | null;
}

/**
 * A wait the engine holds a run at on its own (spec 10.4.5, 10.7.2): a
 * timer, or a hold of the platform's that no one answers from an App. Each grants nothing of what it names.
 */
export type WorkflowEngineWait<Key extends string = string> =
  | (WaitFields<Key> & {
      readonly kind: "timer";
      /** A sleep the workflow asked for, or a retry's backoff. */
      readonly purpose: "sleep" | "retry";
      readonly deadline: number;
    })
  | (WaitFields<Key> & {
      readonly kind: "blocked";
      /**
       * Held by policy, a quota, or an outcome no one knows yet: only the
       * platform's own remediation releases it, never a decision.
       */
      readonly reason: "policy" | "quota" | "uncertain";
      readonly message: string;
    });

/**
 * A run listening for an event (spec 10.4.6, 10.7.2): `Key` is the listen
 * task's path, `Event` the generated references of the events it listens
 * for. Its `event` is the very reference the App was generated with.
 */
export type WorkflowEventWait<
  Key extends string = string,
  Event = WorkflowEventReference,
> = WaitFields<Key> & {
  readonly kind: "event";
  readonly event: Event;
  /** Whether the person may send it now; false when unknown. */
  readonly canSend: boolean;
};

/**
 * A run held for a person's decision (spec 10.4.5, 10.7.2): `Key` is the
 * decision binding's alias, `Value` the type of the value a response to it
 * carries, in a phantom member only.
 */
export type WorkflowDecisionWait<
  Key extends string = string,
  Value = unknown,
> = WaitFields<Key> & {
  readonly kind: "decision";
  /** Whether the person may answer it now; false when unknown or stale. */
  readonly canRespond: boolean;
  /** Types only: never set. */
  readonly [argsType]?: Value;
};

/**
 * A wait a run is held at now (spec 10.4.5, 10.7.2): a timer, an event,
 * a person's decision, or a hold of the platform's. A
 * generated workflow reference narrows it to the waits that workflow
 * declares (`WorkflowWaitOf`).
 */
export type WorkflowWait<Key extends string = string> =
  | WorkflowEngineWait<Key>
  | WorkflowEventWait<Key>
  | WorkflowDecisionWait<Key>;

/**
 * One pending decision in the person's inbox (spec 10.7.2): the run it
 * holds and the exact wait, which `respond` takes as it is.
 */
export interface WorkflowDecisionInboxItem<
  Key extends string = string,
  Value = unknown,
> {
  readonly run: RunHandle;
  readonly wait: WorkflowDecisionWait<Key, Value>;
}

/** A page of `Item`s, as every paginated query answers it. */
export type WorkflowQueryPage<Item> = PaginationResult<Item>;

/**
 * One decision's detail (spec 10.7.2), discriminated by its `key`: the
 * exact wait, the prompt, the context the person reviews and whether they
 * may answer it now.
 */
export interface WorkflowDecisionDetail<
  Key extends string = string,
  Value = unknown,
  Context = unknown,
> {
  readonly key: Key;
  readonly wait: WorkflowDecisionWait<Key, Value>;
  /** Plain text, bounded: never HTML. */
  readonly prompt: string;
  readonly context: Context;
  readonly canRespond: boolean;
}
