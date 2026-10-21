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
// reports for an isolate, but for what that module's header lists as
// beyond it (GRA-939). That holds on either profile; on Cloudflare it drops
// nothing the runtime wouldn't. Core can't tell whether its own process was
// served `--verbose`, so under `SANDBOX_IN_PROCESS=unbounded` not doing so
// is the operator's rule (core's env.d.ts).
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
  keys: Object.keys,
  isPrototypeOf: Object.prototype.isPrototypeOf,
  stringOf: String,
  slice: String.prototype.slice,
  stringify: JSON.stringify,
  Proxy,
  Response,
  resolve: Promise.resolve.bind(Promise),
  then: Promise.prototype.then,
  bind: Function.prototype.bind,
  entrypointPrototype: WorkerEntrypoint.prototype,
});
`;

/** The built-ins module's name: none the isolate's modules have. */
const builtinsModule = "grasp-sandbox-builtins.js";

/**
 * The wrapper main module of an isolate whose entrypoint `entrypoint` is
 * called (`default` for its default export): it imports the original main
 * and exports that entrypoint wrapped, so whatever the entrypoint's call
 * throws is answered as a value branded `brand`, never thrown to workerd,
 * which served `--verbose` would report it with its message (GRA-939).
 *
 * - A `WorkerEntrypoint` class: a subclass whose instances are proxies,
 *   each method read through it (as workerd reads the method it calls)
 *   wrapped, and called on the real instance, so the entrypoint's own calls
 *   of its methods throw as they always did.
 * - A default export's handler object: its handlers wrapped, each called
 *   on the object, its context's `waitUntil` swallowing a rejection (the
 *   quiet module covers a `WorkerEntrypoint`'s own `ctx`).
 * - `fetch` answers a thrown error as a Response under `thrownHeader`.
 * - Anything else is exported as it is.
 *
 * It uses only the built-ins `builtinsSource` kept, never a global or a
 * prototype's method the isolate's code could have replaced: no spread,
 * destructuring or `instanceof`, which read those.
 */
const entrySource = (
  mainModule: string,
  builtins: string,
  entrypoint: string,
  brand: string
): string => `import { builtins } from ${JSON.stringify(`./${builtins}`)};
import * as main from ${JSON.stringify(`./${mainModule}`)};
const { apply, get, define, keys, isPrototypeOf, stringOf, slice, stringify, Proxy, Response, resolve, then, bind, entrypointPrototype } = builtins;
const brand = ${JSON.stringify(brand)};
const cut = (text, most) => apply(slice, text, [0, most]);
const textOf = (read, fallback) => {
  try {
    const value = read();
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
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
  return { name: cut(name, ${maxThrownName}), message: cut(message, ${maxThrownMessage}), code };
};
const answered = (method, self, args) =>
  (async () => {
    try {
      return await apply(method, self, args);
    } catch (error) {
      return { [brand]: thrownOf(error) };
    }
  })();
const fetched = (method, self, args) =>
  (async () => {
    try {
      return await apply(method, self, args);
    } catch (error) {
      return new Response(stringify(thrownOf(error)), {
        status: 500,
        headers: { ${JSON.stringify(thrownHeader)}: brand },
      });
    }
  })();
const call = (key, method, self, args) =>
  key === "fetch" ? fetched(method, self, args) : answered(method, self, args);
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
const quietClass = (Base) => {
  const handler = {
    get: (target, property) => {
      const value = get(target, property, target);
      if (typeof property !== "string" || property === "constructor" || typeof value !== "function") {
        return value;
      }
      return (...args) => call(property, value, target, args);
    },
  };
  return class extends Base {
    constructor(ctx, env) {
      super(ctx, env);
      return new Proxy(this, handler);
    }
  };
};
const quietHandlers = (handlers) => {
  const quiet = {};
  const names = keys(handlers);
  for (let index = 0; index < names.length; index += 1) {
    const key = names[index];
    const value = get(handlers, key);
    define(quiet, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value:
        typeof value === "function"
          ? (...args) => {
              // A handler's context comes third: fetch(request, env, ctx).
              if (args.length >= 3) {
                args[2] = quietContext(args[2]);
              }
              return call(key, value, handlers, args);
            }
          : value,
    });
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
  const error = new (kinds[name] ?? Error)(message);
  if (error.name !== name) {
    error.name = name.slice(0, maxThrownName);
  }
  const code = field("code");
  if (typeof code === "string" || typeof code === "number") {
    Object.defineProperty(error, "code", {
      configurable: true,
      enumerable: true,
      value: code,
      writable: true,
    });
  }
  return error;
};

/** What a quiet entrypoint's call answered, its thrown error thrown again. */
const rethrown = async (answer: unknown, brand: string): Promise<unknown> => {
  const value: unknown = await answer;
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, brand)
  ) {
    throw rebuilt(Reflect.get(value, brand));
  }
  return value;
};

/** What a quiet `fetch` answered, its thrown error thrown again. */
const rethrownFetch = async (
  answer: unknown,
  brand: string
): Promise<unknown> => {
  const response: unknown = await answer;
  if (
    response instanceof Response &&
    response.headers.get(thrownHeader) === brand
  ) {
    throw rebuilt(await response.json());
  }
  return response;
};

/** Properties of an entrypoint's stub that are never its methods' calls. */
const stubOwn: ReadonlySet<PropertyKey> = new Set(["then", "constructor"]);

/**
 * The entrypoint stub `entry` with each call's thrown error, answered as a
 * value branded `brand`, thrown again host-side: as an error of the same
 * built-in kind, with its name, its code and its message to
 * `maxThrownMessage` characters, as an RPC call's thrown error arrived.
 */
const rethrowing = (entry: object, brand: string): object =>
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
          ? await rethrownFetch(answer, brand)
          : await rethrown(answer, brand);
      };
    },
  });

/**
 * `code` with its console silenced first and its main module wrapped so
 * entrypoint `entrypoint`'s thrown errors cross as values branded `brand`,
 * unless it has a tail.
 */
const quietCode = <Code extends QuietableCode>(
  code: Code,
  entrypoint: string,
  brand: string
): Code => {
  if ((code.tails?.length ?? 0) > 0 || (code.streamingTails?.length ?? 0) > 0) {
    return code;
  }
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
  const modules = quietModules(
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
      [entry]: entrySource(code.mainModule, builtins, entrypoint, brand),
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
 * with what its calls throw rethrown host-side (`rethrowing`). The isolate
 * is loaded once a caller names the entrypoint, since its wrapper main
 * exports that one (`entrySource`).
 */
const quietStub = <Stub extends QuietableStub>(
  load: (entrypoint: string, brand: string) => Stub
): Stub => {
  const stub: QuietableStub = {
    getEntrypoint: (name, options) => {
      const brand = crypto.randomUUID();
      const entry = load(entrypointOf(name), brand).getEntrypoint(
        name,
        options
      );
      return typeof entry === "object" && entry !== null
        ? rethrowing(entry, brand)
        : entry;
    },
    getDurableObjectClass: (name, options) =>
      load(entrypointOf(name), crypto.randomUUID()).getDurableObjectClass?.(
        name,
        options
      ),
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
    quietStub((entrypoint, brand) =>
      loader.get(
        name === null ? null : `${name}\u0000quiet:${entrypoint}`,
        async () => quietCode(await getCode(), entrypoint, brand)
      )
    ),
  load: (code) => {
    // Refused as it is loaded, as the Loader refuses a module it can't
    // load: the isolate itself loads once an entrypoint is asked for.
    quietCode(code, "default", "");
    return quietStub((entrypoint, brand) =>
      loader.load(quietCode(code, entrypoint, brand))
    );
  },
});
