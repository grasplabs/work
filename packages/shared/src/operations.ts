import { platformErrorNamespaces } from "./error-namespaces.ts";
import {
  defineErrorFamily,
  expectedNamespaces,
  isExpectedCode,
} from "./errors.ts";
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
  "operation.deadline_exceeded":
    "The operation ran past its deadline, and was stopped before it changed anything more.",
  "operation.unfinished_call":
    "The operation left a call it started running past its deadline.",
  "operation.mode_mismatch":
    "That action streams its progress, or doesn't, unlike what the call expects: a streaming action is called through useStream or client.stream, any other through useAction or client.action.",
  "operation.cancelled":
    "The action was cancelled before it finished. What it changed before then stays changed.",
  "operation.outcome_unknown":
    "The action stopped without an answer, so whether it finished is unknown. It wasn't run again.",
  "operation.stream_limit":
    "You're running as many streaming actions in this App as one person may at once. Wait for one to finish, or cancel one.",
  "operation.action_limit":
    "You're running as many actions in this App as one person may at once. Wait for one to finish.",
  "operation.access_changed":
    "Your access to this App changed since this action started, so its outcome isn't shown. Run it again to see it under your access now.",
  "operation.no_stream":
    "Only an action that declares `stream` emits progress.",
  "operation.emit_limit":
    "The action emitted more progress snapshots than one call may.",
  "operation.call_limit":
    "This call made more host calls, ran more nested functions, or made more resource requests than one call may.",
  "operation.depth_exceeded":
    "Functions called each other deeper than one call may go.",
  "operation.cpu_exceeded":
    "The operation used more CPU time than one call may, so it was stopped.",
  "operation.memory_exceeded":
    "The operation used more memory than one call may, so it was stopped.",
  "operation.sandbox_refused":
    "The operation's code sent the host more than one call may.",
  "operation.sandbox_busy":
    "This App runs as many calls at once as it may. Try again shortly.",
  "operation.sandbox_unavailable":
    "The sandbox that runs the App's code isn't available. Try again shortly.",
  "operation.sandbox_lost":
    "The sandbox stopped answering after the call started, so whether it changed anything is unknown.",
  "resource.not_allowed":
    "The App didn't declare that use of this resource for this function.",
  "resource.unavailable":
    "This resource isn't bound to the App, or its binding doesn't serve the contract the App declared.",
  "resource.budget_exhausted":
    "The model budget this request counts against is used up, so it wasn't sent.",
  "resource.budget_busy":
    "Model requests still under way hold what's left of the budget this request counts against, so it wasn't sent. Try again shortly.",
  "resource.queued":
    "Other requests running now fill this share of the model requests that may run at once, so this one wasn't sent yet. Try again after the wait it names.",
  "resource.rate_limited":
    "The model's provider is taking no more requests for now, so this request wasn't answered. Try again after the wait it names.",
  "resource.awaiting_confirmation":
    "This request waits for the person it acts for to confirm it. Make the same call again once they have.",
  "resource.declined":
    "The person this request waited for declined it: it didn't run, and won't under this call's key.",
  "resource.idempotency_conflict":
    "This call's key was already used for a request with other arguments: it wasn't run again.",
  "resource.invalid_args":
    "The arguments don't fit the contract of the resource's action.",
  "resource.item_not_found":
    "The resource has no such item, or none the App may read for this person.",
  "resource.operation_failed":
    "The store's operation refused the request or failed: its details name the store's own code.",
  "resource.busy":
    "The store's operation couldn't run just now. Try again shortly.",
  "contract.invalid_resource_result":
    "A resource answered something its contract doesn't allow.",
  "contract.invalid_args": "The arguments don't fit the operation.",
  "contract.input_too_large":
    "The arguments are larger than an operation accepts.",
  "contract.invalid_return":
    "The operation returned something its contract doesn't allow.",
  "contract.result_too_large":
    "The operation returned more than an operation may return.",
  "contract.invalid_progress":
    "The action emitted progress its stream schema doesn't allow.",
  "contract.progress_too_large":
    "The action emitted a progress snapshot larger than one may be.",
  "contract.invalid_error":
    "The operation failed with an error its contract doesn't allow.",
  "contract.invalid_query":
    "The operation built a query its schema doesn't allow.",
  "contract.invalid_write":
    "The operation staged a change its schema doesn't allow.",
  "contract.invalid_request":
    "The operation's code sent the host something that isn't JSON.",
  "mutation.too_large":
    "This change stages more than one commit can hold, with what it returns.",
  "operation.read_limit":
    "This call read the store more often, or with more staged changes, than one call may.",
  "mutation.concurrent_change":
    "The records changed while this change was made. Try again.",
});

/**
 * Why an effect outside the platform can't be told apart from success or
 * failure: the provider accepted a request whose outcome is unknown, so
 * nothing is retried under a fresh key (spec 12).
 */
export const effectErrors = defineErrorFamily({
  "effect.outcome_unknown":
    "Whether the external request took effect is unknown. It wasn't retried.",
});

/** The category of each platform code a caller may get, by code. */
const categories: Readonly<Record<string, ErrorCategory>> = {
  "auth.unauthenticated": "authorization",
  "app.not_found": "authorization",
  "app.unreadable": "authorization",
  "role.forbidden": "authorization",
  "permission.denied": "authorization",
  "data.access_denied": "authorization",
  "resource.unavailable": "authorization",
  "resource.not_allowed": "contract",
  "resource.budget_exhausted": "operational",
  "resource.budget_busy": "operational",
  "resource.queued": "operational",
  "resource.rate_limited": "operational",
  "resource.awaiting_confirmation": "operational",
  "resource.item_not_found": "domain",
  "resource.invalid_args": "contract",
  "resource.declined": "domain",
  "resource.idempotency_conflict": "contract",
  "resource.operation_failed": "domain",
  "resource.busy": "operational",
  "data.write_denied": "authorization",
  "data.conflict": "domain",
  "data.referenced": "domain",
  "data.reference_invalid": "domain",
  "data.cascade_limit": "domain",
  "data.not_unique": "domain",
  "data.result_limit": "domain",
  "data.aggregate_overflow": "domain",
  "data.scan_limit": "source",
  "data.index_required": "source",
  "contract.invalid_query": "source",
  "mutation.too_large": "contract",
  "effect.outcome_unknown": "uncertain",
  "operation.deadline_exceeded": "operational",
  "operation.sandbox_busy": "operational",
  "operation.sandbox_unavailable": "operational",
  // The call may have started, and changed something.
  "operation.sandbox_lost": "uncertain",
  // The call ended (its caller went, or it was stopped): nothing the App's
  // code or its caller did wrong.
  "operation.ended": "operational",
  // Cancelled by the person, or because no screen followed it any more.
  "operation.cancelled": "operational",
  // Its host went away while it ran: what it did is unknown, not failed.
  "operation.outcome_unknown": "uncertain",
  // Nothing ran: room comes back as the person's other streams end.
  "operation.stream_limit": "operational",
  "operation.action_limit": "operational",
  "operation.access_changed": "authorization",
  // The App's own code went past a bound of one call: its source, not the
  // caller's request or the platform.
  "operation.cpu_exceeded": "source",
  "operation.memory_exceeded": "source",
  "operation.sandbox_refused": "source",
  "operation.call_limit": "source",
  "operation.depth_exceeded": "source",
  "operation.emit_limit": "source",
  "operation.no_stream": "source",
  // A call it started outlived the operation's deadline: the operation
  // broke its contract to end with its calls.
  "operation.unfinished_call": "contract",
};

/** The platform codes worth trying again, unchanged, a little later. */
const retryableCodes: ReadonlySet<string> = new Set([
  "query.concurrent_change",
  "mutation.concurrent_change",
  "data.reads_changed",
  "submission.superseded",
  "submission.deadline_passed",
  // Nothing was sent; room comes back as requests under way settle.
  "resource.budget_busy",
  // Nothing was sent; a share comes back as requests in flight end, and a
  // provider's rate as its window passes.
  "resource.queued",
  "resource.rate_limited",
  // A shared store's operation that couldn't run now (busy, a concurrent
  // change): nothing it did stands in the way of the same call again.
  "resource.busy",
  "operation.sandbox_busy",
  "operation.sandbox_unavailable",
  // Nothing was published; the build runs on, cached for the next try.
  "workflow.build_slow",
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
    code === "data.guard_limit" ||
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

/**
 * Whether `code` is, or could pass for, a platform error's, which App code
 * can't throw as its own: an expected code of any family loaded, or any
 * code in a namespace a family or the SDK uses, from the live registry as
 * well as the list the SDK carries.
 */
export const isPlatformCode = (code: unknown): code is string => {
  if (typeof code !== "string") {
    return false;
  }
  const namespace = code.slice(0, Math.max(code.indexOf("."), 0));
  return (
    isExpectedCode(code) ||
    platformErrorNamespaces.has(namespace) ||
    expectedNamespaces().has(namespace)
  );
};

/**
 * `jsonOf`'s reading, to `maxDepth`: self-contained, naming nothing from
 * outside it but the language's own globals, so the host loads this very
 * function into an App's isolate to read what App code answers there
 * (app-functions.ts), and the two never drift.
 */
// oxlint-disable-next-line func-style -- a declaration keeps its own name for its source
export function readJsonValue(
  value: unknown,
  depth: number,
  maxDepth: number
): Json | undefined {
  if (depth > maxDepth) {
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
      const item = readJsonValue(value[index], depth + 1, maxDepth);
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
    const item = readJsonValue(entry, depth + 1, maxDepth);
    if (item === undefined || key === "__proto__") {
      return undefined;
    }
    Object.defineProperty(copy, key, { enumerable: true, value: item });
  }
  return copy;
}

/**
 * A JSON copy of `value` (null, strings, booleans, finite numbers, dense
 * arrays and plain objects of those, without prototype keys, at most
 * `valueDepth` deep), or undefined when it is anything else: what crosses
 * from App code is only ever read as JSON.
 */
export const jsonOf = (value: unknown, depth = 1): Json | undefined =>
  readJsonValue(value, depth, valueDepth);

const encoder = new TextEncoder();

/** What `jsonWithin`'s walk answers for a value that isn't a scalar. */
const notScalar = Symbol("not a scalar");

/** The bytes of `text` as UTF-8, without encoding text plainly too long. */
const stringBytes = (text: string, remaining: number): number =>
  text.length > remaining
    ? Number.POSITIVE_INFINITY
    : encoder.encode(JSON.stringify(text)).byteLength;

/**
 * `value` as `jsonOf` copies it, with the bytes of its JSON text, if those
 * are at most `maxBytes`: counted as the walk goes, which stops as soon as
 * the count passes the limit (`"too_large"`), so a large value costs no
 * more than the limit to refuse. Undefined for what isn't JSON.
 */
export const jsonWithin = (
  value: unknown,
  maxBytes: number
): { json: Json; bytes: number } | "too_large" | undefined => {
  let used = 0;
  let over = false;
  const spend = (bytes: number): boolean => {
    used += bytes;
    over = used > maxBytes;
    return !over;
  };
  /** A scalar's copy, or undefined; `notScalar` when `item` isn't one. */
  const scalar = (item: unknown): Json | undefined | typeof notScalar => {
    if (item === null) {
      return spend(4) ? null : undefined;
    }
    if (typeof item === "string") {
      return spend(stringBytes(item, maxBytes - used)) ? item : undefined;
    }
    if (typeof item === "boolean") {
      return spend(item ? 4 : 5) ? item : undefined;
    }
    if (typeof item === "number") {
      return Number.isFinite(item) && spend(JSON.stringify(item).length)
        ? item
        : undefined;
    }
    return notScalar;
  };
  const array = (item: unknown[], depth: number): Json | undefined => {
    const items: Json[] = [];
    if (!spend(2 + Math.max(item.length - 1, 0))) {
      return undefined;
    }
    for (let index = 0; index < item.length; index += 1) {
      const entry = Object.hasOwn(item, index)
        ? // oxlint-disable-next-line no-use-before-define -- arrays and objects nest each other
          walk(item[index], depth + 1)
        : undefined;
      if (entry === undefined) {
        return undefined;
      }
      items.push(entry);
    }
    return items;
  };
  const object = (item: object, depth: number): Json | undefined => {
    const prototype: unknown = Reflect.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const entries = Object.entries(item);
    if (!spend(2 + Math.max(entries.length - 1, 0))) {
      return undefined;
    }
    const copy: Record<string, Json> = {};
    for (const [key, entry] of entries) {
      if (
        key === "__proto__" ||
        !spend(stringBytes(key, maxBytes - used) + 1)
      ) {
        return undefined;
      }
      // oxlint-disable-next-line no-use-before-define -- arrays and objects nest each other
      const copied = walk(entry, depth + 1);
      if (copied === undefined) {
        return undefined;
      }
      Object.defineProperty(copy, key, { enumerable: true, value: copied });
    }
    return copy;
  };
  const walk = (item: unknown, depth: number): Json | undefined => {
    if (over || depth > valueDepth) {
      return undefined;
    }
    const copied = scalar(item);
    if (copied !== notScalar) {
      return copied;
    }
    if (typeof item !== "object" || item === null) {
      return undefined;
    }
    return Array.isArray(item) ? array(item, depth) : object(item, depth);
  };
  const json = walk(value, 1);
  if (over) {
    return "too_large";
  }
  return json === undefined ? undefined : { json, bytes: used };
};
