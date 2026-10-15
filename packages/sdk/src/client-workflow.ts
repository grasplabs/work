import { canonicalJson } from "@grasp-os/shared/json";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";

import { appErrorDetailsOf } from "./app-error.ts";
import { clientInternals } from "./client-core.ts";
import type {
  GraspClient,
  SubmissionTarget,
  WorkflowLink,
} from "./client-core.ts";
import {
  clientError,
  fences,
  GraspError,
  issueDetails,
  readAnswer,
  readRejection,
} from "./client-error.ts";
import type { AppErrorPayload, RunHandle, WorkflowWait } from "./references.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";
import { readDescriptor } from "./value-read.ts";
import { descriptorOf } from "./value-schema.ts";
import { v } from "./values.ts";

// Workflow runs on a screen (spec 10.4–10.4.7, 10.7.2, 10.7.3): what
// `useWorkflow` (react.ts) shows and does, on the session client's own
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
// - `{ workflow, watch: "run", runId }`: pushes `{ revision, result }`, the
//   result the run's snapshot (`RunSnapshot`) or a refusal, one revision of
//   the run each, status and what the person may do with it together.
// - `{ workflow, watch: "binding" }`: pushes `{ revision, result }`, the
//   result `{ canRun }` for the person and binding in force; `revision`
//   moves on with the binding's policy generation, never back.
//
// A value is shown only if its revision is newer than the subscription's
// last and not older than what is shown. A refusal is heard whatever its
// revision: one that fences (revocation, expiry, a role taken away)
// clears the whole client; a binding's refusal that doesn't fence only
// turns `canRun` off, and never hides a run being shown.
//
// A command's key is the client's, sent again unchanged while its answer
// is lost, so the host answers the same receipt rather than admit it
// twice. The host checks the person, the binding, the contract and the
// run's lifecycle on every request; nothing the client derives here is a
// grant. Failure modes, and how each is closed:
//
// - A render, a remount or a reconnect starts or controls a run: commands
//   are sent only from `run`, `pause`, `resume` and `cancel`, never from a
//   subscription, a render or a lost connection, which only follows again.
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
//   screen, but every capability is off until a fresh push arrives.
// - Data outlives access: a refusal of the person or the build fences the
//   whole client (client-core.ts), which clears every run shown here.
// - A forged or malformed answer delivered: references, snapshots, handles
//   and receipts are read with the native interpreter before anything of
//   them is shown or answered; a run of another contract is refused.
// - A command's failure shown as the run's: it rejects its own promise and
//   is never the view's `error`, which is only a failed run's.
// - Unmounting stops a run: it only stops following; nothing is sent.

/** A workflow reference, read as data and checked. */
export interface ReadWorkflow {
  /** What identifies it: its App, release, contract and fingerprint. */
  readonly key: string;
  readonly resourceId: string;
  readonly contractId: string;
  readonly fingerprint: string;
  readonly input: ValueDescriptor;
  readonly output: ValueDescriptor;
  /** What a request names of it, exactly as the host reads it. */
  readonly wire: {
    readonly resourceId: string;
    readonly resourceVersion: number;
    readonly contractId: string;
    readonly fingerprint: string;
    readonly kind: "workflow";
  };
}

const fingerprintPattern = /^[0-9a-f]{64}$/u;

const readWorkflows = new WeakMap<object, ReadWorkflow>();

/**
 * `value` as a public workflow reference, read as data, its descriptors
 * checked; `contract.invalid_request` for anything else (an operation's
 * reference, an internal one, a string, a forged object).
 */
export const readWorkflowReference = (value: unknown): ReadWorkflow => {
  const known =
    typeof value === "object" && value !== null
      ? readWorkflows.get(value)
      : undefined;
  if (known !== undefined) {
    return known;
  }
  if (
    !isPlainObject(value) ||
    value.kind !== "workflow" ||
    value.visibility !== "public" ||
    typeof value.resourceId !== "string" ||
    typeof value.resourceVersion !== "number" ||
    !Number.isSafeInteger(value.resourceVersion) ||
    typeof value.alias !== "string" ||
    typeof value.contractId !== "string" ||
    typeof value.fingerprint !== "string" ||
    !fingerprintPattern.test(value.fingerprint)
  ) {
    throw clientError("contract.invalid_request");
  }
  let input: ValueDescriptor;
  let output: ValueDescriptor;
  try {
    input = readDescriptor(value.input, 1, { nodes: 0 });
    output = readDescriptor(value.output, 1, { nodes: 0 });
  } catch {
    throw clientError("contract.invalid_request");
  }
  const wire = {
    resourceId: value.resourceId,
    resourceVersion: value.resourceVersion,
    contractId: value.contractId,
    fingerprint: value.fingerprint,
    kind: "workflow",
  } as const;
  const read: ReadWorkflow = {
    key: canonicalJson([
      wire.resourceId,
      wire.resourceVersion,
      wire.contractId,
      wire.fingerprint,
    ]),
    resourceId: wire.resourceId,
    contractId: wire.contractId,
    fingerprint: wire.fingerprint,
    input,
    output,
    wire,
  };
  readWorkflows.set(value, read);
  return read;
};

// What the host sends, as the native interpreter checks it. Bounded where
// the host bounds it, so a list that doesn't fit is refused whole, never
// cut short and shown as if complete.

/** The most waits one snapshot lists. */
export const maxWaits = 256;

const idText = v.string().min(1).max(256);
const plainText = v.string().max(2000);

const runHandleSchema = v.object({
  runId: idText,
  workflowId: idText,
  workflowVersion: v.number().integer().min(1),
  manifestHash: idText,
});

const errorFieldsSchema = v.object({
  code: v.string().min(1).max(256),
  message: plainText,
  category: v.enum([
    "source",
    "contract",
    "domain",
    "authorization",
    "operational",
    "uncertain",
    "safety",
  ]),
  retryable: v.boolean(),
  requestId: idText.nullable(),
});

const waitFields = {
  id: idText,
  taskId: v.string().min(1).max(1024),
  key: v.string().min(1).max(256),
  title: v.string().max(200),
  openedAt: v.timestamp(),
  deadline: v.timestamp().nullable(),
};

const waitSchema = v.union(
  v.object({
    ...waitFields,
    kind: v.literal("timer"),
    purpose: v.enum(["sleep", "retry"]),
    deadline: v.timestamp(),
  }),
  v.object({
    ...waitFields,
    kind: v.literal("event"),
    event: v.object({
      kind: v.literal("workflowEvent"),
      alias: v.string().min(1).max(64),
      fingerprint: v.string().min(64).max(64),
    }),
    canSend: v.boolean(),
  }),
  v.object({
    ...waitFields,
    kind: v.literal("decision"),
    canRespond: v.boolean(),
  }),
  v.object({ ...waitFields, kind: v.literal("child"), child: runHandleSchema }),
  v.object({
    ...waitFields,
    kind: v.literal("blocked"),
    reason: v.enum(["policy", "quota", "uncertain"]),
    message: plainText,
  })
);

const controlKinds = ["pause", "resume", "cancel"] as const;

/** A run's snapshot, without its output and errors (read apart). */
const snapshotSchema = v.object({
  runId: idText,
  workflowId: idText,
  workflowVersion: v.number().integer().min(1),
  manifestHash: idText,
  /** The fingerprint of the contract the run pins. */
  fingerprint: v.string().min(64).max(64),
  status: v.enum([
    "queued",
    "running",
    "waiting",
    "paused",
    "compensating",
    "completed",
    "failed",
    "cancelled",
  ]),
  startedAt: v.timestamp().nullable(),
  finishedAt: v.timestamp().nullable(),
  waits: v.array(waitSchema).max(maxWaits),
  control: v.object({
    canPause: v.boolean(),
    canResume: v.boolean(),
    canCancel: v.boolean(),
    pendingControl: v
      .object({ kind: v.enum(controlKinds), stage: v.literal("applying") })
      .nullable(),
  }),
});

const compensationSchema = v.object({
  cause: v.enum(["failure", "cancellation"]),
  activity: v.enum(["running", "waiting", "paused"]),
});

const bindingSchema = v.object({ canRun: v.boolean() });

const receiptSchema = v.object({
  kind: v.enum(controlKinds),
  state: v.enum(["admitted", "applied", "superseded"]),
  /** The run's revision that admitted it: a later one settles it. */
  revision: v.number().integer().min(1),
});

const descriptors = {
  handle: descriptorOf(runHandleSchema),
  errorFields: descriptorOf(errorFieldsSchema),
  snapshot: descriptorOf(snapshotSchema),
  compensation: descriptorOf(compensationSchema),
  binding: descriptorOf(bindingSchema),
  receipt: descriptorOf(receiptSchema),
};

/** `value`, and everything in it, frozen. */
const frozen = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      frozen(item);
    }
    Object.freeze(value);
  }
  return value;
};

/** `value` checked against `descriptor`: its fresh copy, or undefined. */
const checked = (descriptor: ValueDescriptor, value: unknown): unknown => {
  const result = validateValue(descriptor, value);
  return result.issues === undefined ? result.value : undefined;
};

/** `value` read as a run's sanitized failure, or undefined. */
const readErrorPayload = (value: unknown): AppErrorPayload | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const { details, ...fields } = value;
  const read = checked(descriptors.errorFields, fields);
  const copy = details === undefined ? undefined : appErrorDetailsOf(details);
  if (read === undefined || (details !== undefined && copy === undefined)) {
    return undefined;
  }
  // SAFETY: checked against `errorFieldsSchema` just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const payload = read as Omit<AppErrorPayload, "details">;
  return copy === undefined ? payload : { ...payload, details: copy };
};

/** What a run is, as the host projects it to the person (`watch: "run"`). */
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
  readonly output?: unknown;
  readonly error?: AppErrorPayload;
  readonly waits: readonly WorkflowWait[];
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

const ended: ReadonlySet<RunSnapshot["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Whether a run of `status` has ended. */
export const hasEnded = (status: RunSnapshot["status"]): boolean =>
  ended.has(status);

export const invalidSnapshot = (): GraspError =>
  clientError("contract.invalid_snapshot");

/** The compensation `raw` holds, read, for a run compensating; or none. */
const readCompensation = (raw: unknown): RunSnapshot["compensation"] => {
  if (!isPlainObject(raw)) {
    throw invalidSnapshot();
  }
  const { originalError, ...fields } = raw;
  const read = checked(descriptors.compensation, fields);
  if (read === undefined) {
    throw invalidSnapshot();
  }
  // SAFETY: checked against `compensationSchema` just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const { cause, activity } = read as {
    readonly cause: "failure" | "cancellation";
    readonly activity: "running" | "waiting" | "paused";
  };
  if (cause === "cancellation") {
    if (originalError !== undefined) {
      throw invalidSnapshot();
    }
    return { cause, activity };
  }
  const error = readErrorPayload(originalError);
  if (error === undefined) {
    throw invalidSnapshot();
  }
  return { cause, activity, originalError: error };
};

/**
 * Whether `snapshot`'s fields agree with its status (spec 10.4.1): an end
 * time exactly when it ended; output exactly when completed, an error
 * exactly when failed, a compensation exactly while compensating; no
 * outstanding wait while queued or once ended; and a completed run that
 * ran.
 */
const agrees = (snapshot: RunSnapshot): boolean => {
  const { status } = snapshot;
  const over = hasEnded(status);
  return (
    over === (snapshot.finishedAt !== null) &&
    (status === "completed") === "output" in snapshot &&
    (status === "failed") === (snapshot.error !== undefined) &&
    (status === "compensating") === (snapshot.compensation !== undefined) &&
    ((status !== "queued" && !over) || snapshot.waits.length === 0) &&
    (status !== "completed" || snapshot.startedAt !== null)
  );
};

/**
 * A push of run `runId` of `read`, read: its snapshot, frozen, or a
 * structured error thrown (`contract.invalid_snapshot`, or
 * `contract.mismatch` for a run that pins another contract).
 */
const readSnapshot = (
  read: ReadWorkflow,
  runId: string,
  value: unknown
): RunSnapshot => {
  if (!isPlainObject(value)) {
    throw invalidSnapshot();
  }
  const { output, error, compensation, ...fields } = value;
  const base = checked(descriptors.snapshot, fields);
  if (base === undefined) {
    throw invalidSnapshot();
  }
  // SAFETY: checked against `snapshotSchema` just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const snapshot = base as Omit<
    RunSnapshot,
    "output" | "error" | "compensation"
  > & { readonly fingerprint: string };
  if (snapshot.runId !== runId) {
    throw invalidSnapshot();
  }
  if (snapshot.fingerprint !== read.fingerprint) {
    throw clientError("contract.mismatch");
  }
  const run = {
    runId: snapshot.runId,
    workflowId: snapshot.workflowId,
    workflowVersion: snapshot.workflowVersion,
    manifestHash: snapshot.manifestHash,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    waits: snapshot.waits,
    control: snapshot.control,
  };
  let outputPart: { readonly output?: unknown } = {};
  if ("output" in value) {
    const result = validateValue(read.output, output);
    if (result.issues !== undefined) {
      throw invalidSnapshot();
    }
    outputPart = { output: result.value };
  }
  const failure = error === undefined ? undefined : readErrorPayload(error);
  if (error !== undefined && failure === undefined) {
    throw invalidSnapshot();
  }
  const parsed: RunSnapshot = {
    ...run,
    ...outputPart,
    ...(failure === undefined ? {} : { error: failure }),
    ...(compensation === undefined
      ? {}
      : { compensation: readCompensation(compensation) }),
  };
  if (!agrees(parsed)) {
    throw invalidSnapshot();
  }
  return frozen(parsed);
};

/** What the host says of a binding for the person (`watch: "binding"`). */
export interface BindingSnapshot {
  readonly canRun: boolean;
}

const readBinding = (value: unknown): BindingSnapshot => {
  const read = checked(descriptors.binding, value);
  if (read === undefined) {
    throw invalidSnapshot();
  }
  // SAFETY: checked against `bindingSchema` just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return frozen(read as BindingSnapshot);
};

/** A control's receipt, as the host answers it. */
export interface ControlReceipt {
  readonly kind: (typeof controlKinds)[number];
  readonly state: "admitted" | "applied" | "superseded";
  /**
   * The revision of the run's snapshot that recorded its admission (or,
   * once applied or superseded, its settlement): a snapshot newer than it
   * shows where the control stands.
   */
  readonly revision: number;
}

/** A fresh logical submission key: 128 random bits, in hex. */
const freshKey = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

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
}

const nothingYet: WatchState<never> = Object.freeze({
  value: undefined,
  revision: 0,
  fresh: false,
  error: undefined,
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

/** How long a subscription must last for its losses to count afresh. */
const steadyMs = 30_000;

/** How long to wait before following again after `failures` losses: jittered. */
const followDelay = (failures: number): number =>
  Math.max(250, Math.random() * Math.min(30_000, 1000 * 2 ** failures));

/** How long a refusal said to wait before asking again, if it said. */
const hintOf = (error: GraspError): number => {
  const hinted = isPlainObject(error.details)
    ? error.details.retryAfterMs
    : undefined;
  return typeof hinted === "number" && Number.isFinite(hinted) ? hinted : 0;
};

/**
 * Refusals after which following again would only be refused again: the
 * App moved on, the page follows too many, or the request itself.
 */
const endsFollowing = (code: string): boolean =>
  code.startsWith("version.") ||
  code.startsWith("contract.") ||
  code.startsWith("workflow.") ||
  code === "app.not_running" ||
  code === "screen.too_many_queries" ||
  code === "screen.invalid";

const runKey = (read: ReadWorkflow, runId: string): string =>
  canonicalJson(["run", read.key, runId]);

const bindingKey = (read: ReadWorkflow): string =>
  canonicalJson(["binding", read.key]);

/** What a workflow's commands are scoped by, as a mutation's are. */
const targetOf = (read: ReadWorkflow): SubmissionTarget => ({
  kind: "mutation",
  resourceId: read.resourceId,
  contractId: read.contractId,
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
    return frozen(answer as RunHandle);
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
    return frozen(answer as ControlReceipt);
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
    if (watch === undefined) {
      WorkflowChannel.#show(entry, {
        ...nothingYet,
        error: clientError("workflow.unavailable"),
      });
      live.stopped = true;
      entry.live = undefined;
      return;
    }
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
    // never one older than what is shown.
    if (
      typeof push.revision !== "number" ||
      !Number.isSafeInteger(push.revision) ||
      push.revision < 1 ||
      push.revision <= live.revision ||
      push.revision < entry.state.revision
    ) {
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
    if (endsFollowing(error.code)) {
      WorkflowChannel.#stop(entry);
      WorkflowChannel.#show(entry, { ...nothingYet, error });
      return;
    }
    if (entry.live === live) {
      live.retryAfterMs = hintOf(error);
      // Worth following again (the request budget, say): what is shown
      // stays, its capabilities off until a fresh push.
      WorkflowChannel.#show(entry, { ...entry.state, fresh: false });
    }
  }

  /** Core, or the connection, let go of `live`: follow again, later. */
  #lost(entry: Watched<unknown>, live: Live, atLeastMs = 0): void {
    live.release = undefined;
    const failures =
      Date.now() - live.since >= steadyMs ? 0 : live.failures + 1;
    if (entry.state.fresh) {
      WorkflowChannel.#show(entry, { ...entry.state, fresh: false });
    }
    clearTimeout(live.retry);
    live.retry = setTimeout(
      () => {
        if (WorkflowChannel.#current(entry, live) && entry.listeners.size > 0) {
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
