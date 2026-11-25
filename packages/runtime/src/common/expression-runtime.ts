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

/** The prototypes of what an expression writes or reads. */
const valuePrototypes = (): readonly object[] => [
  Array.prototype,
  String.prototype,
  Number.prototype,
  Boolean.prototype,
  Object.prototype,
];

/**
 * The names a value an expression holds can inherit as a function: every
 * function-valued property (or accessor) of the prototypes of what an
 * expression writes or reads (arrays, strings, numbers, booleans and
 * object literals). A field of one of these names is read through `own`.
 *
 * A fixed list, never read off the runtime that lowers the expression:
 * the code is lowered where it is published (core, or Node for a
 * blueprint) and runs in a workflow's isolate, whose prototypes may hold
 * more. So the list is the lowering's and the run's alike, and a run
 * whose runtime's prototypes hold a function of a name not in it
 * refuses to start (`unlistedInheritedNames`), rather than read such a
 * field as the built-in it would be.
 */
export const inheritedNames: ReadonlySet<string> = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "anchor",
  "at",
  "big",
  "blink",
  "bold",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "concat",
  "constructor",
  "copyWithin",
  "endsWith",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "fixed",
  "flat",
  "flatMap",
  "fontcolor",
  "fontsize",
  "forEach",
  "hasOwnProperty",
  "includes",
  "indexOf",
  "isPrototypeOf",
  "isWellFormed",
  "italics",
  "join",
  "keys",
  "lastIndexOf",
  "link",
  "localeCompare",
  "map",
  "match",
  "matchAll",
  "normalize",
  "padEnd",
  "padStart",
  "pop",
  "propertyIsEnumerable",
  "push",
  "reduce",
  "reduceRight",
  "repeat",
  "replace",
  "replaceAll",
  "reverse",
  "search",
  "shift",
  "slice",
  "small",
  "some",
  "sort",
  "splice",
  "split",
  "startsWith",
  "strike",
  "sub",
  "substr",
  "substring",
  "sup",
  "toExponential",
  "toFixed",
  "toLocaleLowerCase",
  "toLocaleString",
  "toLocaleUpperCase",
  "toLowerCase",
  "toPrecision",
  "toReversed",
  "toSorted",
  "toSpliced",
  "toString",
  "toUpperCase",
  "toWellFormed",
  "trim",
  "trimEnd",
  "trimLeft",
  "trimRight",
  "trimStart",
  "unshift",
  "valueOf",
  "values",
  "with",
]);

/**
 * The function-valued names of this runtime's value prototypes that
 * `inheritedNames` doesn't list: none, or a run on it would read a field
 * of such a name as a built-in function.
 */
export const unlistedInheritedNames = (): string[] =>
  valuePrototypes().flatMap((prototype) =>
    Object.getOwnPropertyNames(prototype).filter((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      const inherited =
        descriptor === undefined ||
        !("value" in descriptor) ||
        typeof descriptor.value === "function";
      return inherited && !inheritedNames.has(name);
    })
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
 * JavaScript's read does (a `?.` before it is the lowering's to keep).
 */
export const own = (value: unknown, name: string): unknown => {
  if (value === null || value === undefined) {
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
