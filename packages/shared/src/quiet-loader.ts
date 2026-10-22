import { hasNodeModules, quietModules } from "./quiet-isolate.ts";

// What an isolate core or connect loads itself may print (GRA-910,
// GRA-940). On Cloudflare a Loader isolate's console output is dropped
// unless a tail is attached, and then it goes to the tail alone. Plain
// workerd prints it to the loading Worker's own stdout and stderr, the
// deployment's logs, where whatever the code logs (a record, a caller's
// input, a document's text, an API's response to a connector) would be read
// by whoever reads those logs. Connect loads a connector's isolate for every
// native action call, on either profile (apps/connect/src/connectors.ts).
// Core loads isolates itself off Cloudflare only with
// `SANDBOX_IN_PROCESS=unbounded` (apps/core/src/sandboxed.ts), which is for
// tests and local development, but nothing stops a deployment setting it.
//
// So every isolate core or connect loads goes through `quietLoader`: its
// main module imports the quiet module first (quiet-isolate.ts), which
// silences every console method before any other module loads and keeps
// what the code leaves uncaught from anything workerd served `--verbose`
// reports for an isolate. What the module can't reach, `quietLoader` does
// (GRA-939): the isolate's main is a wrapper (`entrySource`) that answers
// whatever its entrypoint's call throws as a value, which the stub
// `quietLoader` hands back throws again here, and a default export's own
// context's `waitUntil` swallows a rejection. Isolates of App code,
// connectors and packages have no Node.js (`isolateBase`), so no timer
// imported by name from `node:timers`. What still reaches a workerd served
// `--verbose` is that kind of timer's throw in the platform's own code that
// turns Node on (the compiler, extraction), whose imports are its own
// bundle's. That holds on either profile; on Cloudflare it drops nothing
// the runtime wouldn't.
//
// An isolate with a tail is left as it is: its tail (core's server-logs.ts)
// is how a builder sees what the App's server code wrote, and a silenced
// console would hand the tail nothing. On plain workerd that output still
// reaches the process's logs too, which `SANDBOX_IN_PROCESS=unbounded`
// accepts (core's env.d.ts); GRA-919 delivers it to the tail's destinations
// instead. Connect attaches no tail.

/**
 * What `quietLoader` needs of a Loader's code: the Worker Loader's own
 * `WorkerLoaderWorkerCode`, read structurally so this package needs no
 * Workers types.
 */
export interface QuietableCode {
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, unknown>>;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: readonly string[];
  readonly tails?: readonly unknown[];
  readonly streamingTails?: readonly unknown[];
}

/** A Worker Loader, as `quietLoader` wraps one. */
export interface QuietableLoader<Code extends QuietableCode, Stub> {
  readonly get: (
    name: string | null,
    getCode: () => Code | Promise<Code>
  ) => Stub;
  readonly load: (code: Code) => Stub;
}

/** The most characters of a thrown error's message that cross (GRA-939). */
export const maxThrownMessage = 2000;

/** The most characters of a thrown error's name that cross. */
const maxThrownName = 200;

/** The header a quiet `fetch`'s thrown error crosses under, as a Response. */
const thrownHeader = "x-grasp-thrown";

/**
 * The key of the envelope every wrapped call's answer comes in: `{ value }`
 * or `{ thrown }`, made by the wrapper alone, so a value's own keys never
 * read as a thrown error. The same for every isolate, so an isolate the
 * Loader keeps answers the same envelope whichever stub of it asks.
 */
const envelopeKey = "\u0000grasp:answer";

/** The wrapper module's name: a main module none of the isolate's has. */
const entryModule = "grasp-sandbox-entry.js";

/** A module name none of `modules` has, from `name`. */
const freeModuleName = (
  modules: Readonly<Record<string, unknown>>,
  name: string
): string => {
  const stem = name.replace(/\.js$/u, "");
  let candidate = name;
  for (let count = 1; Object.hasOwn(modules, candidate); count += 1) {
    candidate = `${stem}-${count}.js`;
  }
  return candidate;
};

/** An export's name a wrapper can declare, or `default`. */
const identifier = /^[A-Za-z_$][\w$]*$/u;

/**
 * The module the wrapper imports first, so it is evaluated before the
 * original main and anything it imports: it keeps the built-ins the
 * wrapper uses, as they are before any of the isolate's own code can
 * replace one (`Reflect.get`, `JSON.stringify`, `Array.prototype` setters
 * and the like), so nothing the code does as it loads makes the wrapper
 * itself throw, or answer for it.
 */
const builtinsSource = `import { WorkerEntrypoint } from "cloudflare:workers";
export const builtins = Object.freeze({
  apply: Reflect.apply,
  get: Reflect.get,
  define: Reflect.defineProperty,
  ownKeys: Reflect.ownKeys,
  descriptorOf: Reflect.getOwnPropertyDescriptor,
  prototypeOf: Reflect.getPrototypeOf,
  create: Object.create,
  isArray: Array.isArray,
  isPrototypeOf: Object.prototype.isPrototypeOf,
  objectPrototype: Object.prototype,
  stringOf: String,
  slice: String.prototype.slice,
  stringify: JSON.stringify,
  parse: JSON.parse,
  Map,
  mapGet: Map.prototype.get,
  mapSet: Map.prototype.set,
  Proxy,
  Response,
  Headers,
  headersHas: Headers.prototype.has,
  headersDelete: Headers.prototype.delete,
  resolve: Promise.resolve.bind(Promise),
  then: Promise.prototype.then,
  bind: Function.prototype.bind,
  entrypointPrototype: WorkerEntrypoint.prototype,
});
`;

/** The built-ins module's name: none the isolate's modules have. */
const builtinsModule = "grasp-sandbox-builtins.js";

/** The deepest plain data the wrapper copies out of a call's answer. */
const maxAnswerDepth = 64;

/** The most characters of a thrown error's details, as JSON, that cross. */
const maxThrownDetails = 8192;

/**
 * The wrapper main module of an isolate whose entrypoint `entrypoint` is
 * called (`default` for its default export): it imports the original main
 * and exports that entrypoint wrapped, so nothing of its call is thrown to
 * workerd, which served `--verbose` would report it with its message
 * (GRA-939). Every answer of a wrapped call is an envelope the wrapper
 * makes (`envelopeKey`): `{ value }`, or `{ thrown }` with the thrown
 * error's name, code, message and details, bounded. An answer's own value
 * never becomes an error, whatever keys it has.
 *
 * - A `WorkerEntrypoint` class: a subclass whose instances are proxies,
 *   each method read through it (as workerd reads the method it calls)
 *   wrapped, and called on the real instance, so the entrypoint's own calls
 *   of its methods throw as they always did. A method read that throws (an
 *   accessor) answers that throw. A constructor that throws makes a stand-in
 *   whose every method answers it. The context it is given is quiet.
 * - A default export's handler object: its handlers wrapped, each called
 *   on the object, its context's `waitUntil` swallowing a rejection (the
 *   quiet module covers a `WorkerEntrypoint`'s own `this.ctx`).
 * - `fetch` answers a thrown error as a Response under `thrownHeader`; a
 *   Response of the entrypoint's own never carries that header.
 * - Anything else is exported as it is.
 *
 * A value answered is copied into plain data inside the call (`plainOf`),
 * so a getter or a proxy's trap in it runs, and throws, there, not as
 * workerd serializes it. What isn't plain data (an RpcTarget, a stream, a
 * Date, a class's instance) crosses as it is: its methods and accessors run
 * after the call, outside the wrapper (GRA-939 lists it as open).
 *
 * It uses only the built-ins `builtinsSource` kept, never a global or a
 * prototype's method the isolate's code could have replaced: no spread,
 * destructuring or `instanceof`, which read those.
 */
const entrySource = (
  mainModule: string,
  builtins: string,
  entrypoint: string
): string => `import { builtins } from ${JSON.stringify(`./${builtins}`)};
import * as main from ${JSON.stringify(`./${mainModule}`)};
const { apply, get, define, ownKeys, descriptorOf, prototypeOf, create, isArray, isPrototypeOf, objectPrototype, stringOf, slice, stringify, parse, Map, mapGet, mapSet, Proxy, Response, Headers, headersHas, headersDelete, resolve, then, bind, entrypointPrototype } = builtins;
const envelopeKey = ${JSON.stringify(envelopeKey)};
const thrownHeader = ${JSON.stringify(thrownHeader)};
const cut = (text, most) => apply(slice, text, [0, most]);
const field = (target, key, value) =>
  define(target, key, { configurable: true, enumerable: true, writable: true, value });
const plainOf = (value, depth, seen) => {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const known = apply(mapGet, seen, [value]);
  if (known !== undefined) {
    return known;
  }
  if (depth > ${maxAnswerDepth}) {
    throw new TypeError("The answer is nested too deeply to send.");
  }
  if (isArray(value)) {
    const copy = [];
    apply(mapSet, seen, [value, copy]);
    const length = get(value, "length");
    for (let index = 0; index < length; index += 1) {
      field(copy, index, plainOf(get(value, index), depth + 1, seen));
    }
    return copy;
  }
  const prototype = prototypeOf(value);
  if (prototype !== objectPrototype && prototype !== null) {
    // Not plain data: crosses as it is (an RpcTarget, a stream, a Date).
    return value;
  }
  const copy = prototype === null ? create(null) : {};
  apply(mapSet, seen, [value, copy]);
  const names = ownKeys(value);
  for (let index = 0; index < names.length; index += 1) {
    const key = names[index];
    const descriptor = typeof key === "string" ? descriptorOf(value, key) : undefined;
    if (descriptor !== undefined && get(descriptor, "enumerable") === true) {
      const getter = get(descriptor, "get");
      const read =
        typeof getter === "function" ? apply(getter, value, []) : get(descriptor, "value");
      field(copy, key, plainOf(read, depth + 1, seen));
    }
  }
  return copy;
};
const textOf = (read, fallback) => {
  try {
    const value = read();
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
};
const detailsOf = (error) => {
  try {
    const details = plainOf(get(error, "details"), 1, new Map());
    if (details === null || typeof details !== "object") {
      return undefined;
    }
    const text = stringify(details);
    // Parsed back from the text checked: plain JSON, read once, with no
    // \`toJSON\` or getter of the isolate's left to run as it is sent.
    return typeof text === "string" && text.length <= ${maxThrownDetails} ? parse(text) : undefined;
  } catch {
    return undefined;
  }
};
const thrownOf = (error) => {
  const isObject = (typeof error === "object" && error !== null) || typeof error === "function";
  const name = isObject ? textOf(() => get(error, "name"), "Error") : "Error";
  const message = isObject
    ? textOf(() => get(error, "message"), "")
    : textOf(() => stringOf(error), "[unprintable]");
  let code;
  try {
    const given = isObject ? get(error, "code") : undefined;
    code = typeof given === "string" || typeof given === "number" ? given : undefined;
  } catch {
    code = undefined;
  }
  return {
    name: cut(name, ${maxThrownName}),
    message: cut(message, ${maxThrownMessage}),
    code,
    details: isObject ? detailsOf(error) : undefined,
  };
};
// An envelope whose own \`then\` is undefined: never a thenable, whatever the
// isolate's code put on \`Object.prototype\`, so the call's promise settles
// with it.
const envelopeOf = (key, value) => {
  const envelope = {};
  field(envelope, "then", undefined);
  field(envelope, envelopeKey, true);
  field(envelope, key, value);
  return envelope;
};
const thrownAnswer = (error) => envelopeOf("thrown", thrownOf(error));
const thrownResponse = (error) =>
  new Response(stringify(thrownOf(error)), {
    status: 500,
    headers: { [thrownHeader]: "1" },
  });
const answered = (method, self, args) =>
  (async () => {
    try {
      const value = await apply(method, self, args);
      return envelopeOf("value", plainOf(value, 1, new Map()));
    } catch (error) {
      return thrownAnswer(error);
    }
  })();
// A Response of the entrypoint's own, without the header a thrown error's
// crosses under, so it never reads as one.
const ownResponse = (response) => {
  if (typeof response !== "object" || response === null || !apply(isPrototypeOf, Response.prototype, [response])) {
    return response;
  }
  const headers = get(response, "headers");
  if (!apply(headersHas, headers, [thrownHeader])) {
    return response;
  }
  const copied = new Headers(headers);
  apply(headersDelete, copied, [thrownHeader]);
  return new Response(get(response, "body"), {
    status: get(response, "status"),
    statusText: get(response, "statusText"),
    headers: copied,
  });
};
const fetched = (method, self, args) =>
  (async () => {
    try {
      return ownResponse(await apply(method, self, args));
    } catch (error) {
      return thrownResponse(error);
    }
  })();
const call = (key, method, self, args) =>
  key === "fetch" ? fetched(method, self, args) : answered(method, self, args);
// What a call of a method that couldn't even be read answers: its throw.
const thrownCall = (key, error) =>
  key === "fetch" ? async () => thrownResponse(error) : async () => thrownAnswer(error);
const swallowed = () => undefined;
const quietContext = (ctx) => {
  if (ctx === null || typeof ctx !== "object") {
    return ctx;
  }
  return new Proxy(ctx, {
    get: (target, property) => {
      const value = get(target, property, target);
      if (property === "waitUntil" && typeof value === "function") {
        return (promise) => apply(value, target, [apply(then, resolve(promise), [undefined, swallowed])]);
      }
      return typeof value === "function" ? apply(bind, value, [target]) : value;
    },
  });
};
const methodOf = (property) =>
  typeof property === "string" && property !== "constructor" && property !== "then";
// An entrypoint whose constructor threw: every method answers that throw.
const standIn = (error) =>
  new Proxy(create(entrypointPrototype), {
    get: (target, property) =>
      methodOf(property) ? thrownCall(property, error) : get(target, property, target),
  });
const quietClass = (Base) => {
  const handler = {
    get: (target, property) => {
      let value;
      try {
        value = get(target, property, target);
      } catch (error) {
        return methodOf(property) ? thrownCall(property, error) : undefined;
      }
      if (!methodOf(property) || typeof value !== "function") {
        return value;
      }
      return (...args) => call(property, value, target, args);
    },
  };
  return class extends Base {
    constructor(ctx, env) {
      let failed = false;
      let thrown;
      try {
        super(quietContext(ctx), env);
      } catch (error) {
        failed = true;
        thrown = error;
      }
      if (failed) {
        return standIn(thrown);
      }
      return new Proxy(this, handler);
    }
  };
};
const quietHandlers = (handlers) => {
  const quiet = {};
  const names = ownKeys(handlers);
  for (let index = 0; index < names.length; index += 1) {
    const key = names[index];
    if (typeof key === "string") {
      let value;
      let failed = false;
      let thrown;
      try {
        value = get(handlers, key);
      } catch (error) {
        failed = true;
        thrown = error;
      }
      field(
        quiet,
        key,
        failed
          ? thrownCall(key, thrown)
          : typeof value === "function"
            ? (...args) => {
                // A handler's context comes third: fetch(request, env, ctx).
                if (args.length >= 3) {
                  args[2] = quietContext(args[2]);
                }
                return call(key, value, handlers, args);
              }
            : value
      );
    }
  }
  return quiet;
};
const quietEntrypoint = (value) => {
  if (
    typeof value === "function" &&
    typeof get(value, "prototype") === "object" &&
    apply(isPrototypeOf, entrypointPrototype, [get(value, "prototype")])
  ) {
    return quietClass(value);
  }
  if (value !== null && typeof value === "object") {
    return quietHandlers(value);
  }
  return value;
};
${
  entrypoint === "default"
    ? "export default quietEntrypoint(main.default);"
    : `export const ${entrypoint} = quietEntrypoint(main.${entrypoint});`
}
`;

/** An error rebuilt host-side from what a quiet entrypoint answered. */
const rebuilt = (thrown: unknown): Error => {
  const field = (key: string): unknown =>
    typeof thrown === "object" && thrown !== null
      ? Reflect.get(thrown, key)
      : undefined;
  const given = field("name");
  const name = typeof given === "string" ? given : "Error";
  const text = field("message");
  const message =
    typeof text === "string" ? text.slice(0, maxThrownMessage) : "";
  const kinds: Readonly<Record<string, ErrorConstructor>> = {
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
  };
  // The isolate's code chose the name: only a built-in kind's own entry,
  // never one `Object.prototype` gives (`constructor`, `toString`).
  const Kind = Object.hasOwn(kinds, name) ? kinds[name] : undefined;
  const error = new (Kind ?? Error)(message);
  if (error.name !== name) {
    error.name = name.slice(0, maxThrownName);
  }
  // Its code and details, as an RPC call's thrown error carries them, for
  // the callers that read them (an App error's details, `retryAfterMs`).
  for (const key of ["code", "details"] as const) {
    const value = field(key);
    const kept =
      key === "code"
        ? typeof value === "string" || typeof value === "number"
        : typeof value === "object" && value !== null;
    if (kept) {
      Object.defineProperty(error, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
  }
  return error;
};

/** What a quiet entrypoint's call answered: its envelope opened. */
const rethrown = async (answer: unknown): Promise<unknown> => {
  const value: unknown = await answer;
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, envelopeKey)
  ) {
    return value;
  }
  if (Object.hasOwn(value, "thrown")) {
    throw rebuilt(Reflect.get(value, "thrown"));
  }
  return Reflect.get(value, "value");
};

/** What a quiet `fetch` answered, its thrown error thrown again. */
const rethrownFetch = async (answer: unknown): Promise<unknown> => {
  const response: unknown = await answer;
  if (
    response instanceof Response &&
    response.headers.get(thrownHeader) === "1"
  ) {
    throw rebuilt(await response.json());
  }
  return response;
};

/** Properties of an entrypoint's stub that are never its methods' calls. */
const stubOwn: ReadonlySet<PropertyKey> = new Set(["then", "constructor"]);

/**
 * The entrypoint stub `entry` with each call's envelope opened: its value,
 * or its thrown error thrown again host-side, as an error of the same
 * built-in kind with its name, code, details and message to
 * `maxThrownMessage` characters, as an RPC call's thrown error arrived.
 */
const rethrowing = (entry: object): object =>
  new Proxy(entry, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property, target);
      if (
        typeof property !== "string" ||
        stubOwn.has(property) ||
        typeof value !== "function"
      ) {
        return value;
      }
      return async (...args: unknown[]) => {
        const answer: unknown = Reflect.apply(value, target, args);
        return property === "fetch"
          ? await rethrownFetch(answer)
          : await rethrown(answer);
      };
    },
  });

/**
 * `code` with its console silenced first, unless it has a tail (whose
 * tail is how a builder sees what it wrote), and its main module wrapped
 * so entrypoint `entrypoint`'s call throws nothing to workerd, tail or not.
 */
const quietCode = <Code extends QuietableCode>(
  code: Code,
  entrypoint: string
): Code => {
  const tailed =
    (code.tails?.length ?? 0) > 0 || (code.streamingTails?.length ?? 0) > 0;
  const main = code.modules[code.mainModule];
  // An ES module given as `{ js }` stays one: a module given as text is
  // read by its name's extension, which `{ js }` doesn't need.
  const js: unknown =
    typeof main === "object" && main !== null && "js" in main
      ? main.js
      : undefined;
  const given = typeof js === "string" ? js : main;
  if (typeof given !== "string") {
    // Anything else (CommonJS, Python, a missing module) can't import the
    // quiet module first: refused rather than loaded unsilenced.
    throw new TypeError(
      `An isolate's main module must be an ES module to be silenced: ${code.mainModule} isn't one.`
    );
  }
  const modules = tailed
    ? { ...code.modules }
    : quietModules(
        code.mainModule,
        { ...code.modules, [code.mainModule]: given },
        // Its `node:timers` caught too, where it has them.
        {
          nodejsCompat: hasNodeModules({
            compatibilityDate: code.compatibilityDate ?? "",
            compatibilityFlags: code.compatibilityFlags,
          }),
        }
      );
  const quieted = modules[code.mainModule];
  const builtins = freeModuleName(modules, builtinsModule);
  const entry = freeModuleName({ ...modules, [builtins]: "" }, entryModule);
  return {
    ...code,
    mainModule: entry,
    modules: {
      ...(typeof main === "string" || typeof quieted !== "string"
        ? modules
        : { ...modules, [code.mainModule]: { js: quieted } }),
      [builtins]: builtinsSource,
      [entry]: entrySource(code.mainModule, builtins, entrypoint),
    },
  };
};

/** What `quietLoader` needs of a Loader's stub of an isolate. */
export interface QuietableStub {
  readonly getEntrypoint: (name?: string, options?: never) => unknown;
  readonly getDurableObjectClass?: (name?: string, options?: never) => unknown;
}

/** The entrypoint a stub's call names: `default` for none. */
const entrypointOf = (entrypoint = "default"): string => {
  if (!identifier.test(entrypoint)) {
    throw new TypeError(
      `An entrypoint's name must be an identifier to be silenced: ${entrypoint} isn't one.`
    );
  }
  return entrypoint;
};

/**
 * A stub of the isolate `load` loads for the entrypoint it is asked for,
 * with each call's envelope opened host-side (`rethrowing`). The isolate
 * is loaded once a caller names the entrypoint, since its wrapper main
 * exports that one (`entrySource`). A Durable Object class isn't wrapped,
 * so none is handed out: nothing core or connect loads has one.
 */
const quietStub = <Stub extends QuietableStub>(
  load: (entrypoint: string) => Stub
): Stub => {
  const stub: QuietableStub = {
    getEntrypoint: (name, options) => {
      const entry = load(entrypointOf(name)).getEntrypoint(name, options);
      return typeof entry === "object" && entry !== null
        ? rethrowing(entry)
        : entry;
    },
    getDurableObjectClass: () => {
      throw new TypeError(
        "A silenced isolate hands out no Durable Object class: its methods' throws aren't wrapped."
      );
    },
  };
  // SAFETY: a stub with the Loader's stub's methods, each answering what
  // the Loader's own answers, through `rethrowing`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return stub as Stub;
};

/**
 * `loader`, loading every isolate with its console silenced first and its
 * entrypoint's thrown errors crossing as values, unless it has a tail (see
 * the header). Core and connect read their `LOADER` through this, so no
 * isolate either loads prints to the deployment's logs. An isolate `get`
 * caches is cached per entrypoint: its wrapper main is that entrypoint's.
 */
export const quietLoader = <
  Code extends QuietableCode,
  Stub extends QuietableStub,
>(
  loader: QuietableLoader<Code, Stub>
): QuietableLoader<Code, Stub> => ({
  get: (name, getCode) =>
    quietStub((entrypoint) =>
      loader.get(
        name === null ? null : `${name}\u0000quiet:${entrypoint}`,
        async () => quietCode(await getCode(), entrypoint)
      )
    ),
  load: (code) => {
    // Refused as it is loaded, as the Loader refuses a module it can't
    // load: the isolate itself loads once an entrypoint is asked for.
    quietCode(code, "default");
    // One isolate per entrypoint asked for, however often it is asked for,
    // as the Loader's `load` gives one isolate however many stubs of it.
    const loaded = new Map<string, Stub>();
    return quietStub((entrypoint) => {
      let stub = loaded.get(entrypoint);
      if (stub === undefined) {
        stub = loader.load(quietCode(code, entrypoint));
        loaded.set(entrypoint, stub);
      }
      return stub;
    });
  },
});
