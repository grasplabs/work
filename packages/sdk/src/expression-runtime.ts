/**
 * What a workflow expression may call, and the one guard its generated
 * code reads through (expression-check.ts, expression-lowering.ts).
 *
 * An expression's code is plain JavaScript (`invoice.lines.filter((line)
 * => line.total > 3)`), safe because no expression can ever hold a
 * function value:
 *
 * - every value it starts from is JSON, which holds none: the run's args,
 *   parameters, state and step results are copied into frozen objects
 *   with no prototype (the workflow runtime's `frozenData`), so a field
 *   nobody wrote is `undefined`, never something inherited;
 * - the only functions it writes are the arrows it passes as the one
 *   argument of a callback method (`callbackMethods`);
 * - it calls only the allowed methods (`allowedMethods`), by name, in
 *   call position;
 * - and a field it reads whose name a built-in prototype (an array's, a
 *   string's, a number's, a boolean's, an object literal's) has as a
 *   function (`values`, `at`, `toString`) is read through `own`, which
 *   gives only the value's own field: so `[].forEach` or `"".link` is
 *   `undefined`, never the method, and no expression can file a built-in
 *   under an allowed name (`{ at: [].forEach }.at(…)`) or hand one to a
 *   conversion (`${{ toString: list.reverse }}`).
 */

import { expressionFailed } from "@grasp-os/shared/workflows";

/** The methods that take the expression's one arrow function. */
export const callbackMethods: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
]);

/** Every method an expression may call, on some kind of value. */
export const allowedMethods: ReadonlySet<string> = new Set([
  ...callbackMethods,
  "includes",
  "indexOf",
  "slice",
  "concat",
  "join",
  "at",
  "split",
  "trim",
  "trimStart",
  "trimEnd",
  "toLowerCase",
  "toUpperCase",
  "startsWith",
  "endsWith",
  "toFixed",
]);

/**
 * The names a value an expression holds can inherit as a function: every
 * function-valued property of the prototypes of what an expression writes
 * or reads (arrays, strings, numbers, booleans and object literals),
 * as this runtime has them. A field of one of these names is read through
 * `own`.
 */
export const inheritedNames: ReadonlySet<string> = new Set(
  [
    Array.prototype,
    String.prototype,
    Number.prototype,
    Boolean.prototype,
    Object.prototype,
  ].flatMap((prototype) =>
    Object.getOwnPropertyNames(prototype).filter((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      return (
        descriptor === undefined ||
        !("value" in descriptor) ||
        typeof descriptor.value === "function"
      );
    })
  )
);

/**
 * Why an expression failed as it ran: `expression.failed`. Its message
 * names only what the expression wrote (a field's name), never a value.
 */
export class ExpressionFailedError extends TypeError {
  override readonly name = "ExpressionFailedError";
  readonly code = expressionFailed;
}

/** The longest a name stands in a failure's message. */
const maxNameInMessage = 64;

/**
 * `value.name` where `name` is one a built-in prototype has as a function
 * (`inheritedNames`): the value's own field, or `undefined` where it has
 * none, never anything inherited. Throws on `null` or `undefined`, as
 * JavaScript's read does, unless the read is `optional` (`?.`).
 */
export const own = (
  value: unknown,
  name: string,
  optional = false
): unknown => {
  if (value === null || value === undefined) {
    if (optional) {
      return undefined;
    }
    const shown =
      name.length > maxNameInMessage
        ? `${name.slice(0, maxNameInMessage)}…`
        : name;
    throw new ExpressionFailedError(
      `Cannot read "${shown}" of ${String(value)}.`
    );
  }
  if (typeof value !== "object" || !Object.hasOwn(value, name)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
};
