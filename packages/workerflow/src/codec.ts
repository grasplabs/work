// The journal's value codec: params, step results and run outputs as text,
// so a run's journal can be read back by any later process, exported or
// moved, and never holds anything live (a function, an RPC stub, an object
// of some class whose behaviour would not come back with it).
//
// The text is JSON: `[version, node]`. Strings, booleans, null and finite
// numbers are themselves; every other value is an array whose first element
// names what it is, so no plain value can be mistaken for a tagged one:
//
//   ["A", ...items]          array
//   ["O", key, value, ...]   plain object (own enumerable string keys)
//   ["U"]                    undefined
//   ["N", "NaN" | "Infinity" | "-Infinity" | "-0"]
//   ["I", "123"]             bigint
//   ["D", ms | null]         Date (null: an invalid date)
//   ["B", base64]            Uint8Array
//   ["R", base64]            ArrayBuffer
//   ["M", key, value, ...]   Map
//   ["S", ...items]          Set
//
// Anything else is refused when it is encoded, before it reaches the
// journal: a version that can't hold a value never pretends it did.

export const codecVersion = 1;

/** Cloudflare Workflows' limit on what one step may return. */
export const maxEncodedBytes = 1024 * 1024;

/** A value the codec can't keep: the step or run fails with it. */
export class SerializationError extends TypeError {
  override readonly name = "SerializationError";
}

type Node = null | boolean | number | string | Node[];

const specialNumbers = new Map<string, number>([
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["-0", -0],
]);

/** btoa takes a binary string; built in pieces so large inputs fit. */
const base64Chunk = 0x80_00;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += base64Chunk) {
    binary += String.fromCodePoint(
      ...bytes.subarray(offset, offset + base64Chunk)
    );
  }
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0);

/**
 * Whether `value` is exactly of the built-in kind, not a subclass of it: a
 * subclass's own behaviour would not come back after a decode. Its content
 * is then read through the built-in's own methods and internal slots, never
 * through anything the value itself carries: an own `getTime`, iterator or
 * `entries` can't change or hide what is kept. Own properties beyond the
 * content are not kept, as structured clone doesn't keep them either.
 */
const isExactly = (value: object, prototype: object): boolean =>
  Object.getPrototypeOf(value) === prototype;

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** A name for the kind of `value`, for the message; never throws. */
const kindOf = (value: object): string => {
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    const maker =
      typeof prototype === "object" &&
      prototype !== null &&
      "constructor" in prototype
        ? prototype.constructor
        : undefined;
    const name: unknown = typeof maker === "function" ? maker.name : undefined;
    return typeof name === "string" ? name : "object";
  } catch {
    return "object";
  }
};

const encodeNumber = (value: number): Node => {
  if (Object.is(value, -0)) {
    return ["N", "-0"];
  }
  return Number.isFinite(value) ? value : ["N", String(value)];
};

/** Encodes one object; `ancestors` catches a value that contains itself. */
const encodeObject = (
  value: object,
  path: string,
  ancestors: Set<object>
): Node => {
  if (ancestors.has(value)) {
    throw new SerializationError(`${path} refers to itself`);
  }
  ancestors.add(value);
  const inner = (item: unknown, at: string): Node =>
    // oxlint-disable-next-line no-use-before-define -- the two recurse into each other
    encodeNode(item, at, ancestors);
  let node: Node;
  if (Array.isArray(value) && isExactly(value, Array.prototype)) {
    // By index and length, not the array's (possibly own) iterator.
    node = [
      "A",
      ...Array.from({ length: value.length }, (_, index): Node =>
        inner(value[index], `${path}[${index}]`)
      ),
    ];
  } else if (value instanceof Date && isExactly(value, Date.prototype)) {
    const time = Date.prototype.getTime.call(value);
    node = ["D", Number.isNaN(time) ? null : time];
  } else if (
    value instanceof Uint8Array &&
    isExactly(value, Uint8Array.prototype)
  ) {
    // Copied from its internal slots into a fresh array of our own.
    node = ["B", toBase64(new Uint8Array(value))];
  } else if (
    value instanceof ArrayBuffer &&
    isExactly(value, ArrayBuffer.prototype)
  ) {
    node = ["R", toBase64(new Uint8Array(value))];
  } else if (value instanceof Map && isExactly(value, Map.prototype)) {
    node = ["M"];
    for (const [key, item] of Map.prototype.entries.call(value)) {
      node.push(inner(key, `${path} key`), inner(item, `${path} value`));
    }
  } else if (value instanceof Set && isExactly(value, Set.prototype)) {
    node = [
      "S",
      ...Array.from(Set.prototype.values.call(value), (item) =>
        inner(item, `${path} item`)
      ),
    ];
  } else if (isPlainObject(value)) {
    node = ["O"];
    for (const [key, item] of Object.entries(value)) {
      node.push(key, inner(item, `${path}.${key}`));
    }
  } else {
    throw new SerializationError(
      `${path} is a ${kindOf(value)}, which a workflow can't keep: only plain objects, arrays, Dates, Maps, Sets and bytes are kept`
    );
  }
  ancestors.delete(value);
  return node;
};

const encodeNode = (
  value: unknown,
  path: string,
  ancestors: Set<object>
): Node => {
  switch (typeof value) {
    case "string":
    case "boolean": {
      return value;
    }
    case "number": {
      return encodeNumber(value);
    }
    case "undefined": {
      return ["U"];
    }
    case "bigint": {
      return ["I", value.toString()];
    }
    case "object": {
      return value === null ? null : encodeObject(value, path, ancestors);
    }
    case "function":
    case "symbol": {
      throw new SerializationError(
        `${path} is a ${typeof value}, which a workflow can't keep`
      );
    }
    default: {
      throw new SerializationError(
        `${path} is a ${typeof value}, which a workflow can't keep`
      );
    }
  }
};

/** Encodes `value` for the journal; throws SerializationError if it can't. */
export const encode = (value: unknown): string => {
  const text = JSON.stringify([
    codecVersion,
    encodeNode(value, "the value", new Set()),
  ]);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxEncodedBytes) {
    throw new SerializationError(
      `the value takes ${bytes} bytes, more than the ${maxEncodedBytes} a workflow keeps`
    );
  }
  return text;
};

const corrupt = (detail: string): Error =>
  new Error(`The journal holds a value this codec can't read: ${detail}`);

const pairs = (items: Node[]): [Node, Node][] => {
  if (items.length % 2 !== 0) {
    throw corrupt("an odd number of key and value entries");
  }
  const result: [Node, Node][] = [];
  for (let index = 0; index < items.length; index += 2) {
    result.push([items[index] ?? null, items[index + 1] ?? null]);
  }
  return result;
};

const decodeTagged = (tag: string, rest: Node[]): unknown => {
  // oxlint-disable-next-line no-use-before-define -- the two recurse into each other
  const inner = (item: Node): unknown => decodeNode(item);
  switch (tag) {
    case "A": {
      return rest.map((item) => inner(item));
    }
    case "O": {
      const object: Record<string, unknown> = {};
      for (const [key, item] of pairs(rest)) {
        if (typeof key !== "string") {
          throw corrupt("an object key that isn't a string");
        }
        // defineProperty, so a key named __proto__ stays a key.
        Object.defineProperty(object, key, {
          value: inner(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return object;
    }
    case "U": {
      return undefined;
    }
    case "N": {
      const [name] = rest;
      const number =
        typeof name === "string" ? specialNumbers.get(name) : undefined;
      if (number === undefined) {
        throw corrupt(`the number ${JSON.stringify(name)}`);
      }
      return number;
    }
    case "I": {
      const [digits] = rest;
      if (typeof digits !== "string") {
        throw corrupt("a bigint without digits");
      }
      return BigInt(digits);
    }
    case "D": {
      const [time] = rest;
      return new Date(typeof time === "number" ? time : Number.NaN);
    }
    case "B":
    case "R": {
      const [text] = rest;
      if (typeof text !== "string") {
        throw corrupt("bytes without base64");
      }
      const bytes = fromBase64(text);
      return tag === "B" ? bytes : bytes.buffer;
    }
    case "M": {
      return new Map(
        pairs(rest).map(([key, item]) => [inner(key), inner(item)])
      );
    }
    case "S": {
      return new Set(rest.map((item) => inner(item)));
    }
    default: {
      throw corrupt(`the tag ${JSON.stringify(tag)}`);
    }
  }
};

const decodeNode = (node: Node): unknown => {
  if (!Array.isArray(node)) {
    return node;
  }
  const [tag, ...rest] = node;
  if (typeof tag !== "string") {
    throw corrupt(`a value tagged ${JSON.stringify(tag)}`);
  }
  return decodeTagged(tag, rest);
};

const isNode = (value: unknown): value is Node =>
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string" ||
  (Array.isArray(value) && value.every((item) => isNode(item)));

/** The node of codec text, checked: its version and its shape. */
const readNode = (text: string): Node => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed[0] !== codecVersion) {
    throw corrupt(
      `codec version ${JSON.stringify(Array.isArray(parsed) ? parsed[0] : parsed)}`
    );
  }
  const node: unknown = parsed[1];
  if (!isNode(node)) {
    throw corrupt("an object where only arrays and scalars are written");
  }
  return node;
};

/** Sorts each plain object's keys; Map, Set and array order stays. */
const canonicalNode = (node: Node): Node => {
  if (!Array.isArray(node)) {
    return node;
  }
  const [tag, ...rest] = node;
  if (tag !== "O") {
    return [tag ?? null, ...rest.map((item) => canonicalNode(item))];
  }
  const entries: [string, Node][] = [];
  for (let index = 0; index < rest.length; index += 2) {
    entries.push([String(rest[index]), canonicalNode(rest[index + 1] ?? null)]);
  }
  // By code unit, the same in every runtime (not locale order).
  entries.sort(([a], [b]) => (a < b ? -1 : Number(a > b)));
  return ["O", ...entries.flat()];
};

/**
 * Codec text with every plain object's keys in sorted order, so two
 * encodings of the same value compare equal however their keys were
 * ordered. A Map's entries, a Set's items and an array's elements keep
 * their order: the codec keeps it, and it is part of the value.
 */
export const canonical = (text: string): string =>
  JSON.stringify([codecVersion, canonicalNode(readNode(text))]);

/** Decodes what `encode` made: a fresh value, every time. */
export const decode = (text: string): unknown => decodeNode(readNode(text));
