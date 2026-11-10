// What an isolate's code reads the clock and randomness through, and what
// it reads in their place, from sources the caller gives
// (`clockAndRandomnessFrom`). A mutation's fixed time and seeded
// randomness (mutation-runtime.ts) are put in place for good: each
// replacement is non-configurable and non-writable, on the object code
// reaches it on and on the prototype the platform keeps it on, so code
// that loads after can't put the original back or reach it another way.
// A migration's transform has the same replacements, refusing, shadowed
// while it runs and restored after (determinism.ts).
//
// Every way the platform reads the clock or draws randomness of its own
// is on this one list, so both get each. One answers from the sources
// where they can stand in for it, and is refused (`unseeded`) where they
// can't:
// - The clock (`Date`, a formatter given no date, `performance.now`) and
//   randomness (`Math.random`, `crypto.getRandomValues`, `randomUUID`):
//   from the sources.
// - What records the time it is made: a `File`'s `lastModified` and a
//   `PerformanceMark`'s or `performance.mark`'s `startTime`, each unless
//   given, from the sources; `performance.measure`, refused. workerd keeps
//   its classes on the global's prototype, so `File` and `PerformanceMark`
//   are replaced there as well as on the global.
// - A file the platform makes itself, of the time it runs: `FormData`'s
//   `append` or `set` given a blob, and reading a body as a form
//   (`formData()`), which makes one of each file in it. Both refused,
//   deliberately broadly: also a file given with no name (which the
//   platform keeps as it is) and a urlencoded body (which holds no
//   files), as neither is of use without a network, and one rule is
//   simpler to hold than telling them apart.
// - A form's body: a `Response` or `Request` made with a `FormData` body
//   gets a multipart boundary of the platform's randomness, in its
//   `content-type` and its bytes, so is refused. A request's `body` is
//   read once, and the platform reads `init` through a proxy that
//   answers that body, so neither a `body` getter answering the check
//   one thing and the platform another, nor a getter or proxy trap of
//   `init`'s writing a form to it after, changes what the platform
//   reads; every other field is read on `init` itself, so its getters
//   run with it as `this`. An algorithm's name below is held the same
//   way.
// - Keys and randomized cryptography: `generateKey` is refused, and so is
//   `sign`, `encrypt` or `wrapKey` with an algorithm that draws a nonce,
//   salt or padding (ECDSA, RSA-PSS, RSA-OAEP): only the algorithms that
//   answer the same for the same key, data and parameters pass (an AES
//   mode's IV or counter is the caller's). The algorithm's name is read
//   once and passed on as read. `deriveBits`, `deriveKey`, `importKey`,
//   `digest`, `DigestStream`, `verify`, `decrypt` and `unwrapKey` draw
//   none.
// Looked at in workerd and drawing none: `performance.timeOrigin` and an
// event's `timeStamp` (both 0), `navigator`, `structuredClone` (files
// don't clone), `URL.createObjectURL` (not implemented); `scheduler.wait`
// and timers answer no time. Not a value code reads, so not on the list:
// when a weak reference is cleared, which only the garbage collector
// decides; and `fetch`, a sink, not a source: an App's isolate has no
// network (`globalOutbound: null`), and the boundary of a form it would
// send never comes back to App code.
// Not stopped, and not a boundary: a value computed while App modules
// load, before a mutation starts or a transform runs, comes from the
// platform's own clock and randomness, as determinism.ts says for a
// transform.

/**
 * The intrinsics the replacements call, and the platform's functions they
 * pass on to, taken as this module loads, before any module of App or
 * workflow code: a replacement never looks one up again, so replacing
 * `Reflect.construct`, `Object.defineProperty` or the like can't intercept
 * what it passes on (the real `Date`, formatter or `File`), nor the
 * arguments that carry a time.
 */
const {
  apply,
  construct,
  get: reflectGet,
  getPrototypeOf,
  setPrototypeOf,
} = Reflect;
const { defineProperty, getOwnPropertyDescriptor, hasOwn } = Object;
const platformString = String;
const PlatformProxy = Proxy;
const toUpperCase: unknown = Reflect.get(String.prototype, "toUpperCase");
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

/** `Class`'s prototype, where it is a class that has one. */
const prototypeOf = (Class: unknown): object | undefined => {
  const prototype: unknown =
    typeof Class === "function" ? Reflect.get(Class, "prototype") : undefined;
  return typeof prototype === "object" && prototype !== null
    ? prototype
    : undefined;
};

/** `key` of `target`, its own, where it holds one: its value, or its getter. */
const ownValue = (target: object | undefined, key: string): unknown =>
  target === undefined
    ? undefined
    : Reflect.getOwnPropertyDescriptor(target, key)?.value;
const ownGetter = (target: object | undefined, key: string): unknown =>
  target === undefined
    ? undefined
    : Reflect.getOwnPropertyDescriptor(target, key)?.get;

/** The object `object` finds `key` on: itself, or one of its prototypes. */
const holderOf = (object: unknown, key: string): object | undefined => {
  let at = object;
  while (typeof at === "object" && at !== null) {
    if (hasOwn(at, key)) {
      return at;
    }
    at = getPrototypeOf(at);
  }
  return undefined;
};

const platformRequest: unknown = Reflect.get(globalThis, "Request");
const platformResponse: unknown = Reflect.get(globalThis, "Response");
const formDataPrototype = prototypeOf(Reflect.get(globalThis, "FormData"));
const formDataHas = ownValue(formDataPrototype, "has");
const formDataAppend = ownValue(formDataPrototype, "append");
const formDataSet = ownValue(formDataPrototype, "set");
const blobSize = ownGetter(
  prototypeOf(Reflect.get(globalThis, "Blob")),
  "size"
);
const requestMethod = ownGetter(prototypeOf(platformRequest), "method");
/**
 * Where a request and a response keep `formData` (in workerd, one
 * `Body`), each once, with the platform's.
 */
const formReaders = [
  ...new Set([
    holderOf(prototypeOf(platformRequest), "formData"),
    holderOf(prototypeOf(platformResponse), "formData"),
  ]),
].flatMap((holder) =>
  holder === undefined ? [] : [{ holder, read: ownValue(holder, "formData") }]
);
const platformSubtle: object = crypto.subtle;
const platformGenerateKey: unknown = Reflect.get(platformSubtle, "generateKey");
const platformSign: unknown = Reflect.get(platformSubtle, "sign");
const platformEncrypt: unknown = Reflect.get(platformSubtle, "encrypt");
const platformWrapKey: unknown = Reflect.get(platformSubtle, "wrapKey");

/** What a replacement stands in for. */
export type Reads = "the clock" | "randomness";

/** What the clock and randomness answer from. */
export interface ClockAndRandomness {
  /**
   * `Date.now()`, `new Date()`, `Date()`, a formatter given no date, and a
   * file's `lastModified` unless given.
   */
  readonly now: () => number;
  /** `performance.now()`, and a mark's `startTime` unless given. */
  readonly performanceNow: () => number;
  readonly random: () => number;
  readonly getRandomValues: (array: ArrayBufferView<ArrayBuffer>) => unknown;
  readonly randomUUID: () => string;
  /**
   * Called before the platform's own of what the sources can't stand in
   * for (`what`, which reads `reads`): a measure, a form's file or body,
   * generating a key, a randomized signature or encryption. Throws to
   * refuse it; returns to let the platform's run.
   */
  readonly unseeded: (what: string, reads: Reads) => void;
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
  /** What it stands in for. */
  readonly reads: Reads;
}

/** `value` in place of `key` of `target`, standing in for what `reads`. */
const replacing = (
  target: object,
  key: string,
  value: unknown,
  reads: Reads,
  ifOwn = false
): Replacement => ({ target, key, get: undefined, value, ifOwn, reads });

/**
 * `object`, its prototype taken away: only its own fields are read, never
 * one module code put on `Object.prototype` (or, for an index, on
 * `Array.prototype`).
 */
export const withoutPrototype = <T extends object>(object: T): T => {
  setPrototypeOf(object, null);
  return object;
};

/**
 * The algorithms whose `sign`, `encrypt` and `wrapKey` answer the same for
 * the same key, data and parameters, by their names as the platform
 * matches them (in capitals). ECDSA, RSA-PSS and RSA-OAEP draw a nonce,
 * salt or padding of the platform's randomness, and any other is taken to.
 */
const deterministicAlgorithms: Readonly<Record<string, true | undefined>> =
  withoutPrototype({
    HMAC: true,
    "RSASSA-PKCS1-V1_5": true,
    ED25519: true,
    "NODE-ED25519": true,
    "AES-GCM": true,
    "AES-CBC": true,
    "AES-CTR": true,
    "AES-KW": true,
  });

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
 * `value` in place of `key` where code reaches the platform's: on
 * `object`'s prototype, and on `object` itself (`ifOwn`).
 */
const whereReached = (
  object: object,
  key: string,
  value: unknown,
  reads: Reads
): Replacement[] => {
  const prototype: unknown = getPrototypeOf(object);
  return [
    ...(typeof prototype === "object" && prototype !== null
      ? [replacing(prototype, key, value, reads)]
      : []),
    replacing(object, key, value, reads, true),
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

/** A field's data descriptor, holding `value`, as an assignment makes one. */
const dataField = (value: unknown): PropertyDescriptor =>
  // SAFETY: a data descriptor's fields; `__proto__: null` only sets its
  // prototype, so no `get` or `set` of App code's is read as one.
  ({
    __proto__: null,
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  }) as PropertyDescriptor;

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
    defineProperty(given, at, dataField(at === index ? value : args[at]));
  }
  return given;
};

/**
 * `object` as the platform reads it, with `key` as read once (`value`):
 * a proxy over it whose `get` answers `value` for `key`, so a getter that
 * answers one thing to a check and another to the platform is never read
 * again, and whatever App code writes to `object` after (a getter writing
 * `this.body`, a trap writing to its receiver) never reaches what the
 * platform reads. Every other field is read on `object` with `object` as
 * receiver, so its getters, private fields too, run as they would
 * without the check. workerd reads a request's `init` and an algorithm
 * by `[[Get]]` alone (no `has` or descriptor reads), which is all the
 * proxy has to answer.
 */
const withOwn = (object: object, key: string, value: unknown): object =>
  // SAFETY: the handler has exactly a `ProxyHandler`'s `get` trap;
  // `__proto__: null` only sets its prototype.
  new PlatformProxy(object, {
    // No prototype: a trap the handler doesn't have is never looked up on
    // `Object.prototype`, where App code could define one.
    __proto__: null,
    get: (target, field): unknown => {
      if (field === key) {
        return value;
      }
      const read: unknown = reflectGet(target, field, target);
      return read;
    },
  } as ProxyHandler<object>);

/** Whether `check`, called on `value`, passes: only the platform's own do. */
const passes = (check: unknown, value: unknown, args: unknown[]): boolean => {
  if (typeof check !== "function") {
    return false;
  }
  try {
    apply(check, value, args);
    return true;
  } catch {
    return false;
  }
};
const isFormData = (value: unknown): boolean =>
  passes(formDataHas, value, [""]);
const isBlob = (value: unknown): boolean => passes(blobSize, value, []);
const isRequest = (value: unknown): boolean => passes(requestMethod, value, []);

/** `args[index]`, where given: never looked up on `Array.prototype`. */
const argumentAt = (args: readonly unknown[], index: number): unknown =>
  args.length > index ? args[index] : undefined;

/**
 * In place of the platform's class `Class` (the global `name`, on the
 * global and its prototype, and its prototype's `constructor`): one that
 * constructs it with the arguments `given` answers for those it is given.
 * Nothing where the platform has no such class; throws where its class
 * has no prototype to replace `constructor` on, so nothing runs with the
 * class half replaced.
 */
const classWith = (
  Class: unknown,
  name: string,
  reads: Reads,
  given: (args: unknown[]) => unknown[]
): Replacement[] => {
  if (typeof Class !== "function") {
    return [];
  }
  const prototype = prototypeOf(Class);
  if (prototype === undefined) {
    throw new TypeError(`${name} has no prototype here.`);
  }
  // SAFETY: the handler has exactly a `ProxyHandler`'s `construct` trap;
  // `__proto__: null` only sets its prototype.
  const replaced = new Proxy(Class, {
    // No prototype: a trap the handler doesn't have is never looked up on
    // `Object.prototype`, where App code could define one.
    __proto__: null,
    construct: (target, args: unknown[], newTarget) => {
      const made: unknown = construct(target, given(args), newTarget);
      // SAFETY: constructing the platform's class makes one of its instances.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return made as object;
    },
  } as ProxyHandler<typeof Class>);
  return [
    ...whereReached(globalThis, name, replaced, reads),
    replacing(prototype, "constructor", replaced, reads),
  ];
};

/**
 * The platform's class `Class` (`name`), its instances taking the time
 * they are made, `options[key]`, from `time` when its argument at `index`
 * doesn't set it.
 */
const timedClass = (
  Class: unknown,
  name: string,
  index: number,
  key: string,
  time: () => number
): Replacement[] =>
  classWith(Class, name, "the clock", (args) =>
    argumentsWith(args, index, withDefault(argumentAt(args, index), key, time))
  );

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
 * platform's, from `sources` (see the threat model above): `Date.now` (on
 * the real `Date`, which the global's proxy hands descriptor reads and
 * gets to), `new Date()` and `Date()` through the global `Date` or
 * `Date.prototype.constructor`, `Intl.DateTimeFormat` formatting no date,
 * the performance timeline's clock and what reads it (a mark's time, a
 * measure), a file's `lastModified` and a mark's `startTime` unless
 * given, `Math.random`, `crypto`'s `getRandomValues` and `randomUUID`;
 * and, asking `unseeded` first, a form's files and body, and
 * `SubtleCrypto`'s `generateKey` and randomized `sign`, `encrypt` and
 * `wrapKey`.
 */
export const clockAndRandomnessFrom = (
  sources: ClockAndRandomness
): Replacement[] => {
  const { unseeded } = sources;
  const date = dateFrom(sources.now);
  /**
   * The platform's `method`, called once `unseeded` let `what` run, put
   * where `place` puts it. Nothing where the platform has no such method.
   */
  const unseededAt = (
    method: unknown,
    what: string,
    reads: Reads,
    place: (call: unknown) => Replacement[]
  ): Replacement[] =>
    typeof method === "function"
      ? place(function unseededCall(this: unknown, ...args: unknown[]) {
          unseeded(what, reads);
          const answer: unknown = apply(method, this, args);
          return answer;
        })
      : [];
  /**
   * `FormData`'s `key`, the platform's `method` (`append` or `set`):
   * given a blob, it makes a file of it, of the time it runs.
   */
  const formEntry = (key: string, method: unknown): Replacement[] =>
    formDataPrototype !== undefined && typeof method === "function"
      ? [
          replacing(
            formDataPrototype,
            key,
            function formEntryCall(this: unknown, ...args: unknown[]): unknown {
              if (isBlob(argumentAt(args, 1))) {
                unseeded("a form's file", "the clock");
              }
              const answer: unknown = apply(method, this, args);
              return answer;
            },
            "the clock"
          ),
        ]
      : [];
  /**
   * `SubtleCrypto`'s `key`, the platform's `method`, which takes its
   * algorithm at `index`: asks `unseeded` unless the algorithm answers
   * the same each time. Its name is read once, and the algorithm passed
   * on as read.
   */
  const randomized = (
    key: string,
    method: unknown,
    index: number,
    what: string
  ): Replacement[] => {
    if (typeof method !== "function") {
      return [];
    }
    return whereReached(
      platformSubtle,
      key,
      function randomizedCall(this: unknown, ...args: unknown[]): unknown {
        const algorithm = argumentAt(args, index);
        let name: unknown;
        let given = args;
        if (typeof algorithm === "string") {
          name = algorithm;
        } else if (
          (typeof algorithm === "object" || typeof algorithm === "function") &&
          algorithm !== null
        ) {
          const read: unknown = reflectGet(algorithm, "name");
          name = read === undefined ? undefined : platformString(read);
          given = argumentsWith(args, index, withOwn(algorithm, "name", name));
        }
        const capitals: unknown =
          typeof name === "string" && typeof toUpperCase === "function"
            ? apply(toUpperCase, name, [])
            : undefined;
        if (
          typeof capitals !== "string" ||
          deterministicAlgorithms[capitals] !== true
        ) {
          unseeded(what, "randomness");
        }
        const answer: unknown = apply(method, this, given);
        return answer;
      },
      "randomness"
    );
  };
  return [
    replacing(platformDate, "now", sources.now, "the clock"),
    replacing(globalThis, "Date", date, "the clock"),
    replacing(datePrototype, "constructor", date, "the clock"),
    {
      target: dateFormatPrototype,
      key: "format",
      get: formatFrom(sources.now),
      value: undefined,
      ifOwn: false,
      reads: "the clock",
    },
    replacing(
      dateFormatPrototype,
      "formatToParts",
      formatToPartsFrom(sources.now),
      "the clock"
    ),
    ...whereReached(performance, "now", sources.performanceNow, "the clock"),
    ...(typeof platformMark === "function"
      ? whereReached(
          performance,
          "mark",
          markFrom(sources.performanceNow),
          "the clock"
        )
      : []),
    ...unseededAt(platformMeasure, "performance.measure", "the clock", (call) =>
      whereReached(performance, "measure", call, "the clock")
    ),
    ...timedClass(platformFile, "File", 2, "lastModified", sources.now),
    ...timedClass(
      platformPerformanceMark,
      "PerformanceMark",
      1,
      "startTime",
      sources.performanceNow
    ),
    ...formEntry("append", formDataAppend),
    ...formEntry("set", formDataSet),
    ...formReaders.flatMap(({ holder, read }) =>
      unseededAt(read, "reading a form", "the clock", (call) => [
        replacing(holder, "formData", call, "the clock"),
      ])
    ),
    ...classWith(platformResponse, "Response", "randomness", (args) => {
      if (isFormData(argumentAt(args, 0))) {
        unseeded("a form's body", "randomness");
      }
      return args;
    }),
    ...classWith(platformRequest, "Request", "randomness", (args) => {
      const init = argumentAt(args, 1);
      if (
        (typeof init !== "object" && typeof init !== "function") ||
        init === null ||
        isRequest(init)
      ) {
        return args;
      }
      const body: unknown = reflectGet(init, "body");
      if (isFormData(body)) {
        unseeded("a form's body", "randomness");
      }
      return argumentsWith(args, 1, withOwn(init, "body", body));
    }),
    replacing(Math, "random", sources.random, "randomness"),
    ...whereReached(
      crypto,
      "getRandomValues",
      sources.getRandomValues,
      "randomness"
    ),
    ...whereReached(crypto, "randomUUID", sources.randomUUID, "randomness"),
    ...unseededAt(
      platformGenerateKey,
      "generating a key",
      "randomness",
      (call) => whereReached(platformSubtle, "generateKey", call, "randomness")
    ),
    ...randomized("sign", platformSign, 0, "a randomized signature"),
    ...randomized("encrypt", platformEncrypt, 0, "randomized encryption"),
    ...randomized("wrapKey", platformWrapKey, 3, "randomized key wrapping"),
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
