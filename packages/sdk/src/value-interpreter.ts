import { currencyCodes, timeZones } from "./value-catalog.ts";
import {
  isPlainObject,
  isSemanticKind,
  unsafeKeys,
  valueIssueMessages,
  valueLimits,
} from "./value-descriptor.ts";
import type {
  FrozenJson,
  JsonValue,
  SemanticKind,
  ValueDescriptor,
  ValueIssue,
  ValueIssueCode,
  ValueResult,
} from "./value-descriptor.ts";

// The one interpreter of value descriptors. Every check of a value, in a
// form, at a function's boundary or on a stored record, is this function
// reading the same descriptor, so they can't disagree.
//
// It always works in one order: is the value there (or does a default stand
// in), may it be null, is it the right kind, normalize (trim), then the
// constraints. The order a schema's modifiers were written in changes
// nothing.
//
// It only walks down the descriptor, never down the value on its own, so a
// descriptor's depth bounds the recursion: a value that refers to itself
// can't loop it. `valueLimits.steps` bounds the width.

/** Returned in place of a value that was refused. */
const invalid = Symbol("invalid");
type Checked = unknown;

interface CheckState {
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

const refuse = (state: CheckState, code: ValueIssueCode): typeof invalid => {
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

/** A copy of a default, so no two results share an array or an object. */
const copyJson = (value: FrozenJson): JsonValue => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(copyJson);
  }
  const copy: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = copyJson(entry);
  }
  return copy;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const emailMaxLength = 254;

/**
 * A record ID: a UUIDv7 in lower case, as they are minted. One spelling per
 * ID, so two strings that differ only in case can't name the same record.
 */
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

const cronPartPattern =
  /^(?:\*|(?<from>\d{1,2})(?:-(?<to>\d{1,2}))?)(?:\/(?<step>\d{1,2}))?$/u;

/** The lowest and highest number of each cron field, in order. */
const cronFieldRanges = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

const isCronPart = (part: string, lowest: number, highest: number): boolean => {
  const groups = cronPartPattern.exec(part)?.groups;
  if (groups === undefined) {
    return false;
  }
  const { from, to, step } = groups;
  if (step !== undefined && Number(step) < 1) {
    return false;
  }
  if (from === undefined) {
    return true;
  }
  const first = Number(from);
  const last = to === undefined ? first : Number(to);
  return first >= lowest && last <= highest && first <= last;
};

/**
 * Five cron fields (minute, hour, day of month, month, day of week) in
 * numbers, single spaces between them: `*`, `5`, `1-5`, `*\/15`, `1-5/2` and
 * lists of those. Names (`MON`) and other dialects aren't one fixed form.
 */
const isCron = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > valueLimits.nameLength) {
    return false;
  }
  const fields = value.split(" ");
  return (
    fields.length === cronFieldRanges.length &&
    cronFieldRanges.every(([lowest, highest], index) =>
      (fields[index] ?? "")
        .split(",")
        .every((part) => isCronPart(part, lowest, highest))
    )
  );
};

/**
 * Reads an object with a fixed set of keys: refuses anything that isn't a
 * JSON object or has a key outside the set, then checks each key with
 * `checkKey`. A key left out of the result is one whose value is absent.
 */
const checkStrictObject = (
  value: unknown,
  keys: readonly string[],
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
    if (!keys.includes(key)) {
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

const moneyKeys = ["minorUnits", "currency"] as const;
const scheduleKeys = ["cron", "timeZone"] as const;
const fileKeys = ["id"] as const;

/** The kinds with one fixed wire form each. */
const semanticChecks: Record<
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

const checkString = (
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

const checkNumber = (
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

const checkArray = (
  descriptor: ValueDescriptor & { kind: "array" },
  value: unknown,
  state: CheckState
): Checked => {
  if (!Array.isArray(value)) {
    return refuse(state, "value.invalid_type");
  }
  // The length is checked before any element is read or copied.
  if (descriptor.min !== undefined && value.length < descriptor.min) {
    return refuse(state, "value.too_short");
  }
  if (descriptor.max !== undefined && value.length > descriptor.max) {
    return refuse(state, "value.too_long");
  }
  const result: unknown[] = [];
  let valid = true;
  for (let index = 0; index < value.length && !state.stopped; index += 1) {
    state.path.push(index);
    // A hole reads as undefined, which a required item refuses.
    // oxlint-disable-next-line no-use-before-define -- the checks of nested values call each other
    const checked = check(descriptor.item, value[index], state);
    state.path.pop();
    if (checked === invalid) {
      valid = false;
    } else {
      result.push(checked);
    }
  }
  return valid && !state.stopped ? result : invalid;
};

const checkRecord = (
  descriptor: ValueDescriptor & { kind: "record" },
  value: unknown,
  state: CheckState
): Checked => {
  if (!isPlainObject(value)) {
    return refuse(state, "value.invalid_type");
  }
  const result: Record<string, unknown> = {};
  let valid = true;
  for (const key of Object.keys(value)) {
    if (state.stopped) {
      break;
    }
    if (unsafeKeys.has(key) || key.length > valueLimits.nameLength) {
      refuse(state, "value.unsafe_key");
      valid = false;
    } else {
      state.path.push(key);
      // oxlint-disable-next-line no-use-before-define -- the checks of nested values call each other
      const checked = check(descriptor.value, value[key], state);
      state.path.pop();
      if (checked === invalid) {
        valid = false;
      } else {
        result[key] = checked;
      }
    }
  }
  return valid && !state.stopped ? result : invalid;
};

/**
 * The first member the value fits, in the order they were declared. What
 * the other members had against it is not reported: one issue says none fit.
 */
const checkUnion = (
  descriptor: ValueDescriptor & { kind: "union" },
  value: unknown,
  state: CheckState
): Checked => {
  const { issues, issueLimit } = state;
  let matched: Checked = invalid;
  for (const member of descriptor.members) {
    // A member is tried on its own: one issue is enough to rule it out.
    state.issues = [];
    state.issueLimit = 1;
    // oxlint-disable-next-line no-use-before-define -- the checks of nested values call each other
    const checked = check(member, value, state);
    state.stopped = state.exhausted;
    if (checked !== invalid || state.exhausted) {
      matched = checked;
      break;
    }
  }
  state.issues = issues;
  state.issueLimit = issueLimit;
  if (matched === invalid && !state.exhausted) {
    return refuse(state, "value.no_union_match");
  }
  return matched;
};

const isSemantic = (
  descriptor: ValueDescriptor
): descriptor is Extract<ValueDescriptor, { kind: SemanticKind }> =>
  isSemanticKind(descriptor.kind);

/** The value when it holds, an issue when it doesn't. */
const pass = (
  holds: boolean,
  value: unknown,
  state: CheckState,
  code: ValueIssueCode = "value.invalid_type"
): Checked => (holds ? value : refuse(state, code));

const checkKind = (
  descriptor: ValueDescriptor,
  value: unknown,
  state: CheckState
): Checked => {
  if (isSemantic(descriptor)) {
    return semanticChecks[descriptor.kind](value, state);
  }
  switch (descriptor.kind) {
    case "string": {
      return checkString(descriptor, value, state);
    }
    case "number": {
      return checkNumber(descriptor, value, state);
    }
    case "boolean": {
      return pass(typeof value === "boolean", value, state);
    }
    case "null": {
      return pass(value === null, value, state);
    }
    case "literal": {
      return pass(
        value === descriptor.value,
        value,
        state,
        "value.invalid_literal"
      );
    }
    case "enum": {
      return pass(
        typeof value === "string" && descriptor.values.includes(value),
        value,
        state,
        "value.invalid_enum"
      );
    }
    case "id": {
      return pass(
        typeof value === "string" && idPattern.test(value),
        value,
        state,
        "value.invalid_id"
      );
    }
    case "object": {
      const { fields } = descriptor;
      return checkStrictObject(
        value,
        Object.keys(fields),
        state,
        (key, entry) =>
          // oxlint-disable-next-line no-use-before-define -- the checks of nested values call each other
          check(fields[key], entry, state)
      );
    }
    case "array": {
      return checkArray(descriptor, value, state);
    }
    case "union": {
      return checkUnion(descriptor, value, state);
    }
    case "record": {
      return checkRecord(descriptor, value, state);
    }
    default: {
      // A kind this interpreter doesn't know never passes.
      return refuse(state, "value.invalid_type");
    }
  }
};

const check = (
  descriptor: ValueDescriptor | undefined,
  value: unknown,
  state: CheckState
): Checked => {
  if (state.stopped || descriptor === undefined) {
    return invalid;
  }
  state.steps += 1;
  if (state.steps > valueLimits.steps) {
    state.exhausted = true;
    state.stopped = true;
    return invalid;
  }
  if (value === undefined) {
    if (descriptor.presence === "optional") {
      return undefined;
    }
    return descriptor.presence === "default" &&
      descriptor.defaultValue !== undefined
      ? copyJson(descriptor.defaultValue)
      : refuse(state, "value.required");
  }
  if (value === null && descriptor.nullable) {
    return null;
  }
  return checkKind(descriptor, value, state);
};

const issue = (code: ValueIssueCode): ValueIssue => ({
  code,
  message: valueIssueMessages[code],
  path: [],
});

/**
 * Checks a value against a descriptor: the normalized value (a fresh copy,
 * never the one passed in), or what is wrong with it. It never throws for a
 * value, whatever it is given.
 */
export const validateValue = (
  descriptor: ValueDescriptor,
  value: unknown
): ValueResult<unknown> => {
  const state: CheckState = {
    exhausted: false,
    issueLimit: valueLimits.issues,
    issues: [],
    path: [],
    steps: 0,
    stopped: false,
  };
  let checked: Checked = invalid;
  try {
    checked = check(descriptor, value, state);
  } catch {
    // Only a value that runs code when read (a proxy, a getter) throws.
    return { issues: [issue("value.unreadable")] };
  }
  if (state.exhausted) {
    return { issues: [issue("value.too_complex")] };
  }
  return checked === invalid || state.issues.length > 0
    ? { issues: state.issues }
    : { value: checked };
};
