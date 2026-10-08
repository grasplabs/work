// The journal's value codec: params, step results and run outputs as text,
// so a run's journal can be read back by any later process, exported or
// moved, and never holds anything live (a function, an RPC stub, a host
// object whose state lives outside the isolate).
//
// What it keeps is what Cloudflare Workflows keeps of a step's result,
// structured clone: primitives, arrays (holes too), plain objects, Dates,
// RegExps, Maps, Sets, ArrayBuffers, every typed array, DataViews, boxed
// primitives and errors, with shared and cyclic references as they were
// (a view and its own buffer stay one buffer). As structured clone does,
// an instance of a class of the author's own comes back as a plain object
// of its own enumerable data, and a subclass of a built-in as the
// built-in. Named differences:
//
// - An error keeps its name (any name, where structured clone keeps only
//   the standard ones), its message and its safe code (errors.ts); not its
//   stack or cause.
// - Nesting deeper than `maxNestingDepth` is refused, rather than left to
//   the stack.
// - Runs of array holes count a byte each against the size limit, so a
//   sparse array of more than about a million holes is refused.
//
// Size follows Cloudflare's rule, 1 MiB of the value as structured clone
// keeps it: bytes at their length, a string at one byte a character when
// every character fits in one (Latin-1) and two otherwise, and a little
// for every other value. The text kept is a different measure: it must
// also fit a SQLite value (`maxStoredTextBytes`), which a string of
// characters JSON escapes (quotes, control characters) can outgrow.
//
// The text is JSON: `[version, node]`. Strings, booleans, null and finite
// numbers are themselves; every other value is an array whose first element
// names what it is, so no plain value can be mistaken for a tagged one:
//
//   ["A", ...items]            array; an item ["H", n] is a run of n holes
//   ["O", key, value, ...]     plain object (own enumerable string keys)
//   ["U"]                      undefined
//   ["N", "NaN" | "Infinity" | "-Infinity" | "-0"]
//   ["I", "123"]               bigint
//   ["D", ms | null]           Date (null: an invalid date)
//   ["X", source, flags]       RegExp
//   ["R", base64]              ArrayBuffer
//   ["T", kind, buffer, byteOffset, length]
//                              typed array (kind: its class's name) over
//                              the ArrayBuffer node `buffer`
//   ["V", buffer, byteOffset, byteLength]   DataView
//   ["W", node]                a boxed boolean, number, string or bigint
//   ["E", name, message, code | null]   error
//   ["M", key, value, ...]     Map
//   ["S", ...items]            Set
//   ["P", index]               the index-th object met before, in the
//                              order objects are first met: shared or cyclic
//   ["Z", attempt, chunks, length, sha256, chunkDigest, encoding]
//                              a step's stream result, kept in the run's
//                              storage (streams.ts); only ever a step's
//                              whole result, never inside a value
//
// Anything else is refused when it is encoded, before it reaches the
// journal: a version that can't hold a value never pretends it did.
//
// A value's kind and content are read through the built-ins' own getters
// and methods, kept as this module loads, and their internal slots: an own
// `getTime`, iterator, `buffer` or `byteLength` on a value can't change or
// hide what is kept, and an object that only borrows a built-in's
// prototype is read as the plain object it is.
import {
  arrayBufferLength,
  brand,
  dataViewLength,
  getterOf,
  invoke,
  isDetached,
  methodOf,
  notOfKind,
  typedArrayKind,
  viewOf,
} from "./builtins.ts";
import type { Intrinsic, ViewParts } from "./builtins.ts";
import { errorParts, errorRecord, namedError, safeCode } from "./errors.ts";

/**
 * The format's version; a change to the format is a new one. No journal
 * predates version 2 (nothing earlier was released), so text of any other
 * version is refused, not read; a later format that changes it brings its
 * own upgrade of the text before it.
 */
export const codecVersion = 2;

/**
 * Cloudflare Workflows' limit on what one step may return, of the value as
 * structured clone keeps it (see above for how it is counted).
 */
export const maxEncodedBytes = 1024 * 1024;

/**
 * The most text one value may take in the journal, in UTF-8 bytes: inside
 * a SQLite value of a Durable Object (2 MB), with room for its row.
 */
export const maxStoredTextBytes = 1_900_000;

/** How deep values may nest, objects inside objects. */
export const maxNestingDepth = 512;

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

// The built-ins' own getters and methods, kept as this module loads.

const mapSize = getterOf(Map.prototype, "size");
const setSize = getterOf(Set.prototype, "size");
const regExpSource = getterOf(RegExp.prototype, "source");
/** In the order `RegExp.prototype.flags` lists them. */
const regExpFlags: [string, Intrinsic][] = (
  [
    ["d", "hasIndices"],
    ["g", "global"],
    ["i", "ignoreCase"],
    ["m", "multiline"],
    ["s", "dotAll"],
    ["u", "unicode"],
    ["v", "unicodeSets"],
    ["y", "sticky"],
  ] as const
).flatMap(([flag, key]) =>
  Object.getOwnPropertyDescriptor(RegExp.prototype, key)?.get === undefined
    ? []
    : [[flag, getterOf(RegExp.prototype, key)]]
);
const getTime = methodOf(Date.prototype, "getTime");
const mapForEach = methodOf(Map.prototype, "forEach");
const setForEach = methodOf(Set.prototype, "forEach");
const isPrototypeOf = methodOf(Object.prototype, "isPrototypeOf");
const hasOwnProperty = methodOf(Object.prototype, "hasOwnProperty");
const functionSource = methodOf(Function.prototype, "toString");
const errorPrototype = Error.prototype;
/** `Error.isError`, where the runtime has it: an error by its slot. */
const errorBrand: unknown = Reflect.get(Error, "isError");

/** The boxed primitives structured clone keeps; a boxed symbol isn't one. */
const boxes: Intrinsic[] = [
  Boolean.prototype,
  Number.prototype,
  String.prototype,
  BigInt.prototype,
].map((prototype) => methodOf(prototype, "valueOf"));
const symbolValue = methodOf(Symbol.prototype, "valueOf");

interface ViewKind {
  readonly prototype: object;
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): object;
}

const isViewKind = (value: unknown): value is ViewKind =>
  typeof value === "function" &&
  typeof Reflect.get(value, "BYTES_PER_ELEMENT") === "number";

/** Every typed array class this runtime has, by name. */
const viewKinds = new Map<string, ViewKind>(
  [
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    // Newer runtimes only.
    "Float16Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ].flatMap((name): [string, ViewKind][] => {
    const kind: unknown = Reflect.get(globalThis, name);
    return isViewKind(kind) ? [[name, kind]] : [];
  })
);

/**
 * The built-in classes structured clone keeps, as themselves or (for an
 * object that only borrows their prototype) as a plain object. Any other
 * class of the runtime's own (a URL, a Promise, a stream, an RPC stub) is
 * a host object it refuses, and so does the codec.
 */
const cloneable = new Set<unknown>([
  ...[
    "Object",
    "Array",
    "Date",
    "RegExp",
    "Map",
    "Set",
    "ArrayBuffer",
    "DataView",
    "Boolean",
    "Number",
    "String",
    "BigInt",
    "Error",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
    "AggregateError",
    ...viewKinds.keys(),
  ].map((name): unknown => Reflect.get(globalThis, name)),
  // %TypedArray%, which every typed array class extends.
  Reflect.getPrototypeOf(Uint8Array),
]);

const nativeSource = /\{\s*\[native code\]\s*\}\s*$/u;

/** Whether `maker` is a class of the runtime's own, not of any author's. */
const isNative = (maker: unknown): boolean => {
  if (typeof maker !== "function") {
    return false;
  }
  const source = invoke(functionSource, maker);
  return typeof source === "string" && nativeSource.test(source);
};

/** Prototype chains longer than this aren't walked further. */
const maxChain = 64;

/**
 * The runtime's own class on `value`'s prototype chain that structured
 * clone refuses, if there is one: a host object, whatever class of the
 * author's extends it.
 */
const hostClassOf = (value: object): unknown => {
  let prototype = Reflect.getPrototypeOf(value);
  for (let link = 0; prototype !== null && link < maxChain; link += 1) {
    const maker: unknown = Reflect.getOwnPropertyDescriptor(
      prototype,
      "constructor"
    )?.value;
    if (isNative(maker) && !cloneable.has(maker)) {
      return maker;
    }
    prototype = Reflect.getPrototypeOf(prototype);
  }
  return undefined;
};

const isError = (value: object): boolean =>
  typeof errorBrand === "function"
    ? Reflect.apply(errorBrand, Error, [value]) === true
    : invoke(isPrototypeOf, errorPrototype, value) === true;

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
    return typeof name === "string" && name !== "" ? name : "object";
  } catch {
    return "object";
  }
};

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

// oxlint-disable-next-line no-control-regex -- Latin-1 is exactly U+0000 to U+00FF
const beyondLatin1 = /[^\u0000-ÿ]/u;

/** A string's size as structured clone keeps it. */
const stringSize = (text: string): number =>
  beyondLatin1.test(text) ? text.length * 2 : text.length;

// Encoding

interface Encoder {
  /** Each object met so far, by the order it was first met. */
  readonly seen: Map<object, number>;
  /** The value's size so far, counted as Cloudflare's 1 MiB rule counts. */
  size: number;
  /** How deep the object being encoded sits. */
  depth: number;
  /** Writes plain objects' keys in code-unit order (canonical text). */
  readonly sortKeys: boolean;
}

const tooLarge = (bytes: number): SerializationError =>
  new SerializationError(
    `the value takes more than ${maxEncodedBytes} bytes (${bytes} so far), the most a workflow step may return`
  );

const count = (state: Encoder, bytes: number): void => {
  state.size += bytes;
  if (state.size > maxEncodedBytes) {
    throw tooLarge(state.size);
  }
};

const refuse = (value: object, path: string): never => {
  throw new SerializationError(
    `${path} is a ${kindOf(value)}, which a workflow can't keep: structured clone refuses it (a byte stream is kept only as a step's whole result)`
  );
};

type Inner = (item: unknown, at: string) => Node;

/** An ArrayBuffer's node; refused when it was transferred away. */
const encodeBuffer = (
  buffer: ArrayBuffer,
  path: string,
  state: Encoder
): Node => {
  if (isDetached(buffer)) {
    throw new SerializationError(`${path} is a detached ArrayBuffer`);
  }
  // Its internal slots, through the typed array constructor.
  const bytes = new Uint8Array(buffer);
  count(state, bytes.byteLength);
  return ["R", toBase64(bytes)];
};

/** A view's node: its buffer as an object of its own, shared or not. */
const encodeView = (
  value: object,
  parts: ViewParts,
  path: string,
  inner: Inner
): Node => {
  const kind = brand(typedArrayKind, value);
  const buffer = inner(parts.buffer, `${path}.buffer`);
  if (typeof kind !== "string") {
    return ["V", buffer, parts.byteOffset, parts.byteLength];
  }
  const view = viewKinds.get(kind);
  if (view === undefined) {
    return refuse(value, path);
  }
  return [
    "T",
    kind,
    buffer,
    parts.byteOffset,
    parts.byteLength / view.BYTES_PER_ELEMENT,
  ];
};

/** A built-in of fixed content: its node, or undefined if it isn't one. */
const encodeBuiltIn = (
  value: object,
  path: string,
  state: Encoder,
  inner: Inner
): Node | undefined => {
  if (brand(arrayBufferLength, value) !== notOfKind) {
    // SAFETY: the built-in getter just read its slot: an ArrayBuffer.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return encodeBuffer(value as ArrayBuffer, path, state);
  }
  if (
    typeof brand(typedArrayKind, value) === "string" ||
    brand(dataViewLength, value) !== notOfKind
  ) {
    const parts = viewOf(value);
    return parts === undefined
      ? refuse(value, path)
      : encodeView(value, parts, path, inner);
  }
  const time = brand(getTime, value);
  if (typeof time === "number") {
    return ["D", Number.isNaN(time) ? null : time];
  }
  const source = brand(regExpSource, value);
  if (typeof source === "string") {
    const flags = regExpFlags
      .filter(([, get]) => invoke(get, value) === true)
      .map(([flag]) => flag)
      .join("");
    count(state, stringSize(source) + flags.length);
    return ["X", source, flags];
  }
  return undefined;
};

/** An array's node, by index and length, holes kept as runs. */
const encodeArray = (
  value: unknown[],
  path: string,
  state: Encoder,
  inner: Inner
): Node => {
  const { length } = value;
  const node: Node[] = ["A"];
  let holes = 0;
  for (let index = 0; index < length; index += 1) {
    if (invoke(hasOwnProperty, value, index) === true) {
      if (holes > 0) {
        node.push(["H", holes]);
        holes = 0;
      }
      node.push(inner(value[index], `${path}[${index}]`));
    } else {
      // Counted, so a vast sparse array is refused rather than walked.
      count(state, 1);
      holes += 1;
    }
  }
  if (holes > 0) {
    node.push(["H", holes]);
  }
  return node;
};

/** A container, a box or an error: its node, or undefined. */
const encodeComposite = (
  value: object,
  path: string,
  state: Encoder,
  inner: Inner
): Node | undefined => {
  if (Array.isArray(value)) {
    return encodeArray(value, path, state, inner);
  }
  if (brand(mapSize, value) !== notOfKind) {
    const node: Node[] = ["M"];
    // The built-in forEach walks the entries in its internal slots.
    invoke(mapForEach, value, (item: unknown, key: unknown) => {
      node.push(inner(key, `${path} key`), inner(item, `${path} value`));
    });
    return node;
  }
  if (brand(setSize, value) !== notOfKind) {
    const node: Node[] = ["S"];
    invoke(setForEach, value, (item: unknown) => {
      node.push(inner(item, `${path} item`));
    });
    return node;
  }
  for (const valueOf of boxes) {
    const primitive = brand(valueOf, value);
    if (primitive !== notOfKind) {
      return ["W", inner(primitive, path)];
    }
  }
  if (brand(symbolValue, value) !== notOfKind) {
    return refuse(value, path);
  }
  if (isError(value)) {
    // Any error, of any class: what identifies one is its name, which is
    // kept. Errors are the one kind a class of its own is usual for.
    const parts = errorParts(value);
    if (parts === undefined) {
      throw new SerializationError(
        `${path} is an error whose name or message can't be read`
      );
    }
    count(state, stringSize(parts.name) + stringSize(parts.message));
    return ["E", parts.name, parts.message, parts.code ?? null];
  }
  return undefined;
};

/** Own enumerable string-keyed data, as structured clone takes it. */
const encodePlainObject = (
  value: object,
  path: string,
  state: Encoder,
  inner: Inner
): Node => {
  const node: Node[] = ["O"];
  const entries = Object.entries(value);
  if (state.sortKeys) {
    // By code unit, the same in every runtime (not locale order).
    entries.sort(([a], [b]) => (a < b ? -1 : Number(a > b)));
  }
  for (const [key, item] of entries) {
    count(state, stringSize(key));
    node.push(key, inner(item, `${path}.${key}`));
  }
  return node;
};

const encodeKind = (
  value: object,
  path: string,
  state: Encoder,
  inner: Inner
): Node => {
  const builtIn = encodeBuiltIn(value, path, state, inner);
  if (builtIn !== undefined) {
    return builtIn;
  }
  const composite = encodeComposite(value, path, state, inner);
  if (composite !== undefined) {
    return composite;
  }
  if (hostClassOf(value) !== undefined) {
    return refuse(value, path);
  }
  // A plain object, an instance of an author's class, or an object that
  // borrows a cloneable built-in's prototype: its own data, as a plain
  // object, as structured clone keeps it.
  return encodePlainObject(value, path, state, inner);
};

const encodeObject = (value: object, path: string, state: Encoder): Node => {
  const met = state.seen.get(value);
  if (met !== undefined) {
    return ["P", met];
  }
  // Numbered before its content, so content that refers back finds it.
  state.seen.set(value, state.seen.size);
  if (state.depth >= maxNestingDepth) {
    throw new SerializationError(
      `${path} nests deeper than the ${maxNestingDepth} levels a workflow keeps`
    );
  }
  state.depth += 1;
  const inner: Inner = (item, at) =>
    // oxlint-disable-next-line no-use-before-define -- the encoders recurse into each other
    encodeNode(item, at, state);
  const node = encodeKind(value, path, state, inner);
  state.depth -= 1;
  return node;
};

const encodeNumber = (value: number): Node => {
  if (Object.is(value, -0)) {
    return ["N", "-0"];
  }
  return Number.isFinite(value) ? value : ["N", String(value)];
};

const encodeNode = (value: unknown, path: string, state: Encoder): Node => {
  count(state, 1);
  switch (typeof value) {
    case "string": {
      count(state, stringSize(value));
      return value;
    }
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
      const digits = value.toString();
      count(state, digits.length);
      return ["I", digits];
    }
    case "object": {
      return value === null ? null : encodeObject(value, path, state);
    }
    case "function":
    case "symbol": {
      // A function (an RPC stub's method among them) or a symbol.
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

/** Checks the text a node takes in the journal; returns it. */
const storedText = (node: Node): string => {
  const text = JSON.stringify([codecVersion, node]);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxStoredTextBytes) {
    throw new SerializationError(
      `the value's stored text takes ${bytes} bytes, more than the ${maxStoredTextBytes} a journal value holds: its strings escape to more text than they hold (quotes, backslashes, control characters)`
    );
  }
  return text;
};

/** `encode`, with plain objects' keys sorted when `sortKeys`. */
const encodeWith = (value: unknown, sortKeys: boolean): string => {
  const state: Encoder = { seen: new Map(), size: 0, depth: 0, sortKeys };
  let node: Node;
  try {
    node = encodeNode(value, "the value", state);
  } catch (error) {
    if (error instanceof SerializationError) {
      throw error;
    }
    // A getter or proxy trap of the value's own that threw. What it threw
    // is the value's own: read only through errorRecord, which is total
    // and bounded.
    throw new SerializationError(
      `the value can't be read: ${errorRecord(error).message}`
    );
  }
  return storedText(node);
};

/** Encodes `value` for the journal; throws SerializationError if it can't. */
export const encode = (value: unknown): string => encodeWith(value, false);

// Stream results

/** What the journal keeps of a step's stream result (streams.ts). */
export interface StreamResult {
  /** The attempt whose bytes were kept. */
  readonly attempt: number;
  readonly chunks: number;
  /** In bytes. */
  readonly length: number;
  /** SHA-256 of the bytes, lowercase hex. */
  readonly sha256: string;
  /** SHA-256 of the chunks' SHA-256 digests, in order, lowercase hex. */
  readonly chunkDigest: string;
  /** How the bytes are stored: `identity`, as they came. */
  readonly encoding: "identity";
}

export const encodeStreamResult = (result: StreamResult): string =>
  JSON.stringify([
    codecVersion,
    [
      "Z",
      result.attempt,
      result.chunks,
      result.length,
      result.sha256,
      result.chunkDigest,
      result.encoding,
    ],
  ]);

// Decoding

const corrupt = (detail: string): Error =>
  new Error(`The journal holds a value this codec can't read: ${detail}`);

interface Decoder {
  /** Each object made so far, in the order the encoder numbered them. */
  readonly objects: unknown[];
  depth: number;
}

const made = <T>(state: Decoder, value: T): T => {
  state.objects.push(value);
  return value;
};

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

const fromBase64 = (text: Node | undefined): ArrayBuffer => {
  if (typeof text !== "string") {
    throw corrupt("bytes without base64");
  }
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw corrupt("bytes whose base64 doesn't read");
  }
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0).buffer;
};

const isCount = (value: Node | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A view over `buffer`, checked to lie inside it. */
const viewOver = (
  kind: Node | undefined,
  buffer: unknown,
  byteOffset: Node | undefined,
  length: Node | undefined
): object => {
  const view = typeof kind === "string" ? viewKinds.get(kind) : undefined;
  const size = view?.BYTES_PER_ELEMENT ?? 1;
  if (
    !(buffer instanceof ArrayBuffer) ||
    !isCount(byteOffset) ||
    !isCount(length) ||
    byteOffset % size !== 0 ||
    byteOffset + length * size > buffer.byteLength
  ) {
    throw corrupt(`a view of kind ${JSON.stringify(kind)} outside its buffer`);
  }
  if (view === undefined) {
    if (kind !== null) {
      throw corrupt(`a typed array of kind ${JSON.stringify(kind)}`);
    }
    return new DataView(buffer, byteOffset, length);
  }
  return new view(buffer, byteOffset, length);
};

const decodeRegExp = (source: Node | undefined, flags: Node | undefined) => {
  if (typeof source !== "string" || typeof flags !== "string") {
    throw corrupt("a RegExp without source and flags");
  }
  try {
    return new RegExp(source, flags);
  } catch {
    throw corrupt(`the RegExp /${source}/${flags}`);
  }
};

const decodeError = (rest: Node[]): Error => {
  const [name, message, code] = rest;
  const safe = code === null ? undefined : safeCode(code);
  if (
    typeof name !== "string" ||
    typeof message !== "string" ||
    (code !== null && safe === undefined)
  ) {
    throw corrupt("an error without name, message and code");
  }
  return namedError(name, message, safe);
};

const boxable = new Set(["boolean", "number", "string", "bigint"]);

/** A leaf: a value with nothing inside it to decode. */
const decodeLeaf = (tag: string, rest: Node[]): unknown => {
  switch (tag) {
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
      if (typeof digits !== "string" || !/^-?\d+$/u.test(digits)) {
        throw corrupt("a bigint without digits");
      }
      return BigInt(digits);
    }
    default: {
      throw corrupt(`the tag ${JSON.stringify(tag)}`);
    }
  }
};

const notFixed = Symbol("not a value of fixed content");

/** A built-in of fixed content (nothing inside it is decoded), or notFixed. */
const decodeFixed = (tag: string, rest: Node[]): unknown => {
  switch (tag) {
    case "D": {
      const [time] = rest;
      return new Date(typeof time === "number" ? time : Number.NaN);
    }
    case "X": {
      return decodeRegExp(rest[0], rest[1]);
    }
    case "R": {
      return fromBase64(rest[0]);
    }
    case "E": {
      return decodeError(rest);
    }
    default: {
      return notFixed;
    }
  }
};

const decodeReference = (rest: Node[], state: Decoder): unknown => {
  const [index] = rest;
  if (!isCount(index) || index >= state.objects.length) {
    throw corrupt(`a reference to object ${JSON.stringify(index)}`);
  }
  return state.objects[index];
};

/** The longest array the runtime makes. */
const maxArrayLength = 2 ** 32 - 1;

const holesIn = (item: Node): number | undefined => {
  if (!Array.isArray(item) || item[0] !== "H") {
    return undefined;
  }
  const [, holes] = item;
  if (!isCount(holes) || holes === 0 || item.length !== 2) {
    throw corrupt("a run of holes without its length");
  }
  return holes;
};

type InnerDecode = (item: Node) => unknown;

const decodeArray = (
  rest: Node[],
  state: Decoder,
  inner: InnerDecode
): unknown[] => {
  const array = made<unknown[]>(state, []);
  let index = 0;
  for (const item of rest) {
    const holes = holesIn(item);
    if (holes === undefined) {
      array[index] = inner(item);
      index += 1;
    } else {
      index += holes;
    }
    if (index > maxArrayLength) {
      throw corrupt("an array longer than any array");
    }
  }
  array.length = index;
  return array;
};

/** A view: numbered before its buffer, as the encoder numbered it. */
const decodeView = (
  kind: Node | undefined,
  args: Node[],
  state: Decoder,
  inner: InnerDecode
): object => {
  const at = state.objects.length;
  state.objects.push(undefined);
  const [buffer, byteOffset, length] = args;
  const view = viewOver(kind, inner(buffer ?? null), byteOffset, length);
  state.objects[at] = view;
  return view;
};

const decodeTagged = (tag: string, rest: Node[], state: Decoder): unknown => {
  // oxlint-disable-next-line no-use-before-define -- the two recurse into each other
  const inner: InnerDecode = (item) => decodeNode(item, state);
  switch (tag) {
    case "A": {
      return decodeArray(rest, state, inner);
    }
    case "O": {
      const object = made<Record<string, unknown>>(state, {});
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
    case "T": {
      return decodeView(rest[0], rest.slice(1), state, inner);
    }
    case "V": {
      return decodeView(null, rest, state, inner);
    }
    case "W": {
      // A primitive inside: nothing it holds is numbered.
      const [boxed] = rest;
      const primitive =
        rest.length === 1 && boxed !== undefined ? inner(boxed) : undefined;
      if (!boxable.has(typeof primitive)) {
        throw corrupt("a box without a boolean, number, string or bigint");
      }
      // oxlint-disable-next-line unicorn/new-for-builtins -- Object() is how a primitive is boxed
      return made(state, Object(primitive));
    }
    case "M": {
      const map = made(state, new Map<unknown, unknown>());
      for (const [key, item] of pairs(rest)) {
        const decodedKey = inner(key);
        map.set(decodedKey, inner(item));
      }
      return map;
    }
    case "S": {
      const set = made(state, new Set<unknown>());
      for (const item of rest) {
        set.add(inner(item));
      }
      return set;
    }
    case "P": {
      return decodeReference(rest, state);
    }
    default: {
      const fixed = decodeFixed(tag, rest);
      return fixed === notFixed ? decodeLeaf(tag, rest) : made(state, fixed);
    }
  }
};

/**
 * The tags of objects: what the encoder counts toward the nesting depth,
 * and so the decoder too. Leaves of other kinds (undefined, special
 * numbers, bigints), references and runs of holes nest nothing.
 */
const objectTags = new Set([
  "A",
  "O",
  "D",
  "X",
  "R",
  "T",
  "V",
  "W",
  "E",
  "M",
  "S",
]);

const decodeNode = (node: Node, state: Decoder): unknown => {
  if (!Array.isArray(node)) {
    return node;
  }
  const [tag, ...rest] = node;
  if (typeof tag !== "string") {
    throw corrupt(`a value tagged ${JSON.stringify(tag)}`);
  }
  if (!objectTags.has(tag)) {
    return decodeTagged(tag, rest, state);
  }
  // The encoder's rule, the same way round: an object at depth n is
  // refused when n reaches the limit.
  if (state.depth >= maxNestingDepth) {
    throw corrupt(`nesting deeper than ${maxNestingDepth} levels`);
  }
  state.depth += 1;
  const value = decodeTagged(tag, rest, state);
  state.depth -= 1;
  return value;
};

/** Checks a parsed value is a node, iteratively: no depth can overflow. */
const isNode = (value: unknown): value is Node => {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item: unknown = pending.pop();
    if (Array.isArray(item)) {
      const children: unknown[] = item;
      for (const child of children) {
        pending.push(child);
      }
    } else if (
      item !== null &&
      typeof item !== "boolean" &&
      typeof item !== "number" &&
      typeof item !== "string"
    ) {
      return false;
    }
  }
  return true;
};

/** The node of codec text, checked: its version and its shape. */
const readNode = (text: string): Node => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed[0] !== codecVersion) {
    // No journal predates this version; see codecVersion.
    throw corrupt(
      `codec version ${JSON.stringify(Array.isArray(parsed) ? parsed[0] : parsed)}, where this engine reads only version ${codecVersion}`
    );
  }
  const node: unknown = parsed[1];
  if (!isNode(node)) {
    throw corrupt("an object where only arrays and scalars are written");
  }
  return node;
};

const sha256Pattern = /^[\da-f]{64}$/u;

const readStreamResult = (rest: Node[]): StreamResult => {
  const [attempt, chunks, length, sha256, chunkDigest, encoding] = rest;
  if (
    !isCount(attempt) ||
    attempt < 1 ||
    !isCount(chunks) ||
    !isCount(length) ||
    typeof sha256 !== "string" ||
    !sha256Pattern.test(sha256) ||
    typeof chunkDigest !== "string" ||
    !sha256Pattern.test(chunkDigest) ||
    encoding !== "identity"
  ) {
    throw corrupt("a stream result without its attempt, size and hash");
  }
  return { attempt, chunks, length, sha256, chunkDigest, encoding };
};

/**
 * The stream result codec text holds, or undefined when it holds a value.
 * Only a step's whole result is ever one.
 */
export const streamResultOf = (text: string): StreamResult | undefined => {
  const node = readNode(text);
  return Array.isArray(node) && node[0] === "Z"
    ? readStreamResult(node.slice(1))
    : undefined;
};

/**
 * Decodes what `encode` made: a fresh value, every time. A stream result
 * isn't a value: it is read through its step (streams.ts).
 */
export const decode = (text: string): unknown => {
  const node = readNode(text);
  if (Array.isArray(node) && node[0] === "Z") {
    throw corrupt("a stream result outside its step");
  }
  return decodeNode(node, { objects: [], depth: 0 });
};

// Equivalence

/**
 * Codec text in one canonical form: decoded, then encoded again with every
 * plain object's keys in sorted order. References are numbered as the
 * encoder numbers them, by first visit in its one deterministic walk, so
 * the same graph always gives the same text. Linear in the text, with no
 * budget that could change an answer.
 */
const canonicalOf = (text: string): string => encodeWith(decode(text), true);

/**
 * Whether two codec texts hold the same value: the same content, whatever
 * order a plain object's keys came in. Which parts are one shared object
 * and which equal copies is part of the value: two texts that share
 * differently are different. (A start or an event delivered again comes
 * over RPC or JSON, where sharing is kept the same or lost in both.) A
 * Map's entries, a Set's items and an array's elements keep their order:
 * the codec keeps it, and it is part of the value.
 */
export const equivalent = (left: string, right: string): boolean =>
  canonicalOf(left) === canonicalOf(right);
