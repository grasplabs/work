import type {
  AnyFunctionReference,
  argsType,
  returnType,
} from "./function-references.ts";
import type { WorkflowDecisionReference } from "./workflow-decisions.ts";
import type { WorkflowEventReference } from "./workflow-events.ts";
import type { WorkflowWait } from "./workflow-runs.ts";

declare const waitType: unique symbol;

/**
 * A generated reference to one of the workflows an App declares:
 * `workflows.<alias>`. Its name, and its events', decisions', queries'
 * and mutations' references, each a name too; nothing else at run time.
 * Its types (the args a run takes, what a completed run returns and the
 * waits it can be held at) live in phantom members only, printed from
 * the App's own declaration (`permission.workflow`). It holds no binding
 * and grants nothing: the host resolves each name in the App's release
 * and the binding in force. What `useWorkflow` needs beyond the names
 * (each event's type and data, the listen tasks, each decision's value
 * and context) comes with the page's build (`.grasp/functions.ts`). Its
 * runs are read and changed through its ordinary `queries` and
 * `mutations`, which `useWorkflow` is built on.
 */
export interface WorkflowReference<
  Alias extends string = string,
  Args = unknown,
  Returns = unknown,
  Wait = WorkflowWait,
  Events = Readonly<Record<string, WorkflowEventReference>>,
  Decisions = Readonly<Record<string, WorkflowDecisionReference>>,
  Queries = Readonly<Record<string, AnyFunctionReference>>,
  Mutations = Readonly<Record<string, AnyFunctionReference>>,
> {
  /** Its name: `workflows.<alias>`. */
  readonly name: `workflows.${Alias}`;
  /** Its events, by their alias in the workflow. */
  readonly events: Events;
  /** Its decisions, by their alias in the workflow. */
  readonly decisions: Decisions;
  /**
   * Its ordinary queries: `run`, `canStart`, `runs` and `history`, and,
   * when it declares decisions, `decisions` and `decision`; for
   * `useQuery` and `usePaginatedQuery`.
   */
  readonly queries: Queries;
  /**
   * Its ordinary mutations: `start`, `pause`, `resume` and `cancel`, and,
   * when it declares events, `send`; for `useMutation`.
   */
  readonly mutations: Mutations;
  /** Types only: never set. */
  readonly [argsType]?: Args;
  /** Types only: never set. */
  readonly [returnType]?: Returns;
  /** Types only: never set. */
  readonly [waitType]?: Wait;
}

/** Any generated workflow reference, whatever it takes and gives. */
export type AnyWorkflowReference = WorkflowReference<
  string,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowArgsOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowReturnOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowWaitOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowEventsOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowDecisionsOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- never read
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- never read
  any
>;

/** The args a run of `Reference` takes, as a caller passes them. */
export type WorkflowArgsOf<Reference> =
  Reference extends WorkflowReference<string, infer Args> ? Args : never;

/** What a completed run of `Reference` returns. */
export type WorkflowReturnOf<Reference> =
  Reference extends WorkflowReference<string, unknown, infer Returns>
    ? Returns
    : never;

/** The waits a run of `Reference` can be held at. */
export type WorkflowWaitOf<Reference> =
  Reference extends WorkflowReference<string, unknown, unknown, infer Wait>
    ? Wait
    : never;

/**
 * The most a workflow permission declares: events, listen tasks and
 * decisions, and the longest listen task's path; an event's type is
 * `isEventType`'s, as a run's inbox takes one. The declaration refuses
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
