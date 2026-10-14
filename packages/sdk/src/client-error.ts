import type { Json } from "@grasp-os/shared/json";

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
      "Whether the action finished is unknown, so it wasn't run again. Call it again with the same idempotency key to get its outcome.",
    category: "uncertain",
  },
  "operation.unreachable": {
    message: "The App's server couldn't be reached. Try again.",
    category: "operational",
  },
} as const satisfies Record<
  string,
  { message: string; category: ErrorCategory }
>;

/** A failure the client itself decides on. */
export type ClientErrorCode = keyof typeof clientErrors;

/** The client's own failure `code`, with its `details`. */
export const clientError = (
  code: ClientErrorCode,
  details?: Json
): GraspError =>
  new GraspError({
    code,
    ...clientErrors[code],
    retryable: code === "operation.unreachable",
    requestId: null,
    ...(details === undefined ? {} : { details }),
  });

/**
 * Refusals that mean the person, or the build they run, no longer gets
 * the App's data: the client clears every cached result on one.
 */
export const fencingCodes: ReadonlySet<string> = new Set([
  "auth.unauthenticated",
  "role.forbidden",
  "app.not_found",
  "app.unreadable",
  "screen.unreviewed",
  "screen.revoked",
]);

/**
 * Host failures that changed nothing and may be sent again unchanged:
 * the host ran nothing, or committed nothing (spec 32.1).
 */
export const nothingRanCodes: ReadonlySet<string> = new Set([
  "screen.rate_limited",
  "operation.sandbox_busy",
  "operation.sandbox_unavailable",
  "mutation.concurrent_change",
  "query.concurrent_change",
  "submission.superseded",
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
  return {
    kind: "failed",
    error: new GraspError({
      code,
      message: error instanceof Error ? error.message : "The call was refused.",
      category: refusalCategory(code),
      retryable: nothingRanCodes.has(code),
      requestId: null,
    }),
  };
};
