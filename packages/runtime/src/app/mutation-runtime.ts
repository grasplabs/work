import { rngChacha20 } from "@noble/ciphers/chacha.js";
import { hexToBytes } from "@noble/ciphers/utils.js";

import { replaceClockAndRandomness } from "./clock-and-randomness.ts";

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
// functions, and for good, through what a workflow's calculation is locked
// down with (clock-and-randomness.ts), so it can't put them back. Besides
// those: the performance timeline's clock, and `File`'s and
// `PerformanceMark`'s times; what no seed reaches (measuring the
// timeline, a form's files and body, generating a key, randomized
// signatures and encryption) is refused. Until the host starts a mutation
// each answers as the platform's does. The isolate runs one invocation and
// is thrown away, so nothing reaches another call.

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

/** What a mutation can't use: the platform's, which answers no rerun the same. */
const unavailable = (what: string): Error =>
  new Error(
    `A mutation answers the same when it runs again: ${what} isn't available in one. Use an action.`
  );

/**
 * Puts the mutation runtime in place of the clock and randomness, for
 * good: what the host's isolate module calls first. Answers how the host
 * starts the invocation's mutation, once. Throws when a replacement
 * didn't take: no function runs in an isolate where one didn't.
 */
export const installMutationRuntime = (): ((start: MutationStart) => void) => {
  let fixed: Fixed | undefined;
  // The platform's own, as they are before anything is replaced: read
  // through an instance, as workerd may hand a method only to one.
  const platformNow = Date.now.bind(Date);
  const platformRandom = Math.random.bind(Math);
  const platformRandomValues = crypto.getRandomValues.bind(crypto);
  const platformRandomUUID = crypto.randomUUID.bind(crypto);
  const platformPerformanceNow = performance.now.bind(performance);
  const { timeOrigin } = performance;

  const now = (): number => fixed?.time ?? platformNow();
  /** `performance.now()`: the mutation's start, on the timeline's origin. */
  const performanceNow = (): number =>
    fixed === undefined ? platformPerformanceNow() : fixed.time - timeOrigin;
  const sealed = replaceClockAndRandomness({
    now,
    performanceNow,
    random: () =>
      fixed === undefined ? platformRandom() : unitInterval(fixed.bytes(8)),
    getRandomValues: (array) => {
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
    },
    randomUUID: () =>
      fixed === undefined ? platformRandomUUID() : uuidOf(fixed.bytes(16)),
    // Refused in a mutation: no seed reaches it.
    unseeded: (what) => {
      if (fixed !== undefined) {
        throw unavailable(what);
      }
    },
  });
  if (!sealed) {
    throw new Error(
      "The mutation runtime couldn't replace the platform's clock and randomness."
    );
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
