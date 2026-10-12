import {
  appErrorCodePattern,
  appErrorDetailsMaxBytes,
  appErrorMessageMaxLength,
  isAppErrorCode,
  reservedErrorNamespaces,
} from "@grasp-os/shared/operation-limits";

import { isPlainObject, valueLimits } from "./value-descriptor.ts";
import type { JsonValue } from "./value-descriptor.ts";

// `AppError`: how a server function fails on purpose, with a code its
// callers can branch on and a message people can read. It is a domain
// outcome (a note that isn't there, a limit the business sets), not a
// defect: the host answers it to the caller as it is, adding what only
// the host knows (the category, whether to retry, the request ID), and
// never what App code didn't put in it (no cause, no stack).
//
// Its parts are checked as it is built, and again by the host, which
// trusts nothing that crosses from App code: a code in one of the
// platform's namespaces (`data.*`, `auth.*`, ...) can't be thrown, so an
// App can't pass its failure off as the platform's.

const encoder = new TextEncoder();

/**
 * A copy of `value` if it is JSON (null, strings, booleans, finite
 * numbers, dense arrays and plain objects of those, without prototype
 * keys) at most `valueLimits.depth` deep; undefined otherwise.
 */
const jsonCopy = (value: unknown, depth = 1): JsonValue | undefined => {
  if (depth > valueLimits.depth) {
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
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return undefined;
      }
      const item = jsonCopy(value[index], depth + 1);
      if (item === undefined) {
        return undefined;
      }
      items.push(item);
    }
    return items;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const copy: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const item = jsonCopy(entry, depth + 1);
    if (item === undefined || key === "__proto__") {
      return undefined;
    }
    copy[key] = item;
  }
  return copy;
};

/**
 * `details` as an error may carry them: a JSON copy of at most
 * `appErrorDetailsMaxBytes` bytes, or undefined when they are anything
 * else (too large, not JSON).
 */
export const appErrorDetailsOf = (details: unknown): JsonValue | undefined => {
  const copy = jsonCopy(details);
  if (copy === undefined) {
    return undefined;
  }
  const text = JSON.stringify(copy);
  return encoder.encode(text).byteLength <= appErrorDetailsMaxBytes
    ? copy
    : undefined;
};

/** Why an `AppError` couldn't be built. */
const invalidError = (message: string): TypeError =>
  new TypeError(`An AppError ${message}`);

/**
 * A server function's domain failure: `code` is stable and dotted, e.g.
 * `note.not_found`, and never in a platform namespace (`data`, `auth`,
 * `query`, ...); `message` is safe to show, at most 500 code units;
 * `details`, when given, are JSON of at most 16 KiB. Built wrongly, it
 * throws a `TypeError` instead, which its caller sees as an unexpected
 * failure.
 *
 * ```ts
 * if (!note) throw new AppError("note.not_found", "The note is unavailable.");
 * ```
 */
export class AppError extends Error {
  readonly code: string;
  readonly details?: JsonValue;

  constructor(code: string, message: string, details?: JsonValue) {
    // Typed loosely: JavaScript callers pass anything.
    const given: unknown = code;
    if (!isAppErrorCode(given)) {
      const namespace =
        typeof given === "string" ? given.slice(0, given.indexOf(".")) : "";
      throw invalidError(
        typeof given === "string" &&
          appErrorCodePattern.test(given) &&
          reservedErrorNamespaces.has(namespace)
          ? `code can't be in the platform's \`${namespace}\` namespace.`
          : "code is two or more dotted lower-case segments, e.g. `note.not_found`."
      );
    }
    if (
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > appErrorMessageMaxLength
    ) {
      throw invalidError(
        `message is between 1 and ${appErrorMessageMaxLength} characters.`
      );
    }
    const copied =
      details === undefined ? undefined : appErrorDetailsOf(details);
    if (details !== undefined && copied === undefined) {
      throw invalidError(
        `details are JSON of at most ${appErrorDetailsMaxBytes} bytes.`
      );
    }
    super(message);
    this.name = "AppError";
    this.code = code;
    if (copied !== undefined) {
      this.details = copied;
    }
  }
}
