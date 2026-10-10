import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import type { Json } from "./json.ts";

// Submissions: one logical change a caller asks for, such as an App's
// record save, kept by core as a receipt under the caller's idempotency
// key. A retry under the same key gets the outcome of the change already
// made, never a second change; the same key with other input is refused.
// A key is the caller's intent not to repeat itself, never a permission:
// its receipt is scoped to who made it, through what and for what, and
// only that caller, still allowed, gets it back.

/**
 * How long a receipt is kept, and so how long a key deduplicates: at
 * least this long, and for as long as a workflow run it belongs to is
 * live. A caller may retry under a key only within it.
 */
export const submissionRetentionDays = 30;

/**
 * How long an expired receipt's tombstone is kept after it, so a key
 * reused that late is refused as expired rather than taken as new.
 */
export const submissionTombstoneDays = 30;

/** A caller's idempotency key: 1 to 128 printable ASCII characters. */
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[ -~]+$/u, "Printable ASCII only");

/** What a caller may pass along with a submission. */
export const submissionOptionsSchema = z
  .strictObject({ idempotencyKey: idempotencyKeySchema.optional() })
  .optional();

export const submissionErrors = defineErrorFamily({
  "submission.key_invalid":
    "That isn't a valid idempotency key: 1 to 128 printable ASCII characters.",
  "submission.key_conflict":
    "This idempotency key was already used for a different change. Use a new key for a new change.",
  "submission.expired":
    "This idempotency key's receipt has expired, so whether the change was made can't be told. Check, then use a new key.",
  "submission.superseded":
    "A newer attempt of this change took over, so this one wrote nothing.",
  "submission.intent_unsupported":
    "Nothing takes this kind of notification yet, so the change wasn't made.",
});

/**
 * What a committed submission can still have to tell others, through its
 * outbox (committed in its batch): that a record changed, which whoever
 * follows the record's collection learns; a notification for a workflow
 * run; a workflow run to start. Each is handed over after the commit,
 * never as part of it: no change spans the store and a run. A kind is
 * staged only once something takes it (its consumer): invalidations with
 * live queries, notifications and starts with their dispatch.
 */
export const submissionIntentKinds = [
  "record.changed",
  "workflow.notify",
  "workflow.start",
] as const;
export type SubmissionIntentKind = (typeof submissionIntentKinds)[number];

/** A record that a submission changed, at the version it made. */
export interface RecordChanged {
  kind: "record.changed";
  collectionId: string;
  documentId: string;
  version: number;
}

/**
 * A workflow notification or start a submission staged: its content is
 * defined where it is delivered.
 */
export interface WorkflowIntent {
  kind: "workflow.notify" | "workflow.start";
  data: Json;
}

export type SubmissionIntent = RecordChanged | WorkflowIntent;
