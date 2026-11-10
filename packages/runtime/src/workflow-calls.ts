import { clientInternals } from "./client-core.ts";
import type { GraspClient } from "./client-core.ts";
import { clientError } from "./client-error.ts";
import type { QueryEntry } from "./client-query-entry.ts";
import { deepFreeze } from "./declaration.ts";
import { eventReferenceName } from "./workflow-events.ts";
import type { ReadWorkflow } from "./workflow-reference-read.ts";
import { respondToDecision } from "./workflow-respond.ts";
import type { RunHandle } from "./workflow-runs.ts";
import type { PendingControl, Submitting, ViewParts } from "./workflow-view.ts";
import { showsControl } from "./workflow-view.ts";

// What one `useWorkflow` keeps beside its two live queries (`run` and
// `canStart`): its own starts and controls, each a call of the workflow
// reference's mutations through the session client, which sends it under
// one key until the host answers, never twice. Nothing here sends a
// request on its own: only `start`, `pause`, `resume`, `cancel`, `send` and
// `respond`, called by the page.
//
// - Selection: without a run ID, the hook shows the run of its latest
//   admitted start: a start admitted late never replaces a newer one's
//   run, and a failed one keeps what was shown.
// - The commands are the same functions for the hook's life, so a page
//   may keep one in a handler or a callback. Each addresses the run the
//   hook selects when it is called (the run ID it committed, else its
//   latest admitted start's; `workflow.not_attached` for none), never one
//   a render saw before, whether or not its snapshot loaded yet: a start
//   and then a cancel in one handler cancel the run just started, and the
//   host checks every one as it would any. A selection changed while one
//   is under way doesn't redirect it, and one asked of another run shows
//   nothing on this one. The hook commits its run ID before any layout
//   effect runs, and once it lets go of these calls (another workflow or
//   client, or it unmounted) a kept command refuses. A start admitted
//   late is addressed as soon as it is admitted, a render before the page
//   shows it.
// - An event is sent only by a reference this very workflow's reference
//   holds, never another workflow's, a stale release's or one made up; the
//   host checks it, and its data, again.
// - A control looks settled before it is: once admitted, it stays
//   `applying` while the run's query still shows what it showed when the
//   answer came, unless that already shows it; the host's snapshot says
//   the rest (`pendingControl`). A host that ends up where it was (another
//   page undid the control) pushes nothing new, so `applying` ends after
//   `applyingAtMostMs` whatever comes.
// - Capabilities are the host's alone: what a snapshot of the `run` query
//   says may be done, narrowed by this hook's own controls. As any live
//   query's, a snapshot kept through a lost connection stays shown, and
//   the host refuses what is no longer allowed; nothing here is a grant.

/** The longest a control of this hook's shows `applying` on its own. */
export const applyingAtMostMs = 10_000;

/** What one hook has under way itself. */
export interface LocalCalls {
  readonly starting: number;
  /** The run of its latest admitted start: what it shows without a run ID. */
  readonly startedRunId: string | undefined;
  readonly submitting: readonly Submitting[];
}

/**
 * One hook's own starts and controls, for one client and workflow, read
 * by React with `useSyncExternalStore`.
 */
export class WorkflowCalls {
  readonly #client: GraspClient;
  readonly #read: ReadWorkflow;
  readonly #listeners = new Set<() => void>();
  #local: LocalCalls = {
    starting: 0,
    startedRunId: undefined,
    submitting: [],
  };
  #startSeq = 0;
  #admittedSeq = 0;
  /** The run ID the hook committed, if it was given one. */
  #selected: string | undefined;
  /** Whether the hook let go of these calls: its commands then refuse. */
  #retired = false;

  constructor(client: GraspClient, read: ReadWorkflow) {
    this.#client = client;
    this.#read = read;
  }

  readonly subscribe = (onChange: () => void): (() => void) => {
    this.#listeners.add(onChange);
    return () => {
      this.#listeners.delete(onChange);
    };
  };

  readonly local = (): LocalCalls => this.#local;

  /**
   * The run ID the hook committed (`undefined` for its latest start's),
   * which its commands address from now on.
   */
  readonly select = (runId: string | undefined): void => {
    this.#selected = runId;
    this.#retired = false;
  };

  /**
   * The hook let go of these calls (another workflow or client, or it
   * unmounted): its kept commands refuse (`workflow.not_attached`) until
   * it selects again.
   */
  readonly retire = (): void => {
    this.#retired = true;
  };

  /** Starts a run with `args`: its handle, once the host admitted it. */
  readonly start = async (args: unknown): Promise<RunHandle> => {
    this.#startSeq += 1;
    const seq = this.#startSeq;
    this.#set({ starting: this.#local.starting + 1 });
    try {
      const handle = await this.#client.mutation(this.#read.functions.start, {
        args,
      });
      if (seq > this.#admittedSeq) {
        this.#admittedSeq = seq;
        this.#set({ startedRunId: handle.runId });
      }
      return deepFreeze(handle);
    } finally {
      this.#set({ starting: this.#local.starting - 1 });
    }
  };

  /** The hook's commands, the same for its life (see the header). */
  readonly commands: ViewParts["commands"] = {
    start: this.start,
    pause: async () => {
      await this.#control("pause");
    },
    resume: async () => {
      await this.#control("resume");
    },
    cancel: async () => {
      await this.#control("cancel");
    },
    send: async (event: unknown, data: unknown) => {
      await this.#send(this.#attached(), event, data);
    },
    respond: async (wait: unknown, response: unknown) => {
      await respondToDecision(
        clientInternals(this.#client),
        this.#read,
        this.#attached(),
        wait,
        response
      );
    },
  };

  /** The run the hook selects now: what a command addresses. */
  #attached(): string {
    const runId = this.#selected ?? this.#local.startedRunId;
    if (runId === undefined || this.#retired) {
      throw clientError("workflow.not_attached");
    }
    return runId;
  }

  /**
   * Asks the host for `kind` of the run selected now: resolves once
   * admitted, the control shown applying until the host shows it (see
   * the header).
   */
  async #control(kind: PendingControl["kind"]): Promise<void> {
    const runId = this.#attached();
    const asked: Submitting = { kind, runId, stage: "submitting" };
    // What a newer snapshot has settled no longer counts: read before the
    // control shows, so nothing here can leave it `submitting`.
    const kept = this.#local.submitting.filter(
      (each) =>
        each.stage === "submitting" ||
        each.before === this.#entry(each.runId).snapshot.value
    );
    this.#set({ submitting: [...kept, asked] });
    let applying: Submitting | undefined;
    try {
      const receipt = await this.#client.mutation(this.#read.functions[kind], {
        runId,
      });
      const before = this.#entry(runId).snapshot.value;
      if (receipt.state === "admitted" && !showsControl(kind, before)) {
        applying = { kind, runId, stage: "applying", before };
      }
    } finally {
      this.#set({
        submitting: this.#local.submitting.flatMap((each) => {
          if (each !== asked) {
            return [each];
          }
          return applying === undefined ? [] : [applying];
        }),
      });
    }
    if (applying !== undefined) {
      const shown = applying;
      setTimeout(() => {
        if (this.#local.submitting.includes(shown)) {
          this.#set({
            submitting: this.#local.submitting.filter((each) => each !== shown),
          });
        }
      }, applyingAtMostMs);
    }
  }

  /** The run query of `runId`'s entry, as the hook reads it. */
  #entry(runId: string): QueryEntry {
    return clientInternals(this.#client).entry(this.#read.functions.run, {
      runId,
    });
  }

  /**
   * Sends run `runId` the event `event` names, with `data`: one of this
   * very workflow's own, named under its name, which the release
   * declares; the host checks the data with its descriptor again.
   */
  async #send(runId: string, event: unknown, data: unknown): Promise<void> {
    const named = eventReferenceName(event);
    const { send } = this.#read.functions;
    if (
      named === undefined ||
      named.workflow !== this.#read.alias ||
      !this.#read.events.has(named.alias) ||
      send === undefined
    ) {
      throw clientError("contract.invalid_request");
    }
    await this.#client.mutation(send, { runId, event: named.alias, data });
  }

  #set(change: Partial<LocalCalls>): void {
    this.#local = { ...this.#local, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
