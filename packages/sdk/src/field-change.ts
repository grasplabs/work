import { assignable } from "./descriptor-assignable.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

// What a change of one field's descriptor means for the values a store
// already holds under it: a widening every stored value still fits, which
// a store applies on its own, or anything else, which needs a migration.
// Decided from the descriptors alone (descriptor-assignable.ts proves
// conservatively: what it can't prove isn't a widening).

/** Whether `descriptor` holds a value of one of `kinds`, at any depth. */
const holdsKind = (
  descriptor: ValueDescriptor,
  kinds: ReadonlySet<ValueDescriptor["kind"]>
): boolean => {
  if (kinds.has(descriptor.kind)) {
    return true;
  }
  if (descriptor.kind === "object") {
    return Object.values(descriptor.fields).some((field) =>
      holdsKind(field, kinds)
    );
  }
  if (descriptor.kind === "array") {
    return holdsKind(descriptor.item, kinds);
  }
  if (descriptor.kind === "union") {
    return descriptor.members.some((member) => holdsKind(member, kinds));
  }
  if (descriptor.kind === "record") {
    return holdsKind(descriptor.value, kinds);
  }
  return false;
};

const referenceKinds: ReadonlySet<ValueDescriptor["kind"]> = new Set([
  "id",
  "file",
]);

/**
 * Whether `descriptor` can hold a record ID or a file, at any depth: what
 * a store's reference and file indexes read a record by, so only a write
 * the store checks may change it.
 */
export const holdsReference = (descriptor: ValueDescriptor): boolean =>
  holdsKind(descriptor, referenceKinds);

/** Whether `descriptor` has a defaulted field nested in it, at any depth. */
const holdsNestedDefault = (descriptor: ValueDescriptor): boolean => {
  if (descriptor.kind === "object") {
    return Object.values(descriptor.fields).some(
      (field) => field.presence === "default" || holdsNestedDefault(field)
    );
  }
  if (descriptor.kind === "array") {
    return holdsNestedDefault(descriptor.item);
  }
  if (descriptor.kind === "record") {
    return holdsNestedDefault(descriptor.value);
  }
  return (
    descriptor.kind === "union" && descriptor.members.some(holdsNestedDefault)
  );
};

/**
 * Whether `after` gives a field nested in an object a default `before`
 * didn't: stored values may lack it, and a read never makes one up, so
 * such a change is no widening. Compared through objects, array items,
 * record values and a union's members in place; where the two don't line
 * up, any nested default of `after` counts as added.
 */
const addsNestedDefault = (
  before: ValueDescriptor,
  after: ValueDescriptor
): boolean => {
  if (before.kind === "union" && after.kind === "union") {
    return (
      before.members.length !== after.members.length ||
      after.members.some((member, at) => {
        const was = before.members[at];
        return was === undefined || addsNestedDefault(was, member);
      })
    );
  }
  if (before.kind === "object" && after.kind === "object") {
    return Object.entries(after.fields).some(([name, field]) => {
      const was = Object.hasOwn(before.fields, name)
        ? before.fields[name]
        : undefined;
      // A default of its own, new; or one deeper, defaulted or not.
      return (
        (field.presence === "default" && was?.presence !== "default") ||
        (was !== undefined && addsNestedDefault(was, field))
      );
    });
  }
  if (before.kind === "array" && after.kind === "array") {
    return addsNestedDefault(before.item, after.item);
  }
  if (before.kind === "record" && after.kind === "record") {
    return addsNestedDefault(before.value, after.value);
  }
  return before.kind !== after.kind && holdsNestedDefault(after);
};

/**
 * Whether every value a field `before` stored, `after` takes as it is, and
 * a record lacking the field fits `after` wherever it fit `before`: a
 * higher bound, a new enum value, a field made optional or nullable.
 */
export const fieldWidens = (
  before: ValueDescriptor,
  after: ValueDescriptor
): boolean =>
  (after.presence === "optional" || before.presence !== "optional") &&
  assignable(before, after) &&
  !addsNestedDefault(before, after);
