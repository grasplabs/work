import { deepFreeze, isPlainObject } from "@grasp-os/shared/json";

import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import type { DecisionValueOf } from "./workflow-decisions.ts";
import type { EventDataOf } from "./workflow-events.ts";
import type { controlKinds } from "./workflow-functions.ts";
import type { ReadWorkflow } from "./workflow-reference-read.ts";
import type {
  AppErrorPayload,
  RunHandle,
  WorkflowWait,
} from "./workflow-runs.ts";

/** A control asked for and not yet settled, for the selected run. */
export interface PendingControl {
  readonly kind: "pause" | "resume" | "cancel";
  /**
   * `submitting` while this hook's request is unanswered, `applying` once
   * the host admitted it until the run settles it.
   */
  readonly stage: "submitting" | "applying";
}

/** What a hook does, and may do now, whatever its run's status. */
export interface WorkflowCommands<Args, Wait, Event = never> {
  /**
   * Starts a new run with `args`: resolves with its handle once the host
   * admitted it durably (never when it finishes); rejects with a
   * structured error otherwise. With no `runId` given to the hook, the
   * hook then shows the run of its latest admitted start.
   */
  readonly start: (args: Args) => Promise<RunHandle>;
  /**
   * Pauses the selected run at its next safe point: resolves once the
   * host admitted it; the run's status says when it is paused.
   */
  readonly pause: () => Promise<void>;
  /** Resumes the selected paused run, as `pause` does. */
  readonly resume: () => Promise<void>;
  /**
   * Cancels the selected run, as `pause` does. It takes priority over a
   * pause or resume still applying, and undoes nothing already done.
   */
  readonly cancel: () => Promise<void>;
  /**
   * Sends the selected run `event`, one of its workflow's own event
   * references (`workflows.<workflow>.events.<alias>`), with `data` as
   * that event declares it: resolves once the host committed it to the
   * run's inbox, never when the run takes it. Each call is its own event;
   * it resumes no paused run and answers no decision.
   */
  readonly send: <Sent extends Event>(
    event: Sent,
    data: NoInfer<EventDataOf<Sent>>
  ) => Promise<void>;
  /**
   * Answers a decision the selected run is held at:
   * `wait` exactly as a wait of this run's (`waits`) or the decision inbox
   * (`queries.decisions`) gave it, and `value` as that decision's value
   * schema declares it. The page asks the person to confirm the answer in
   * its own dialog first; it resolves once the answer is the recorded
   * decision, and rejects with `decision.cancelled` when they cancel it,
   * the draft kept. Never sent on render, mount or a lost connection; an
   * answer whose outcome is lost rejects with `decision.outcome_unknown`,
   * and giving the same answer again records nothing twice.
   */
  readonly respond: <Answered extends Extract<Wait, { kind: "decision" }>>(
    wait: Answered,
    response: {
      readonly approved: boolean;
      readonly value: NoInfer<DecisionValueOf<Answered>>;
    }
  ) => Promise<void>;
  /** Whether a new run may be started now (not a promise it will be). */
  readonly canStart: boolean;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canCancel: boolean;
  /** Whether a start of this hook's is still unresolved. */
  readonly isStarting: boolean;
  readonly pendingControl: PendingControl | null;
  /**
   * The waits the selected run is held at now: empty while idle or
   * loading, which says nothing yet of the run's waits.
   */
  readonly waits: readonly Wait[];
}

/** A run the host showed: who it is, and when it started. */
export type ObservedRun = Readonly<RunHandle> & {
  readonly startedAt: number | null;
};

/** The selected run's status, and what each status has. */
export type WorkflowRunView<Returns> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly runId: string }
  /**
   * The person may not see the run (a decision that asked them was
   * answered, its alias bound elsewhere, or no such run): nothing of it
   * is shown, and it is no error. Shown again should access come back.
   */
  | { readonly status: "unavailable"; readonly runId: string }
  | (ObservedRun & {
      readonly status: "queued" | "running" | "waiting" | "paused";
      readonly finishedAt: null;
    })
  | (ObservedRun & {
      readonly status: "compensating";
      readonly finishedAt: null;
      readonly activity: "running" | "waiting" | "paused";
    } & (
        | {
            readonly cause: "failure";
            readonly originalError: Readonly<AppErrorPayload>;
          }
        | { readonly cause: "cancellation" }
      ))
  | (ObservedRun & {
      readonly status: "completed";
      readonly finishedAt: number;
      readonly result: Returns;
    })
  | (ObservedRun & {
      readonly status: "failed";
      readonly finishedAt: number;
      readonly error: Readonly<AppErrorPayload>;
    })
  | (ObservedRun & {
      readonly status: "cancelled";
      readonly finishedAt: number;
    });

/** What `useWorkflow` answers: the commands and the selected run's view. */
export type WorkflowView<
  Args,
  Returns,
  Wait = WorkflowWait,
  Event = never,
> = WorkflowCommands<Args, Wait, Event> & WorkflowRunView<Returns>;

/** A wait as the `run` query names it: its event by alias. */
type RunWait =
  | Exclude<WorkflowWait, { readonly kind: "event" }>
  | (Omit<Extract<WorkflowWait, { readonly kind: "event" }>, "event"> & {
      readonly event: {
        readonly kind: "workflowEvent";
        readonly alias: string;
      };
    });

/**
 * One run as a workflow reference's `run` query answers it (its
 * descriptor, workflow-functions.ts, says exactly what the host sends).
 */
export interface RunSnapshot extends RunHandle {
  readonly status:
    | "queued"
    | "running"
    | "waiting"
    | "paused"
    | "compensating"
    | "completed"
    | "failed"
    | "cancelled";
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly compensation?:
    | {
        readonly cause: "failure";
        readonly activity: "running" | "waiting" | "paused";
        readonly originalError: AppErrorPayload;
      }
    | {
        readonly cause: "cancellation";
        readonly activity: "running" | "waiting" | "paused";
      };
  readonly result?: unknown;
  readonly error?: AppErrorPayload;
  readonly waits: readonly RunWait[];
  readonly control: {
    readonly canPause: boolean;
    readonly canResume: boolean;
    readonly canCancel: boolean;
    readonly pendingControl: {
      readonly kind: (typeof controlKinds)[number];
      readonly stage: "applying";
    } | null;
  };
}

const ended: ReadonlySet<string> = new Set<RunSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

const invalidSnapshot = (): GraspError =>
  clientError("contract.invalid_snapshot");

/** A snapshot as its status's variant of the view. */
const runView = (snapshot: RunSnapshot): WorkflowRunView<unknown> => {
  const observed: ObservedRun = {
    runId: snapshot.runId,
    workflowId: snapshot.workflowId,
    workflowVersion: snapshot.workflowVersion,
    manifestHash: snapshot.manifestHash,
    startedAt: snapshot.startedAt,
  };
  const { status, finishedAt, compensation, error } = snapshot;
  // The `run` query's descriptor gives each status its own fields.
  const endedAt = (): number => {
    if (finishedAt === null) {
      throw invalidSnapshot();
    }
    return finishedAt;
  };
  switch (status) {
    case "queued":
    case "running":
    case "waiting":
    case "paused": {
      return { ...observed, status, finishedAt: null };
    }
    case "compensating": {
      if (compensation === undefined) {
        throw invalidSnapshot();
      }
      return { ...observed, status, finishedAt: null, ...compensation };
    }
    case "completed": {
      return {
        ...observed,
        status,
        finishedAt: endedAt(),
        result: snapshot.result,
      };
    }
    case "failed": {
      if (error === undefined) {
        throw invalidSnapshot();
      }
      return { ...observed, status, finishedAt: endedAt(), error };
    }
    case "cancelled": {
      return { ...observed, status, finishedAt: endedAt() };
    }
    default: {
      return status satisfies never;
    }
  }
};

/**
 * `waits` with each event wait's event the reference `read` holds under
 * its alias: a run listening for an event the App's release doesn't
 * declare, or in a task that doesn't listen for it, is an invalid
 * snapshot, as is one held for a decision it doesn't declare; never a
 * wait shown with an event or a response type its key doesn't promise.
 */
const resolvedWaits = (
  read: ReadWorkflow,
  waits: readonly RunWait[]
): readonly WorkflowWait[] =>
  deepFreeze(
    waits.map((wait): WorkflowWait => {
      if (wait.kind === "decision" && !read.decisions.has(wait.key)) {
        throw invalidSnapshot();
      }
      if (wait.kind !== "event") {
        return wait;
      }
      const { alias } = wait.event;
      const event = read.events.get(alias);
      if (
        event === undefined ||
        read.listens.get(wait.key)?.has(alias) !== true
      ) {
        throw invalidSnapshot();
      }
      return { ...wait, event: event.reference };
    })
  );

/**
 * A control of this hook's: `submitting` while its request is unanswered;
 * once the host admitted it, `applying` while the run's query still shows
 * `before`, the snapshot it showed when the answer came, within the
 * bounds workflow-calls.ts sets (`WorkflowCalls`, its header).
 */
export type Submitting =
  | {
      readonly kind: PendingControl["kind"];
      readonly runId: string;
      readonly stage: "submitting";
    }
  | {
      readonly kind: PendingControl["kind"];
      readonly runId: string;
      readonly stage: "applying";
      readonly before: unknown;
    };

/** Whether `each`, of this hook's, is still unsettled on `snapshot`. */
const unsettled = (each: Submitting, snapshot: unknown): boolean =>
  each.stage === "submitting" || each.before === snapshot;

/**
 * The run's unsettled control: this hook's own, or the host's, applying;
 * a cancel, either's, outranks a pause or resume. None once the run has
 * ended: a request still unanswered was overtaken, and its caller alone
 * hears how it ends.
 */
const pendingOf = (
  runId: string,
  snapshot: RunSnapshot | null | undefined,
  submitting: readonly Submitting[]
): PendingControl | null => {
  if (
    snapshot !== null &&
    snapshot !== undefined &&
    ended.has(snapshot.status)
  ) {
    return null;
  }
  const mine = submitting.filter(
    (each) => each.runId === runId && unsettled(each, snapshot)
  );
  const host = snapshot?.control.pendingControl ?? null;
  const myCancel = mine.findLast(({ kind }) => kind === "cancel");
  if (myCancel !== undefined) {
    return { kind: "cancel", stage: myCancel.stage };
  }
  if (host?.kind === "cancel") {
    return host;
  }
  const last = mine.at(-1);
  return last === undefined ? host : { kind: last.kind, stage: last.stage };
};

/**
 * Whether `snapshot`, the run's query as a control of `kind` was admitted,
 * already shows it: applying, or where it leads (a pause paused, a resume
 * no longer paused, any control once the run has ended), or no run at
 * all. Such a snapshot may be the last the host pushes, so the control is
 * left to it; any other is older than the control, which shows applying
 * until a newer one.
 */
export const showsControl = (
  kind: PendingControl["kind"],
  snapshot: unknown
): boolean => {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.control)) {
    return true;
  }
  const { status, control } = snapshot;
  const pending = isPlainObject(control.pendingControl)
    ? control.pendingControl.kind
    : undefined;
  if (pending === kind || (typeof status === "string" && ended.has(status))) {
    return true;
  }
  if (kind === "pause") {
    return status === "paused";
  }
  return kind === "resume" && status !== "paused";
};

const noWaits: readonly never[] = Object.freeze([]);

/** What a `useWorkflow` view is built from (react/workflow.ts). */
export interface ViewParts {
  readonly read: ReadWorkflow;
  /** The run selected: the one given, or the latest admitted start's. */
  readonly runId: string | undefined;
  /** The `run` query's answer: undefined while it loads, null if not seen. */
  readonly snapshot: RunSnapshot | null | undefined;
  /** The `canStart` query's answer, undefined while it loads. */
  readonly canStart: boolean | undefined;
  readonly starting: boolean;
  readonly submitting: readonly Submitting[];
  readonly commands: Pick<
    WorkflowCommands<unknown, WorkflowWait, unknown>,
    "start" | "pause" | "resume" | "cancel" | "send" | "respond"
  >;
}

/**
 * The view of `parts`: capabilities are the host's, from the run's
 * snapshot, narrowed by this hook's own unanswered controls; nothing turns
 * them on from status, ownership or role, and none is offered for a run
 * that ended or rolls back.
 */
export const workflowView = ({
  read,
  runId,
  snapshot,
  canStart,
  starting,
  submitting,
  commands,
}: ViewParts): WorkflowView<unknown, unknown> => {
  const pending =
    runId === undefined ? null : pendingOf(runId, snapshot, submitting);
  const free =
    snapshot !== null &&
    snapshot !== undefined &&
    !ended.has(snapshot.status) &&
    snapshot.status !== "compensating";
  const shared = {
    ...commands,
    canStart: canStart === true,
    canPause: free && snapshot.control.canPause && pending === null,
    canResume: free && snapshot.control.canResume && pending === null,
    canCancel: free && snapshot.control.canCancel && pending?.kind !== "cancel",
    isStarting: starting,
    pendingControl: pending === null ? null : Object.freeze({ ...pending }),
    waits:
      snapshot === null || snapshot === undefined
        ? noWaits
        : resolvedWaits(read, snapshot.waits),
  };
  if (runId === undefined) {
    return Object.freeze({ ...shared, status: "idle" });
  }
  if (snapshot === undefined) {
    return Object.freeze({ ...shared, status: "loading", runId });
  }
  if (snapshot === null) {
    return Object.freeze({ ...shared, status: "unavailable", runId });
  }
  return Object.freeze({ ...shared, ...runView(snapshot) });
};
