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
 * How deep and how big plain data may be by default: as deep as Cap'n
 * Web reads a message by default, the deepest any reader of ours takes
 * (a browser's connection, a screen's frame), and as big as the longest
 * message workerd's RPC or Cap'n Web carries. A bound on the walk and the
 * clone after it, not on what an App may answer, which its readers bound.
 */
export const plainDataBounds: ValueBounds = {
  depth: 256,
  size: 32 * 1024 * 1024,
};

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

/**
 * Takes one value an object holds, and what its key counts toward the
 * size; answers whether to go on to the next.
 */
type Visit = (held: unknown, keySize: number) => boolean;

/** Visits a property's value, if it has one: a getter holds nothing. */
const visitProperty = (value: object, key: string, visit: Visit): boolean => {
  const property = Reflect.getOwnPropertyDescriptor(value, key);
  return property !== undefined && "value" in property
    ? visit(property.value, key.length)
    : true;
};

/** Visits an object's own enumerable keys and values, until told to stop. */
const visitOwn = (value: object, visit: Visit): void => {
  // `for...in`, not a list of all the keys made first; the prototype is
  // `Object.prototype` or `null`, so it adds no key, and inherited ones
  // are passed over anyway.
  for (const key in value) {
    if (Object.hasOwn(value, key) && !visitProperty(value, key, visit)) {
      return;
    }
  }
};

/**
 * Visits what an error holds: every own data property, enumerable or not
 * (Cap'n Web gives an `AggregateError` its `errors`, and an error its
 * `cause`, as properties `Object.keys` doesn't list), but its message,
 * counted at its own level (`ownSize`), and its stack, which isn't
 * counted: the runtime makes one up for an error the sender sent none for.
 */
const visitError = (error: Error, visit: Visit): void => {
  for (const key of Object.getOwnPropertyNames(error)) {
    if (
      key !== "message" &&
      key !== "stack" &&
      !visitProperty(error, key, visit)
    ) {
      return;
    }
  }
};

/**
 * Visits what an object holds, as Cap'n Web and structured clone carry
 * it, one value at a time, until `visit` says to stop: an array's
 * elements, a map's keys and values, a set's members, a plain object's
 * own enumerable keys and values, an error's as `visitError` says. A leaf
 * holds nothing. Whether it is of a kind that is measured.
 */
const visitHeld = (value: object, visit: Visit): boolean => {
  // By its own prototype, exactly a built-in one, and nothing it says of
  // itself. A value's prototype can be set to another value (Cap'n Web
  // puts a referred value in place under the key it was sent as,
  // `__proto__` too), and what a prototype holds is read through the
  // object: so an object of no kind measured here is refused, never a
  // leaf.
  const prototype: unknown = Reflect.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      return false;
    }
    for (const held of value) {
      if (!visit(held, 0)) {
        break;
      }
    }
    return true;
  }
  if (value instanceof Map) {
    if (prototype !== Map.prototype) {
      return false;
    }
    for (const [key, held] of value) {
      if (!(visit(key, 0) && visit(held, 0))) {
        break;
      }
    }
    return true;
  }
  if (value instanceof Set) {
    if (prototype !== Set.prototype) {
      return false;
    }
    for (const held of value) {
      if (!visit(held, 0)) {
        break;
      }
    }
    return true;
  }
  if (value instanceof Error) {
    if (!errorPrototypes.has(prototype)) {
      return false;
    }
    visitError(value, visit);
    return true;
  }
  if (prototype === Object.prototype || prototype === null) {
    visitOwn(value, visit);
    return true;
  }
  return leafPrototypes.has(prototype);
};

/**
 * What a value counts toward a size by itself, apart from what it holds:
 * a string its length, bytes theirs, an error its name and message.
 */
const ownSize = (value: unknown): number => {
  if (typeof value === "string") {
    return 1 + value.length;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return 1 + value.byteLength;
  }
  if (
    value instanceof Error &&
    errorPrototypes.has(Reflect.getPrototypeOf(value))
  ) {
    return 1 + value.name.length + value.message.length;
  }
  return 1;
};

/** Where a walk is: the values waiting, and the size counted so far. */
interface Walk {
  readonly pending: { value: unknown; level: number }[];
  size: number;
}

/**
 * Queues what `value`, at `level`, holds, one member at a time, and
 * stops at the first that passes a bound: the bound it passed, `kind` for
 * an object of no kind measured, or nothing.
 */
const queueHeld = (
  walk: Walk,
  value: object,
  level: number,
  bounds: ValueBounds
): PassedBound | undefined => {
  let passed: PassedBound | undefined;
  const measured = visitHeld(value, (held, keySize) => {
    if (level >= bounds.depth) {
      passed = "depth";
      return false;
    }
    walk.size += keySize;
    walk.pending.push({ value: held, level: level + 1 });
    // Each value waiting counts at least one toward the size.
    if (walk.size + walk.pending.length > bounds.size) {
      passed = "size";
      return false;
    }
    return true;
  });
  return measured ? passed : "kind";
};

/**
 * The bound `values` pass together, if any: each is measured from level
 * 1, and their sizes add up. Walked with a stack of its own, one value at
 * a time, and an object's members one at a time too: it stops at the
 * first that passes a bound, so a value costs no more to measure than its
 * bounds, however wide. A value held twice counts twice, as it would
 * travel. A value that holds itself passes the depth.
 */
export const passedBound = (
  values: readonly unknown[],
  bounds: ValueBounds
): PassedBound | undefined => {
  const walk: Walk = {
    pending: values.map((value) => ({ value, level: 1 })),
    size: 0,
  };
  while (walk.pending.length > 0) {
    const next = walk.pending.pop();
    if (next === undefined) {
      break;
    }
    const { value, level } = next;
    walk.size += ownSize(value);
    if (walk.size > bounds.size) {
      return "size";
    }
    if (typeof value === "object" && value !== null) {
      const passed = queueHeld(walk, value, level, bounds);
      if (passed !== undefined) {
        return passed;
      }
    }
  }
  return undefined;
};
