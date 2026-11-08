import { refusals } from "./lockdown.ts";
import { impureMessage } from "./migration.ts";

/** A function that refuses, for what a migration can't use. */
const unavailable = refusals(impureMessage);

/** What a global held before a transform: its own property, if it had one. */
interface Saved {
  readonly target: object;
  readonly key: string;
  readonly own: PropertyDescriptor | undefined;
}

/** Shadows the accessor `key` of `target` with `get` where it can, as `shadow`. */
const shadowGetter = (
  target: object,
  key: string,
  get: () => unknown
): Saved => {
  const own = Object.getOwnPropertyDescriptor(target, key);
  try {
    Object.defineProperty(target, key, { configurable: true, get });
  } catch {
    // Not configurable here: left as it is (see `deterministically`).
  }
  return { target, key, own };
};

/** Shadows `key` of `target` with `value` where it can; what it held before. */
const shadow = (target: object, key: string, value: unknown): Saved => {
  const own = Object.getOwnPropertyDescriptor(target, key);
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
  } catch {
    // Not configurable here: left as it is (see `deterministically`).
  }
  return { target, key, own };
};

/** Puts back what `saved` held before it was shadowed. */
const restore = ({ target, key, own }: Saved): void => {
  try {
    if (own === undefined) {
      Reflect.deleteProperty(target, key);
    } else {
      Object.defineProperty(target, key, own);
    }
  } catch {
    // As `shadow` left it.
  }
};

/** `Date`, except that it never tells the time. */
const clocklessDate = (): DateConstructor =>
  new Proxy(Date, {
    apply: unavailable("the clock"),
    construct: (target, args: unknown[]) => {
      if (args.length === 0) {
        return unavailable("the clock")();
      }
      // SAFETY: constructing `Date` with arguments makes a `Date`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return Reflect.construct(target, args) as Date;
    },
    get: (target, key, receiver): unknown => {
      if (key === "now") {
        return unavailable("the clock");
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return value;
    },
  });

/**
 * The prototypes the shadows reach the real functions through, as they
 * were when the runner loaded, before any App module did: `Date` is also
 * reachable as `Date.prototype.constructor`, and `crypto`'s methods live
 * on its prototype.
 */
const datePrototype = Date.prototype;
const cryptoPrototype: unknown = Object.getPrototypeOf(crypto);
const dateFormatPrototype: object = Intl.DateTimeFormat.prototype;
const formatGetter: unknown = Reflect.getOwnPropertyDescriptor(
  dateFormatPrototype,
  "format"
)?.get;
const formatToParts: unknown = Reflect.getOwnPropertyDescriptor(
  dateFormatPrototype,
  "formatToParts"
)?.value;

/**
 * `Intl.DateTimeFormat`'s `format` getter, as the platform's is: it
 * answers a function bound to its formatter, so a detached
 * `const format = formatter.format` still works. The function refuses to
 * format the current time (no date given); formatting a date it is given
 * is pure.
 */
const datelessFormatGetter = function datelessFormatGetter(
  this: unknown
): unknown {
  const bound: unknown =
    typeof formatGetter === "function"
      ? Reflect.apply(formatGetter, this, [])
      : undefined;
  return (...args: unknown[]): unknown => {
    if (args[0] === undefined || typeof bound !== "function") {
      return unavailable("the clock")();
    }
    const formatted: unknown = Reflect.apply(bound, undefined, args);
    return formatted;
  };
};

/** `Intl.DateTimeFormat`'s `formatToParts`, as `datelessFormat`. */
const datelessFormatToParts = function datelessFormatToParts(
  this: unknown,
  ...args: unknown[]
): unknown {
  if (args[0] === undefined || typeof formatToParts !== "function") {
    return unavailable("the clock")();
  }
  const parts: unknown = Reflect.apply(formatToParts, this, args);
  return parts;
};

/**
 * Runs `work` with randomness and the clocks taken away (`Math.random`,
 * `crypto`'s random values on the object and its prototype, `Date.now`,
 * `new Date()` through `Date` or `Date.prototype.constructor`,
 * `performance.now`, and `Intl.DateTimeFormat` formatting the current
 * time), restoring them after, so a transform answers the same for the
 * same row however often a batch is retried. Best effort, not a boundary:
 * App code that kept a reference to one from before, or a value computed
 * as its modules loaded, still differs between calls, and the isolate has
 * no capability for it to misuse either way. So a retried batch is
 * answered from the store's receipt and never compared with an earlier
 * answer.
 */
export const deterministically = <Result>(work: () => Result): Result => {
  const clockless = clocklessDate();
  const prototypeOfCrypto =
    typeof cryptoPrototype === "object" && cryptoPrototype !== null
      ? cryptoPrototype
      : crypto;
  const saved = [
    shadow(Math, "random", unavailable("randomness")),
    shadow(crypto, "getRandomValues", unavailable("randomness")),
    shadow(crypto, "randomUUID", unavailable("randomness")),
    shadow(prototypeOfCrypto, "getRandomValues", unavailable("randomness")),
    shadow(prototypeOfCrypto, "randomUUID", unavailable("randomness")),
    shadow(performance, "now", unavailable("the clock")),
    shadow(globalThis, "Date", clockless),
    shadow(datePrototype, "constructor", clockless),
    shadowGetter(dateFormatPrototype, "format", datelessFormatGetter),
    shadow(dateFormatPrototype, "formatToParts", datelessFormatToParts),
  ];
  try {
    return work();
  } finally {
    for (const one of saved.toReversed()) {
      restore(one);
    }
  }
};
