import { errorCategories } from "@grasp-os/shared/error-categories";
import type { Json } from "@grasp-os/shared/json";

import { GraspError } from "./client-error.ts";
import type { ErrorCategory } from "./client-error.ts";
import { fencingCodes, nothingRanCodes } from "./refusals.ts";
import { isPlainObject } from "./value-descriptor.ts";

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
  // A link the App's declaration doesn't allow, or one that isn't one.
  "link.not_allowed": "authorization",
  "link.invalid": "contract",
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

const categories: ReadonlySet<unknown> = new Set(errorCategories);

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
 * What core answered a call (`{ result }`): its value or its
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
 * (a transport's rejection):
 * of its details, only how long to wait before asking again is kept.
 * `internal.unexpected` is the page's word for a request that may or may
 * not have arrived: a lost response.
 */
const readRefusal = (
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
