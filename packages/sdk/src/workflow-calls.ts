import { clientInternals } from "./client-core.ts";
import type { GraspClient } from "./client-core.ts";
import { clientError } from "./client-error.ts";
import { deepFreeze } from "./declaration.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ReadWorkflow } from "./workflow-reference-read.ts";
import { respondToDecision } from "./workflow-respond.ts";
import type { RunHandle } from "./workflow-runs.ts";
import type {
  PendingControl,
  RunSnapshot,
  Submitting,
  ViewParts,
} from "./workflow-view.ts";
import { showsControl } from "./workflow-view.ts";

// What one `useWorkflow` keeps beside its two live queries (`run` and
// `canStart`): its own starts and controls, each a call of the workflow
// reference's mutations through the session client, which sends it under
// one key until the host answers, never twice. Nothing here sends a
// request on its own: only `run`, `pause`, `resume`, `cancel`, `send` and
// `respond`, called by the page.
//
// - Selection: without a run ID, the hook shows the run of its latest
//   admitted start: a start admitted late never replaces a newer one's
//   run, and a failed one keeps what was shown.
// - A command addresses the run the hook showed when the command was
//   made, once that run's snapshot loaded (`workflow.not_attached`
//   otherwise): a selection changed while it is under way doesn't
//   redirect it, and one asked of another run shows nothing on this one.
// - An event is sent only by a reference this very workflow's reference
//   holds, never another workflow's, a stale release's or one made up; the
//   host checks it, and its data, again.
// - A control looks settled before it is: once admitted, it stays
//   `applying` until the run's query shows a snapshot other than the one
//   it showed as the answer came (`Submitting`), unless that one already
//   shows it; the host's snapshot says the rest (`pendingControl`). A
//   read the host began before the control was written, and pushes after
//   its answer, can still end that early, for as long as the next read
//   takes: a control asked again meanwhile joins the first or is done,
//   never a second. Waiting for the snapshot to show it instead could
//   wait for good, for a control another page overtook.
// - Capabilities are the host's alone: what a snapshot of the `run` query
//   says may be done, narrowed by this hook's own controls. As any live
//   query's, a snapshot kept through a lost connection stays shown, and
//   the host refuses what is no longer allowed; nothing here is a grant.

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

  /**
   * The commands of a hook showing `runId`, whose `run` query answered
   * `snapshot`: each addresses that run, once it loaded.
   */
  commandsFor(
    runId: string | undefined,
    snapshot: RunSnapshot | null | undefined
  ): ViewParts["commands"] {
    const shown = (): string => {
      if (runId === undefined || snapshot === undefined || snapshot === null) {
        throw clientError("workflow.not_attached");
      }
      return runId;
    };
    return {
      run: this.start,
      pause: async () => {
        await this.#control("pause", shown());
      },
      resume: async () => {
        await this.#control("resume", shown());
      },
      cancel: async () => {
        await this.#control("cancel", shown());
      },
      send: async (event: unknown, data: unknown) => {
        await this.#send(shown(), event, data);
      },
      respond: async (wait: unknown, response: unknown) => {
        await respondToDecision(
          clientInternals(this.#client),
          this.#read,
          shown(),
          wait,
          response
        );
      },
    };
  }

  /**
   * Asks the host for `kind` of run `runId`: resolves once admitted, the
   * control shown applying until a newer snapshot of the run (see the
   * header).
   */
  async #control(kind: PendingControl["kind"], runId: string): Promise<void> {
    const asked: Submitting = { kind, runId, stage: "submitting" };
    // What a newer snapshot has settled no longer counts.
    const kept = this.#local.submitting.filter(
      (each) =>
        each.stage === "submitting" || each.before === this.#shown(each.runId)
    );
    this.#set({ submitting: [...kept, asked] });
    let applying: Submitting | undefined;
    try {
      const receipt = await this.#client.mutation(this.#read.functions[kind], {
        runId,
      });
      const before = this.#shown(runId);
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
  }

  /** What the run query of `runId` shows now, as the hook reads it. */
  #shown(runId: string): unknown {
    return clientInternals(this.#client).entry(this.#read.functions.run, {
      runId,
    }).snapshot.value;
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
