import type { AnyPermission, WorkflowPermission } from "./permission-types.ts";
import type { EventDataOf, WorkflowEventReference } from "./workflow-events.ts";

/**
 * What an App's permissions grant its functions, as one union: each
 * permission its actions reach and each workflow it starts. Its pages'
 * permissions (files, links) and `people` aren't among them: every kind
 * reads the people the same way (`ctx.people`), which the host refuses
 * to an App that doesn't declare them.
 */
export type Grant = AnyPermission | AnyWorkflow;

/** The event references of the workflows among `Grants`. */
type GrantedEvent<Grants extends Grant> = WorkflowEventReference<
  `workflows.${GrantedWorkflow<Grants>["alias"]}`,
  string,
  string,
  // oxlint-disable-next-line typescript/no-explicit-any -- the data is only read, by `EventDataOf`
  any
>;

/**
 * `ctx.notify`: stages the event `event` (one of a workflow among
 * `Grants`) for run `runId` of its workflow, with `data` as that event
 * declares it, never inferred from the call.
 */
export type Notify<Grants extends Grant> = <Event extends GrantedEvent<Grants>>(
  event: Event,
  notification: {
    readonly runId: string;
    readonly data: NoInfer<EventDataOf<Event>>;
  }
) => void;

/** Any workflow declaration, whatever its input. */
// oxlint-disable-next-line typescript/no-explicit-any -- the input is only read, by `WorkflowInput`
type AnyWorkflow = WorkflowPermission<string, any>;

/** The workflows among `Grants`. */
type GrantedWorkflow<Grants extends Grant> = Extract<Grants, AnyWorkflow>;

/** The input a caller starts workflow `Workflow` with. */
type WorkflowInput<Workflow> =
  Workflow extends WorkflowPermission<string, infer Input> ? Input : never;

/**
 * A workflow start the host admitted: durable from the moment it resolves,
 * whatever happens to the caller next. It doesn't wait for the run.
 */
export interface RunHandle {
  /**
   * The start's receipt: the same for every attempt of the same start (an
   * action called again under the same idempotency key).
   */
  readonly startId: string;
  /** The run executing it. */
  readonly runId: string;
  /** The version of the workflow it started: the one its alias binds. */
  readonly version: number;
}

/**
 * What a start of `Workflow` takes: its input, which may be left out where
 * the input schema takes none (its default, say).
 */
type StartArgs<Workflow> =
  undefined extends WorkflowInput<Workflow>
    ? [input?: WorkflowInput<Workflow>]
    : [input: WorkflowInput<Workflow>];

/**
 * `ctx.workflows`: each workflow among `Grants`, by its alias, started with its input,
 * answering `Started`.
 */
export type Workflows<Grants extends Grant, Started> = {
  readonly [Workflow in GrantedWorkflow<Grants> as Workflow["alias"]]: {
    readonly start: (...input: StartArgs<Workflow>) => Promise<Started>;
  };
};
