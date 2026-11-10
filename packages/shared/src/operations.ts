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
  "function.not_found": "There is no such function.",
  "function.kind_mismatch":
    "That function is of another kind than the call expects.",
  "function.read_only": "A query reads records and can't change them.",
  "function.no_database":
    "An action has no database: it reads and writes through the App's queries and mutations.",
  "function.no_resources":
    "Only an action uses resources; queries and mutations never reach outside the App.",
  "function.ended": "This function's call has ended.",
  "function.deadline_exceeded":
    "The function ran past its deadline, and was stopped before it changed anything more.",
  "function.unfinished_call":
    "The function left a call it started running past its deadline.",
  "function.mode_mismatch":
    "That action streams its progress, or doesn't, unlike what the call expects: a streaming action is called through useStream or client.stream, any other through useAction or client.action.",
  "function.cancelled":
    "The action was cancelled before it finished. What it changed before then stays changed.",
  "function.outcome_unknown":
    "The action stopped without an answer, so whether it finished is unknown. It wasn't run again.",
  "function.stream_limit":
    "You're running as many streaming actions in this App as one person may at once. Wait for one to finish, or cancel one.",
  "function.action_limit":
    "You're running as many actions in this App as one person may at once. Wait for one to finish.",
  "function.access_changed":
    "Your access to this App changed since this action started, so its outcome isn't shown. Run it again to see it under your access now.",
  "function.no_stream": "Only an action that declares `stream` emits progress.",
  "function.emit_limit":
    "The action emitted more progress snapshots than one call may.",
  "function.call_limit":
    "This call made more host calls, ran more nested functions, or made more resource requests than one call may.",
  "function.depth_exceeded":
    "Functions called each other deeper than one call may go.",
  "function.cpu_exceeded":
    "The function used more CPU time than one call may, so it was stopped.",
  "function.memory_exceeded":
    "The function used more memory than one call may, so it was stopped.",
  "function.sandbox_refused":
    "The function's code sent the host more than one call may.",
  "function.sandbox_busy":
    "This App runs as many calls at once as it may. Try again shortly.",
  "function.sandbox_unavailable":
    "The sandbox that runs the App's code isn't available. Try again shortly.",
  "function.sandbox_lost":
    "The sandbox stopped answering after the call started, so whether it changed anything is unknown.",
  "resource.not_allowed":
    "The App didn't declare that use of this resource for this function.",
  "resource.unavailable":
    "This resource isn't bound to the App, or its binding doesn't serve the contract the App declared.",
  "resource.budget_busy":
    "Runs still under way take all the room this request may use, so it wasn't started. Try again shortly.",
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
  "resource.limit_reached":
    "The App used this resource as much as it may in one call, one minute, one hour or one day, holds as much of it open as it may at once, or made as deep, as round or as many calls between Apps as it may, so this request wasn't made. Its details name which.",
  "contract.invalid_resource_result":
    "A resource answered something its contract doesn't allow.",
  "contract.invalid_args": "The arguments don't fit the function.",
  "contract.input_too_large":
    "The arguments are larger than a function accepts.",
  "contract.invalid_return":
    "The function returned something its contract doesn't allow.",
  "contract.result_too_large":
    "The function returned more than a function may return.",
  "contract.invalid_progress":
    "The action emitted progress its stream schema doesn't allow.",
  "contract.progress_too_large":
    "The action emitted a progress snapshot larger than one may be.",
  "contract.invalid_error":
    "The function failed with an error its contract doesn't allow.",
  "contract.invalid_query":
    "The function built a query its schema doesn't allow.",
  "contract.invalid_write":
    "The function staged a change its schema doesn't allow.",
  "contract.invalid_request":
    "The function's code sent the host something that isn't JSON.",
  "contract.not_paginated":
    "That query doesn't take a pagination argument and answer pages, so it can't be read as a paginated list.",
  "mutation.too_large":
    "This change stages more than one commit can hold, with what it returns.",
  "function.read_limit":
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
  "resource.budget_busy": "operational",
  "resource.rate_limited": "operational",
  "resource.awaiting_confirmation": "operational",
  "resource.item_not_found": "domain",
  "resource.invalid_args": "contract",
  "resource.declined": "domain",
  "resource.idempotency_conflict": "contract",
  "resource.limit_reached": "operational",
  "data.write_denied": "authorization",
  "data.conflict": "domain",
  "data.referenced": "domain",
  "data.reference_invalid": "domain",
  "data.cascade_limit": "domain",
  "data.deleting": "domain",
  "data.not_unique": "domain",
  "data.aggregate_overflow": "domain",
  "data.scan_limit": "source",
  "data.index_required": "source",
  "contract.invalid_query": "source",
  "mutation.too_large": "contract",
  "effect.outcome_unknown": "uncertain",
  "function.deadline_exceeded": "operational",
  "function.sandbox_busy": "operational",
  "function.sandbox_unavailable": "operational",
  // The call may have started, and changed something.
  "function.sandbox_lost": "uncertain",
  // The call ended (its caller went, or it was stopped): nothing the App's
  // code or its caller did wrong.
  "function.ended": "operational",
  // Cancelled by the person, or because no page followed it any more.
  "function.cancelled": "operational",
  // Its host went away while it ran: what it did is unknown, not failed.
  "function.outcome_unknown": "uncertain",
  // Nothing ran: room comes back as the person's other streams end.
  "function.stream_limit": "operational",
  "function.action_limit": "operational",
  "function.access_changed": "authorization",
  // The App's own code went past a bound of one call: its source, not the
  // caller's request or the platform.
  "function.cpu_exceeded": "source",
  "function.memory_exceeded": "source",
  "function.sandbox_refused": "source",
  "function.call_limit": "source",
  "function.depth_exceeded": "source",
  "function.emit_limit": "source",
  "function.no_stream": "source",
  // A call it started outlived the operation's deadline: the operation
  // broke its contract to end with its calls.
  "function.unfinished_call": "contract",
  // A JSON workflow's own error, which its `raise` task declares.
  "workflow.raised": "domain",
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
  // Nothing was sent; a provider's rate comes back as its window passes.
  "resource.rate_limited",
  "function.sandbox_busy",
  "function.sandbox_unavailable",
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
    code.startsWith("function.") ||
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

/**
 * The refusals of a draft of spec 8's layout that a change of its code
 * fixes: code that doesn't seal. Never one of what was kept
 * (`version.manifest_corrupt`, `version.artifact_corrupt`), which no
 * change of the draft fixes.
 */
export const draftSealFailures: ReadonlySet<string> = new Set([
  "version.build_failed",
  "version.inspection_failed",
  "version.invalid_manifest",
]);

/**
 * Whether a preview's call of a draft's function failed with `code`
 * through the draft's own fault, for it to fix: its code (`source`), a
 * contract it or its caller broke, or code that doesn't seal. Never an
 * error the App meant (`domain`), nor a refusal that isn't the draft's
 * (an out-of-date preview, a person who lost access), nor
 * `internal.unexpected`, which says nothing of whose it was.
 */
export const isDraftFault = (code: string): boolean => {
  const category = categoryOf(code);
  return (
    category === "source" ||
    category === "contract" ||
    draftSealFailures.has(code)
  );
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
 * `maxDepth` deep, `valueDepth` unless said), or undefined when it is
 * anything else: what crosses from App code is only ever read as JSON.
 */
export const jsonOf = (
  value: unknown,
  depth = 1,
  maxDepth = valueDepth
): Json | undefined => readJsonValue(value, depth, maxDepth);

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
