import { clientError, fences } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import { hasEnded, invalidSnapshot } from "./client-workflow.ts";
import type {
  BindingSnapshot,
  ReadWorkflow,
  RunSnapshot,
  WatchState,
  WorkflowChannel,
} from "./client-workflow.ts";
import type { AppErrorPayload, RunHandle, WorkflowWait } from "./references.ts";

// One `useWorkflow`'s state (spec 10.4.1–10.4.7, 10.7.3): the run it
// selects, its own starts and controls, and the view it derives from them
// and from the channel's snapshots (client-workflow.ts). React reads it
// with `useSyncExternalStore`; nothing here sends a request on its own.
//
// - Selection: without a run ID, the run of the latest admitted start
//   (`#admittedSeq`: a start admitted late never replaces a newer one's
//   run, and a failed one keeps what was shown); with one, exactly it.
//   Each change of the run shown moves the generation on.
// - Controls address the run shown when they were called, captured with
//   the generation: one answered after the selection changed shows
//   nothing on the run shown now.
// - Capabilities are the host's, from the one snapshot of the run being
//   shown, and only while that snapshot is of the subscription in force;
//   this hook's own unsettled controls narrow them further. Nothing turns
//   them on from status, ownership or role.
// - A control the host admitted stays `applying` until a snapshot newer
//   than the one shown at admission arrives; a cancel, this hook's or the
//   host's, outranks a pause or resume.

/** A selection: `null` follows the hook's latest admitted start. */
export type Selection = string | null;

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
export interface WorkflowCommands<Input, Wait> {
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

/** The selected run's status, and what each status has (spec 10.4.1). */
export type WorkflowRunView<Output> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly runId: string }
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
export type WorkflowView<Input, Output, Wait = WorkflowWait> = WorkflowCommands<
  Input,
  Wait
> &
  WorkflowRunView<Output>;

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
const controlsOf = (
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

const noWaits: readonly never[] = Object.freeze([]);

/**
 * `snapshot`'s waits as shown: whether an event may be sent or a decision
 * answered is the host's word only while the subscription is in force,
 * and off from a lost connection until a fresh push, as the run's own
 * controls are; the waits themselves stay on screen.
 */
const waitsOf = (
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

/** A control of this hook's, while it is unsettled. */
interface Intent {
  readonly kind: PendingControl["kind"];
  readonly runId: string;
  /** The selection's generation it was asked under. */
  readonly generation: number;
  stage: PendingControl["stage"];
  /** Once admitted: the revision a newer snapshot than settles it. */
  settleAfter: number | undefined;
  done: Promise<void> | undefined;
}

/** What a view was built from: rebuilt only when any of it changes. */
interface Built {
  readonly selection: Selection;
  readonly version: number;
  readonly run: WatchState<RunSnapshot> | undefined;
  readonly binding: WatchState<BindingSnapshot>;
  readonly view: WorkflowView<unknown, unknown>;
}

/**
 * One `useWorkflow`'s state, for one client and reference: the selection
 * it shows, its starts and controls, and the view it derives from them and
 * the channel's snapshots. React reads it with `useSyncExternalStore`;
 * its commands are the same functions for its whole life.
 */
export class WorkflowStore {
  readonly #channel: WorkflowChannel;
  readonly #read: ReadWorkflow;
  /** The selection the hook committed, once it subscribed. */
  #committed: Selection | undefined;
  /** Moves on whenever the run shown changes. */
  #generation = 0;
  /** The run of the latest admitted start, for the automatic selection. */
  #autoRunId: string | undefined;
  #startSeq = 0;
  #admittedSeq = 0;
  #starting = 0;
  readonly #intents: Intent[] = [];
  readonly #listeners = new Set<() => void>();
  #attached: { readonly runId: string; readonly stop: () => void } | undefined;
  #binding: (() => void) | undefined;
  /** Moves on with anything of this store's own the view shows. */
  #version = 0;
  #built: Built | undefined;

  constructor(channel: WorkflowChannel, read: ReadWorkflow) {
    this.#channel = channel;
    this.#read = read;
  }

  /** Shows `selection` and tells `onChange` of every change, until stopped. */
  readonly subscribe = (
    selection: Selection,
    onChange: () => void
  ): (() => void) => {
    this.#listeners.add(onChange);
    if (this.#committed !== selection) {
      const before =
        this.#committed === undefined
          ? undefined
          : this.#runIdOf(this.#committed);
      this.#committed = selection;
      // The generation moves on only when the run shown does: selecting
      // the same run another way keeps its controls.
      if (this.#runIdOf(selection) !== before) {
        this.#generation += 1;
      }
      this.#version += 1;
    }
    this.#binding ??= this.#channel.followBinding(this.#read, this.#changed);
    this.#attach();
    return () => {
      this.#listeners.delete(onChange);
      if (this.#listeners.size === 0) {
        this.#attached?.stop();
        this.#attached = undefined;
        this.#binding?.();
        this.#binding = undefined;
      }
    };
  };

  /** The view of `selection`, the same object until something changes. */
  readonly view = (selection: Selection): WorkflowView<unknown, unknown> => {
    const runId = this.#runIdOf(selection);
    const run =
      runId === undefined
        ? undefined
        : this.#channel.peekRun(this.#read, runId);
    const binding = this.#channel.peekBinding(this.#read);
    const built = this.#built;
    if (
      built?.selection === selection &&
      built.version === this.#version &&
      built.run === run &&
      built.binding === binding
    ) {
      return built.view;
    }
    const view = this.#build(runId, run, binding);
    this.#built = { selection, version: this.#version, run, binding, view };
    return view;
  };

  /** Why `selection` can't be shown: a refusal, thrown while rendering. */
  readonly error = (selection: Selection): GraspError | undefined => {
    const runId = this.#runIdOf(selection);
    const run =
      runId === undefined
        ? undefined
        : this.#channel.peekRun(this.#read, runId);
    if (run?.error !== undefined) {
      return run.error;
    }
    // A binding's refusal only turns `canRun` off; only one that fences
    // (the person or build lost access) is thrown over what is shown.
    const bindingError = this.#channel.peekBinding(this.#read).error;
    return bindingError !== undefined && fences(bindingError.code)
      ? bindingError
      : undefined;
  };

  readonly run = async (input: unknown): Promise<RunHandle> => {
    this.#startSeq += 1;
    const seq = this.#startSeq;
    this.#starting += 1;
    this.#changed();
    try {
      const handle = await this.#channel.start(this.#read, input);
      // The latest admitted start is the automatic selection, whatever
      // the hook shows now: a start admitted late never replaces a newer
      // one's run. It is shown only while the hook selects automatically;
      // an explicit selection is the caller's alone.
      if (seq > this.#admittedSeq) {
        const before = this.#autoRunId;
        this.#admittedSeq = seq;
        this.#autoRunId = handle.runId;
        if (this.#committed === null && handle.runId !== before) {
          this.#generation += 1;
          this.#attach();
        }
      }
      return handle;
    } finally {
      this.#starting -= 1;
      this.#changed();
    }
  };

  readonly pause = async (): Promise<void> => {
    await this.#control("pause");
  };

  readonly resume = async (): Promise<void> => {
    await this.#control("resume");
  };

  readonly cancel = async (): Promise<void> => {
    await this.#control("cancel");
  };

  #runIdOf(selection: Selection): string | undefined {
    return selection ?? this.#autoRunId;
  }

  /** Follows the committed selection's run, and only it. */
  #attach(): void {
    const runId =
      this.#committed === undefined
        ? undefined
        : this.#runIdOf(this.#committed);
    if (this.#attached?.runId === runId) {
      return;
    }
    this.#attached?.stop();
    this.#attached =
      runId === undefined || this.#listeners.size === 0
        ? undefined
        : {
            runId,
            stop: this.#channel.followRun(this.#read, runId, this.#changed),
          };
  }

  readonly #changed = (): void => {
    this.#version += 1;
    this.#settle();
    for (const listener of this.#listeners) {
      listener();
    }
  };

  /** Lets go of admitted controls a newer snapshot settled. */
  #settle(): void {
    for (let index = this.#intents.length - 1; index >= 0; index -= 1) {
      const intent = this.#intents[index];
      if (intent !== undefined && this.#settled(intent)) {
        this.#intents.splice(index, 1);
      }
    }
  }

  #settled(intent: Intent): boolean {
    if (intent.generation !== this.#generation) {
      return true;
    }
    if (intent.stage !== "applying" || intent.settleAfter === undefined) {
      return false;
    }
    const { revision } = this.#channel.peekRun(this.#read, intent.runId);
    return revision > intent.settleAfter;
  }

  async #control(kind: PendingControl["kind"]): Promise<void> {
    const runId =
      this.#committed === undefined
        ? undefined
        : this.#runIdOf(this.#committed);
    if (
      runId === undefined ||
      this.#channel.peekRun(this.#read, runId).value === undefined
    ) {
      throw clientError("workflow.not_attached");
    }
    const generation = this.#generation;
    const joined = this.#intents.find(
      (intent) =>
        intent.kind === kind &&
        intent.runId === runId &&
        intent.generation === generation &&
        intent.stage !== "applying"
    );
    if (joined?.done !== undefined) {
      // The same request, still unanswered: the same submission.
      await joined.done;
      return;
    }
    const intent: Intent = {
      kind,
      runId,
      generation,
      stage: "submitting",
      settleAfter: undefined,
      done: undefined,
    };
    this.#intents.push(intent);
    this.#changed();
    const drop = (): void => {
      const at = this.#intents.indexOf(intent);
      if (at !== -1) {
        this.#intents.splice(at, 1);
      }
    };
    const send = async (): Promise<void> => {
      try {
        const receipt = await this.#channel.control(
          this.#read,
          runId,
          kind,
          () => {
            if (intent.stage === "submitting") {
              intent.stage = "recovering";
              this.#changed();
            }
          }
        );
        // Applying until the run's snapshot shows where it stands: one
        // newer than the revision that admitted it, or, for a receipt
        // already applied or superseded, the revision that settled it.
        // A snapshot that arrived before this answer may have done so
        // already; an older one never does.
        intent.stage = "applying";
        intent.settleAfter =
          receipt.state === "admitted"
            ? receipt.revision
            : receipt.revision - 1;
      } catch (error) {
        drop();
        throw error;
      } finally {
        this.#changed();
      }
    };
    intent.done = send();
    await intent.done;
  }

  /** The selected run's unsettled control, this hook's or the host's. */
  #pending(
    runId: string,
    run: WatchState<RunSnapshot> | undefined
  ): PendingControl | null {
    // An ended run has nothing left to control: a request still awaiting
    // its answer was overtaken, and its caller alone hears how it ends.
    if (run?.value !== undefined && hasEnded(run.value.status)) {
      return null;
    }
    const mine = this.#intents.filter(
      (intent) => intent.runId === runId && !this.#settled(intent)
    );
    const host = run?.value?.control.pendingControl ?? null;
    // Cancel overrides a pause or resume, wherever either was asked for: an
    // older request of this hook's never hides the host's cancel.
    const myCancel = mine.findLast((intent) => intent.kind === "cancel");
    if (myCancel !== undefined) {
      return { kind: "cancel", stage: myCancel.stage };
    }
    if (host?.kind === "cancel") {
      return host;
    }
    const mineLast = mine.at(-1);
    return mineLast === undefined
      ? host
      : { kind: mineLast.kind, stage: mineLast.stage };
  }

  #build(
    runId: string | undefined,
    run: WatchState<RunSnapshot> | undefined,
    binding: WatchState<BindingSnapshot>
  ): WorkflowView<unknown, unknown> {
    const pending = runId === undefined ? null : this.#pending(runId, run);
    const snapshot = run?.error === undefined ? run?.value : undefined;
    const commands: WorkflowCommands<unknown, WorkflowWait> = {
      run: this.run,
      pause: this.pause,
      resume: this.resume,
      cancel: this.cancel,
      canRun:
        binding.fresh &&
        binding.error === undefined &&
        binding.value?.canRun === true,
      ...controlsOf(run, pending),
      isStarting: this.#starting > 0,
      pendingControl: pending === null ? null : Object.freeze({ ...pending }),
      waits: snapshot === undefined ? noWaits : waitsOf(snapshot, run),
    };
    if (runId === undefined) {
      return Object.freeze({ ...commands, status: "idle" });
    }
    if (snapshot === undefined) {
      return Object.freeze({ ...commands, status: "loading", runId });
    }
    return Object.freeze({ ...commands, ...runView(snapshot) });
  }
}
