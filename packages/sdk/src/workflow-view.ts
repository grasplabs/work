import type { WatchState } from "./client-workflow.ts";
import { hasEnded, invalidSnapshot } from "./run-snapshot.ts";
import type { RunSnapshot } from "./run-snapshot.ts";
import type { DecisionValueOf } from "./workflow-decisions.ts";
import type { EventDataOf } from "./workflow-events.ts";
import type {
  AppErrorPayload,
  RunHandle,
  WorkflowWait,
} from "./workflow-runs.ts";

/** A control asked for and not yet settled, for the selected run. */
export interface PendingControl {
  readonly kind: "pause" | "resume" | "cancel";
  /**
   * `submitting` until the host admits it, `recovering` while a lost
   * answer is recovered, `applying` once admitted until a snapshot shows
   * it settled or superseded.
   */
  readonly stage: "submitting" | "applying" | "recovering";
}

/** What a hook does, and may do now, whatever its run's status. */
export interface WorkflowCommands<Input, Wait, Event = never> {
  /**
   * Starts a new run with `input`: resolves with its handle once the host
   * admitted it durably (never when it finishes); rejects with a
   * structured error otherwise. With no `runId` given to the hook, the
   * hook then shows the run of its latest admitted start.
   */
  readonly run: (input: Input) => Promise<RunHandle>;
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
  readonly canRun: boolean;
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
export type WorkflowRunView<Output> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly runId: string }
  /**
   * The run was shown, and the person may see it no more (a decision that
   * asked them was answered, its alias bound elsewhere): nothing of it is
   * shown, and it is no error. Shown again should access come back.
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
      readonly output: Output;
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
  Input,
  Output,
  Wait = WorkflowWait,
  Event = never,
> = WorkflowCommands<Input, Wait, Event> & WorkflowRunView<Output>;

/** A snapshot as its status's variant of the view. */
export const runView = (snapshot: RunSnapshot): WorkflowRunView<unknown> => {
  const observed: ObservedRun = {
    runId: snapshot.runId,
    workflowId: snapshot.workflowId,
    workflowVersion: snapshot.workflowVersion,
    manifestHash: snapshot.manifestHash,
    startedAt: snapshot.startedAt,
  };
  const { status, finishedAt, compensation, error } = snapshot;
  // A snapshot's fields agree with its status (`agrees`, as it was read).
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
        output: snapshot.output,
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
 * What may be asked of the run `run` shows, with `pending` unsettled: the
 * host's word, from a snapshot of the subscription in force, of a run that
 * hasn't ended and isn't compensating, narrowed by what is pending; never
 * from status alone.
 */
export const controlsOf = (
  run: WatchState<RunSnapshot> | undefined,
  pending: PendingControl | null
): Pick<
  WorkflowCommands<unknown, unknown>,
  "canPause" | "canResume" | "canCancel"
> => {
  const snapshot = run?.error === undefined ? run?.value : undefined;
  if (
    run?.fresh !== true ||
    snapshot === undefined ||
    hasEnded(snapshot.status) ||
    snapshot.status === "compensating"
  ) {
    return { canPause: false, canResume: false, canCancel: false };
  }
  const { control } = snapshot;
  return {
    canPause: control.canPause && pending === null,
    canResume: control.canResume && pending === null,
    canCancel: control.canCancel && pending?.kind !== "cancel",
  };
};

export const noWaits: readonly never[] = Object.freeze([]);

/**
 * `snapshot`'s waits as shown: whether an event may be sent or a decision
 * answered is the host's word only while the subscription is in force,
 * and off from a lost connection until a fresh push, as the run's own
 * controls are; the waits themselves stay on screen.
 */
export const waitsOf = (
  snapshot: RunSnapshot,
  run: WatchState<RunSnapshot> | undefined
): readonly WorkflowWait[] => {
  if (run?.fresh === true) {
    return snapshot.waits;
  }
  return Object.freeze(
    snapshot.waits.map((wait) => {
      if (wait.kind === "event") {
        return Object.freeze({ ...wait, canSend: false });
      }
      if (wait.kind === "decision") {
        return Object.freeze({ ...wait, canRespond: false });
      }
      return wait;
    })
  );
};
