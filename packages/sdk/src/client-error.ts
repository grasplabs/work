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
  "contract.not_paginated": {
    message:
      "That query doesn't take a pagination argument and answer pages, so it can't be read as a paginated list.",
    category: "contract",
  },
  "query.window_limit": {
    message:
      "This list can't load more: it holds as many records as one live list may. Narrow it with the query's arguments instead.",
    category: "operational",
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
      "Whether this finished is unknown: no answer came back in time. Sending it again with the same idempotency key gets its outcome, and never runs it a second time.",
    category: "uncertain",
  },
  "stream.cancelled": {
    message:
      "You stopped following this action. The platform cancels it once no one follows it; what it already did stays done.",
    category: "operational",
  },
  "stream.outcome_unknown": {
    message:
      "The connection to this action was lost and couldn't be restored, so its outcome is unknown. It wasn't run again: run it again with the same idempotency key to get its outcome.",
    category: "uncertain",
  },
  "contract.mode_mismatch": {
    message:
      "That action streams its progress: run it with useStream or client.stream. Any other action runs with useAction or client.action.",
    category: "contract",
  },
  "stream.active": {
    message:
      "This stream is still running: wait for it to finish, or cancel it, before you run it again.",
    category: "contract",
  },
  "navigation.invalid_screen": {
    message:
      "That isn't one of the App's screens: use one from the App's generated screens.",
    category: "contract",
  },
  "navigation.unavailable": {
    message: "This screen can't navigate: it isn't running in Grasp's shell.",
    category: "contract",
  },
  "stream.unavailable": {
    message: "Streaming actions can't run here.",
    category: "operational",
  },
  "operation.unreachable": {
    message: "The App's server couldn't be reached. Try again.",
    category: "operational",
  },
  "auth.unauthenticated": {
    message: "Sign in to continue.",
    category: "authorization",
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
  "contract.invalid_snapshot": {
    message:
      "The platform sent a run that doesn't fit its workflow's contract, so it isn't shown.",
    category: "contract",
  },
  "contract.mismatch": {
    message:
      "This run belongs to another version of the workflow's contract than this screen was built for.",
    category: "contract",
  },
  "workflow.not_attached": {
    message:
      "No run is shown yet: start one, or wait for the selected run to load, before you control it.",
    category: "contract",
  },
  "workflow.unavailable": {
    message: "Workflow runs can't be followed here.",
    category: "operational",
  },
  "file.operation_undeclared": {
    message:
      "This App doesn't declare that use of these files: add it to the resource's operations.",
    category: "contract",
  },
  "file.upload_active": {
    message:
      "An upload is already running here: wait for it, or cancel it first.",
    category: "contract",
  },
  "file.channel_unavailable": {
    message: "Files can't be moved here.",
    category: "operational",
  },
  "file.cancelled": {
    message: "The upload was cancelled.",
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
 * no token to give yet. `auth.principal_changed` fences: core answers it
 * when the browser's session is someone else's than the screen's (its
 * function route), so nothing held for the person before stays. The
 * client's own refusal under that code is unsent and fenced already, so
 * it never reaches the fence check.
 */
const nonFencingAuthCodes: ReadonlySet<string> = new Set([
  "auth.token_unavailable",
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
  code === "operation.access_changed" ||
  code === "submission.expired";

/** The category of each refusal of core's file channel that isn't operational. */
const fileCategories: Readonly<Record<string, ErrorCategory>> = {
  "file.not_found": "authorization",
  "file.operation_denied": "authorization",
  "file.invalid": "contract",
  "file.too_large": "contract",
  "file.type_unsupported": "contract",
  "file.content_mismatch": "contract",
  "file.referenced": "domain",
  "submission.key_conflict": "contract",
};

/** The category of a refusal the page or core sent before any call ran. */
const refusalCategory = (code: string): ErrorCategory => {
  if (fencingCodes.has(code) || code.startsWith("auth.")) {
    return "authorization";
  }
  const file = Object.hasOwn(fileCategories, code)
    ? fileCategories[code]
    : undefined;
  if (file !== undefined) {
    return file;
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
 * How long a refusal's `details` say to wait before asking again, in
 * milliseconds, if they say.
 */
export const retryAfterOf = (details: unknown): number | undefined => {
  const said = isPlainObject(details) ? details.retryAfterMs : undefined;
  return typeof said === "number" && Number.isFinite(said) ? said : undefined;
};

/**
 * A refusal coded `code`, as the page or core said it before any call ran
 * (a transport's rejection, or core's refusal on a portable host's route):
 * of its details, only how long to wait before asking again is kept.
 * `internal.unexpected` is the page's word for a request that may or may
 * not have arrived: a lost response.
 */
export const readRefusal = (
  code: string,
  message: string,
  details?: unknown
): Settled => {
  if (code === "internal.unexpected") {
    return { kind: "lost" };
  }
  const retryAfterMs = retryAfterOf(details);
  return {
    kind: "failed",
    error: new GraspError({
      code,
      message,
      category: refusalCategory(code),
      retryable: nothingRanCodes.has(code),
      requestId: null,
      ...(retryAfterMs === undefined ? {} : { details: { retryAfterMs } }),
    }),
  };
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
  if (typeof code !== "string") {
    return { kind: "lost" };
  }
  return readRefusal(
    code,
    error instanceof Error ? error.message : "The call was refused.",
    typeof error === "object" && error !== null && "details" in error
      ? error.details
      : undefined
  );
};
