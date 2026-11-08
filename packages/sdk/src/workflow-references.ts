import type {
  AnyFunctionReference,
  argsType,
  returnType,
} from "./function-references.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import type { WorkflowDecisionReference } from "./workflow-decisions.ts";
import type { WorkflowEventReference } from "./workflow-events.ts";
import type { WorkflowWait } from "./workflow-runs.ts";

declare const waitType: unique symbol;

/**
 * A generated reference to one of the workflows an App binds: the App
 * and release it belongs to, the binding's alias, the
 * contract it pins (its ID and fingerprint, over its input and output;
 * each event and decision has its own), the descriptors of its input and
 * output, its event references under `events` and its decisions' schemas
 * under `decisions`. Its types, the input a run takes,
 * the output a completed run has and the waits it can be held at, live
 * in phantom members only. It holds no binding and grants nothing: the
 * host resolves it against the release and binding in force, and refuses
 * a run whose pinned contract isn't this one. It has no `.start`, `.get`
 * or `.cancel`: runs go through `useWorkflow`.
 */
export interface WorkflowReference<
  Alias extends string = string,
  Input = unknown,
  Output = unknown,
  Wait = WorkflowWait,
  Events = Readonly<Record<string, WorkflowEventReference>>,
  Decisions = Readonly<Record<string, WorkflowDecisionReference>>,
  Queries = Readonly<Record<string, AnyFunctionReference>>,
> {
  readonly kind: "workflow";
  readonly visibility: "public";
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly alias: Alias;
  /** Its registered path, e.g. `workflows.summarizeNote`. */
  readonly contractId: string;
  /** The SHA-256 of its exact input and output contract, in hex. */
  readonly fingerprint: string;
  readonly input: ValueDescriptor;
  readonly output: ValueDescriptor;
  /** Its events, by their binding's alias in the workflow. */
  readonly events: Events;
  /**
   * Its listen tasks, by path, with the aliases of the events each listens
   * for: what an event wait's key may name, and with which event.
   */
  readonly listens: Readonly<Record<string, readonly string[]>>;
  /** Its decisions, by their binding's alias in the workflow. */
  readonly decisions: Decisions;
  /**
   * Its ordinary queries: `runs` and `history`, and, when it
   * declares decisions, `decisions` and `decision`; for `useQuery` and
   * `usePaginatedQuery`.
   */
  readonly queries: Queries;
  /** Types only: never set. */
  readonly [argsType]?: Input;
  /** Types only: never set. */
  readonly [returnType]?: Output;
  /** Types only: never set. */
  readonly [waitType]?: Wait;
}

/** Any generated workflow reference, whatever it takes and gives. */
export type AnyWorkflowReference = WorkflowReference<
  string,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowInputOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowOutputOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowWaitOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowEventsOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowDecisionsOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- never read
  any
>;

/** The input a run of `Reference` takes, as a caller passes it. */
export type WorkflowInputOf<Reference> =
  Reference extends WorkflowReference<string, infer Input> ? Input : never;

/** The output a completed run of `Reference` has. */
export type WorkflowOutputOf<Reference> =
  Reference extends WorkflowReference<string, unknown, infer Output>
    ? Output
    : never;

/** The waits a run of `Reference` can be held at. */
export type WorkflowWaitOf<Reference> =
  Reference extends WorkflowReference<string, unknown, unknown, infer Wait>
    ? Wait
    : never;

/**
 * The most a generated workflow reference declares: events, listen tasks
 * and decisions, and the longest listen task's path; an event's type is
 * `isEventType`'s, as a run's inbox takes one. The generator refuses
 * more, and the client reads no more, so what one makes the other reads.
 */
export const workflowReferenceLimits = {
  events: 64,
  listens: 256,
  decisions: 64,
  taskPathLength: 1024,
} as const;

/** The event references of `Reference`, by alias. */
export type WorkflowEventsOf<Reference> =
  Reference extends WorkflowReference<
    string,
    unknown,
    unknown,
    unknown,
    infer Events
  >
    ? Events
    : never;

/** The decision references of `Reference`, by key. */
export type WorkflowDecisionsOf<Reference> =
  Reference extends WorkflowReference<
    string,
    unknown,
    unknown,
    unknown,
    unknown,
    infer Decisions
  >
    ? Decisions
    : never;
