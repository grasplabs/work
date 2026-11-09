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

/**
 * `args` as a caller sends them: a field with a default may be left out,
 * so it is optional to the caller, whatever fills it in once received.
 */
const asSent = (args: ValueDescriptor): ValueDescriptor =>
  args.kind === "object"
    ? {
        ...args,
        fields: Object.fromEntries(
          Object.entries(args.fields).map(([name, field]) => [
            name,
            field.presence === "default"
              ? { ...field, presence: "optional" }
              : field,
          ])
        ),
      }
    : args;

/**
 * `answer` as a caller reading what `read` declared reads it: an object's
 * fields `read` doesn't name left out, so a field added to an answer is
 * one no caller reads, and breaks none. One `read` names, removed or
 * retyped, still does.
 */
const asRead = (
  answer: ValueDescriptor,
  read: ValueDescriptor
): ValueDescriptor => {
  if (answer.kind === "object" && read.kind === "object") {
    return {
      ...answer,
      fields: Object.fromEntries(
        Object.entries(answer.fields).flatMap(([name, field]) => {
          const known = Object.hasOwn(read.fields, name)
            ? read.fields[name]
            : undefined;
          return known === undefined ? [] : [[name, asRead(field, known)]];
        })
      ),
    };
  }
  if (answer.kind === "array" && read.kind === "array") {
    return { ...answer, item: asRead(answer.item, read.item) };
  }
  return answer;
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
