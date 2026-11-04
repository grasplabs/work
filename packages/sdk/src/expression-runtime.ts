/**
 * What a workflow expression's generated code reads and calls through
 * (`compileExpression` in expression-check.ts): every member read is
 * `readMember`, every method call `callMethod`, every `?.` link
 * `optionalChain`. The syntactic check refuses what it can name; these
 * guard what it can't, at run time, wherever the expression's values
 * came from:
 *
 * - `readMember` gives only a value's own data properties (an array's or
 *   string's `length` among them), never through the prototype chain,
 *   never a getter's result, and never a function. No expression can
 *   hold a function value, so none can file a built-in under an allowed
 *   name in an object literal (`{ at: [].forEach }`) or hand one to an
 *   implicit conversion (`toString`, `valueOf`, `toJSON`, `then`).
 * - `callMethod` calls an allowed built-in, captured when this module
 *   loads, only on a real array, string or number, so `{ indexOf, length:
 *   1e15 }` can't stand in for an array. A callback method takes exactly
 *   one function, the arrow the expression wrote there; others take none.
 *
 * Only plain data passes: arrays and objects of `Object.prototype` (or
 * none), strings, numbers, booleans and null, as a run's JSON values
 * are, and the arrays and objects an expression builds from them.
 */

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

const isArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * `object[key]` of an expression: an own data property's value, or
 * `undefined` where there is none, as JavaScript gives a missing field.
 * Throws where JavaScript would (`null` or `undefined`), and where the
 * value isn't plain data: a getter, a function, or an object of a class.
 */
export const readMember = (object: unknown, key: string | number): unknown => {
  const name = String(key);
  if (object === null || object === undefined) {
    throw new TypeError(`Cannot read "${name}" of ${String(object)}.`);
  }
  if (typeof object === "number" || typeof object === "boolean") {
    return undefined;
  }
  if (
    typeof object !== "string" &&
    !(typeof object === "object" && (isArray(object) || isPlainObject(object)))
  ) {
    throw new TypeError(`Cannot read "${name}": not a JSON value.`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (descriptor === undefined) {
    return undefined;
  }
  if (!("value" in descriptor)) {
    throw new TypeError(`Cannot read "${name}": not a data property.`);
  }
  const value: unknown = descriptor.value;
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Cannot read "${name}": not a JSON value.`);
  }
  return value;
};

/** The built-ins an expression may call on `receiver`, by its kind. */
const methodsOf = (receiver: unknown): ReadonlyMap<string, Method> => {
  if (isArray(receiver)) {
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
): unknown => {
  const method = methodsOf(receiver).get(name);
  if (method === undefined) {
    throw new TypeError(`\`${name}\` can't be called on this value.`);
  }
  const functions = args.filter((arg) => typeof arg === "function").length;
  const expected = callbackMethods.has(name) ? 1 : 0;
  if (functions !== expected || (expected === 1 && args.length !== 1)) {
    throw new TypeError(
      expected === 1
        ? `\`${name}\` takes one arrow function.`
        : `\`${name}\` takes no function.`
    );
  }
  return Reflect.apply(method, receiver, args);
};

/** `value?.…` of an expression: the rest of the chain, unless `value` is nullish. */
export const optionalChain = (
  value: unknown,
  rest: (value: unknown) => unknown
): unknown => (value === null || value === undefined ? undefined : rest(value));
