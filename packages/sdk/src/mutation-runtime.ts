import { rngChacha20 } from "@noble/ciphers/chacha.js";
import { hexToBytes } from "@noble/ciphers/utils.js";

// A mutation's time and randomness, as Convex's: inside a mutation
// `Date.now()` and `new Date()` answer the time it started, and
// `Math.random()`, `crypto.getRandomValues()` and `crypto.randomUUID()`
// answer from a seed fixed for it, so a mutation run again (its reads
// went stale, or its caller sent it again under its key) computes what
// it did the first time. Both come from its receipt (the host's), never
// from App code. Queries and actions keep the platform's own.
//
// Installed by the host's module of a function's isolate before any App
// module loads (release-runner.ts), so App code never holds the platform's
// functions, and for good (neither writable nor configurable), so it can't
// put them back. Until the host starts a mutation each answers as the
// platform's does. The isolate runs one invocation and is thrown away, so
// nothing reaches another call.

/** When a mutation started, and the seed of its randomness (64 hex digits). */
export interface MutationStart {
  readonly startedAt: number;
  readonly seed: string;
}

/** What a mutation answers in place of the clock and the platform's randomness. */
interface Fixed {
  readonly time: number;
  readonly bytes: (length: number) => Uint8Array;
}

/** The most bytes one `getRandomValues` fills, as Web Crypto's limit. */
const randomValuesMaxBytes = 65_536;

/** The integer arrays `getRandomValues` fills, as Web Crypto's. */
const isIntegerArray = (value: unknown): value is ArrayBufferView =>
  value instanceof Int8Array ||
  value instanceof Uint8Array ||
  value instanceof Uint8ClampedArray ||
  value instanceof Int16Array ||
  value instanceof Uint16Array ||
  value instanceof Int32Array ||
  value instanceof Uint32Array ||
  value instanceof BigInt64Array ||
  value instanceof BigUint64Array;

/** Puts `value` at `object[key]` for good: neither writable nor configurable. */
const replace = (object: object, key: string, value: unknown): void => {
  Object.defineProperty(object, key, {
    value,
    writable: false,
    configurable: false,
    enumerable: false,
  });
};

/** A float in [0, 1) from 53 of `bytes`' bits, as `Math.random` answers. */
const unitInterval = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
  // The high word's top 21 bits, then the low word's 32: 53 bits, a
  // double's mantissa.
  const high = Math.floor(view.getUint32(0) / 2 ** 11);
  const low = view.getUint32(4);
  return (high * 2 ** 32 + low) / 2 ** 53;
};

/** A version 4 UUID of 16 `bytes` (RFC 9562), as `crypto.randomUUID` answers. */
const uuidOf = (bytes: Uint8Array): string => {
  const hex = Array.from(bytes, (byte, index) => {
    // Its version, 4, in byte 6's high digit, and its variant, `10`, in
    // byte 8's two high bits; the rest as they came.
    if (index === 6) {
      return (0x40 + (byte % 0x10)).toString(16);
    }
    if (index === 8) {
      return (0x80 + (byte % 0x40)).toString(16);
    }
    return byte.toString(16).padStart(2, "0");
  });
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10, 16),
  ]
    .map((group) => group.join(""))
    .join("-");
};

/**
 * Puts the mutation runtime in place of the clock and randomness, for
 * good: what the host's isolate module calls first. Answers how the host
 * starts the invocation's mutation, once.
 */
export const installMutationRuntime = (): ((start: MutationStart) => void) => {
  let fixed: Fixed | undefined;
  const PlatformDate = Date;
  const platformNow = Date.now.bind(Date);
  const platformRandom = Math.random.bind(Math);
  const cryptoPrototype: unknown = Object.getPrototypeOf(crypto);
  const platformRandomValues = crypto.getRandomValues.bind(crypto);
  const platformRandomUUID = crypto.randomUUID.bind(crypto);

  const now = (): number => fixed?.time ?? platformNow();
  const MutationDate: DateConstructor = new Proxy(PlatformDate, {
    // `Date()` is the time as a string.
    apply: (): string => new PlatformDate(now()).toString(),
    construct: (target, args: unknown[], newTarget): Date =>
      // SAFETY: constructing `Date`, or a subclass of it, makes a `Date`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      Reflect.construct(
        target,
        args.length === 0 ? [now()] : args,
        // A subclass's, or our own: never the platform's `Date` itself.
        newTarget === MutationDate ? target : newTarget
      ) as Date,
    get: (target, key, receiver): unknown =>
      key === "now" ? now : Reflect.get(target, key, receiver),
  });
  const random = (): number =>
    fixed === undefined ? platformRandom() : unitInterval(fixed.bytes(8));
  const getRandomValues = (array: ArrayBufferView<ArrayBuffer>): unknown => {
    if (fixed === undefined) {
      // The platform's, which checks `array` itself.
      return platformRandomValues(array);
    }
    if (!isIntegerArray(array)) {
      throw new TypeError("getRandomValues takes an integer typed array.");
    }
    if (array.byteLength > randomValuesMaxBytes) {
      throw new DOMException(
        `getRandomValues fills at most ${randomValuesMaxBytes} bytes.`,
        "QuotaExceededError"
      );
    }
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(
      fixed.bytes(array.byteLength)
    );
    return array;
  };
  const randomUUID = (): string =>
    fixed === undefined ? platformRandomUUID() : uuidOf(fixed.bytes(16));

  replace(globalThis, "Date", MutationDate);
  replace(PlatformDate.prototype, "constructor", MutationDate);
  replace(Math, "random", random);
  // On the object and its prototype: `Crypto.prototype.randomUUID.call(crypto)`
  // reaches the same.
  for (const target of [crypto, cryptoPrototype]) {
    if (typeof target !== "object" || target === null) {
      continue;
    }
    replace(target, "getRandomValues", getRandomValues);
    replace(target, "randomUUID", randomUUID);
  }

  return ({ startedAt, seed }) => {
    if (fixed !== undefined) {
      throw new Error("The invocation's mutation started already.");
    }
    const stream = rngChacha20(hexToBytes(seed));
    fixed = {
      time: startedAt,
      bytes: (length) => stream.randomBytes(length),
    };
  };
};
