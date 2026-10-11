// How deep and how big a value is, measured without recursion: what
// arrives from an untrusted side is measured before anything walks it
// recursively (a schema, a clone, a measure of its bytes), so the measure
// itself can't exhaust the stack, and stops as soon as a bound is passed,
// so a value built to be expensive costs no more than its bound.

/** How deep a value may nest, and how much it may hold. */
export interface ValueBounds {
  /** Levels, its leaf included: a leaf alone is 1, `[leaf]` is 2. */
  readonly depth: number;
  /**
   * What it holds, in UTF-16 code units, as Cap'n Web measures a message:
   * one for each value in it, plus each string's and each object key's
   * length, plus each byte array's length. That is never more than the
   * shortest text that writes the value down, so a value one message
   * could carry is within a size as large as that message.
   */
  readonly size: number;
}

/**
 * Which bound a value passed: too deep, too big, or holding an object of
 * a kind it can't be measured by (an unknown prototype).
 */
export type PassedBound = "depth" | "size" | "kind";

/**
 * The global constructors whose instances are leaves: what Cap'n Web and
 * structured clone carry that holds no value to walk. Not a stream, nor a
 * request or a response, which carry one: what it streams would arrive
 * unchecked, chunk by chunk, so none is taken. A method that is to read
 * one must take it apart from this, and bound each chunk itself. Looked up by name,
 * as not every runtime has every one.
 */
const leafConstructors = [
  "Date",
  "ArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  // How Cap'n Web reads bytes where the runtime has Node's Buffer.
  "Buffer",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Blob",
  "Headers",
  "URL",
] as const;

/** The error classes Cap'n Web rebuilds an error as, and structured clone. */
const errorConstructors = [
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
] as const;

/** The prototypes of what `names` name, of those this runtime has. */
const prototypesOf = (names: readonly string[]): Set<unknown> => {
  const prototypes = new Set<unknown>();
  for (const name of names) {
    const constructor: unknown = Reflect.get(globalThis, name);
    if (typeof constructor === "function") {
      prototypes.add(Reflect.get(constructor, "prototype"));
    }
  }
  return prototypes;
};

const leafPrototypes = prototypesOf(leafConstructors);
const errorPrototypes = prototypesOf(errorConstructors);

/** What an object holds that is walked, and what it counts by itself. */
interface Held {
  /** Its keys' lengths, and an error's name and message, toward the size. */
  size: number;
  /** The values it holds, each a level deeper. */
  held: unknown[];
}

/** An object's own enumerable keys and values; a getter holds nothing. */
const ownEntries = (value: object): Held => {
  let size = 0;
  const held: unknown[] = [];
  for (const key of Object.keys(value)) {
    size += key.length;
    const property = Reflect.getOwnPropertyDescriptor(value, key);
    if (property !== undefined && "value" in property) {
      held.push(property.value);
    }
  }
  return { size, held };
};

/**
 * What an error holds: every own data property, enumerable or not (Cap'n
 * Web gives an `AggregateError` its `errors`, and an error its `cause`,
 * as properties `Object.keys` doesn't list), each a level deeper, but its
 * message, which counts toward its size at its own level with its name,
 * and its stack, which isn't counted: the runtime makes one up for an
 * error the sender sent none for.
 */
const errorHeld = (error: Error): Held => {
  let size = error.name.length + error.message.length;
  const held: unknown[] = [];
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key !== "message" && key !== "stack") {
      size += key.length;
      const property = Reflect.getOwnPropertyDescriptor(error, key);
      if (property !== undefined && "value" in property) {
        held.push(property.value);
      }
    }
  }
  return { size, held };
};

/**
 * What an object holds, as Cap'n Web and structured clone carry it: an
 * array's elements, a map's keys and values, a set's members, a plain
 * object's own enumerable keys and values, an error's as `errorHeld`
 * says. A leaf holds nothing; an object of an unknown kind is
 * `undefined`.
 */
const heldBy = (value: object): Held | undefined => {
  // By its own prototype, exactly a built-in one, and nothing it says of
  // itself. A value's prototype can be set to another value (Cap'n Web
  // puts a referred value in place under the key it was sent as,
  // `__proto__` too), and what a prototype holds is read through the
  // object: so an object of no kind measured here is refused, never a
  // leaf.
  const prototype: unknown = Reflect.getPrototypeOf(value);
  if (Array.isArray(value)) {
    return prototype === Array.prototype ? { size: 0, held: value } : undefined;
  }
  if (value instanceof Map) {
    if (prototype !== Map.prototype) {
      return undefined;
    }
    const held: unknown[] = [];
    for (const [key, inner] of value) {
      held.push(key, inner);
    }
    return { size: 0, held };
  }
  if (value instanceof Set) {
    return prototype === Set.prototype
      ? { size: 0, held: [...value] }
      : undefined;
  }
  if (value instanceof Error) {
    return errorPrototypes.has(prototype) ? errorHeld(value) : undefined;
  }
  if (prototype === Object.prototype || prototype === null) {
    return ownEntries(value);
  }
  return leafPrototypes.has(prototype) ? { size: 0, held: [] } : undefined;
};

/** What a value counts toward a size by itself, apart from what it holds. */
const ownSize = (value: unknown): number => {
  if (typeof value === "string") {
    return 1 + value.length;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return 1 + value.byteLength;
  }
  return 1;
};

/**
 * The bound `values` pass together, if any: each is measured from level
 * 1, and their sizes add up. Walked with a stack of its own, one value at
 * a time; a value held twice counts twice, as it would travel. A value
 * that holds itself passes the depth.
 */
export const passedBound = (
  values: readonly unknown[],
  bounds: ValueBounds
): PassedBound | undefined => {
  const pending: { value: unknown; level: number }[] = values.map((value) => ({
    value,
    level: 1,
  }));
  let size = 0;
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) {
      break;
    }
    const { value, level } = next;
    size += ownSize(value);
    if (size > bounds.size) {
      return "size";
    }
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const contents = heldBy(value);
    if (contents === undefined) {
      return "kind";
    }
    const { held } = contents;
    size += contents.size;
    if (size > bounds.size) {
      return "size";
    }
    if (held.length > 0 && level >= bounds.depth) {
      return "depth";
    }
    // One at a time, not spread: a long array would pass too many
    // arguments at once. Each counts at least one toward the size, so no
    // more are pushed than the size has room for.
    for (const inner of held) {
      pending.push({ value: inner, level: level + 1 });
      if (pending.length > bounds.size - size) {
        return "size";
      }
    }
  }
  return undefined;
};
