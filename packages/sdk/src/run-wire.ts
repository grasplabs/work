import { appErrorDetailsOf } from "./app-error.ts";
import { descriptorOf } from "./sealed-descriptors.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";
import { v } from "./values.ts";
import { workflowReferenceLimits } from "./workflow-references.ts";
import type { AppErrorPayload } from "./workflow-runs.ts";

// What the host sends, as the native interpreter checks it. Bounded where
// the host bounds it, so a list that doesn't fit is refused whole, never
// cut short and shown as if complete.

/** The most waits one snapshot lists. */
export const maxWaits = 256;

/** The longest ID the host gives a run or a wait. */
export const maxWaitIdLength = 256;

const idText = v.string().min(1).max(maxWaitIdLength);
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
  // A decision's alias, a task's path or `$run`: as long as a task path.
  key: v.string().min(1).max(workflowReferenceLimits.taskPathLength),
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
  v.object({
    ...waitFields,
    kind: v.literal("blocked"),
    reason: v.enum(["policy", "quota", "uncertain"]),
    message: plainText,
  })
);

export const controlKinds = ["pause", "resume", "cancel"] as const;

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

/** A send's answer: the ID the host minted for its event. */
const sentSchema = v.object({ eventId: idText });

export const descriptors = {
  handle: descriptorOf(runHandleSchema),
  sent: descriptorOf(sentSchema),
  errorFields: descriptorOf(errorFieldsSchema),
  snapshot: descriptorOf(snapshotSchema),
  compensation: descriptorOf(compensationSchema),
  binding: descriptorOf(bindingSchema),
  receipt: descriptorOf(receiptSchema),
};

/** `value` checked against `descriptor`: its fresh copy, or undefined. */
export const checked = (
  descriptor: ValueDescriptor,
  value: unknown
): unknown => {
  const result = validateValue(descriptor, value);
  return result.issues === undefined ? result.value : undefined;
};

/** `value` read as a run's sanitized failure, or undefined. */
export const readErrorPayload = (
  value: unknown
): AppErrorPayload | undefined => {
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
