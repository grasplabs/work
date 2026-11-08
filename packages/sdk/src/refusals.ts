import { GraspError } from "./client-error.ts";
import type { ErrorCategory } from "./client-error.ts";

/**
 * Refusals, besides sign-in's (`fences`), that mean the person or the
 * build they run no longer gets the App's data.
 */
export const fencingCodes: ReadonlySet<string> = new Set([
  "role.forbidden",
  "app.not_found",
  "app.unreadable",
  "page.unreviewed",
  "page.revoked",
  "version.revoked",
  "permission.person_inactive",
  "app.not_running",
]);

/**
 * Whether a refusal means the person, or the build they run, no longer
 * gets the App's data: the client clears every cached result on one.
 * Every sign-in refusal does (`auth.*`): `auth.principal_changed` among
 * them, which core answers when the browser's session is someone else's
 * than the page's (its function route), so nothing held for the person
 * before stays.
 */
export const fences = (code: string): boolean =>
  fencingCodes.has(code) || code.startsWith("auth.");

/**
 * Host failures of a query or a mutation that changed nothing and may be
 * sent again unchanged: the host ran nothing, or committed nothing (spec
 * 32.1); a mutation commits all of itself or nothing. An action commits
 * what it runs step by step, so of these only a refusal before it reached
 * the App (`refusedBeforeCallCodes`) means it ran nothing.
 */
export const nothingRanCodes: ReadonlySet<string> = new Set([
  "page.rate_limited",
  "function.sandbox_busy",
  "function.sandbox_unavailable",
  "mutation.concurrent_change",
  "query.concurrent_change",
  "submission.superseded",
]);

/**
 * Categories of the host's answers that prove a call ran and failed: the
 * App's own failures and the data's (`domain`: `data.conflict` and the
 * like), and its code going past what it may (`source`). Never one that
 * may have been answered before or without running it: a refusal of the
 * person, the request, the key (`submission.key_conflict`, answered while
 * the first call's receipt has no outcome yet; `submission.expired`), the
 * sandbox or the time it took (`contract`, `operational`, `authorization`),
 * nor an outcome unknown.
 */
const ranAndFailedCategories: ReadonlySet<ErrorCategory> = new Set([
  "domain",
  "source",
]);

/**
 * Whether `failure`, what a call of a submission came to, makes the
 * outcome of a key left unknown known: the host's own answer (it carries
 * a request ID) that the call ran and failed (`ranAndFailedCategories`).
 * Anything else leaves it as unknown as it was, erring safe. The session
 * client forgets whose such a key is, and a form gives up the submission
 * it keeps, only on this, so neither ever sends it again for someone else.
 */
export const settlesSubmission = (failure: GraspError): boolean =>
  failure.requestId !== null &&
  ranAndFailedCategories.has(failure.category) &&
  !nothingRanCodes.has(failure.code) &&
  // A refusal that fences (the build revoked, the App stopped) says the
  // access went, not what became of the call: whoever comes next never
  // gets the key.
  !fences(failure.code);

/** Refusals sent before a call reached the App's code: nothing of it ran. */
export const refusedBeforeCallCodes: ReadonlySet<string> = new Set([
  "page.rate_limited",
]);

/**
 * The refusal of the person or the build that `error` is, or carries: its
 * own code, or the code an outcome withheld for it names
 * (`details.refusal`, as core sends an action's answer it withheld after
 * the run). The client fences on it either way. Only that wrapper's
 * `details.refusal` counts: an App's own error may carry any details.
 */
export const fencingRefusalOf = (error: GraspError): GraspError | undefined => {
  if (fences(error.code)) {
    return error;
  }
  if (error.code !== "submission.outcome_unknown") {
    return undefined;
  }
  const { details } = error;
  const refusal: unknown =
    typeof details === "object" && details !== null
      ? Reflect.get(details, "refusal")
      : undefined;
  if (typeof refusal !== "string" || !fences(refusal)) {
    return undefined;
  }
  return new GraspError({
    code: refusal,
    message: "You no longer have access to this App's data.",
    category: "authorization",
    retryable: false,
    requestId: error.requestId,
  });
};

/**
 * Refusals that withhold an outcome rather than tell it: the person or
 * the build lost access, the access changed, or the receipt expired.
 * After a lost answer, one of these leaves what the call did unknown.
 */
export const hidesOutcome = (code: string): boolean =>
  fences(code) ||
  code === "function.access_changed" ||
  code === "submission.expired";
