import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import type { WatchState, WorkflowChannel } from "./client-workflow.ts";
import { fences } from "./refusals.ts";
import { hasEnded } from "./run-snapshot.ts";
import type { BindingSnapshot, RunSnapshot } from "./run-snapshot.ts";
import type { ReadWorkflow } from "./workflow-reference-read.ts";
import type { RunHandle, WorkflowWait } from "./workflow-runs.ts";
import { controlsOf, noWaits, runView, waitsOf } from "./workflow-view.ts";
import type {
  PendingControl,
  WorkflowCommands,
  WorkflowView,
} from "./workflow-view.ts";

// One `useWorkflow`'s state: the run it
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
// - A send addresses the run shown when it was called, as a control does:
//   a selection changed while it is under way doesn't redirect it. Each
//   call is its own event; none is joined with another.

/** A selection: `null` follows the hook's latest admitted start. */
export type Selection = string | null;

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

  readonly respond = async (
    wait: unknown,
    response: unknown
  ): Promise<void> => {
    const runId = this.#attachedRunId();
    await this.#channel.respond(this.#read, runId, wait, response);
  };

  readonly send = async (event: unknown, data: unknown): Promise<void> => {
    const runId = this.#attachedRunId();
    await this.#channel.send(this.#read, runId, event, data);
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

  /** The run shown now, once its snapshot loaded: `workflow.not_attached` otherwise. */
  #attachedRunId(): string {
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
    return runId;
  }

  async #control(kind: PendingControl["kind"]): Promise<void> {
    const runId = this.#attachedRunId();
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
    const commands: WorkflowCommands<unknown, WorkflowWait, unknown> = {
      run: this.run,
      pause: this.pause,
      resume: this.resume,
      cancel: this.cancel,
      send: this.send,
      respond: this.respond,
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
      return Object.freeze({
        ...commands,
        status: run?.unavailable === true ? "unavailable" : "loading",
        runId,
      });
    }
    return Object.freeze({ ...commands, ...runView(snapshot) });
  }
}
