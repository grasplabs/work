import { canonicalJson } from "@grasp-os/shared/json";

import type { Settled } from "./call-answers.ts";
import { clientError, GraspError } from "./client-error.ts";
import type { ReadReference } from "./client-request.ts";
import {
  hidesOutcome,
  nothingRanCodes,
  refusedBeforeCallCodes,
} from "./refusals.ts";
import { isPlainObject } from "./value-descriptor.ts";

/**
 * How long a submission refused with a nothing-ran code (its budget used
 * up, the sandbox busy) is sent again, waiting as each refusal says.
 */
export const submissionBudgetMs = 15_000;

/**
 * How long a mutation whose answers are lost is sent again under its key;
 * then it rejects as `submission.outcome_unknown`, its key recovering it.
 */
const lostBudgetMs = 5 * 60_000;

/**
 * `error`, an outcome the host can't tell, with the key it was sent
 * under among its details: a caller that let the client pick the key
 * can still recover the outcome by it, and not run the call afresh.
 */
export const withKey = (error: GraspError, key: string): GraspError =>
  new GraspError({
    code: error.code,
    message: error.message,
    category: error.category,
    retryable: error.retryable,
    requestId: error.requestId,
    details: {
      ...(isPlainObject(error.details) ? error.details : {}),
      idempotencyKey: key,
    },
  });

/** Where a submission stands, for the attempt that settled as it did. */
interface SubmissionAttempt {
  readonly isAction: boolean;
  readonly key: string;
  /** When it was first sent. */
  readonly started: number;
  /** Since when its answers are lost, if they are. */
  readonly lostSince: number | undefined;
  readonly now: number;
}

/** What a submission does next: settle, fail, or send again. */
type SubmissionVerdict =
  | { readonly next: "settle"; readonly value: unknown }
  | { readonly next: "fail"; readonly error: GraspError }
  /** `unknown`: whether it committed can't be told, its answer lost. */
  | { readonly next: "retry"; readonly unknown: boolean };

/**
 * Whether `settled` was refused before anything of the submission ran:
 * a mutation commits all of itself or nothing; an action commits step by
 * step, so only a refusal before it reached the App ran nothing of it.
 */
const ranNothing = (settled: Settled, isAction: boolean): boolean =>
  settled.kind === "failed" &&
  (isAction ? refusedBeforeCallCodes : nothingRanCodes).has(settled.error.code);

/**
 * Whether, after `settled`, what the App's queries show may be out of
 * date: a confirmed change; an action's failure after a step, or its lost
 * answer, which undoes none of what it committed (its queries are read
 * again, the action itself is never run again); or a record that is gone since this
 * client read it (`data.conflict`), or preferences someone changed since
 * (`data.preferences_changed`), so a page shows them as they are now.
 */
export const showsStale = (settled: Settled, isAction: boolean): boolean =>
  settled.kind === "value" ||
  (isAction && !ranNothing(settled, isAction)) ||
  (settled.kind === "failed" &&
    (settled.error.code === "data.conflict" ||
      settled.error.code === "data.preferences_changed"));

/**
 * Where a key left unknown is remembered: by function and key, as the
 * host scopes a key's receipt (the client serves one App).
 */
export const uncertainScope = (reference: ReadReference, key: string): string =>
  canonicalJson([reference.name, key]);

/**
 * The code of the refusal `settled` is, if it withholds the outcome of
 * what may have run: one `hidesOutcome` names, after a lost answer
 * (`lost`), or, for an action, `function.access_changed` or
 * `submission.expired`, which come only once something ran under its key
 * (its receipt, or its tombstone once the receipt expired): a form that
 * stays uncertain past the receipt still keeps its key.
 */
const ranUnderKeyCodes: ReadonlySet<string> = new Set([
  "function.access_changed",
  "submission.expired",
]);

/** The code `settled` withholds an outcome with, if it does (see above). */
const withheldCode = (
  settled: Settled,
  lost: boolean,
  isAction: boolean
): string | undefined => {
  if (settled.kind !== "failed" || !hidesOutcome(settled.error.code)) {
    return undefined;
  }
  const { code } = settled.error;
  return lost || (isAction && ranUnderKeyCodes.has(code)) ? code : undefined;
};

/**
 * `answered` with its value read by `read`, when given: one `read` doesn't
 * accept is as good as lost.
 */
export const readSettled = (
  answered: Settled,
  read: ((value: unknown) => unknown) | undefined
): Settled => {
  if (answered.kind !== "value" || read === undefined) {
    return answered;
  }
  const value = read(answered.value);
  return value === undefined ? { kind: "lost" } : { kind: "value", value };
};

/** What a submission does next after `settled` (see `#send`). */
export const submissionVerdict = (
  settled: Settled,
  attempt: SubmissionAttempt
): SubmissionVerdict => {
  const { isAction, key, started, lostSince, now } = attempt;
  const outcomeUnknown = (refusal?: string) =>
    clientError(
      "submission.outcome_unknown",
      refusal === undefined
        ? { idempotencyKey: key }
        : { idempotencyKey: key, refusal }
    );
  if (settled.kind === "value") {
    return { next: "settle", value: settled.value };
  }
  if (
    lostSince !== undefined &&
    settled.kind === "failed" &&
    settled.error.category === "authorization"
  ) {
    // An earlier attempt's answer was lost, and access is gone or someone
    // else signed in: whether it committed is the person's to recover
    // with its key, not a failure, and it is never sent again for someone
    // else.
    return { next: "fail", error: outcomeUnknown() };
  }
  // A refusal that withholds the outcome of what may have run: after a
  // lost answer, or an action's `function.access_changed`, which comes
  // only once something ran under its key. Still unknown, with the key:
  // never a definite failure that invites a resubmit under a fresh one.
  const withheld = withheldCode(settled, lostSince !== undefined, isAction);
  if (withheld !== undefined) {
    return { next: "fail", error: outcomeUnknown(withheld) };
  }
  // An answer lost, or an outcome the host itself can't tell.
  const unknown =
    settled.kind === "lost" || settled.error.category === "uncertain";
  if (unknown && isAction && settled.kind === "failed") {
    // The action's receipt holds what the host can't tell: sending it
    // again answers the same.
    return { next: "fail", error: withKey(settled.error, key) };
  }
  if (unknown) {
    // Sent again under its key, which recovers its receipt (or joins an
    // action still running), for as long as `lostBudgetMs`: never forever.
    return now - (lostSince ?? now) >= lostBudgetMs
      ? { next: "fail", error: outcomeUnknown() }
      : { next: "retry", unknown: true };
  }
  if (!ranNothing(settled, isAction)) {
    return { next: "fail", error: settled.error };
  }
  // A refusal that ran nothing (its budget, a busy sandbox) is sent again
  // for `submissionBudgetMs` from the call's start, or, once an answer was
  // lost, for `lostBudgetMs` from then, past which what the lost answer
  // would have said stays unknown, with its key.
  if (lostSince === undefined) {
    return now - started >= submissionBudgetMs
      ? { next: "fail", error: settled.error }
      : { next: "retry", unknown: false };
  }
  return now - lostSince >= lostBudgetMs
    ? { next: "fail", error: outcomeUnknown(settled.error.code) }
    : { next: "retry", unknown: false };
};
