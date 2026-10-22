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
// `quietLoader` hands back throws again here, and every context it hands
// the isolate's code (a constructor's, a default export's handler's) is a
// quiet one: its `waitUntil` swallows a rejection, and its
// `blockConcurrencyWhile` turns a callback's throw into a constant error. Isolates of App code,
// connectors and packages have no Node.js (`isolateBase`), so no timer
// imported by name from `node:timers`. What still reaches a workerd served
// `--verbose` is that kind of timer's throw in the platform's own code that
// turns Node on (the compiler, extraction), whose imports are its own
// bundle's. That holds on either profile; on Cloudflare it drops nothing
// the runtime wouldn't.
//
// An isolate with a tail keeps its console: its tail (core's
// server-logs.ts) is how a builder sees what the App's server code wrote,
// and a silenced console would hand the tail nothing. Everything else is
// as for any isolate: what it leaves uncaught is caught (quiet-isolate.ts),
// and what its entrypoint or Durable Object class throws crosses as a
// value (`entrySource`), so none of it is reported with its message. The
// one gap: on plain workerd, a tailed isolate's `console` calls also print
// a raw line to the process's own stdout, as the tail receives them,
// whether or not workerd is served `--verbose`. Core loads a tailed isolate
// itself (an App's server, a draft's preview) only with
// `SANDBOX_IN_PROCESS=unbounded` (core's env.d.ts), so that is where an
// App's console reaches the deployment's logs. The tail takes its lines
// from the runtime's own console, which an isolate can't reach one way and
// not the other, so no replacement of `console` keeps the tail's lines and
// drops the print. On Cloudflare the tail alone gets them. The fix is
// GRA-919: deliver the tail's lines without the runtime's console. Until
// then, on-prem runs Apps only with `unbounded` (`requireBoundedHere`,
// core's sandboxed.ts), so GRA-919 is needed before on-prem Apps handle
// personal data. Connect attaches no tail.

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

/** What an export is wrapped as: an entrypoint, or a Durable Object's class. */
type ExportKind = "entrypoint" | "durableObject";

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
const builtinsSource = `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
function accessorOf(start, key) {
  for (let at = start; at !== null; at = Reflect.getPrototypeOf(at)) {
    const found = Reflect.getOwnPropertyDescriptor(at, key);
    if (found !== undefined) {
      return found.get;
    }
  }
  return undefined;
}
export const builtins = Object.freeze({
  apply: Reflect.apply,
  get: Reflect.get,
  define: Reflect.defineProperty,
  ownKeys: Reflect.ownKeys,
  descriptorOf: Reflect.getOwnPropertyDescriptor,
  prototypeOf: Reflect.getPrototypeOf,
  setPrototypeOf: Reflect.setPrototypeOf,
  construct: Reflect.construct,
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
  WeakMap,
  weakGet: WeakMap.prototype.get,
  weakSet: WeakMap.prototype.set,
  Proxy,
  Response,
  Headers,
  headersHas: Headers.prototype.has,
  headersDelete: Headers.prototype.delete,
  resolve: Promise.resolve.bind(Promise),
  then: Promise.prototype.then,
  bind: Function.prototype.bind,
  EntrypointClass: WorkerEntrypoint,
  entrypointPrototype: WorkerEntrypoint.prototype,
  DurableClass: DurableObject,
  durablePrototype: DurableObject.prototype,
  responsePrototype: Response.prototype,
  // Response's own getters, found up its chain as they are now: a subclass
  // or an own property of an isolate's Response can't stand in for them.
  responseHeaders: accessorOf(Response.prototype, "headers"),
  responseBody: accessorOf(Response.prototype, "body"),
  responseStatus: accessorOf(Response.prototype, "status"),
  responseStatusText: accessorOf(Response.prototype, "statusText"),
});
`;

/** The built-ins module's name: none the isolate's modules have. */
const builtinsModule = "grasp-sandbox-builtins.js";

/** The most characters of a thrown error's whole JSON text that are read. */
const maxThrownText = 2 * (maxThrownMessage + 8192 + 1024);

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
 *   on the object, its context quiet (the quiet module covers a class's
 *   own `this.ctx`). A quiet context's `waitUntil` swallows a rejection,
 *   and its `blockConcurrencyWhile` answers a callback's throw as a
 *   constant error.
 * - `fetch` answers a thrown error as a Response under `thrownHeader`; a
 *   Response of the entrypoint's own never carries that header.
 * - Anything else is exported as it is.
 * - A Durable Object's class (`kind` `durableObject`, a class of
 *   `DurableObject` alone) is wrapped the same way as an entrypoint's
 *   class: its RPC methods answer envelopes, and what workerd calls on its
 *   own (`alarm`, `webSocketMessage`, `webSocketClose`,
 *   `webSocketError`, `fetch`) answers one too, so a throw of those
 *   is swallowed, not reported: a throwing `alarm` isn't retried. A
 *   constructor that throws makes the same stand-in. Its constructor is
 *   given the quiet context too (`RealStateBase`), so what the App's code
 *   hands a context by accident stays quiet. What is guaranteed is that
 *   much: an App's accidental throws, rejections and failures are silenced.
 *   App code that sets out to print, or to reach the runtime's own state,
 *   isn't stopped, just as its console isn't in a tailed isolate (GRA-919).
 *
 * A value answered is copied into plain data inside the call (`plainOf`),
 * so a getter or a proxy's trap in it runs, and throws, there, not as
 * workerd serializes it. What isn't plain data (an RpcTarget, a stream, a
 * Date, a class's instance) crosses as it is: its methods and accessors run
 * after the call, outside the wrapper. So does every \`fetch\` Response's
 * body, a stream read after the call: a body that errors as it is read
 * isn't answered by the wrapper (GRA-939 lists both as open).
 *
 * It uses only the built-ins `builtinsSource` kept, never a global or a
 * prototype's method the isolate's code could have replaced: no spread,
 * destructuring or `instanceof`, which read those.
 */
const entrySource = (
  mainModule: string,
  builtins: string,
  entrypoint: string,
  kind: ExportKind
): string => `import { builtins } from ${JSON.stringify(`./${builtins}`)};
import * as main from ${JSON.stringify(`./${mainModule}`)};
const { apply, get, define, ownKeys, descriptorOf, prototypeOf, setPrototypeOf, construct, create, isArray, isPrototypeOf, objectPrototype, stringOf, slice, stringify, parse, Map, mapGet, mapSet, WeakMap, weakGet, weakSet, Proxy, Response, Headers, headersHas, headersDelete, resolve, then, bind, EntrypointClass, entrypointPrototype, DurableClass, durablePrototype, responsePrototype, responseHeaders, responseBody, responseStatus, responseStatusText } = builtins;
const isDurable = ${JSON.stringify(kind === "durableObject")};
const BaseClass = isDurable ? DurableClass : EntrypointClass;
const basePrototype = isDurable ? durablePrototype : entrypointPrototype;
const envelopeKey = ${JSON.stringify(envelopeKey)};
const thrownHeader = ${JSON.stringify(thrownHeader)};
const cut = (text, most) => apply(slice, text, [0, most]);
// Every record the wrapper hands the runtime (a descriptor, a Response's
// init and headers) has no prototype, so nothing the isolate's code put on
// \`Object.prototype\` is read from it.
const recordOf = (entries) => {
  const record = create(null);
  for (let index = 0; index < entries.length; index += 2) {
    record[entries[index]] = entries[index + 1];
  }
  return record;
};
const field = (target, key, value) =>
  define(target, key, recordOf(["configurable", true, "enumerable", true, "writable", true, "value", value]));
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
      // A descriptor's own fields only: an accessor's has \`get\`, data's
      // \`value\`, and nothing is read from \`Object.prototype\`.
      const accessor = descriptorOf(descriptor, "get") !== undefined;
      const getter = accessor ? get(descriptor, "get") : undefined;
      const read =
        typeof getter === "function"
          ? apply(getter, value, [])
          : accessor
            ? undefined
            : get(descriptor, "value");
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
// A thrown error's details as JSON text, checked and bounded, read once:
// no \`toJSON\` or getter of the isolate's is left to run as it is sent.
const detailsTextOf = (error) => {
  try {
    const details = plainOf(get(error, "details"), 1, new Map());
    if (details === null || typeof details !== "object") {
      return undefined;
    }
    const text = stringify(details);
    if (typeof text !== "string" || text.length > ${maxThrownDetails}) {
      return undefined;
    }
    // Parsed and written again, so the text is JSON the wrapper made.
    const again = stringify(parse(text));
    return typeof again === "string" && again.length <= ${maxThrownDetails} ? again : undefined;
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
  return [
    cut(name, ${maxThrownName}),
    cut(message, ${maxThrownMessage}),
    code,
    isObject ? detailsTextOf(error) : undefined,
  ];
};
// What crosses of a thrown error, as data: own properties only.
const thrownData = (parts) => {
  const data = {};
  field(data, "name", parts[0]);
  field(data, "message", parts[1]);
  if (parts[2] !== undefined) {
    field(data, "code", parts[2]);
  }
  if (parts[3] !== undefined) {
    field(data, "details", parse(parts[3]));
  }
  return data;
};
// The same as JSON text, written from its parts: strings and numbers alone
// are stringified, which reads nothing of any prototype.
const thrownText = (parts) =>
  "{" +
  '"name":' + stringify(parts[0]) +
  ',"message":' + stringify(parts[1]) +
  (parts[2] === undefined ? "" : ',"code":' + stringify(parts[2])) +
  (parts[3] === undefined ? "" : ',"details":' + parts[3]) +
  "}";
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
// A Response whose own \`then\` is undefined, for the same reason: an async
// function resolving with one reads \`then\` up its chain, where the
// isolate's code may have put a throwing getter that workerd would report
// with its message. False when the Response won't take it (frozen, or an
// own \`then\` it keeps).
const unthenable = (response) =>
  define(response, "then", recordOf(["configurable", true, "enumerable", false, "value", undefined, "writable", true]));
const freshResponse = (body, init) => {
  const response = new Response(body, init);
  unthenable(response);
  return response;
};
const responseOf = (text) =>
  freshResponse(text, recordOf(["status", 500, "headers", recordOf([thrownHeader, "1"])]));
// What answers when even answering a throw fails: made now, from nothing
// the isolate's code can reach.
const failedText = '{"name":"Error","message":"The call failed."}';
const failedAnswer = envelopeOf("thrown", thrownData(["Error", "The call failed.", undefined, undefined]));
const thrownAnswer = (error) => {
  try {
    return envelopeOf("thrown", thrownData(thrownOf(error)));
  } catch {
    return failedAnswer;
  }
};
const thrownResponse = (error) => {
  try {
    return responseOf(thrownText(thrownOf(error)));
  } catch {
    try {
      return responseOf(failedText);
    } catch {
      return undefined;
    }
  }
};
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
// Read through Response's own getters (\`builtinsSource\`), never one a
// subclass or an own property puts in their place.
const isResponse = (value) =>
  typeof value === "object" && value !== null && apply(isPrototypeOf, responsePrototype, [value]);
const ownResponse = (response) => {
  if (!isResponse(response)) {
    return response;
  }
  const headers = apply(responseHeaders, response, []);
  if (!apply(headersHas, headers, [thrownHeader]) && unthenable(response)) {
    return response;
  }
  const copied = new Headers(headers);
  apply(headersDelete, copied, [thrownHeader]);
  return freshResponse(
    apply(responseBody, response, []),
    recordOf([
      "status", apply(responseStatus, response, []),
      "statusText", apply(responseStatusText, response, []),
      "headers", copied,
    ])
  );
};
const notResponse = new TypeError("This fetch didn't answer a Response.");
const fetched = (method, self, args) =>
  (async () => {
    try {
      const result = apply(method, self, args);
      // A Response returned as it is isn't awaited: awaiting reads its
      // \`then\` up the chain, where the isolate's code may have put a getter.
      const response = isResponse(result) ? result : await result;
      // Anything else is answered as a constant error: returning it would
      // resolve it after this try, reading a \`then\` its code may have put
      // on it, whose throw would cross with the code's own message.
      return isResponse(response) ? ownResponse(response) : thrownResponse(notResponse);
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
// What a \`blockConcurrencyWhile\` callback's throw becomes: the object
// still breaks, but workerd logs this, never the code's own message.
const blockedError = new Error("A blockConcurrencyWhile callback threw.");
const blocked = () => {
  throw blockedError;
};
// Its value crosses back boxed: a record with no prototype has no \`then\`
// for the runtime to read as it settles the callback's promise.
const unboxed = (box) => box.value;
const blockedWhile = (block, target) => (callback) =>
  apply(then, apply(block, target, [
    async () => {
      try {
        return recordOf(["value", await apply(callback, undefined, [])]);
      } catch {
        return blocked();
      }
    },
  ]), [unboxed]);
const quietContext = (ctx) => {
  if (ctx === null || typeof ctx !== "object") {
    return ctx;
  }
  return new Proxy(ctx, recordOf([
    "get",
    (target, property) => {
      const value = get(target, property, target);
      if (property === "waitUntil" && typeof value === "function") {
        return (promise) => apply(value, target, [apply(then, resolve(promise), [undefined, swallowed])]);
      }
      if (property === "blockConcurrencyWhile" && typeof value === "function") {
        return blockedWhile(value, target);
      }
      return typeof value === "function" ? apply(bind, value, [target]) : value;
    },
  ]));
};
// A Durable Object's constructor is handed the quiet context too, so a
// constructor that keeps it never hands the runtime's own \`waitUntil\` what
// workerd reports by accident. \`DurableObject\`'s own constructor takes the
// real state alone, so \`RealStateBase\` stands between the App's class and
// it and swaps the quiet context back for the state it stands for. It makes
// the object against \`CleanState\`, whose prototype is \`DurableObject\`'s
// own, so the base's \`this.ctx\` meets only the quiet module's accessor
// (made a quiet one again, and not configurable), never a \`ctx\` setter of
// the App's class, then gives it the App's class's prototype. Whatever
// builds on \`RealStateBase\`, the App's class or one App code makes, ends
// up with a quiet \`ctx\` alone.
//
// What that guarantees is the App's accidents: a throw, a rejection, a
// failure handed to a context never reaches workerd's report. It isn't a
// wall against App code that sets out to print: that code can already do
// so through \`console\`, which a tailed isolate keeps (GRA-919), so a way
// it finds to the real state gives it nothing new.
const realStates = new WeakMap();
const CleanState = function () {};
CleanState.prototype = durablePrototype;
const RealStateBase = class extends DurableClass {
  constructor(ctx, env) {
    const real = ctx !== null && typeof ctx === "object" ? apply(weakGet, realStates, [ctx]) : undefined;
    const made = construct(DurableClass, [real === undefined ? ctx : real, env], CleanState);
    setPrototypeOf(made, get(new.target, "prototype"));
    return made;
  }
};
// Puts \`RealStateBase\` under the class in \`Base\`'s chain that extends
// \`DurableObject\`: false where it can't (a frozen class).
const takesQuietState = (Base) => {
  try {
    let at = Base;
    for (let step = 0; step < 64 && at !== null; step += 1) {
      const next = prototypeOf(at);
      if (next === DurableClass) {
        return setPrototypeOf(at, RealStateBase);
      }
      if (next === RealStateBase) {
        return true;
      }
      at = next;
    }
    return false;
  } catch {
    return false;
  }
};
const contextFor = (ctx) => {
  const quiet = quietContext(ctx);
  if (isDurable && quiet !== ctx) {
    apply(weakSet, realStates, [quiet, ctx]);
  }
  return quiet;
};
const methodOf = (property) =>
  typeof property === "string" && property !== "constructor" && property !== "then";
// An entrypoint whose constructor threw: every method answers that throw.
const standIn = (error) =>
  new Proxy(create(basePrototype), recordOf([
    "get",
    (target, property) =>
      methodOf(property) ? thrownCall(property, error) : get(target, property, target),
  ]));
const quietClass = (Base) => {
  if (isDurable && !takesQuietState(Base)) {
    return refusedClass;
  }
  const handler = recordOf([
    "get",
    (target, property) => {
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
  ]);
  return class extends Base {
    constructor(ctx, env) {
      let failed = false;
      let thrown;
      try {
        super(contextFor(ctx), env);
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
// What an export is: an entrypoint class, a handler object, or neither.
// A class is read by its own chain (\`prototypeOf\`), and by its own
// \`prototype\` data property's: where they disagree, or a read throws (a
// Proxy can trap either), it is ambiguous, and refused.
const chainHas = (start, wanted) => {
  let at = start;
  for (let step = 0; step < 64 && at !== null; step += 1) {
    at = prototypeOf(at);
    if (at === wanted) {
      return true;
    }
  }
  return false;
};
const kindOf = (value) => {
  if (value !== null && typeof value === "object") {
    return "handlers";
  }
  if (typeof value !== "function") {
    return "other";
  }
  try {
    const byClass = chainHas(value, BaseClass);
    const own = descriptorOf(value, "prototype");
    // A data property's own \`value\`: an accessor has none of its own.
    const prototype =
      own !== undefined && descriptorOf(own, "value") !== undefined ? get(own, "value") : undefined;
    const byPrototype =
      prototype !== null && typeof prototype === "object" && (prototype === basePrototype || chainHas(prototype, basePrototype));
    if (byClass !== byPrototype) {
      return "refused";
    }
    // A function that isn't an entrypoint class isn't an entrypoint.
    return byClass ? "class" : "refused";
  } catch {
    return "refused";
  }
};
const refusedError = new TypeError("This entrypoint can't be called.");
const refusedClass = class extends BaseClass {
  constructor(ctx, env) {
    try {
      super(ctx, env);
    } catch {
      // Answered as refused all the same.
    }
    return standIn(refusedError);
  }
};
const quietEntrypoint = (value) => {
  const kind = kindOf(value);
  if (kind === "class") {
    return quietClass(value);
  }
  // A Durable Object is a class alone: a handler object is no object's.
  if (kind === "handlers" && !isDurable) {
    return quietHandlers(value);
  }
  if (isDurable) {
    return refusedClass;
  }
  return kind === "refused" ? refusedClass : value;
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
        : typeof value === "object" &&
          value !== null &&
          (JSON.stringify(value)?.length ?? Infinity) <= maxThrownDetails;
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
export const openAnswer = async (answer: unknown): Promise<unknown> => {
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
    // The wrapper's own answer, bounded here too: never more than its
    // parts may be, whatever reached this far.
    const text = await response.text();
    let thrown: unknown;
    try {
      thrown =
        text.length <= maxThrownText ? JSON.parse(text) : { name: "Error" };
    } catch {
      thrown = { name: "Error" };
    }
    throw rebuilt(thrown);
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
          : await openAnswer(answer);
      };
    },
  });

/** Whether `code` has a tail, which its console goes to alone. */
const hasTail = (code: QuietableCode): boolean =>
  (code.tails?.length ?? 0) > 0 || (code.streamingTails?.length ?? 0) > 0;

const noDurableObjectClass = (): TypeError =>
  new TypeError(
    "A silenced isolate hands out a Durable Object class only with a tail: nothing else needs one."
  );

/**
 * `code` with its console silenced first, unless it has a tail (whose
 * tail is how a builder sees what it wrote), what it leaves uncaught
 * caught either way, and its main module wrapped so export `entrypoint`'s
 * call throws nothing to workerd, tail or not.
 */
const quietCode = <Code extends QuietableCode>(
  code: Code,
  entrypoint: string,
  kind: ExportKind = "entrypoint"
): Code => {
  const tailed = hasTail(code);
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
    {
      // Its `node:timers` caught too, where it has them.
      nodejsCompat: hasNodeModules({
        compatibilityDate: code.compatibilityDate ?? "",
        compatibilityFlags: code.compatibilityFlags,
      }),
      // A tail is how its builder sees what it wrote.
      keepConsole: tailed,
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
      [entry]: entrySource(code.mainModule, builtins, entrypoint, kind),
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
 * exports that one (`entrySource`). A Durable Object class is the wrapped
 * class `durableObjectClass` gives, or refuses: see `quietLoader`.
 */
const quietStub = <Stub extends QuietableStub>(
  load: (entrypoint: string) => Stub,
  durableObjectClass: (name?: string) => unknown
): Stub => {
  const stub: QuietableStub = {
    getEntrypoint: (name, options) => {
      const entry = load(entrypointOf(name)).getEntrypoint(name, options);
      return typeof entry === "object" && entry !== null
        ? rethrowing(entry)
        : entry;
    },
    getDurableObjectClass: (name) => durableObjectClass(name),
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
 *
 * A Durable Object class (an App's server object, the only one core or
 * connect loads) is handed out only for an isolate with a tail, wrapped as
 * an entrypoint's class is (`entrySource`): its RPC methods answer
 * envelopes, which the caller opens with `openAnswer` (core's
 * `invokeServer`) so an App's error and its details reach it as thrown,
 * and what workerd calls on its own (`alarm`, `webSocketMessage`,
 * `webSocketClose`, `webSocketError`) or builds (the constructor) throws
 * nothing to it (a facet can set no alarm today, so `alarm` is caught for
 * when it can). The tail already holds the console of an App, so its
 * console stays as it is, and plain workerd prints those same lines to
 * the process's own stdout, served `--verbose` or not: the one gap (see
 * the header). It holds where `SANDBOX_IN_PROCESS=unbounded` runs an App
 * in core's own Loader, which on-prem Apps need today; GRA-919 closes it.
 * An isolate without a tail is refused: nothing needs one.
 */
export const quietLoader = <
  Code extends QuietableCode,
  Stub extends QuietableStub,
>(
  loader: QuietableLoader<Code, Stub>
): QuietableLoader<Code, Stub> => ({
  get: (name, getCode) =>
    quietStub(
      (entrypoint) =>
        loader.get(
          name === null ? null : `${name}\u0000quiet:${entrypoint}`,
          async () => quietCode(await getCode(), entrypoint)
        ),
      (className) =>
        loader
          .get(
            name === null ? null : `${name}\u0000quiet-class:${className}`,
            async () => {
              const code = await getCode();
              if (!hasTail(code)) {
                throw noDurableObjectClass();
              }
              return quietCode(code, entrypointOf(className), "durableObject");
            }
          )
          .getDurableObjectClass?.(className)
    ),
  load: (code) => {
    // Refused as it is loaded, as the Loader refuses a module it can't
    // load: the isolate itself loads once an entrypoint is asked for.
    quietCode(code, "default");
    // One isolate per entrypoint asked for, however often it is asked for,
    // as the Loader's `load` gives one isolate however many stubs of it.
    const loaded = new Map<string, Stub>();
    return quietStub(
      (entrypoint) => {
        let stub = loaded.get(entrypoint);
        if (stub === undefined) {
          stub = loader.load(quietCode(code, entrypoint));
          loaded.set(entrypoint, stub);
        }
        return stub;
      },
      (className) => {
        if (!hasTail(code)) {
          throw noDurableObjectClass();
        }
        return loader
          .load(quietCode(code, entrypointOf(className), "durableObject"))
          .getDurableObjectClass?.(className);
      }
    );
  },
});
