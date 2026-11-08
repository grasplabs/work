import { functionRequestMaxBytes } from "@grasp-os/shared/function-limits";
import { canonicalJson } from "@grasp-os/shared/json";

import { readAnswer, readRejection } from "./call-answers.ts";
import { clientInternals } from "./client-core.ts";
import type { GraspClient } from "./client-core.ts";
import {
  clientError,
  GraspError,
  issueDetails,
  withReceiptLink,
} from "./client-error.ts";
import type { WorkflowLink } from "./client-internals.ts";
import type { ReadReference } from "./client-request.ts";
import {
  endsFollowing,
  followDelay,
  freshKey,
  steadyMs,
} from "./client-shared.ts";
import type { DecisionTransport } from "./client-transport.ts";
import { deepFreeze } from "./declaration.ts";
import { fences } from "./refusals.ts";
import { invalidSnapshot, readBinding, readSnapshot } from "./run-snapshot.ts";
import type { BindingSnapshot, RunSnapshot } from "./run-snapshot.ts";
import type { controlKinds } from "./run-wire.ts";
import { checked, descriptors, maxWaitIdLength } from "./run-wire.ts";
import { isPlainObject } from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";
import type { WorkflowEventReference } from "./workflow-events.ts";
import type { ReadWorkflow } from "./workflow-reference-read.ts";
import type { RunHandle } from "./workflow-runs.ts";

// Workflow runs on a page: what
// `useWorkflow` (react/workflow.ts) shows and does, on the session client's own
// transport. One channel per client follows runs and bindings, shared by
// every hook that shows them; one store per hook keeps that hook's
// selection, its starts and its controls, and derives its view.
//
// What the host serves, as JSON requests over the client's transport
// (`call` for commands, `watch` for subscriptions), each naming the
// workflow by its reference (`wire` below: the App, its release, the
// contract ID and fingerprint, and kind "workflow"):
//
// - `{ workflow, command: "start", input, idempotencyKey }`: starts a run
//   through the App's binding; answers its `RunHandle` once admitted.
// - `{ workflow, command: "pause" | "resume" | "cancel", runId,
//   idempotencyKey }`: controls the run; answers its receipt, `{ kind,
//   state: "admitted" | "applied" | "superseded", revision }`, once
//   admitted, `revision` the run snapshot's that recorded it.
// - `{ workflow, command: "send", runId, event: { alias, type, fingerprint },
//   data, idempotencyKey }`: sends the run the event of that reference;
//   answers `{ eventId }` once its inbox committed it. Nothing of its
//   envelope but the reference and the data is the client's to say.
// - `{ workflow, watch: "run", runId }`: pushes `{ revision, result }`, the
//   result the run's snapshot (`RunSnapshot`) or a refusal, one revision of
//   the run each, status and what the person may do with it together.
// - `{ workflow, watch: "binding" }`: pushes `{ revision, result }`, the
//   result `{ canRun }` for the person and binding in force; `revision`
//   moves on with the binding's policy generation, never back.
//
// A value is shown only if its revision is newer than the subscription's
// last (or the same, while a refusal that keeps following holds what is
// shown stale) and not older than what is shown. A refusal is heard
// whatever its revision: one that fences (revocation, expiry, a role
// taken away) clears the whole client; a binding's refusal that doesn't
// fence only turns `canRun` off, and never hides a run being shown.
//
// A command's key is the client's, sent again unchanged while its answer
// is lost, so the host answers the same receipt rather than admit it
// twice. The host checks the person, the binding, the contract and the
// run's lifecycle on every request; nothing the client derives here is a
// grant. Failure modes, and how each is closed:
//
// - A render, a remount or a reconnect starts, controls or sends to a run:
//   commands are sent only from `run`, `pause`, `resume`, `cancel` and
//   `send`, never from a subscription, a render or a lost connection,
//   which only follows again.
// - An event of another workflow, contract or release sent, or one made
//   up: `send` takes only a reference this workflow's own reference holds
//   (its alias, type, fingerprint, workflow and release all equal), and
//   data its descriptor takes; the host checks both again.
// - One run followed once per hook: a run is followed once per client and
//   reference, however many hooks show it, each keeping its own selection.
// - A late answer shows on another run: each hook's selection has a
//   generation, moved on whenever what it shows changes; a control
//   captures the run and generation it was asked for, and an older start
//   never replaces the run of a newer admitted one.
// - Capability mixed across revisions: a run's status and what may be done
//   with it arrive in one snapshot, shown whole or not at all; a push older
//   than the one shown is dropped.
// - Stale permission after a lost connection: the last snapshot stays on
//   page, but every capability is off until a fresh push arrives.
// - Data outlives access: a refusal of the person or the build fences the
//   whole client (client-core.ts), which clears every run shown here. A
//   run refused as unavailable for now (its alias bound elsewhere, say)
//   is cleared the same way, only the refusal shown; following goes on,
//   and the run shows again only once the host pushes it again.
// - A forged or malformed answer delivered: references, snapshots, handles
//   and receipts are read with the native interpreter before anything of
//   them is shown or answered; a run of another contract is refused.
// - A command's failure shown as the run's: it rejects its own promise and
//   is never the view's `error`, which is only a failed run's.
// - Unmounting stops a run: it only stops following; nothing is sent.

/** A control's receipt, as the host answers it. */
interface ControlReceipt {
  readonly kind: (typeof controlKinds)[number];
  readonly state: "admitted" | "applied" | "superseded";
  /**
   * The revision of the run's snapshot that recorded its admission (or,
   * once applied or superseded, its settlement): a snapshot newer than it
   * shows where the control stands.
   */
  readonly revision: number;
}

/** `request` as JSON text, or `contract.input_too_large` before it is sent. */
const requestText = (request: unknown): string => {
  const text = JSON.stringify(request);
  if (new TextEncoder().encode(text).byteLength > functionRequestMaxBytes) {
    throw clientError("contract.input_too_large", {
      maxBytes: functionRequestMaxBytes,
    });
  }
  return text;
};

/** What a followed run or binding shows now: one immutable state. */
export interface WatchState<Value> {
  readonly value: Value | undefined;
  /** The revision of the push shown, 0 before the first. */
  readonly revision: number;
  /**
   * Whether the value came from the subscription in force: false before
   * the first push and from a lost connection until the next one.
   */
  readonly fresh: boolean;
  readonly error: GraspError | undefined;
  /**
   * Whether access to the run was lost after it was shown: nothing of it
   * stays shown, and that is no error (a decision that asked the person
   * was answered, say). Only a run never shown is refused as an error.
   */
  readonly unavailable: boolean;
}

const nothingYet: WatchState<never> = Object.freeze({
  value: undefined,
  revision: 0,
  fresh: false,
  error: undefined,
  unavailable: false,
});

/** One subscription to the host, while something follows it. */
interface Live {
  /** How long a refusal pushed over it said to wait before following again. */
  retryAfterMs: number;
  release: (() => void) | undefined;
  /** The revision of this subscription's latest push. */
  revision: number;
  failures: number;
  readonly since: number;
  retry: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
}

/** A run or binding the channel follows for whoever shows it. */
export interface Watched<Value> {
  readonly key: string;
  readonly request: string;
  readonly read: (value: unknown) => Value;
  state: WatchState<Value>;
  readonly listeners: Set<() => void>;
  live: Live | undefined;
}

/** How long a refusal said to wait before asking again, if it said. */
const hintOf = (error: GraspError): number => {
  const hinted = isPlainObject(error.details)
    ? error.details.retryAfterMs
    : undefined;
  return typeof hinted === "number" && Number.isFinite(hinted) ? hinted : 0;
};

/**
 * A run refused as one the person may not see: one that doesn't exist
 * reads the same, so nobody learns which runs there are. Access can come
 * back (its alias bound back, a grant given again), and the host pushes
 * the run again when it does, so following goes on, nothing of the run
 * shown meanwhile; a run that is gone ends by its own terminal status,
 * never by this.
 */
const unavailableRun = "workflow.run_unavailable";

/**
 * Refusals after which following a run again would only be refused again:
 * a query's (`endsFollowing`), and the workflow's own but `unavailableRun`.
 */
const endsFollowingRun = (code: string): boolean =>
  endsFollowing(code) ||
  (code.startsWith("workflow.") && code !== unavailableRun);

const runKey = (read: ReadWorkflow, runId: string): string =>
  canonicalJson(["run", read.key, runId]);

const bindingKey = (read: ReadWorkflow): string =>
  canonicalJson(["binding", read.key]);

/**
 * The event reference of `read` that `event` is: one `read` holds, under
 * its alias, equal in everything that identifies it;
 * `contract.invalid_request` for any other (another workflow's, a stale
 * release's, one made up).
 */
const eventOf = (
  read: ReadWorkflow,
  event: unknown
): WorkflowEventReference => {
  const known =
    isPlainObject(event) && typeof event.alias === "string"
      ? read.events.get(event.alias)
      : undefined;
  if (
    known === undefined ||
    !isPlainObject(event) ||
    event.kind !== known.kind ||
    event.resourceId !== known.resourceId ||
    event.resourceVersion !== known.resourceVersion ||
    event.workflow !== known.workflow ||
    event.workflowFingerprint !== known.workflowFingerprint ||
    event.type !== known.type ||
    event.fingerprint !== known.fingerprint
  ) {
    throw clientError("contract.invalid_request");
  }
  return known;
};

/** What a workflow's commands are scoped by, as a mutation's are. */
const targetOf = (read: ReadWorkflow): ReadReference => ({
  kind: "mutation",
  name: read.contractId,
});

/**
 * The client's workflow runs and bindings, followed once each however
 * many hooks show them (see the header).
 */
export class WorkflowChannel {
  readonly #link: WorkflowLink;
  readonly #watched = new Map<string, Watched<unknown>>();

  constructor(link: WorkflowLink) {
    this.#link = link;
    link.onFence((refusal) => {
      this.#fenced(refusal);
    });
  }

  /** The run `runId` of `read`, as followed now, if anything follows it. */
  peekRun(read: ReadWorkflow, runId: string): WatchState<RunSnapshot> {
    // SAFETY: entries are keyed by what they read: a run's key, a run.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return (this.#watched.get(runKey(read, runId))?.state ??
      nothingYet) as WatchState<RunSnapshot>;
  }

  /** What `read`'s binding says, as followed now. */
  peekBinding(read: ReadWorkflow): WatchState<BindingSnapshot> {
    // SAFETY: as in `peekRun`, for a binding's key.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return (this.#watched.get(bindingKey(read))?.state ??
      nothingYet) as WatchState<BindingSnapshot>;
  }

  /** Follows run `runId` of `read` while `onChange` wants it. */
  followRun(read: ReadWorkflow, runId: string, onChange: () => void) {
    return this.#follow(
      runKey(read, runId),
      { workflow: read.wire, watch: "run", runId },
      (value) => readSnapshot(read, runId, value),
      onChange
    );
  }

  /** Follows `read`'s binding while `onChange` wants it. */
  followBinding(read: ReadWorkflow, onChange: () => void) {
    return this.#follow(
      bindingKey(read),
      { workflow: read.wire, watch: "binding" },
      readBinding,
      onChange
    );
  }

  /**
   * Starts a run of `read` with `input`: resolves with its handle once the
   * host admitted it durably; a lost answer is recovered under the same key.
   */
  async start(read: ReadWorkflow, input: unknown): Promise<RunHandle> {
    const accepted = validateValue(read.input, input);
    if (accepted.issues !== undefined) {
      throw clientError("contract.invalid_args", {
        issues: issueDetails(accepted.issues),
      });
    }
    const key = freshKey();
    const answer = await this.#link.command(
      targetOf(read),
      requestText({
        workflow: read.wire,
        command: "start",
        input: accepted.value,
        idempotencyKey: key,
      }),
      key,
      {
        onRecovering: () => {
          // A start shows only that it is under way (`isStarting`).
        },
        read: (value) => checked(descriptors.handle, value),
      }
    );
    // SAFETY: the command resolves only with an answer `read` checked
    // against `runHandleSchema`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return deepFreeze(answer as RunHandle);
  }

  /**
   * Asks the host for `kind` of run `runId`: resolves with its receipt
   * once admitted; `onRecovering` is told while a lost answer is recovered.
   */
  async control(
    read: ReadWorkflow,
    runId: string,
    kind: ControlReceipt["kind"],
    onRecovering: () => void
  ): Promise<ControlReceipt> {
    const key = freshKey();
    const answer = await this.#link.command(
      targetOf(read),
      requestText({
        workflow: read.wire,
        command: kind,
        runId,
        idempotencyKey: key,
      }),
      key,
      {
        onRecovering,
        read: (value) => {
          // SAFETY: checked against `receiptSchema` as it is read.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          const receipt = checked(descriptors.receipt, value) as
            | ControlReceipt
            | undefined;
          return receipt?.kind === kind ? receipt : undefined;
        },
      }
    );
    // SAFETY: the command resolves only with a receipt `read` accepted.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return deepFreeze(answer as ControlReceipt);
  }

  /**
   * Sends run `runId` of `read` the event `event` refers to, with `data`:
   * resolves once the host committed it to the run's inbox (never when the
   * run takes it); a lost answer is recovered under the same key, so one
   * call is one event however often it is sent.
   */
  async send(
    read: ReadWorkflow,
    runId: string,
    event: unknown,
    data: unknown
  ): Promise<void> {
    const known = eventOf(read, event);
    const accepted = validateValue(known.data, data);
    if (accepted.issues !== undefined) {
      throw clientError("contract.invalid_args", {
        issues: issueDetails(accepted.issues),
      });
    }
    const key = freshKey();
    await this.#link.command(
      targetOf(read),
      requestText({
        workflow: read.wire,
        command: "send",
        runId,
        event: {
          alias: known.alias,
          type: known.type,
          fingerprint: known.fingerprint,
        },
        data: accepted.value,
        idempotencyKey: key,
      }),
      key,
      {
        onRecovering: () => {
          // A send shows nothing while under way: its promise is its state.
        },
        read: (value) => checked(descriptors.sent, value),
      }
    );
  }

  /**
   * Answers the decision `wait` holds run `runId` at, with `response`:
   * through the trusted host (`WorkflowLink.decisions`), which has the
   * person confirm the answer in its own UI before it records it. `wait`
   * must be a decision wait of this very workflow's (its key one of the
   * reference's decisions), and `response.value` what that decision's
   * value schema takes. Never sent again on its own: an answer whose
   * outcome is lost is `decision.outcome_unknown`, and the same answer
   * given again is the recorded one, never a second.
   */
  async respond(
    read: ReadWorkflow,
    runId: string,
    wait: unknown,
    response: unknown
  ): Promise<void> {
    const decision =
      isPlainObject(wait) &&
      wait.kind === "decision" &&
      typeof wait.key === "string"
        ? read.decisions.get(wait.key)
        : undefined;
    if (
      decision === undefined ||
      !isPlainObject(wait) ||
      typeof wait.id !== "string" ||
      wait.id.length === 0 ||
      wait.id.length > maxWaitIdLength
    ) {
      throw clientError("contract.invalid_request");
    }
    if (!isPlainObject(response) || typeof response.approved !== "boolean") {
      throw clientError("contract.invalid_args");
    }
    const accepted = validateValue(
      decision.valueSchema.descriptor,
      response.value
    );
    if (accepted.issues !== undefined) {
      throw clientError("contract.invalid_args", {
        issues: issueDetails(accepted.issues),
      });
    }
    const { decisions } = this.#link;
    if (decisions === undefined) {
      throw clientError("decision.unavailable");
    }
    await this.#answer(decisions, runId, wait.id, {
      approved: response.approved,
      payload: accepted.value,
    });
  }

  /**
   * Sends `answer` to decision `decision` of run `runId` through the
   * trusted host: an outcome lost on the way is `decision.outcome_unknown`,
   * carrying a link that sends this very answer again (`withReceiptLink`),
   * so a form asked again never makes a fresh one.
   */
  async #answer(
    decisions: DecisionTransport,
    runId: string,
    decision: string,
    answer: { readonly approved: boolean; readonly payload: unknown }
  ): Promise<void> {
    // A refusal fences only if no fence came since this answer was sent.
    const startedUnder = this.#link.generation();
    try {
      await decisions.respond(runId, decision, answer);
    } catch (error) {
      const settled = readRejection(error);
      if (settled.kind !== "failed") {
        throw withReceiptLink(
          clientError("decision.outcome_unknown"),
          async () => {
            await this.#answer(decisions, runId, decision, answer);
          }
        );
      }
      if (fences(settled.error.code)) {
        this.#link.fence(settled.error, startedUnder);
      }
      throw settled.error;
    }
  }

  #follow(
    key: string,
    request: unknown,
    read: (value: unknown) => unknown,
    onChange: () => void
  ): () => void {
    let watched = this.#watched.get(key);
    if (watched === undefined) {
      watched = {
        key,
        request: requestText(request),
        read,
        state: nothingYet,
        listeners: new Set(),
        live: undefined,
      };
      this.#watched.set(key, watched);
    }
    const entry = watched;
    entry.listeners.add(onChange);
    if (entry.live === undefined && entry.state.error === undefined) {
      this.#subscribe(entry, 0);
    }
    return () => {
      entry.listeners.delete(onChange);
      // Let go of once the task that released it ends without another
      // follower: React resubscribes within one commit (Strict Mode, a
      // changed selection), which keeps the subscription.
      queueMicrotask(() => {
        if (entry.listeners.size === 0) {
          WorkflowChannel.#stop(entry);
          if (this.#watched.get(key) === entry) {
            this.#watched.delete(key);
          }
        }
      });
    };
  }

  #subscribe(entry: Watched<unknown>, failures: number): void {
    const live: Live = {
      release: undefined,
      retryAfterMs: 0,
      revision: 0,
      failures,
      since: Date.now(),
      retry: undefined,
      stopped: false,
    };
    entry.live = live;
    void this.#connect(entry, live);
  }

  static #current(entry: Watched<unknown>, live: Live): boolean {
    return entry.live === live && !live.stopped;
  }

  async #connect(entry: Watched<unknown>, live: Live): Promise<void> {
    const { watch } = this.#link;
    let handle: { release: () => void };
    try {
      handle = await watch(
        entry.request,
        (push) => {
          if (WorkflowChannel.#current(entry, live)) {
            this.#pushed(entry, live, push);
          }
        },
        () => {
          if (WorkflowChannel.#current(entry, live)) {
            this.#lost(entry, live);
          }
        }
      );
    } catch (error) {
      if (!WorkflowChannel.#current(entry, live)) {
        return;
      }
      const settled = readRejection(error);
      if (settled.kind === "failed") {
        this.#refused(entry, live, settled.error);
        if (live.stopped) {
          return;
        }
      }
      // A refusal for the request budget says how long to wait: never
      // less than that, whatever the backoff would allow.
      this.#lost(
        entry,
        live,
        settled.kind === "failed" ? hintOf(settled.error) : 0
      );
      return;
    }
    if (WorkflowChannel.#current(entry, live)) {
      live.release = handle.release;
    } else {
      handle.release();
    }
  }

  /** Shows a push of `live`'s, unless older than what is shown. */
  #pushed(entry: Watched<unknown>, live: Live, push: unknown): void {
    if (!isPlainObject(push)) {
      return;
    }
    const settled = readAnswer({ result: push.result });
    if (settled.kind === "lost") {
      return;
    }
    // A refusal is of the access or the request, not a snapshot: it is
    // heard whatever revision it carries (one already sent, an older one
    // or none), so a revocation always fences.
    if (settled.kind === "failed") {
      this.#refused(entry, live, settled.error);
      return;
    }
    // Each value is one revision of the run or binding: within this
    // subscription only a newer one, and from an earlier subscription
    // never one older than what is shown. The one exception is the same
    // revision again while what is shown isn't fresh: a refusal that
    // keeps following (the request budget, say) turns its capabilities
    // off without moving the revision, and the host sends the snapshot
    // of that revision again once the refusal clears. A revision is one
    // snapshot, so nothing older or mixed can show this way.
    if (
      typeof push.revision !== "number" ||
      !Number.isSafeInteger(push.revision) ||
      push.revision < 1 ||
      push.revision < entry.state.revision
    ) {
      return;
    }
    const recovered = push.revision === live.revision && !entry.state.fresh;
    if (push.revision <= live.revision && !recovered) {
      return;
    }
    live.revision = push.revision;
    try {
      const value = entry.read(settled.value);
      WorkflowChannel.#show(entry, {
        value,
        revision: push.revision,
        fresh: true,
        error: undefined,
        unavailable: false,
      });
    } catch (error) {
      // Never delivered: what the host sent doesn't fit, and nothing of it
      // is shown in place of what came before.
      WorkflowChannel.#stop(entry);
      WorkflowChannel.#show(entry, {
        ...nothingYet,
        error: error instanceof GraspError ? error : invalidSnapshot(),
      });
    }
  }

  /** A refusal of `live`'s: a fence clears everything, else it is shown. */
  #refused(entry: Watched<unknown>, live: Live, error: GraspError): void {
    if (fences(error.code)) {
      this.#link.fence(error);
      return;
    }
    if (endsFollowingRun(error.code)) {
      WorkflowChannel.#stop(entry);
      WorkflowChannel.#show(entry, { ...nothingYet, error });
      return;
    }
    if (entry.live === live) {
      live.retryAfterMs = hintOf(error);
      if (error.code === unavailableRun) {
        // Access to the run is gone, for now: nothing of it stays shown.
        // Lost after it was shown, that is no error but a state of its
        // own (`unavailable`); never shown, it is refused, only why.
        // Following goes on, and the host's next push of it shows it
        // again, fresh. The revision shown is kept, so no older snapshot
        // shows after it.
        const attached =
          entry.state.value !== undefined || entry.state.unavailable;
        WorkflowChannel.#show(entry, {
          ...nothingYet,
          revision: entry.state.revision,
          ...(attached ? { unavailable: true } : { error }),
        });
        return;
      }
      // Worth following again (the request budget, say): what is shown
      // stays, its capabilities off until a fresh push.
      WorkflowChannel.#show(entry, { ...entry.state, fresh: false });
    }
  }

  /** Core, or the connection, let go of `live`: follow again, later. */
  #lost(entry: Watched<unknown>, live: Live, atLeastMs = 0): void {
    // Over: a push it still delivers late is heard no more, so nothing it
    // sent before it was lost shows as fresh, or as a recovery, again.
    live.stopped = true;
    live.release = undefined;
    const failures =
      Date.now() - live.since >= steadyMs ? 0 : live.failures + 1;
    if (entry.state.fresh) {
      WorkflowChannel.#show(entry, { ...entry.state, fresh: false });
    }
    clearTimeout(live.retry);
    live.retry = setTimeout(
      () => {
        if (entry.live === live && entry.listeners.size > 0) {
          this.#subscribe(entry, failures);
        }
      },
      Math.max(
        atLeastMs,
        live.retryAfterMs,
        followDelay(Math.max(0, failures - 1))
      )
    );
  }

  static #stop(entry: Watched<unknown>): void {
    const { live } = entry;
    entry.live = undefined;
    if (live !== undefined) {
      live.stopped = true;
      clearTimeout(live.retry);
      live.release?.();
      live.release = undefined;
    }
  }

  static #show(entry: Watched<unknown>, state: WatchState<unknown>): void {
    entry.state = state;
    for (const listener of entry.listeners) {
      listener();
    }
  }

  /** The person or build lost access: nothing of any run stays shown. */
  #fenced(refusal: GraspError): void {
    for (const entry of this.#watched.values()) {
      WorkflowChannel.#stop(entry);
      WorkflowChannel.#show(entry, { ...nothingYet, error: refusal });
    }
  }
}

const channels = new WeakMap<GraspClient, WorkflowChannel>();

/** The workflow channel of `client`: one per client, made once. */
export const workflowChannel = (client: GraspClient): WorkflowChannel => {
  let channel = channels.get(client);
  if (channel === undefined) {
    channel = new WorkflowChannel(clientInternals(client).workflowLink);
    channels.set(client, channel);
  }
  return channel;
};
