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

/** Which bound a value passed. */
export type PassedBound = "depth" | "size";

/** Whether `value` is an object written with braces, and nothing more. */
const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * What an object holds, as Cap'n Web and structured clone carry it: an
 * array's elements, a map's keys and values, a set's members, a plain
 * object's or an error's own enumerable keys and values (an error's name,
 * message and stack are strings, counted as its keys' values). A getter
 * is held as nothing: it is never run. Anything else holds nothing that
 * is walked.
 */
const heldBy = (value: object): { keys: number; held: unknown[] } => {
  if (Array.isArray(value)) {
    return { keys: 0, held: value };
  }
  if (value instanceof Map) {
    const held: unknown[] = [];
    for (const [key, inner] of value) {
      held.push(key, inner);
    }
    return { keys: 0, held };
  }
  if (value instanceof Set) {
    return { keys: 0, held: [...value] };
  }
  if (!(value instanceof Error || isPlainObject(value))) {
    return { keys: 0, held: [] };
  }
  let keys = 0;
  const held: unknown[] = [];
  for (const key of Object.keys(value)) {
    keys += key.length;
    const property = Reflect.getOwnPropertyDescriptor(value, key);
    if (property !== undefined && "value" in property) {
      held.push(property.value);
    }
  }
  if (value instanceof Error) {
    held.push(value.name, value.message, value.stack);
  }
  return { keys, held };
};

/** What a value counts toward a size by itself, apart from what it holds. */
const ownSize = (value: unknown): number => {
  if (typeof value === "string") {
    return 1 + value.length;
  }
  if (ArrayBuffer.isView(value)) {
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
    const { keys, held } = heldBy(value);
    size += keys;
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
