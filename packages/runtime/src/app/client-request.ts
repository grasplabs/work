import { canonicalJson, isPlainObject } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import { clientError } from "./client-error.ts";
import type { ReferenceKind } from "./function-references.ts";

/**
 * A reference as the client sends it: the function's name, read from the
 * reference, and the kind of call the method or hook makes (a query, a
 * mutation or an action), as Convex's client does. Core resolves the name
 * in the App's current release, refuses a function of another kind and
 * checks the arguments with the function's own validator.
 */
export interface ReadReference {
  readonly name: string;
  readonly kind: ReferenceKind;
}

/**
 * `value`, a reference, as a call of `kind` sends it: its name, and
 * nothing else it carries; `contract.invalid_request` for anything that
 * names no function.
 */
export const readReference = (
  value: unknown,
  kind: ReferenceKind
): ReadReference => {
  if (
    !isPlainObject(value) ||
    typeof value.name !== "string" ||
    value.name.length === 0
  ) {
    throw clientError("contract.invalid_request");
  }
  return { name: value.name, kind };
};

/**
 * `args` as the request carries them, as a JSON snapshot, an omitted
 * input as `{}`;
 * `contract.invalid_args` for anything but an object JSON can hold (a NaN,
 * an infinity or a BigInt in it is refused, as the cache key and the
 * request couldn't be made of it). What they must be beyond that is the
 * function's validator's to say, in core, which also normalizes them
 * (defaults, trimming) before the handler sees them.
 */
export const inputOf = (args: unknown): Json => {
  const input = args ?? {};
  if (!isPlainObject(input)) {
    throw clientError("contract.invalid_args", {
      issues: [{ message: "The arguments must be an object.", path: [] }],
    });
  }
  // SAFETY: an object; whether JSON holds it is checked just below, and
  // core reads it as data and checks it with the function's validator.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const json = input as Json;
  try {
    // A snapshot, never the caller's object: a list's cache key and its
    // Load Mores, and a call sent again, hold what was asked, whatever the
    // caller changes in it after.
    // SAFETY: canonical JSON text parses to the JSON it was made of.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return JSON.parse(canonicalJson(json)) as Json;
  } catch {
    throw clientError("contract.invalid_args", {
      issues: [
        {
          message:
            "The arguments must be JSON: no NaN, infinity, BigInt, undefined array entry, function or cycle.",
          path: [],
        },
      ],
    });
  }
};

export const queryOptionKeys: ReadonlySet<string> = new Set(["signal"]);
export const submitOptionKeys: ReadonlySet<string> = new Set([
  "signal",
  "idempotencyKey",
]);
export const streamOptionKeys: ReadonlySet<string> = new Set([
  ...submitOptionKeys,
  "onProgress",
]);

const keyPattern = /^[ -~]{1,128}$/u;

/**
 * Invocation options, read on their own and strictly: an unknown key is
 * refused rather than passed on, and nothing of them is sent but a key.
 */
export const readOptions = (
  options: unknown,
  allowed: ReadonlySet<string>
): {
  signal?: AbortSignal;
  idempotencyKey?: string;
  onProgress?: (progress: unknown) => void;
} => {
  if (options === undefined) {
    return {};
  }
  if (!isPlainObject(options)) {
    throw new TypeError("Call options are an object.");
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new TypeError(`"${key}" isn't an option of this call.`);
    }
  }
  const { signal, idempotencyKey, onProgress } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("signal is an AbortSignal.");
  }
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new TypeError("onProgress is a function.");
  }
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== "string" || !keyPattern.test(idempotencyKey))
  ) {
    throw clientError("submission.key_invalid");
  }
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(typeof onProgress === "function"
      ? {
          // SAFETY: a function App code passed; it gets what it asked for.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          onProgress: onProgress as (progress: unknown) => void,
        }
      : {}),
  };
};
