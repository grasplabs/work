import {
  checkNumber,
  checkStrictObject,
  checkString,
  invalid,
  refuse,
  semanticChecks,
} from "./value-checks.ts";
import type { Checked, CheckState } from "./value-checks.ts";
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

/**
 * A record ID: a UUIDv7 in lower case, as they are minted. One spelling per
 * ID, so two strings that differ only in case can't name the same record.
 */
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The names of an object descriptor's fields, listed once per descriptor. */
const fieldNames = new WeakMap<object, ReadonlySet<string>>();

const namesOf = (
  fields: Readonly<Record<string, ValueDescriptor>>
): ReadonlySet<string> => {
  let names = fieldNames.get(fields);
  if (names === undefined) {
    names = new Set(Object.keys(fields));
    fieldNames.set(fields, names);
  }
  return names;
};

const checkArray = (
  descriptor: ValueDescriptor & { kind: "array" },
  value: unknown,
  state: CheckState
): Checked => {
  if (!Array.isArray(value)) {
    return refuse(state, "value.invalid_type");
  }
  // The length is read once, and checked before any element is read or
  // copied: an array that reports another length later can't get past it.
  const { length } = value;
  if (descriptor.min !== undefined && length < descriptor.min) {
    return refuse(state, "value.too_short");
  }
  if (descriptor.max !== undefined && length > descriptor.max) {
    return refuse(state, "value.too_long");
  }
  const result: unknown[] = [];
  let valid = true;
  for (let index = 0; index < length && !state.stopped; index += 1) {
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
    if (key.length > valueLimits.nameLength) {
      // Reported at the record: the path never carries an unbounded piece
      // of what was submitted.
      refuse(state, "value.key_too_long");
      valid = false;
    } else if (unsafeKeys.has(key)) {
      state.path.push(key);
      refuse(state, "value.unsafe_key");
      state.path.pop();
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
      // The declared value, not the submitted one: `-0` equals a literal 0
      // and normalizes to it.
      return pass(
        value === descriptor.value,
        descriptor.value,
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
      return checkStrictObject(value, namesOf(fields), state, (key, entry) =>
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
    // Swallowed on purpose. The interpreter itself throws nothing: its
    // recursion is bounded by the descriptor and it calls no App code. So
    // what was thrown came from the value running code as it was read (a
    // proxy, a getter). That is the submitter's text, not a fault of ours,
    // so it is answered as an issue and never passed on or logged.
    return { issues: [issue("value.unreadable")] };
  }
  if (state.exhausted) {
    return { issues: [issue("value.too_complex")] };
  }
  return checked === invalid || state.issues.length > 0
    ? { issues: state.issues }
    : { value: checked };
};
