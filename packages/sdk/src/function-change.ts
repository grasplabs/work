import type { FunctionManifest } from "./app-types.ts";
import { assignable } from "./descriptor-assignable.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

// Whether a server function a caller is bound to still serves that
// caller as another version declares it: what an App's publish checks of
// each function a workflow calls (core's app-function-bindings.ts). The
// caller sends what `before` took and reads what `before` answered, so
// `after` must take every argument `before` took (new arguments only
// optional ones) and answer what `before` did: a field added to an answer
// is one the caller doesn't read; one removed or retyped breaks it. Proved from the
// descriptors alone (descriptor-assignable.ts), conservatively: what
// can't be proved is a break.

/** Where a descriptor's child sits in it: what `rebuilt` hands `each`. */
type Place =
  | { readonly field: string }
  | { readonly item: true }
  | { readonly value: true }
  | { readonly member: number };

/**
 * `descriptor` with each child (an object's fields, an array's item, a
 * record's value, a union's members) replaced by what `each` makes of it;
 * an object's field `each` answers undefined for is left out. The one
 * walk over the descriptor tree that `asSent` and `asRead` share.
 */
const rebuilt = (
  descriptor: ValueDescriptor,
  each: (child: ValueDescriptor, place: Place) => ValueDescriptor | undefined
): ValueDescriptor => {
  const kept = (child: ValueDescriptor, place: Place): ValueDescriptor =>
    each(child, place) ?? child;
  if (descriptor.kind === "object") {
    return {
      ...descriptor,
      fields: Object.fromEntries(
        Object.entries(descriptor.fields).flatMap(([field, child]) => {
          const made = each(child, { field });
          return made === undefined ? [] : [[field, made]];
        })
      ),
    };
  }
  if (descriptor.kind === "array") {
    return { ...descriptor, item: kept(descriptor.item, { item: true }) };
  }
  if (descriptor.kind === "record") {
    return { ...descriptor, value: kept(descriptor.value, { value: true }) };
  }
  if (descriptor.kind === "union") {
    return {
      ...descriptor,
      members: descriptor.members.map((member, index) =>
        kept(member, { member: index })
      ),
    };
  }
  // A scalar has no children.
  return descriptor;
};

/**
 * `sent` as a caller sends it: a field with a default may be left out,
 * at any depth, so it is optional to the caller, whatever fills it in
 * once received.
 */
const asSent = (sent: ValueDescriptor): ValueDescriptor => {
  const relaxed: ValueDescriptor =
    sent.presence === "default" ? { ...sent, presence: "optional" } : sent;
  return rebuilt(relaxed, asSent);
};

/** `read`'s child at `place`, when it has one there. */
const childAt = (
  read: ValueDescriptor,
  place: Place
): ValueDescriptor | undefined => {
  if ("field" in place) {
    return read.kind === "object" && Object.hasOwn(read.fields, place.field)
      ? read.fields[place.field]
      : undefined;
  }
  if ("item" in place) {
    return read.kind === "array" ? read.item : undefined;
  }
  if ("value" in place) {
    return read.kind === "record" ? read.value : undefined;
  }
  return undefined;
};

/**
 * `answer` as a caller reading what `read` declared reads it, at any
 * depth: an object's fields `read` doesn't name left out, so a field added
 * to an answer is one no caller reads, and breaks none. One `read` names,
 * removed or retyped, still does. A union's member is read as the first of
 * `read`'s members it then fits, if any.
 */
const asRead = (
  answer: ValueDescriptor,
  read: ValueDescriptor
): ValueDescriptor => {
  if (answer.kind === "union") {
    return rebuilt(answer, (member) => asRead(member, read));
  }
  if (read.kind === "union") {
    for (const member of read.members) {
      const seen = asRead(answer, member);
      if (assignable(seen, member)) {
        return seen;
      }
    }
    return answer;
  }
  if (answer.kind === "object" && read.kind !== "object") {
    return answer;
  }
  return rebuilt(answer, (child, place) => {
    const known = childAt(read, place);
    if (known === undefined) {
      // An object's field the caller never read; any other child is kept
      // as it is, for `assignable` to refuse.
      return "field" in place ? undefined : child;
    }
    return asRead(child, known);
  });
};

/** Why `after` no longer serves a caller of `before`; undefined when it does. */
export const functionBreak = (
  before: FunctionManifest,
  after: FunctionManifest
): string | undefined => {
  if (after.visibility !== "public") {
    return "is internal now";
  }
  if (after.kind !== before.kind) {
    return `is a ${after.kind} now, not a ${before.kind}`;
  }
  if (!assignable(asSent(before.args), after.args)) {
    return "no longer takes the arguments it took";
  }
  // A function that declared no `returns` promised nothing to read back.
  if (
    before.returns !== null &&
    (after.returns === null ||
      !assignable(asRead(after.returns, before.returns), before.returns))
  ) {
    return "may answer what it didn't before";
  }
  return undefined;
};
