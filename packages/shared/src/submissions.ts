import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import type { Json } from "./json.ts";

// Submissions: one logical change a caller asks for, such as a mutation
// of a business store, kept as a receipt under the caller's idempotency
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

export const submissionErrors = defineErrorFamily({
  "submission.key_invalid":
    "That isn't a valid idempotency key: 1 to 128 printable ASCII characters.",
  "submission.key_conflict":
    "This idempotency key was already used for a different change. Use a new key for a new change.",
  "submission.expired":
    "This idempotency key's receipt has expired, so whether the change was made can't be told. Check, then use a new key.",
  "submission.superseded":
    "A newer attempt of this change took over, so this one wrote nothing.",
  "submission.deadline_passed":
    "The call ran out of time before its change committed, so nothing was written.",
  "submission.intent_unsupported":
    "Nothing takes this kind of notification yet, so the change wasn't made.",
});

/**
 * What a committed submission can still have to tell others, through its
 * outbox (committed in its batch): a notification for a workflow run, or
 * a workflow run to start. Each is handed over after the commit, never as
 * part of it: no change spans the store and a run. A kind is staged only
 * once something takes it (its consumer). Its content is defined where it
 * is delivered.
 */
export interface SubmissionIntent {
  kind: "workflow.notify" | "workflow.start";
  data: Json;
}
export type SubmissionIntentKind = SubmissionIntent["kind"];
