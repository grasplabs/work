/**
 * What a workflow expression's generated code runs through (`code` of
 * `checkExpression`, expression-lowering.ts): the run-time half of the
 * boundary, which stops an expression calling anything but the allowed
 * built-ins, whatever names its data's fields have.
 *
 * - `readMember`, every member read, gives a value's own data property
 *   (an array's or string's `length` among them), never through the
 *   prototype chain and never a function. So no expression holds a
 *   built-in method to file under an allowed name
 *   (`{ at: [].forEach }.at(…)`) or hand to a conversion
 *   (`${{ toString: list.reverse }}`).
 * - `callMethod`, every method call, calls an allowed built-in, captured
 *   when this module loads, only on a real array, string or number, so
 *   `{ indexOf, length: 1e15 }` can't stand in for an array. A callback
 *   method takes exactly one function, the arrow the expression wrote
 *   there; others take none.
 * - `optionalChain`, every `?.` link, runs the rest of the chain only for
 *   a value that isn't nullish.
 * - `jsonValue`, an expression's whole value, makes it the JSON a step
 *   takes and a run records.
 *
 * The run host's contract: an expression's roots (input, step outputs,
 * params, the run) are JSON values, as it stores and replays them. So
 * they hold no getters or functions of their own, and the only functions
 * an expression holds are the arrows it writes as callbacks.
 */

import type { Json } from "@grasp-os/shared/json";

// Captured as this module loads, and called only with `Reflect.apply` and
// an explicit receiver (`callMethod`), so unbound by design.
/* oxlint-disable typescript/unbound-method -- see above */
type Method = (...args: never[]) => unknown;

const arrayMethods = new Map<string, Method>([
  ["map", Array.prototype.map],
  ["filter", Array.prototype.filter],
  ["some", Array.prototype.some],
  ["every", Array.prototype.every],
  ["find", Array.prototype.find],
  ["findIndex", Array.prototype.findIndex],
  ["includes", Array.prototype.includes],
  ["indexOf", Array.prototype.indexOf],
  ["slice", Array.prototype.slice],
  ["concat", Array.prototype.concat],
  ["join", Array.prototype.join],
  ["at", Array.prototype.at],
]);

const stringMethods = new Map<string, Method>([
  ["includes", String.prototype.includes],
  ["indexOf", String.prototype.indexOf],
  ["slice", String.prototype.slice],
  ["concat", String.prototype.concat],
  ["at", String.prototype.at],
  ["split", String.prototype.split],
  ["trim", String.prototype.trim],
  ["trimStart", String.prototype.trimStart],
  ["trimEnd", String.prototype.trimEnd],
  ["toLowerCase", String.prototype.toLowerCase],
  ["toUpperCase", String.prototype.toUpperCase],
  ["startsWith", String.prototype.startsWith],
  ["endsWith", String.prototype.endsWith],
]);

const numberMethods = new Map<string, Method>([
  ["toFixed", Number.prototype.toFixed],
]);
/* oxlint-enable typescript/unbound-method */

const noMethods = new Map<string, Method>();

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
  ...arrayMethods.keys(),
  ...stringMethods.keys(),
  ...numberMethods.keys(),
]);

/**
 * `object[key]` of an expression: an own data property's value, or
 * `undefined` where there is none, as JavaScript gives a missing field.
 * Throws where JavaScript would (`null` or `undefined`), and for a getter
 * or a function.
 */
export const readMember = (
  object: unknown,
  key: string | number
): Json | undefined => {
  const name = String(key);
  if (object === null || object === undefined) {
    throw new TypeError(`Cannot read "${name}" of ${String(object)}.`);
  }
  if (typeof object !== "object" && typeof object !== "string") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (descriptor === undefined) {
    return undefined;
  }
  const value: unknown = descriptor.value;
  if (!("value" in descriptor) || typeof value === "function") {
    throw new TypeError(`Cannot read "${name}": not a data field.`);
  }
  // SAFETY: an own data field, no function, of a run's JSON values (the
  // run host's contract) or of what the expression built from them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return value as Json | undefined;
};

/** The built-ins an expression may call on `receiver`, by its kind. */
const methodsOf = (receiver: unknown): ReadonlyMap<string, Method> => {
  if (
    Array.isArray(receiver) &&
    Object.getPrototypeOf(receiver) === Array.prototype
  ) {
    return arrayMethods;
  }
  if (typeof receiver === "string") {
    return stringMethods;
  }
  if (typeof receiver === "number") {
    return numberMethods;
  }
  return noMethods;
};

/**
 * `receiver.name(...args)` of an expression: an allowed built-in, on a
 * real array, string or number. Throws for anything else, and for a
 * callback method not given exactly one function, or another given one.
 */
export const callMethod = (
  receiver: unknown,
  name: string,
  args: readonly unknown[]
): Json | undefined => {
  const method = methodsOf(receiver).get(name);
  if (method === undefined) {
    throw new TypeError(`\`${name}\` can't be called on this value.`);
  }
  const fits = callbackMethods.has(name)
    ? args.length === 1 && typeof args[0] === "function"
    : args.every((arg) => typeof arg !== "function");
  if (!fits) {
    throw new TypeError(`\`${name}\` was given the wrong arguments.`);
  }
  const result: unknown = Reflect.apply(method, receiver, args);
  // SAFETY: an allowed built-in's result on JSON values and what the
  // expression's own callbacks answered, which are built from them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return result as Json | undefined;
};

/** `value?.…` of an expression: the rest of the chain, unless `value` is nullish. */
export const optionalChain = (
  value: Json | undefined,
  rest: (value: Json) => Json | undefined
): Json | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  return rest(value);
};

/**
 * What an expression evaluates to: JSON, with `undefined` wherever it
 * read a missing field, in a list or object it wrote among them.
 */
export type ExpressionValue =
  | Json
  | undefined
  | readonly ExpressionValue[]
  | { readonly [key: string]: ExpressionValue };

/**
 * An expression's whole value as JSON, as `JSON.stringify` writes it:
 * `undefined`, which JSON has no value for, is `null` on its own and in a
 * list, and an object's member set to it is left out; a number JSON can't
 * write (`NaN`, `±Infinity`) is `null`, and `-0` is `0`. It takes any value
 * an expression evaluates to, so generated code runs every expression,
 * whatever its shape, through this one call.
 */
export const jsonValue = (value: ExpressionValue): Json => {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    // `+ 0` makes `-0` `0`, as JSON writes it.
    return Number.isFinite(value) ? value + 0 : null;
  }
  if (Array.isArray(value)) {
    return value.map((item: ExpressionValue) => jsonValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const members: [string, Json][] = [];
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) {
      members.push([key, jsonValue(member)]);
    }
  }
  return Object.fromEntries(members);
};
