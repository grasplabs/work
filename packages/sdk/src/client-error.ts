import type { Json } from "@grasp-os/shared/json";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { isPlainObject } from "./value-descriptor.ts";

// The structured error a screen's queries, mutations and actions fail
// with (spec 10.1, 32.1): what core answered, as it answered it, or why
// the session client refused or stopped before it had an answer. Never a
// transport envelope, a cause or a stack.

/** A failure's category, as the host classifies it (spec 32.1). */
export type ErrorCategory =
  | "source"
  | "contract"
  | "domain"
  | "authorization"
  | "operational"
  | "uncertain"
  | "safety";

/** What a structured SDK error carries. */
interface ErrorFields {
  readonly code: string;
  readonly message: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  /** The host's request ID to quote; null for the client's own errors. */
  readonly requestId: string | null;
  readonly details?: Json;
}

/**
 * A query, mutation or action that failed: what the host answered, or
 * why the client refused or stopped. Branch on `code`; `message` is for
 * people.
 */
export class GraspError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: Json | undefined;

  constructor(fields: ErrorFields) {
    super(fields.message);
    this.name = "GraspError";
    this.code = fields.code;
    this.category = fields.category;
    this.retryable = fields.retryable;
    this.requestId = fields.requestId;
    this.details = fields.details;
  }
}

/** The client's own failures, by code: their message and category. */
const clientErrors = {
  "contract.invalid_args": {
    message: "The arguments don't fit the operation.",
    category: "contract",
  },
  "contract.input_too_large": {
    message: "The arguments are larger than an operation accepts.",
    category: "contract",
  },
  "contract.invalid_result": {
    message:
      "The save went through, but answered something other than the record it saved, so the form can't show the record as it is now.",
    category: "contract",
  },
  "contract.invalid_request": {
    message:
      "That isn't a public reference of this kind: use one from the App's generated api.",
    category: "contract",
  },
  "submission.key_invalid": {
    message:
      "That isn't a valid idempotency key: 1 to 128 printable ASCII characters.",
    category: "contract",
  },
  "query.cancelled": {
    message: "You stopped waiting for this query.",
    category: "operational",
  },
  "submission.cancelled": {
    message:
      "You stopped waiting for this change. It may still be saved: the platform keeps checking its outcome, and it won't be submitted twice.",
    category: "operational",
  },
  "submission.outcome_unknown": {
    message:
      "Whether this finished is unknown, so it wasn't sent again. Sending it again with the same idempotency key gets a change's outcome; an action runs again, though steps it already completed aren't repeated.",
    category: "uncertain",
  },
  "operation.unreachable": {
    message: "The App's server couldn't be reached. Try again.",
    category: "operational",
  },
  "auth.principal_changed": {
    message:
      "Someone else signed in, so what was shown for the person before was cleared.",
    category: "authorization",
  },
  "form.failed": {
    message: "This couldn't be submitted.",
    category: "operational",
  },
} as const satisfies Record<
  string,
  { message: string; category: ErrorCategory }
>;

/** A failure the client itself decides on. */
export type ClientErrorCode = keyof typeof clientErrors;

/**
 * The client's own failure `code`, with its `details`; and `message` in
 * place of its own, for a failure whose words are someone else's (a local
 * form's callback).
 */
export const clientError = (
  code: ClientErrorCode,
  details?: Json,
  message?: string
): GraspError =>
  new GraspError({
    code,
    ...clientErrors[code],
    ...(message === undefined ? {} : { message }),
    retryable: code === "operation.unreachable",
    requestId: null,
    ...(details === undefined ? {} : { details }),
  });

/**
 * `issues` as a refusal's details carry them: each one's message, its
 * path as keys and indexes, and its code when it has one.
 */
export const issueDetails = (
  issues: readonly (StandardSchemaV1.Issue & { readonly code?: string })[]
): Json[] =>
  issues.map(({ code, message, path }) => ({
    ...(code === undefined ? {} : { code }),
    message,
    path: (path ?? []).map((segment) => {
      const key = typeof segment === "object" ? segment.key : segment;
      return typeof key === "number" ? key : String(key);
    }),
  }));

/** The issues a refusal's `details` carry (`issueDetails`), as read back. */
export const detailIssues = (
  details: Json | undefined
): StandardSchemaV1.Issue[] => {
  const issues = isPlainObject(details) ? details.issues : undefined;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue) => {
    if (!isPlainObject(issue) || typeof issue.message !== "string") {
      return [];
    }
    const path = Array.isArray(issue.path)
      ? issue.path.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number"
        )
      : [];
    return [{ message: issue.message, path }];
  });
};

/**
 * Sign-in refusals that don't mean the person lost access: the host had
 * no token to give yet, or the client itself refused a call because
 * someone else signed in, which fenced already.
 */
const nonFencingAuthCodes: ReadonlySet<string> = new Set([
  "auth.token_unavailable",
  "auth.principal_changed",
]);

/**
 * Refusals, besides sign-in's (`fences`), that mean the person or the
 * build they run no longer gets the App's data.
 */
const fencingCodes: ReadonlySet<string> = new Set([
  "role.forbidden",
  "app.not_found",
  "app.unreadable",
  "screen.unreviewed",
  "screen.revoked",
  "version.revoked",
  "permission.person_inactive",
  "app.not_running",
]);

/**
 * Whether a refusal means the person, or the build they run, no longer
 * gets the App's data: the client clears every cached result on one.
 * Every sign-in refusal does (`auth.*`), but for `nonFencingAuthCodes`.
 */
export const fences = (code: string): boolean =>
  fencingCodes.has(code) ||
  (code.startsWith("auth.") && !nonFencingAuthCodes.has(code));

/**
 * Host failures of a query or a mutation that changed nothing and may be
 * sent again unchanged: the host ran nothing, or committed nothing (spec
 * 32.1); a mutation commits all of itself or nothing. An action commits
 * what it runs step by step, so of these only a refusal before it reached
 * the App (`refusedBeforeCallCodes`) means it ran nothing.
 */
export const nothingRanCodes: ReadonlySet<string> = new Set([
  "screen.rate_limited",
  "operation.sandbox_busy",
  "operation.sandbox_unavailable",
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
  "screen.rate_limited",
]);

/** The category of a refusal the page or core sent before any call ran. */
const refusalCategory = (code: string): ErrorCategory => {
  if (fencingCodes.has(code) || code.startsWith("auth.")) {
    return "authorization";
  }
  if (code.startsWith("request.") || code.startsWith("contract.")) {
    return "contract";
  }
  return "operational";
};

const categories: ReadonlySet<unknown> = new Set([
  "source",
  "contract",
  "domain",
  "authorization",
  "operational",
  "uncertain",
  "safety",
]);

const isCategory = (value: unknown): value is ErrorCategory =>
  categories.has(value);

/** What one call through the transport settled as. */
export type Settled =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "failed"; readonly error: GraspError }
  | { readonly kind: "lost" };

/** A failure core answered (`AppErrorPayload`), as a `GraspError`. */
const fromPayload = (payload: unknown): GraspError | undefined => {
  if (
    !isPlainObject(payload) ||
    typeof payload.code !== "string" ||
    typeof payload.message !== "string" ||
    !isCategory(payload.category) ||
    typeof payload.retryable !== "boolean" ||
    typeof payload.requestId !== "string"
  ) {
    return undefined;
  }
  const { details } = payload;
  return new GraspError({
    code: payload.code,
    message: payload.message,
    category: payload.category,
    retryable: payload.retryable,
    requestId: payload.requestId,
    // SAFETY: what crossed the transport was JSON text, parsed.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    ...(details === undefined ? {} : { details: details as Json }),
  });
};

/**
 * What core answered a call (`{ result }`, spec 32.6): its value or its
 * failure; anything else is read as a lost response.
 */
export const readAnswer = (answer: unknown): Settled => {
  const result = isPlainObject(answer) ? answer.result : undefined;
  if (!isPlainObject(result)) {
    return { kind: "lost" };
  }
  if (result.ok === true && "value" in result) {
    return { kind: "value", value: result.value };
  }
  const error = result.ok === false ? fromPayload(result.error) : undefined;
  return error === undefined ? { kind: "lost" } : { kind: "failed", error };
};

/**
 * A transport's rejection: a coded refusal of the page or core, or a lost
 * response, when it has no code or `internal.unexpected` (the page's word
 * for a request that may or may not have arrived).
 */
export const readRejection = (error: unknown): Settled => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  if (typeof code !== "string" || code === "internal.unexpected") {
    return { kind: "lost" };
  }
  // Of a refusal's details, only how long to wait before asking again.
  const details =
    typeof error === "object" && error !== null && "details" in error
      ? error.details
      : undefined;
  const retryAfterMs = isPlainObject(details)
    ? details.retryAfterMs
    : undefined;
  return {
    kind: "failed",
    error: new GraspError({
      code,
      message: error instanceof Error ? error.message : "The call was refused.",
      category: refusalCategory(code),
      retryable: nothingRanCodes.has(code),
      requestId: null,
      ...(typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
        ? { details: { retryAfterMs } }
        : {}),
    }),
  };
};
