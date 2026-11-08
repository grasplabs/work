// Puts what an isolate's code reads the clock and randomness through in
// place, for good, from sources the caller gives: refusals, for a
// workflow's calculation (compute-lockdown.ts), or a mutation's fixed
// time and seeded randomness (mutation-runtime.ts). Each replacement is
// non-configurable and non-writable, on the object code reaches it on and
// on the prototype the platform keeps it on, so code that loads after
// can't put the original back or reach it another way.

/**
 * The intrinsics the replacements call, taken as this module loads,
 * before any module of App or workflow code: a replacement never looks
 * one up again, so replacing `Reflect.construct` or the like can't
 * intercept what it passes on (the real `Date` or formatter).
 */
const { apply, construct } = Reflect;
const dateToString: unknown = Reflect.get(Date.prototype, "toString");

/** What the clock and randomness answer from. */
interface ClockAndRandomness {
  /** `Date.now()`, `new Date()`, `Date()`, and a formatter given no date. */
  readonly now: () => number;
  readonly random: () => number;
  readonly getRandomValues: (array: ArrayBufferView<ArrayBuffer>) => unknown;
  readonly randomUUID: () => string;
  /** `crypto.subtle.generateKey`, called on the platform's `SubtleCrypto`. */
  readonly generateKey: (this: unknown, ...args: unknown[]) => unknown;
}

/** Puts `value` in place of `key` of `target`, for good; whether it took. */
export const seal = (target: object, key: string, value?: unknown): boolean => {
  try {
    Object.defineProperty(target, key, {
      configurable: false,
      writable: false,
      enumerable: false,
      value,
    });
  } catch {
    return false;
  }
  return Reflect.get(target, key) === value;
};

/**
 * Puts `value` in place of `key` where code reaches the platform's
 * function: on `object`'s prototype, and on `object` itself when it holds
 * `key` as its own. Whether it took on each.
 */
export const sealWhereReached = (
  object: object,
  key: string,
  value: unknown
): boolean => {
  const prototype: unknown = Reflect.getPrototypeOf(object);
  const holders = [
    ...(typeof prototype === "object" && prototype !== null ? [prototype] : []),
    ...(Object.hasOwn(object, key) ? [object] : []),
  ];
  return holders.map((holder) => seal(holder, key, value)).every(Boolean);
};

/** `Date`, its time without a date taken from `now`. */
const dateFrom = (now: () => number): DateConstructor =>
  // SAFETY: the handler has exactly a `ProxyHandler`'s `apply` and
  // `construct` traps; `__proto__: null` only sets its prototype.
  new Proxy(Date, {
    // No prototype: a trap the handler doesn't have is never looked up on
    // `Object.prototype`, where module code could define one and be handed
    // the real `Date`.
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
 * Replaces, for good: `Date.now` (on the real `Date`, which the global's
 * proxy hands descriptor reads and gets to), the global `Date` and
 * `Date.prototype.constructor`, `Math.random`, `crypto`'s
 * `getRandomValues` and `randomUUID`, `SubtleCrypto`'s `generateKey`, and
 * `Intl.DateTimeFormat` formatting no date. Whether every one took.
 */
export const replaceClockAndRandomness = (
  sources: ClockAndRandomness
): boolean => {
  const sealed: boolean[] = [
    sealWhereReached(crypto, "getRandomValues", sources.getRandomValues),
    sealWhereReached(crypto, "randomUUID", sources.randomUUID),
  ];
  if (typeof SubtleCrypto === "function") {
    sealed.push(
      seal(SubtleCrypto.prototype, "generateKey", sources.generateKey)
    );
  }
  const date = dateFrom(sources.now);
  sealed.push(
    // On the real `Date`, before the global is replaced.
    seal(Date, "now", sources.now),
    seal(Math, "random", sources.random),
    seal(globalThis, "Date", date),
    seal(Date.prototype, "constructor", date)
  );
  const dateFormat: object = Intl.DateTimeFormat.prototype;
  const formatGetter: unknown = Reflect.getOwnPropertyDescriptor(
    dateFormat,
    "format"
  )?.get;
  const formatToParts: unknown = Reflect.getOwnPropertyDescriptor(
    dateFormat,
    "formatToParts"
  )?.value;
  try {
    Object.defineProperty(dateFormat, "format", {
      configurable: false,
      enumerable: false,
      // As the platform's getter: a function bound to its formatter, which
      // formats `now` when given no date.
      get(this: unknown): unknown {
        const bound: unknown =
          typeof formatGetter === "function"
            ? apply(formatGetter, this, [])
            : undefined;
        // The date alone, by name: `args[0]` of no arguments would be
        // looked up on `Array.prototype`, where module code could put one.
        return (given?: unknown): unknown => {
          const at = given === undefined ? sources.now() : given;
          if (typeof bound !== "function") {
            throw new TypeError("Intl.DateTimeFormat formats no date here.");
          }
          const formatted: unknown = apply(bound, undefined, [at]);
          return formatted;
        };
      },
    });
    sealed.push(true);
  } catch {
    sealed.push(false);
  }
  sealed.push(
    seal(
      dateFormat,
      "formatToParts",
      function formatToPartsAt(this: unknown, given?: unknown): unknown {
        if (typeof formatToParts !== "function") {
          throw new TypeError("Intl.DateTimeFormat formats no date here.");
        }
        const parts: unknown = apply(formatToParts, this, [
          given === undefined ? sources.now() : given,
        ]);
        return parts;
      }
    )
  );
  return sealed.every(Boolean);
};
