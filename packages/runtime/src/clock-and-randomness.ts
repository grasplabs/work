// What an isolate's code reads the clock and randomness through, and what
// it reads in their place, from sources the caller gives
// (`clockAndRandomnessFrom`). A mutation's fixed time and seeded
// randomness (mutation-runtime.ts) are put in place for good: each
// replacement is non-configurable and non-writable, on the object code
// reaches it on and on the prototype the platform keeps it on, so code
// that loads after can't put the original back or reach it another way.
// A migration's transform has the same replacements, refusing, shadowed
// while it runs and restored after (determinism.ts).

/**
 * The intrinsics the replacements call, and the platform's functions they
 * pass on to, taken as this module loads, before any module of App or
 * workflow code: a replacement never looks one up again, so replacing
 * `Reflect.construct`, `Object.defineProperty` or the like can't intercept
 * what it passes on (the real `Date`, formatter or `File`), nor the
 * arguments that carry a time.
 */
const { apply, construct, getPrototypeOf, setPrototypeOf } = Reflect;
const { defineProperty, getOwnPropertyDescriptor, hasOwn } = Object;
const platformDate = Date;
const datePrototype = Date.prototype;
const dateToString: unknown = Reflect.get(datePrototype, "toString");
const dateFormatPrototype: object = Intl.DateTimeFormat.prototype;
const formatGetter: unknown = Reflect.getOwnPropertyDescriptor(
  dateFormatPrototype,
  "format"
)?.get;
const formatToParts: unknown = Reflect.getOwnPropertyDescriptor(
  dateFormatPrototype,
  "formatToParts"
)?.value;
// Where the platform has them (its compatibility date decides).
const platformMark: unknown = Reflect.get(performance, "mark");
const platformMeasure: unknown = Reflect.get(performance, "measure");
const platformFile: unknown = Reflect.get(globalThis, "File");
const platformPerformanceMark: unknown = Reflect.get(
  globalThis,
  "PerformanceMark"
);

/** What the clock and randomness answer from. */
export interface ClockAndRandomness {
  /**
   * `Date.now()`, `new Date()`, `Date()`, a formatter given no date, and a
   * file's `lastModified` unless given.
   */
  readonly now: () => number;
  /** `performance.now()`, and a mark's `startTime` unless given. */
  readonly performanceNow: () => number;
  /** `performance.measure`, called on the platform's `performance`. */
  readonly measure: (this: unknown, ...args: unknown[]) => unknown;
  readonly random: () => number;
  readonly getRandomValues: (array: ArrayBufferView<ArrayBuffer>) => unknown;
  readonly randomUUID: () => string;
  /** `crypto.subtle.generateKey`, called on the platform's `SubtleCrypto`. */
  readonly generateKey: (this: unknown, ...args: unknown[]) => unknown;
}

/**
 * A property put in place of `key` of `target`: an accessor with `get`,
 * or else `value`. With `ifOwn`, `target` is an object whose prototype
 * holds the platform's function: sealed only where the object holds `key`
 * as its own when sealed, and always shadowed, as module code may give it
 * one later. Every field its own, `get` too when there is none, so
 * reading one never looks on `Object.prototype`, where module code could
 * put one.
 */
export interface Replacement {
  readonly target: object;
  readonly key: string;
  readonly get: ((this: unknown) => unknown) | undefined;
  readonly value: unknown;
  readonly ifOwn: boolean;
}

/** `value` in place of `key` of `target`. */
const replacing = (
  target: object,
  key: string,
  value: unknown,
  ifOwn = false
): Replacement => ({ target, key, get: undefined, value, ifOwn });

/**
 * `object`, its prototype taken away: only its own fields are read, never
 * one module code put on `Object.prototype` (or, for an index, on
 * `Array.prototype`).
 */
export const withoutPrototype = <T extends object>(object: T): T => {
  setPrototypeOf(object, null);
  return object;
};

/** The descriptor that puts `replacement` in place, `configurable` or for good. */
export const descriptorOf = (
  { get, value }: Replacement,
  configurable: boolean
): PropertyDescriptor =>
  withoutPrototype(
    get === undefined
      ? { configurable, enumerable: false, writable: configurable, value }
      : { configurable, enumerable: false, get }
  );

/** Whether `replacement` is in place of `key` of its target. */
export const isInPlace = ({
  target,
  key,
  get,
  value,
}: Replacement): boolean => {
  const found = getOwnPropertyDescriptor(target, key);
  return get === undefined ? found?.value === value : found?.get === get;
};

/**
 * `value` in place of `key` where code reaches the platform's function:
 * on `object`'s prototype, and on `object` itself (`ifOwn`).
 */
const whereReached = (
  object: object,
  key: string,
  value: unknown
): Replacement[] => {
  const prototype: unknown = getPrototypeOf(object);
  return [
    ...(typeof prototype === "object" && prototype !== null
      ? [replacing(prototype, key, value)]
      : []),
    replacing(object, key, value, true),
  ];
};

/**
 * `options`' own enumerable fields, with `key` set to `value()` where they
 * leave it out or set it to `undefined` (as the platform reads an
 * undefined member as one not given). Without a prototype, so nothing App
 * code puts on `Object.prototype` is read as one of its fields; each
 * field defined, never set, so no setter of App code's sees one.
 */
const withDefault = (
  options: unknown,
  key: string,
  value: () => number
): Record<string, unknown> => {
  const given: Record<string, unknown> = {
    __proto__: null,
    ...(typeof options === "object" && options !== null ? options : {}),
  };
  const set: unknown = getOwnPropertyDescriptor(given, key)?.value;
  return {
    __proto__: null,
    ...given,
    [key]: set === undefined ? value() : set,
  };
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
 * In place of the platform's class `Class` (the global `name`, and its
 * prototype's `constructor`): one whose instances take the time they are
 * made, `options[key]`, from `time` when its argument at `index` doesn't
 * set it. Nothing where the platform has no such class; throws where
 * its class has no prototype to replace `constructor` on, so nothing
 * runs with the class half replaced.
 */
const timedClass = (
  Class: unknown,
  name: string,
  index: number,
  key: string,
  time: () => number
): Replacement[] => {
  if (typeof Class !== "function") {
    return [];
  }
  const prototype: unknown = Class.prototype;
  if (typeof prototype !== "object" || prototype === null) {
    throw new TypeError(`${name} has no prototype here.`);
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
        withDefault(args[index], key, time)
      );
      const made: unknown = construct(target, given, newTarget);
      // SAFETY: constructing the platform's class makes one of its instances.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return made as object;
    },
  } as ProxyHandler<typeof Class>);
  return [
    replacing(globalThis, name, timed),
    replacing(prototype, "constructor", timed),
  ];
};

/** `Date`, its time without a date taken from `now`. */
const dateFrom = (now: () => number): DateConstructor =>
  // SAFETY: the handler has exactly a `ProxyHandler`'s `apply` and
  // `construct` traps; `__proto__: null` only sets its prototype.
  new Proxy(platformDate, {
    // No prototype: a trap the handler doesn't have is never looked up on
    // `Object.prototype`, where module code could define one and be handed
    // the real `Date`. With no `get` trap, `Date.now` is read on the real
    // `Date`, where it is replaced too.
    __proto__: null,
    // `Date()` is the time as a string.
    apply: (target): unknown => {
      const date: unknown = construct(target, [now()]);
      if (typeof dateToString !== "function") {
        throw new TypeError("Date has no toString here.");
      }
      const text: unknown = apply(dateToString, date, []);
      return text;
    },
    construct: (target, args: unknown[], newTarget: DateConstructor) =>
      // `newTarget` passed on, so a subclass of `Date` stays one.
      // SAFETY: constructing `Date` makes a `Date`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      construct(target, args.length === 0 ? [now()] : args, newTarget) as Date,
  } as ProxyHandler<DateConstructor>);

/**
 * `Intl.DateTimeFormat`'s `format` getter, as the platform's: a function
 * bound to its formatter, so a detached `const { format } = formatter`
 * still works, which formats `now` when given no date.
 */
const formatFrom = (now: () => number) =>
  function format(this: unknown): unknown {
    const bound: unknown =
      typeof formatGetter === "function"
        ? apply(formatGetter, this, [])
        : undefined;
    // The date alone, by name: `args[0]` of no arguments would be looked
    // up on `Array.prototype`, where module code could put one.
    return (given?: unknown): unknown => {
      const at = given === undefined ? now() : given;
      if (typeof bound !== "function") {
        throw new TypeError("Intl.DateTimeFormat formats no date here.");
      }
      const formatted: unknown = apply(bound, undefined, [at]);
      return formatted;
    };
  };

/** `Intl.DateTimeFormat`'s `formatToParts`, formatting `now` when given no date. */
const formatToPartsFrom = (now: () => number) =>
  function formatToPartsAt(this: unknown, given?: unknown): unknown {
    const at = given === undefined ? now() : given;
    if (typeof formatToParts !== "function") {
      throw new TypeError("Intl.DateTimeFormat formats no date here.");
    }
    const parts: unknown = apply(formatToParts, this, [at]);
    return parts;
  };

/** `performance.mark`, its `startTime` from `performanceNow` unless given. */
const markFrom = (performanceNow: () => number) =>
  function mark(this: unknown, name: unknown, options?: unknown): unknown {
    if (typeof platformMark !== "function") {
      throw new TypeError("performance has no mark here.");
    }
    const marked: unknown = apply(platformMark, this, [
      name,
      withDefault(options, "startTime", performanceNow),
    ]);
    return marked;
  };

/**
 * What tells the time and what draws randomness, each in place of the
 * platform's, from `sources`: `Date.now` (on the real `Date`, which the
 * global's proxy hands descriptor reads and gets to), `new Date()` and
 * `Date()` through the global `Date` or `Date.prototype.constructor`,
 * `Intl.DateTimeFormat` formatting no date, the performance timeline's
 * clock and what reads it (a mark's time, a measure), a file's
 * `lastModified` and a mark's `startTime` unless given, `Math.random`,
 * `crypto`'s `getRandomValues` and `randomUUID`, and `SubtleCrypto`'s
 * `generateKey`.
 */
export const clockAndRandomnessFrom = (
  sources: ClockAndRandomness
): Replacement[] => {
  const date = dateFrom(sources.now);
  return [
    replacing(platformDate, "now", sources.now),
    replacing(globalThis, "Date", date),
    replacing(datePrototype, "constructor", date),
    {
      target: dateFormatPrototype,
      key: "format",
      get: formatFrom(sources.now),
      value: undefined,
      ifOwn: false,
    },
    replacing(
      dateFormatPrototype,
      "formatToParts",
      formatToPartsFrom(sources.now)
    ),
    ...whereReached(performance, "now", sources.performanceNow),
    ...(typeof platformMark === "function"
      ? whereReached(performance, "mark", markFrom(sources.performanceNow))
      : []),
    ...(typeof platformMeasure === "function"
      ? whereReached(performance, "measure", sources.measure)
      : []),
    ...timedClass(platformFile, "File", 2, "lastModified", sources.now),
    ...timedClass(
      platformPerformanceMark,
      "PerformanceMark",
      1,
      "startTime",
      sources.performanceNow
    ),
    replacing(Math, "random", sources.random),
    ...whereReached(crypto, "getRandomValues", sources.getRandomValues),
    ...whereReached(crypto, "randomUUID", sources.randomUUID),
    ...whereReached(crypto.subtle, "generateKey", sources.generateKey),
  ];
};

/**
 * Puts `replacement` in place, for good; whether it took. One `ifOwn` is
 * sealed only where its object holds the key as its own.
 */
const seal = (replacement: Replacement): boolean => {
  const { target, key, ifOwn } = replacement;
  if (ifOwn && !hasOwn(target, key)) {
    return true;
  }
  try {
    defineProperty(target, key, descriptorOf(replacement, false));
  } catch {
    return false;
  }
  return isInPlace(replacement);
};

/**
 * Replaces the clock and randomness, for good, from `sources`
 * (`clockAndRandomnessFrom`). Whether every one took.
 */
export const replaceClockAndRandomness = (
  sources: ClockAndRandomness
): boolean => {
  let replacements: Replacement[];
  try {
    replacements = clockAndRandomnessFrom(sources);
  } catch {
    return false;
  }
  return replacements.map(seal).every(Boolean);
};
