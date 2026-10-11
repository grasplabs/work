import { defineErrorFamily, isExpectedCode } from "./errors.ts";
import type { Json } from "./json.ts";
import { valueDepth } from "./value-depth.ts";

// What a caller gets back from an App's server function (spec 32.1): a
// value, or a failure as an `AppErrorPayload`, which says what went wrong
// in a stable code, a message people can read, the category the host
// puts it in, whether trying again may help, and the request ID to quote.
// Never more: no cause, stack, SQL, provider error or credential reaches
// a caller, whatever the App's code threw (core's operation host,
// apps/core/src/operations.ts, decides what each failure becomes).

/** Why a failure happened, as the host classifies it. */
export type ErrorCategory =
  | "source"
  | "contract"
  | "domain"
  | "authorization"
  | "operational"
  | "uncertain"
  | "safety";

/** A failed operation, as its caller gets it. */
export interface AppErrorPayload {
  code: string;
  message: string;
  category: ErrorCategory;
  retryable: boolean;
  requestId: string;
  details?: Json;
}

/** What an operation answers, as it crosses to its caller. */
export type OperationResult =
  | { ok: true; value: Json }
  | { ok: false; error: AppErrorPayload };

/** Why the operation host refused or failed a call. */
export const operationErrors = defineErrorFamily({
  "operation.not_found": "There is no such operation.",
  "operation.kind_mismatch":
    "That operation is of another kind than the call expects.",
  "operation.read_only": "A query reads records and can't change them.",
  "operation.no_database":
    "An action has no database: it reads and writes through the App's queries and mutations.",
  "operation.no_resources":
    "Only an action uses resources; queries and mutations never reach outside the App.",
  "operation.ended": "This operation's call has ended.",
  "operation.unsupported":
    "This operation needs a capability this release doesn't run yet.",
  "contract.invalid_args": "The arguments don't fit the operation.",
  "contract.input_too_large":
    "The arguments are larger than an operation accepts.",
  "contract.invalid_return":
    "The operation returned something its contract doesn't allow.",
  "contract.result_too_large":
    "The operation returned more than an operation may return.",
  "contract.invalid_error":
    "The operation failed with an error its contract doesn't allow.",
  "contract.invalid_query":
    "The operation built a query its schema doesn't allow.",
  "contract.invalid_write":
    "The operation staged a change its schema doesn't allow.",
  "mutation.concurrent_change":
    "The records changed while this change was made. Try again.",
});

/** The category of each platform code a caller may get, by code. */
const categories: Readonly<Record<string, ErrorCategory>> = {
  "auth.unauthenticated": "authorization",
  "app.not_found": "authorization",
  "app.unreadable": "authorization",
  "role.forbidden": "authorization",
  "permission.denied": "authorization",
  "data.access_denied": "authorization",
  "data.write_denied": "authorization",
  "data.conflict": "domain",
  "data.not_unique": "domain",
  "data.result_limit": "domain",
  "data.aggregate_overflow": "domain",
  "data.scan_limit": "source",
  "data.index_required": "source",
  "contract.invalid_query": "source",
  "effect.outcome_unknown": "uncertain",
};

/** The platform codes worth trying again, unchanged, a little later. */
const retryableCodes: ReadonlySet<string> = new Set([
  "query.concurrent_change",
  "mutation.concurrent_change",
  "data.reads_changed",
  "submission.superseded",
  "submission.deadline_passed",
]);

/** The category of platform error `code`: its own, or by its family. */
export const categoryOf = (code: string): ErrorCategory => {
  const known = Object.hasOwn(categories, code) ? categories[code] : undefined;
  if (known !== undefined) {
    return known;
  }
  if (
    code.startsWith("contract.") ||
    code.startsWith("operation.") ||
    code === "data.invalid" ||
    code === "data.invalid_query" ||
    code === "data.unknown_table" ||
    code === "data.unknown_index" ||
    code === "data.invalid_cursor" ||
    code === "submission.key_conflict" ||
    code === "submission.key_invalid"
  ) {
    return "contract";
  }
  return "operational";
};

/** Whether platform error `code` is worth trying again unchanged. */
export const isRetryableCode = (code: string): boolean =>
  retryableCodes.has(code);

/** Whether `code` is a platform error's, which App code can't throw as its own. */
export const isPlatformCode = (code: unknown): code is string =>
  isExpectedCode(code);

/**
 * A JSON copy of `value` (null, strings, booleans, finite numbers, dense
 * arrays and plain objects of those, without prototype keys, at most
 * `valueDepth` deep), or undefined when it is anything else: what crosses
 * from App code is only ever read as JSON.
 */
export const jsonOf = (value: unknown, depth = 1): Json | undefined => {
  if (depth > valueDepth) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    const items: Json[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return undefined;
      }
      const item = jsonOf(value[index], depth + 1);
      if (item === undefined) {
        return undefined;
      }
      items.push(item);
    }
    return items;
  }
  const prototype: unknown = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  const copy: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) {
    const item = jsonOf(entry, depth + 1);
    if (item === undefined || key === "__proto__") {
      return undefined;
    }
    Object.defineProperty(copy, key, { enumerable: true, value: item });
  }
  return copy;
};
