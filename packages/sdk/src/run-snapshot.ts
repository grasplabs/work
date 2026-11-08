import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import { deepFreeze } from "./declaration.ts";
import type { controlKinds } from "./run-wire.ts";
import { checked, descriptors, readErrorPayload } from "./run-wire.ts";
import { isPlainObject } from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";
import type { ReadWorkflow } from "./workflow-reference-read.ts";
import type {
  AppErrorPayload,
  RunHandle,
  WorkflowWait,
} from "./workflow-runs.ts";

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
 * Whether `snapshot`'s fields agree with its status: an end
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

/** A wait as the host names it: its event by alias and fingerprint. */
type WireWait =
  | Exclude<WorkflowWait, { readonly kind: "event" }>
  | (Omit<Extract<WorkflowWait, { readonly kind: "event" }>, "event"> & {
      readonly event: {
        readonly kind: "workflowEvent";
        readonly alias: string;
        readonly fingerprint: string;
      };
    });

/**
 * `waits` with each event wait's event resolved to the reference `read`
 * was generated with, by alias and fingerprint: a run listening for an
 * event its reference doesn't declare, for another contract of it, or in
 * a task that doesn't listen for it, or held for a decision it doesn't
 * declare, is an invalid snapshot, never a wait shown with an event or a
 * response type its key's type doesn't promise.
 */
const resolvedWaits = (
  read: ReadWorkflow,
  waits: readonly WireWait[]
): readonly WorkflowWait[] =>
  waits.map((wait): WorkflowWait => {
    if (wait.kind === "decision" && !read.decisions.has(wait.key)) {
      throw invalidSnapshot();
    }
    if (wait.kind !== "event") {
      return wait;
    }
    const event = read.events.get(wait.event.alias);
    if (
      event === undefined ||
      event.fingerprint !== wait.event.fingerprint ||
      read.listens.get(wait.key)?.has(event.alias) !== true
    ) {
      throw invalidSnapshot();
    }
    return { ...wait, event };
  });

/**
 * A push of run `runId` of `read`, read: its snapshot, frozen, or a
 * structured error thrown (`contract.invalid_snapshot`, or
 * `contract.mismatch` for a run that pins another contract).
 */
export const readSnapshot = (
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
    "output" | "error" | "compensation" | "waits"
  > & { readonly fingerprint: string; readonly waits: readonly WireWait[] };
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
    waits: resolvedWaits(read, snapshot.waits),
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
  return deepFreeze(parsed);
};

/** What the host says of a binding for the person (`watch: "binding"`). */
export interface BindingSnapshot {
  readonly canRun: boolean;
}

export const readBinding = (value: unknown): BindingSnapshot => {
  const read = checked(descriptors.binding, value);
  if (read === undefined) {
    throw invalidSnapshot();
  }
  // SAFETY: checked against `bindingSchema` just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return deepFreeze(read as BindingSnapshot);
};
