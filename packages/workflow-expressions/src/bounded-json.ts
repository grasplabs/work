/**
 * JSON text from caller values, written with a hard bound on the work.
 *
 * JSON.stringify, or any walk of a value, visits a shared reference every
 * time it occurs: `[v, v]` nested 31 times is 31 arrays in memory but 2^31
 * leaves to visit, long before a size check on the result could run. This
 * writer visits the value once, in order, and stops the moment its output
 * passes `maxBytes`, it nests deeper than `maxDepth`, or it has visited
 * `maxNodes` values and object keys (every own key is charged, whether
 * written, left out for being undefined, or refused). It checks the value is plain JSON as it goes, and reads each
 * property once, so nothing walks the value before or after it and what
 * it checked is what it wrote.
 */

export interface JsonBounds {
  /** UTF-8 bytes of output. */
  maxBytes: number;
  /** Arrays and objects inside one another. */
  maxDepth: number;
  /** Values and object members visited. */
  maxNodes: number;
  /** Sort object keys, as canonical JSON does. */
  sortKeys: boolean;
  /** Refuse integers beyond 2^53, as jq prints overflowing numbers. */
  safeIntegers: boolean;
}

/** Why a value has no JSON text within the bounds. */
export type JsonRefusal = "too_large" | "invalid";

export type JsonWritten =
  | { ok: true; text: string }
  | { ok: false; refusal: JsonRefusal };

class RefusedError extends Error {
  readonly refusal: JsonRefusal;

  constructor(refusal: JsonRefusal) {
    super(`JSON refused: ${refusal}`);
    this.name = "RefusedError";
    this.refusal = refusal;
  }
}

/** UTF-8 bytes of well-formed text. */
const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x8_00) {
      bytes += 2;
    } else if (code < 0x1_00_00) {
      bytes += 3;
    } else {
      // A surrogate pair: one four-byte character in two code units.
      bytes += 4;
      index += 1;
    }
  }
  return bytes;
};

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** A writer of JSON text within `bounds`; it throws RefusedError. */
const createWriter = (bounds: JsonBounds) => {
  const parts: string[] = [];
  let bytes = 0;
  let nodes = 0;

  const emit = (text: string): void => {
    bytes += utf8Length(text);
    if (bytes > bounds.maxBytes) {
      throw new RefusedError("too_large");
    }
    parts.push(text);
  };

  const visit = (): void => {
    nodes += 1;
    if (nodes > bounds.maxNodes) {
      throw new RefusedError("too_large");
    }
  };

  const string = (text: string): void => {
    // Every code unit is at least one byte: too long is too large, before
    // any other work on it.
    if (text.length > bounds.maxBytes - bytes) {
      throw new RefusedError("too_large");
    }
    if (!text.isWellFormed()) {
      throw new RefusedError("invalid");
    }
    emit(JSON.stringify(text));
  };

  const number = (value: number): void => {
    const unsafe =
      bounds.safeIntegers &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value);
    if (!Number.isFinite(value) || unsafe) {
      throw new RefusedError("invalid");
    }
    emit(JSON.stringify(value));
  };

  const write = (value: unknown, depth: number): void => {
    visit();
    if (value === null) {
      emit("null");
    } else if (typeof value === "boolean") {
      emit(value ? "true" : "false");
    } else if (typeof value === "string") {
      string(value);
    } else if (typeof value === "number") {
      number(value);
    } else if (typeof value !== "object" || depth >= bounds.maxDepth) {
      throw new RefusedError("invalid");
    } else if (Array.isArray(value)) {
      // oxlint-disable-next-line no-use-before-define -- mutual recursion
      array(value, depth);
    } else {
      // oxlint-disable-next-line no-use-before-define -- mutual recursion
      object(value, depth);
    }
  };

  const array = (value: readonly unknown[], depth: number): void => {
    // Read once: a proxy's length could change from one read to the next.
    const { length } = value;
    emit("[");
    for (let index = 0; index < length; index += 1) {
      if (!(index in value)) {
        throw new RefusedError("invalid");
      }
      if (index > 0) {
        emit(",");
      }
      write(value[index], depth + 1);
    }
    emit("]");
  };

  /**
   * Members of a plain object, from one list of all its own keys, every
   * one of them charged before any is read. Object.entries would walk the
   * hidden keys (non-enumerable, symbols) uncharged, and on a proxy a
   * second ownKeys call could answer more than the first.
   */
  const membersOf = (value: object): [string, unknown][] => {
    if (!isPlainObject(value)) {
      throw new RefusedError("invalid");
    }
    const keys = Reflect.ownKeys(value);
    nodes += keys.length;
    if (nodes > bounds.maxNodes) {
      throw new RefusedError("too_large");
    }
    const members: [string, unknown][] = [];
    for (const key of keys) {
      // JSON has string keys only, all of them enumerable; a hidden key
      // or a symbol is refused rather than skipped.
      if (typeof key !== "string" || key === "__proto__") {
        throw new RefusedError("invalid");
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true) {
        throw new RefusedError("invalid");
      }
      const member: unknown =
        descriptor.get === undefined
          ? descriptor.value
          : Reflect.apply(descriptor.get, value, []);
      members.push([key, member]);
    }
    return members;
  };

  const object = (value: object, depth: number): void => {
    const members = membersOf(value);
    if (bounds.sortKeys) {
      members.sort(([a], [b]) => (a < b ? -1 : 1));
    }
    emit("{");
    let first = true;
    for (const [key, member] of members) {
      // A member set to undefined is left out, as JSON.stringify does.
      if (member === undefined) {
        continue;
      }
      if (!first) {
        emit(",");
      }
      first = false;
      string(key);
      emit(":");
      write(member, depth + 1);
    }
    emit("}");
  };

  return { emit, write, text: () => parts.join("") };
};

const written = (run: () => string): JsonWritten => {
  try {
    return { ok: true, text: run() };
  } catch (error) {
    if (error instanceof RefusedError) {
      return { ok: false, refusal: error.refusal };
    }
    throw error;
  }
};

/**
 * The JSON text of `values` as one array, `[a,b,…]` (the array itself not
 * counted in the depth), or why there is none within `bounds`. Anything
 * the values' own getters or proxies throw is the caller's to catch.
 */
export const writeJsonArray = (
  values: readonly unknown[],
  bounds: JsonBounds
): JsonWritten =>
  written(() => {
    const writer = createWriter(bounds);
    writer.emit("[");
    for (const [index, value] of values.entries()) {
      if (index > 0) {
        writer.emit(",");
      }
      writer.write(value, 0);
    }
    writer.emit("]");
    return writer.text();
  });

/** The JSON text of one value, or why there is none within `bounds`. */
export const writeJson = (value: unknown, bounds: JsonBounds): JsonWritten =>
  written(() => {
    const writer = createWriter(bounds);
    writer.write(value, 0);
    return writer.text();
  });
