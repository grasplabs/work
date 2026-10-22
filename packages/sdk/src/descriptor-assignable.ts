import type { ValueDescriptor } from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";

// Whether every value one descriptor normalizes to is one another accepts:
// how a surface's input is checked against its screen's (spec 34.1). It is
// conservative on purpose: a pair it can't prove is refused, never let
// through. What it proves, it proves structurally, from the descriptors
// alone, without running anything.

/** The check itself, handed to each kind's rule for what it holds. */
type Check = (from: ValueDescriptor, to: ValueDescriptor) => boolean;

/** Whether `inner`'s bounds lie within `outer`'s (a missing bound is none). */
const within = (
  inner: { readonly min?: number; readonly max?: number },
  outer: { readonly min?: number; readonly max?: number }
): boolean =>
  (outer.min === undefined ||
    (inner.min !== undefined && inner.min >= outer.min)) &&
  (outer.max === undefined ||
    (inner.max !== undefined && inner.max <= outer.max));

/** Whether `to` accepts the one value `value`, wherever it stands. */
const accepts = (to: ValueDescriptor, value: unknown): boolean =>
  "value" in validateValue({ ...to, presence: "required" }, value);

/** Whether a field `from` normalizes is always one `to` takes in its place. */
const fieldAssignable = (
  from: ValueDescriptor | undefined,
  to: ValueDescriptor,
  check: Check
): boolean => {
  if (from === undefined) {
    // Left out, the screen fills it in or goes without.
    return to.presence !== "required";
  }
  // An optional field may be left out, which a required one refuses; a
  // defaulted field never is, once normalized.
  if (from.presence === "optional" && to.presence === "required") {
    return false;
  }
  return check(from, to);
};

/** Objects: the screen's are strict, so no field it doesn't know. */
const objectAssignable = (
  from: Extract<ValueDescriptor, { kind: "object" }>,
  to: ValueDescriptor,
  check: Check
): boolean =>
  to.kind === "object" &&
  Object.keys(from.fields).every((name) => Object.hasOwn(to.fields, name)) &&
  Object.entries(to.fields).every(([name, field]) =>
    fieldAssignable(
      Object.hasOwn(from.fields, name) ? from.fields[name] : undefined,
      field,
      check
    )
  );

/** The containers, with what they hold to compare; undefined for others. */
const containerAssignable = (
  from: ValueDescriptor,
  to: ValueDescriptor,
  check: Check
): boolean | undefined => {
  if (from.kind === "object") {
    return objectAssignable(from, to, check);
  }
  if (from.kind === "array") {
    return to.kind === "array" && within(from, to) && check(from.item, to.item);
  }
  if (from.kind === "record") {
    return to.kind === "record" && check(from.value, to.value);
  }
  return undefined;
};

/** An enum's values, each one `to` accepts. */
const enumAssignable = (
  values: readonly string[],
  to: ValueDescriptor
): boolean =>
  to.kind === "enum"
    ? values.every((value) => to.values.includes(value))
    : to.kind === "string" && values.every((value) => accepts(to, value));

/** The scalars with constraints to compare; undefined for others. */
const scalarAssignable = (
  from: ValueDescriptor,
  to: ValueDescriptor
): boolean | undefined => {
  if (from.kind === "enum") {
    return enumAssignable(from.values, to);
  }
  if (from.kind === "string") {
    return (
      to.kind === "string" &&
      within(from, to) &&
      (from.email || !to.email) &&
      (from.trim || !to.trim)
    );
  }
  if (from.kind === "number") {
    return (
      to.kind === "number" && within(from, to) && (from.integer || !to.integer)
    );
  }
  if (from.kind === "id") {
    return to.kind === "id" && to.tableName === from.tableName;
  }
  return undefined;
};

/**
 * Whether every value `from` normalizes to is one `to` accepts (and so
 * normalizes again without loss of meaning). Nullability and each kind's
 * constraints are compared; anything not proved is false.
 */
export const assignable: Check = (from, to) => {
  if (from.nullable && !to.nullable) {
    return false;
  }
  if (from.kind === "union") {
    return from.members.every((member) => assignable(member, to));
  }
  if (from.kind === "literal") {
    return accepts(to, from.value);
  }
  if (to.kind === "union") {
    return to.members.some((member) => assignable(from, member));
  }
  // Booleans, null and the semantic kinds have no constraints to narrow.
  return (
    containerAssignable(from, to, assignable) ??
    scalarAssignable(from, to) ??
    to.kind === from.kind
  );
};
