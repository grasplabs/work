import { isPlainObject } from "@grasp-os/shared/json";

import { isCron } from "./cron.ts";
import { currencyCodes, timeZones } from "./value-catalog.ts";
import { valueIssueMessages, valueLimits } from "./value-descriptor.ts";
import type {
  SemanticKind,
  ValueDescriptor,
  ValueIssue,
  ValueIssueCode,
} from "./value-descriptor.ts";

/** Returned in place of a value that was refused. */
export const invalid = Symbol("invalid");
export type Checked = unknown;

export interface CheckState {
  /** Read past `valueLimits.steps`: the whole check is refused. */
  exhausted: boolean;
  /** Stop once this many issues are collected. */
  issueLimit: number;
  issues: ValueIssue[];
  /** Where the value being read sits in the one being checked. */
  readonly path: (string | number)[];
  steps: number;
  stopped: boolean;
}

export const refuse = (
  state: CheckState,
  code: ValueIssueCode
): typeof invalid => {
  state.issues.push({
    code,
    message: valueIssueMessages[code],
    path: [...state.path],
  });
  if (state.issues.length >= state.issueLimit) {
    state.stopped = true;
  }
  return invalid;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const emailMaxLength = 254;

/**
 * An opaque reference (a person, a model, a template, a file): visible
 * ASCII without spaces. The host resolves it and decides access; the format
 * only keeps control characters and unbounded text out.
 */
const referencePattern = /^[!-~]+$/u;

const isReference = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= valueLimits.nameLength &&
  referencePattern.test(value);

/**
 * Reads an object with a fixed set of keys: refuses anything that isn't a
 * JSON object or has a key outside the set, then checks each key with
 * `checkKey`. A key left out of the result is one whose value is absent.
 */
export const checkStrictObject = (
  value: unknown,
  keys: ReadonlySet<string>,
  state: CheckState,
  checkKey: (key: string, entry: unknown) => Checked
): Checked => {
  if (!isPlainObject(value)) {
    return refuse(state, "value.invalid_type");
  }
  let valid = true;
  for (const key of Object.keys(value)) {
    if (state.stopped) {
      break;
    }
    if (!keys.has(key)) {
      // The path names the key only when it is short: an issue never
      // carries an unbounded piece of what was submitted.
      const named = key.length <= valueLimits.nameLength;
      if (named) {
        state.path.push(key);
      }
      refuse(state, "value.unknown_key");
      if (named) {
        state.path.pop();
      }
      valid = false;
    }
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    state.path.push(key);
    // Only what the object itself holds: a field named `toString` that is
    // left out is absent, not the method every object inherits.
    const checked = checkKey(
      key,
      Object.hasOwn(value, key) ? value[key] : undefined
    );
    state.path.pop();
    if (checked === invalid) {
      valid = false;
    } else if (checked !== undefined) {
      result[key] = checked;
    }
  }
  return valid ? result : invalid;
};

const checkSafeInteger = (
  value: unknown,
  state: CheckState,
  code: ValueIssueCode,
  lowest = Number.MIN_SAFE_INTEGER
): Checked => {
  if (value === undefined) {
    return refuse(state, "value.required");
  }
  if (typeof value !== "number") {
    return refuse(state, "value.invalid_type");
  }
  return Number.isSafeInteger(value) && value >= lowest
    ? value
    : refuse(state, code);
};

const checkReference = (value: unknown, state: CheckState): Checked => {
  if (value === undefined) {
    return refuse(state, "value.required");
  }
  if (typeof value !== "string") {
    return refuse(state, "value.invalid_type");
  }
  return isReference(value) ? value : refuse(state, "value.invalid_reference");
};

/** A string that must be in a catalog, e.g. a currency code. */
const checkListed = (
  value: unknown,
  state: CheckState,
  catalog: ReadonlySet<string>,
  code: ValueIssueCode
): Checked => {
  if (value === undefined) {
    return refuse(state, "value.required");
  }
  if (typeof value !== "string") {
    return refuse(state, "value.invalid_type");
  }
  return catalog.has(value) ? value : refuse(state, code);
};

const checkCron = (value: unknown, state: CheckState): Checked => {
  if (value === undefined) {
    return refuse(state, "value.required");
  }
  if (typeof value !== "string") {
    return refuse(state, "value.invalid_type");
  }
  return isCron(value) ? value : refuse(state, "value.invalid_cron");
};

const moneyKeys: ReadonlySet<string> = new Set(["minorUnits", "currency"]);
const scheduleKeys: ReadonlySet<string> = new Set(["cron", "timeZone"]);
const fileKeys: ReadonlySet<string> = new Set(["id"]);

/** The kinds with one fixed wire form each. */
export const semanticChecks: Record<
  SemanticKind,
  (value: unknown, state: CheckState) => Checked
> = {
  timestamp: (value, state) =>
    checkSafeInteger(value, state, "value.invalid_timestamp"),
  duration: (value, state) =>
    checkSafeInteger(value, state, "value.invalid_duration", 1),
  person: checkReference,
  model: checkReference,
  template: checkReference,
  file: (value, state) =>
    checkStrictObject(value, fileKeys, state, (_key, entry) =>
      checkReference(entry, state)
    ),
  money: (value, state) =>
    checkStrictObject(value, moneyKeys, state, (key, entry) =>
      key === "currency"
        ? checkListed(entry, state, currencyCodes, "value.invalid_currency")
        : checkSafeInteger(entry, state, "value.not_integer")
    ),
  schedule: (value, state) =>
    checkStrictObject(value, scheduleKeys, state, (key, entry) =>
      key === "cron"
        ? checkCron(entry, state)
        : checkListed(entry, state, timeZones, "value.invalid_time_zone")
    ),
};

export const checkString = (
  descriptor: ValueDescriptor & { kind: "string" },
  value: unknown,
  state: CheckState
): Checked => {
  if (typeof value !== "string") {
    return refuse(state, "value.invalid_type");
  }
  const text = descriptor.trim ? value.trim() : value;
  if (descriptor.min !== undefined && text.length < descriptor.min) {
    return refuse(state, "value.too_short");
  }
  if (descriptor.max !== undefined && text.length > descriptor.max) {
    return refuse(state, "value.too_long");
  }
  if (
    descriptor.email &&
    (text.length > emailMaxLength || !emailPattern.test(text))
  ) {
    return refuse(state, "value.invalid_email");
  }
  return text;
};

export const checkNumber = (
  descriptor: ValueDescriptor & { kind: "number" },
  value: unknown,
  state: CheckState
): Checked => {
  if (typeof value !== "number") {
    return refuse(state, "value.invalid_type");
  }
  if (!Number.isFinite(value)) {
    return refuse(state, "value.not_finite");
  }
  if (descriptor.integer && !Number.isSafeInteger(value)) {
    return refuse(state, "value.not_integer");
  }
  if (descriptor.min !== undefined && value < descriptor.min) {
    return refuse(state, "value.too_small");
  }
  if (descriptor.max !== undefined && value > descriptor.max) {
    return refuse(state, "value.too_large");
  }
  return value;
};
