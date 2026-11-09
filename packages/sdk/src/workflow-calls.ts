import { clientInternals } from "./client-core.ts";
import type { GraspClient } from "./client-core.ts";
import { clientError } from "./client-error.ts";
import type { QueryEntry } from "./client-query-entry.ts";
import { deepFreeze } from "./declaration.ts";
import { isPlainObject } from "./value-descriptor.ts";
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
//   nothing on this one. A start admitted late, or a run ID a child's
//   effect sees before the hook's own commits, is addressed as soon as it
//   is selected, a render before the page shows it.
// - An event is sent only by a reference this very workflow's reference
//   holds, never another workflow's, a stale release's or one made up; the
//   host checks it, and its data, again.
// - A control looks settled before it is: once admitted, it stays
//   `applying` while the run's query still shows what it showed when the
//   control was sent, unless that already shows it. A push that arrived
//   while the control was under way may already be where the host ended
//   up, its last if nothing changes after (equal reads push nothing), so
//   the control is then left to the host's snapshot (`pendingControl`).
//   And as a host that ends up where it was pushes nothing either,
//   `applying` ends after `applyingAtMostMs` whatever comes. Either way a
//   push read before the control was written can make it look settled
//   for as long as the next read takes; the same control asked again
//   meanwhile joins the first on the host, or finds it done.
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
  };

  /** Starts a run with `input`: its handle, once the host admitted it. */
  readonly start = async (input: unknown): Promise<RunHandle> => {
    this.#startSeq += 1;
    const seq = this.#startSeq;
    this.#set({ starting: this.#local.starting + 1 });
    try {
      const handle = await this.#client.mutation(this.#read.functions.start, {
        input,
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

  /** The run the hook selects now, once loaded: what a command addresses. */
  #attached(): string {
    const runId = this.#selected ?? this.#local.startedRunId;
    if (runId === undefined) {
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
    // What a newer snapshot has settled no longer counts.
    const kept = this.#local.submitting.filter(
      (each) =>
        each.stage === "submitting" ||
        each.before === this.#entry(each.runId).snapshot.value
    );
    this.#set({ submitting: [...kept, asked] });
    const sent = this.#entry(runId);
    const shownWhenSent = sent.settled;
    let applying: Submitting | undefined;
    try {
      const receipt = await this.#client.mutation(this.#read.functions[kind], {
        runId,
      });
      const now = this.#entry(runId);
      const overtaken = now !== sent || now.settled !== shownWhenSent;
      const before = now.snapshot.value;
      if (
        receipt.state === "admitted" &&
        !overtaken &&
        !showsControl(kind, before)
      ) {
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

  /** Sends run `runId` the event `event` refers to, with `data`. */
  async #send(runId: string, event: unknown, data: unknown): Promise<void> {
    const alias =
      isPlainObject(event) && typeof event.alias === "string"
        ? event.alias
        : undefined;
    const known =
      alias === undefined ? undefined : this.#read.events.get(alias);
    const { send } = this.#read.functions;
    if (
      known === undefined ||
      send === undefined ||
      !isPlainObject(event) ||
      event.kind !== known.kind ||
      event.workflow !== known.workflow ||
      event.workflowFingerprint !== known.workflowFingerprint ||
      event.resourceId !== known.resourceId ||
      event.resourceVersion !== known.resourceVersion ||
      event.type !== known.type ||
      event.fingerprint !== known.fingerprint
    ) {
      throw clientError("contract.invalid_request");
    }
    await this.#client.mutation(send, { runId, event: known.alias, data });
  }

  #set(change: Partial<LocalCalls>): void {
    this.#local = { ...this.#local, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
