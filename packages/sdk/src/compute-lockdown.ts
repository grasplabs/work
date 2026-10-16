// Takes the clock, randomness, timers and the network away from the
// isolate a workflow's compute module runs in (compute-runner.ts), for the
// isolate's whole life: core's compute call loads this module before any
// of the workflow's own, and every isolate runs one call only, so nothing
// is ever put back.
//
// Defense in depth, not the boundary: the isolate has no env, no bindings
// and no outbound network, so there is nothing to reach. What this adds is
// that a calculation can't read the time or a random number, wait on a
// timer, or generate code (which would import modules the compiler never
// let it name, `cloudflare:sockets` among them), so it answers the same
// for the same input and can hide nothing behind a delay. Each global is
// replaced with a refusal and made non-configurable and non-writable, on
// the global object and on every prototype of it that has it as its own
// (workerd keeps most of the platform's globals there), so module code
// can't put the original back or reach it another way; `lockedDown` says
// whether every one of them took, and the runner refuses to run a
// calculation in an isolate where one didn't.

/**
 * The intrinsics the wrappers below call, taken as this module loads,
 * before any module of the workflow's: a wrapper module code calls later
 * never looks one up again, so replacing `Reflect.apply`, `Error` or the
 * like can't intercept what it passes on (the real `Date` or formatter).
 */
const { apply, construct } = Reflect;
const RefusalError = Error;

/** A function that refuses, for what a calculation can't use. */
const unavailable = (what: string) => (): never => {
  throw new RefusalError(
    `A calculation is pure: ${what} isn't available to it.`
  );
};

/** Puts `value` in place of `key` of `target`, for good; whether it took. */
const seal = (target: object, key: string, value?: unknown): boolean => {
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
 * `Date`, except that it never tells the time: constructing it without a
 * date refuses, and its `now` is the real `Date`'s, sealed as a refusal
 * (`lockdown`), since a proxy hands descriptor reads to its target.
 */
const clocklessDate = (): DateConstructor =>
  // SAFETY: the handler has exactly a `ProxyHandler`'s `apply` and
  // `construct` traps; `__proto__: null` only sets its prototype.
  new Proxy(Date, {
    // No prototype: a trap the handler doesn't have is never looked up on
    // `Object.prototype`, where module code could define one and be handed
    // the real `Date`.
    __proto__: null,
    apply: unavailable("the clock"),
    construct: (target, args: unknown[]) => {
      if (args.length === 0) {
        return unavailable("the clock")();
      }
      // SAFETY: constructing `Date` with arguments makes a `Date`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return construct(target, args) as Date;
    },
  } as ProxyHandler<DateConstructor>);

/** The globals a calculation has no use for, taken away entirely. */
const removedGlobals = [
  "crypto",
  "Crypto",
  "SubtleCrypto",
  "CryptoKey",
  "performance",
  "Performance",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "scheduler",
  "fetch",
  "caches",
  "WebSocket",
  "EventSource",
  "Temporal",
  "WeakRef",
  "FinalizationRegistry",
] as const;

/**
 * The global object and its prototypes, as they are now: where a global
 * may live as an own property.
 */
const globalChain = (): object[] => {
  const chain: object[] = [];
  for (
    let level: object | null = globalThis;
    level !== null;
    level = Reflect.getPrototypeOf(level)
  ) {
    chain.push(level);
  }
  return chain;
};

/**
 * The prototypes whose `constructor` generates code from text: `Function`
 * and its generator and async kin, reached from any function a module
 * writes. Taken as this module loads, before `Function` itself is
 * replaced.
 */
const codeConstructors: readonly object[] = [
  Function.prototype,
  Reflect.getPrototypeOf(function* generator() {
    // Never run: only its prototype is read.
  }) ?? Function.prototype,
  Reflect.getPrototypeOf(async () => {
    // Never run: only its prototype is read.
  }) ?? Function.prototype,
  Reflect.getPrototypeOf(async function* asyncGenerator() {
    // Never run: only its prototype is read.
  }) ?? Function.prototype,
];

/** Whether `probe` throws, as everything taken away must. */
const refuses = (probe: () => unknown): boolean => {
  try {
    probe();
  } catch {
    return true;
  }
  return false;
};

/** Whether `fn`, a function, refuses when called: as it must. */
const calledRefuses = (fn: unknown): boolean =>
  typeof fn === "function" && refuses(() => Reflect.apply(fn, undefined, []));

/** Whether `generate`, called on source text, refuses: as it must. */
const generatesNothing = (generate: unknown): boolean =>
  typeof generate === "function" &&
  refuses(() => Reflect.apply(generate, undefined, ["return 1"]));

/** Checks, after the fact, that what a calculation could misuse refuses. */
const probesRefuse = (): boolean =>
  refuses(() => Date.now()) &&
  calledRefuses(Reflect.getOwnPropertyDescriptor(Date, "now")?.value) &&
  refuses(() => new Date()) &&
  refuses(() => Math.random()) &&
  refuses(() => new Intl.DateTimeFormat().format()) &&
  generatesNothing(Reflect.get(globalThis, "eval")) &&
  generatesNothing(Reflect.get(globalThis, "Function")) &&
  codeConstructors.every((prototype) =>
    generatesNothing(Reflect.get(prototype, "constructor"))
  ) &&
  globalChain().every((level) =>
    removedGlobals.every((key) => Reflect.get(level, key) === undefined)
  );

const lockdown = (): boolean => {
  const sealed: boolean[] = [];
  // The prototypes the real functions live on, as they are now: reachable
  // from instances a module may still hold.
  const cryptoPrototype: unknown =
    typeof crypto === "object" ? Object.getPrototypeOf(crypto) : undefined;
  if (typeof cryptoPrototype === "object" && cryptoPrototype !== null) {
    for (const key of ["getRandomValues", "randomUUID"]) {
      sealed.push(seal(cryptoPrototype, key, unavailable("randomness")));
    }
  }
  if (typeof SubtleCrypto === "function") {
    sealed.push(
      seal(SubtleCrypto.prototype, "generateKey", unavailable("randomness"))
    );
  }
  const clockless = clocklessDate();
  sealed.push(
    // On the real `Date`, before the global is replaced: what the proxy
    // forwards descriptor reads and gets to.
    seal(Date, "now", unavailable("the clock")),
    seal(Math, "random", unavailable("randomness")),
    seal(globalThis, "Date", clockless),
    seal(Date.prototype, "constructor", clockless)
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
      // refuses to format the current time (no date given).
      get(this: unknown): unknown {
        const bound: unknown =
          typeof formatGetter === "function"
            ? apply(formatGetter, this, [])
            : undefined;
        return (...args: unknown[]): unknown => {
          if (args[0] === undefined || typeof bound !== "function") {
            return unavailable("the clock")();
          }
          const formatted: unknown = apply(bound, undefined, args);
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
      function datelessFormatToParts(
        this: unknown,
        ...args: unknown[]
      ): unknown {
        if (args[0] === undefined || typeof formatToParts !== "function") {
          return unavailable("the clock")();
        }
        const parts: unknown = apply(formatToParts, this, args);
        return parts;
      }
    )
  );
  // Code from text: refused wherever a module could reach a constructor.
  const generating = unavailable("generating code");
  sealed.push(
    seal(globalThis, "eval", generating),
    seal(globalThis, "Function", generating),
    ...codeConstructors.map((prototype) =>
      seal(prototype, "constructor", generating)
    )
  );
  const chain = globalChain();
  for (const key of removedGlobals) {
    sealed.push(seal(globalThis, key));
    // And on each prototype that has it as its own, as workerd's globals.
    for (const level of chain.slice(1)) {
      if (Object.hasOwn(level, key)) {
        sealed.push(seal(level, key));
      }
    }
  }
  return sealed.every(Boolean) && probesRefuse();
};

/** Whether the isolate is locked down: the runner runs nothing otherwise. */
export const lockedDown: boolean = lockdown();
