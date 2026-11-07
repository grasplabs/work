import { rngChacha20 } from "@noble/ciphers/chacha.js";
import { hexToBytes } from "@noble/ciphers/utils.js";

import {
  replaceClockAndRandomness,
  seal,
  sealWhereReached,
} from "./clock-and-randomness.ts";

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
// `PerformanceMark`'s times; generating a key and measuring the timeline
// are refused, as no seed reaches them. Until the host starts a mutation
// each answers as the platform's does. The isolate runs one invocation and
// is thrown away, so nothing reaches another call.

/**
 * The intrinsics the replacements call while App code runs, taken as this
 * module loads, before any App module does: a replacement never looks one
 * up again, so App code replacing `Reflect.construct`, `Reflect.apply` or
 * `Object.defineProperty` is never handed the platform's `File`,
 * `generateKey` or the like, nor the arguments that carry a fixed time.
 */
const { apply, construct } = Reflect;
const { defineProperty, getOwnPropertyDescriptor } = Object;

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
 * `options`' own enumerable fields, with `key` set to `value` where they
 * leave it out or set it to `undefined` (as the platform reads an
 * undefined member as one not given). Without a prototype, so nothing App
 * code puts on `Object.prototype` is read as one of its fields; each
 * field defined, never set, so no setter of App code's sees one.
 */
const withDefault = (
  options: unknown,
  key: string,
  value: number
): Record<string, unknown> => {
  const given: Record<string, unknown> = {
    __proto__: null,
    ...(typeof options === "object" && options !== null ? options : {}),
  };
  const set: unknown = getOwnPropertyDescriptor(given, key)?.value;
  return { __proto__: null, ...given, [key]: set === undefined ? value : set };
};

/**
 * `args` with `value` at `index`, each element defined, never set: an
 * array App code put an index setter on `Array.prototype` for never hands
 * it the value.
 */
const argumentsWith = (
  args: readonly unknown[],
  index: number,
  value: unknown
): unknown[] => {
  const given: unknown[] = [];
  const length = args.length > index ? args.length : index + 1;
  for (let at = 0; at < length; at += 1) {
    // SAFETY: a data descriptor's fields; `__proto__: null` only sets its
    // prototype, so no `get` or `set` of App code's is read as one.
    defineProperty(given, at, {
      __proto__: null,
      value: at === index ? value : args[at],
      writable: true,
      enumerable: true,
      configurable: true,
    } as PropertyDescriptor);
  }
  return given;
};

/**
 * Puts in place of the global class `name` (and its prototype's
 * `constructor`) one whose instances take the time they are made,
 * `options[key]`, from `time` when its argument at `index` doesn't set
 * it. Whether it took; nothing to do where the platform has no such class.
 */
const sealTimedClass = (
  name: string,
  index: number,
  key: string,
  time: () => number
): boolean => {
  const Class: unknown = Reflect.get(globalThis, name);
  if (typeof Class !== "function") {
    return true;
  }
  // SAFETY: the handler has exactly a `ProxyHandler`'s `construct` trap;
  // `__proto__: null` only sets its prototype.
  const timed = new Proxy(Class, {
    // No prototype: a trap the handler doesn't have is never looked up on
    // `Object.prototype`, where App code could define one.
    __proto__: null,
    construct: (target, args: unknown[], newTarget) => {
      const given = argumentsWith(
        args,
        index,
        withDefault(args[index], key, time())
      );
      const made: unknown = construct(target, given, newTarget);
      // SAFETY: constructing the platform's class makes one of its instances.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return made as object;
    },
  } as ProxyHandler<typeof Class>);
  const prototype: unknown = Class.prototype;
  return (
    typeof prototype === "object" &&
    prototype !== null &&
    seal(globalThis, name, timed) &&
    seal(prototype, "constructor", timed)
  );
};

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
  const platformGenerateKey: unknown = Reflect.get(
    crypto.subtle,
    "generateKey"
  );
  const platformPerformanceNow = performance.now.bind(performance);
  const platformMark: unknown = Reflect.get(performance, "mark");
  const platformMeasure: unknown = Reflect.get(performance, "measure");
  const { timeOrigin } = performance;

  const now = (): number => fixed?.time ?? platformNow();
  /** `performance.now()`: the mutation's start, on the timeline's origin. */
  const performanceNow = (): number =>
    fixed === undefined ? platformPerformanceNow() : fixed.time - timeOrigin;
  const sealed = [
    replaceClockAndRandomness({
      now,
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
      // A key from the platform's randomness, which no seed reaches.
      generateKey(this: unknown, ...args: unknown[]): unknown {
        if (fixed !== undefined || typeof platformGenerateKey !== "function") {
          throw unavailable("generating a key");
        }
        const generated: unknown = apply(platformGenerateKey, this, args);
        return generated;
      },
    }),
    // The performance timeline's clock, and what reads it: a mark's
    // time, and a measure's end, unless given.
    sealWhereReached(performance, "now", performanceNow),
    // Where the platform has them (its compatibility date decides).
    typeof platformMark !== "function" ||
      sealWhereReached(
        performance,
        "mark",
        function mark(
          this: unknown,
          name: unknown,
          options?: unknown
        ): unknown {
          const marked: unknown = apply(platformMark, this, [
            name,
            withDefault(options, "startTime", performanceNow()),
          ]);
          return marked;
        }
      ),
    typeof platformMeasure !== "function" ||
      sealWhereReached(
        performance,
        "measure",
        function measure(this: unknown, ...args: unknown[]): unknown {
          if (fixed !== undefined) {
            throw unavailable("performance.measure");
          }
          const measured: unknown = apply(platformMeasure, this, args);
          return measured;
        }
      ),
    // A file's `lastModified` and a mark's `startTime`, unless given.
    sealTimedClass("File", 2, "lastModified", now),
    sealTimedClass("PerformanceMark", 1, "startTime", performanceNow),
  ];
  if (!sealed.every(Boolean)) {
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
