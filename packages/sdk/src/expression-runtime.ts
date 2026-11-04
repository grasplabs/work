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
 *
 * The run host's contract: an expression's roots (input, step outputs,
 * params, the run) are JSON values, as it stores and replays them. So
 * they hold no getters or functions of their own, and the only functions
 * an expression holds are the arrows it writes as callbacks.
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

/**
 * `object[key]` of an expression: an own data property's value, or
 * `undefined` where there is none, as JavaScript gives a missing field.
 * Throws where JavaScript would (`null` or `undefined`), and for a getter
 * or a function.
 */
export const readMember = (object: unknown, key: string | number): unknown => {
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
  return value;
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
): unknown => {
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
  return Reflect.apply(method, receiver, args);
};

/** `value?.…` of an expression: the rest of the chain, unless `value` is nullish. */
export const optionalChain = (
  value: unknown,
  rest: (value: unknown) => unknown
): unknown => (value === null || value === undefined ? undefined : rest(value));
