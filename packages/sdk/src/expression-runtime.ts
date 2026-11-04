/**
 * What a workflow expression's generated code runs through (`code` of
 * `checkExpression`, expression-lowering.ts). The syntactic check refuses
 * what it can name; these guard what it can't, at run time:
 *
 * - `checkJson` runs first, on every root the expression reads, on every
 *   evaluation: each must be JSON data (null, booleans, finite numbers,
 *   strings, and arrays and objects of `Array.prototype` and
 *   `Object.prototype` or none, with only own data properties under
 *   string keys), or the expression throws before it reads anything.
 * - `readMember`, every member read, gives only a value's own data
 *   property (an array's or string's `length` among them), never through
 *   the prototype chain, never a getter's result, never a function.
 * - `callMethod`, every method call, calls an allowed built-in, captured
 *   when this module loads, only on a real array, string or number, so
 *   `{ indexOf, length: 1e15 }` can't stand in for an array. A callback
 *   method takes exactly one function, the arrow the expression wrote
 *   there; others take none.
 * - `spreadValue`, every `...`, spreads only a plain array or an object
 *   of own data properties.
 * - `optionalChain`, every `?.` link, runs the rest of the chain only for
 *   a value that isn't nullish.
 *
 * What holds, then: every value an expression holds is JSON data, built
 * from its roots, its literals, these guards' results, or the arrays and
 * objects it writes from those; and the only functions are the arrows it
 * writes as callbacks, which go straight to `callMethod`. So no
 * expression can hold a built-in method to file under an allowed name
 * (`{ at: [].forEach }.at(…)`), and the operators, templates and
 * conversions it applies (`${value}`, `+`, `<`) find only the built-in
 * `Object.prototype` and `Array.prototype` methods, never a function of
 * the data's: a field named `toString` or `then` holds data.
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

/**
 * The values of an array's or object's own properties, when they are all
 * data under string keys (an array's `length` left out); `undefined` when
 * any is a getter or setter or has a symbol for its key.
 */
const ownData = (value: object): unknown[] | undefined => {
  const values: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor =
      typeof key === "string"
        ? Object.getOwnPropertyDescriptor(value, key)
        : undefined;
    if (descriptor === undefined || !("value" in descriptor)) {
      return undefined;
    }
    if (!(key === "length" && Array.isArray(value))) {
      values.push(descriptor.value);
    }
  }
  return values;
};

/** Whether `value` is an array or object `ownData` holds to. */
const isContainer = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  (isArray(value) || isPlainObject(value));

/**
 * Throws unless every one of `roots` is JSON data, all the way down:
 * null, undefined, booleans, numbers and strings, and arrays and objects
 * (`isContainer`) of own data properties under string keys. Generated
 * code calls it first, with the roots the expression reads.
 */
export const checkJson = (...roots: unknown[]): void => {
  const pending = [...roots];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    const type = typeof value;
    if (
      value === null ||
      type === "undefined" ||
      type === "boolean" ||
      type === "number" ||
      type === "string"
    ) {
      continue;
    }
    if (!isContainer(value)) {
      throw new TypeError("An expression's value is not JSON data.");
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    const values = ownData(value);
    if (values === undefined) {
      throw new TypeError("An expression's value is not JSON data.");
    }
    for (const item of values) {
      pending.push(item);
    }
  }
};

/** `...value` of an expression: a plain array or object of own data only. */
export const spreadValue = (value: unknown): unknown => {
  if (!(isContainer(value) && ownData(value) !== undefined)) {
    throw new TypeError("Only an array or an object of data can be spread.");
  }
  return value;
};
