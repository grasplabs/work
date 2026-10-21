import {
  captureEntrypoint,
  captureMethod,
  capturedModules,
  hasNodeModules,
  quietModules,
} from "@grasp-os/shared/quiet-isolate";
/**
 * A session on the on-prem sandbox host (sandbox-host.ts): one call of an
 * isolate whose code reaches back into core through capabilities, such as
 * an App function's operation channel or a workflow run's host.
 *
 * Core opens a WebSocket per call through the supervisor
 * (scripts/workerd-sandbox.ts) and speaks capnweb over it
 * (apps/core/src/sandboxed.ts). workerd can't send a stub to another
 * process, so the capabilities arrive here as capnweb stubs, and this
 * module hands the isolate a workerd RpcTarget for each, with only the
 * methods core named for it, every one forwarding to its stub. The isolate
 * never sees capnweb or the session: it can reach exactly what core passed
 * for this call, nothing named by an ID it could guess, and nothing once
 * the session ends (with it, the process: one call per process).
 *
 * Whatever the call says, the isolate gets no network and an empty env:
 * this module sets both, and the sandbox host's settings, with one flag a
 * call may add: `nodejs_compat`, for core's own App compiler. Core's
 * platform modules (the compiler, the package builder: JavaScript, JSON
 * and WebAssembly, far larger than a message) come as their sizes, and
 * this module reads each through a reader core passed with the call, a
 * chunk at a time and in order, before the isolate loads; a call may
 * hand over only so many, and only so much. Capabilities arrive as the
 * call's arguments only;
 * workerd refuses an RpcTarget in a loaded Worker's env ("Remote RPC
 * references can only be serialized for RPC").
 */
import {
  // oxlint-disable-next-line no-restricted-imports -- its only caller is core, over the supervisor's private socket: nothing untrusted calls it
  RpcTarget as CapnwebTarget,
  newWorkersWebSocketRpcResponse,
} from "capnweb";
import type { RpcTarget } from "cloudflare:workers";

import { sessionMaxRuns } from "../call-limits.ts";
import {
  declaredMethodsOf,
  invoke,
  objectCapability,
  outward,
} from "./sandbox-capability.ts";

/** What the workerd config gives the sandbox host. */
export interface SessionEnv {
  LOADER: WorkerLoader;
}

/**
 * How every isolate runs here, whatever a call says: the sandbox host's own
 * settings (sandbox-host.ts), passed in so this module has none of its own.
 */
export interface IsolateSettings {
  compatibilityDate: string;
  compatibilityFlags: string[];
  limits: { cpuMs: number };
}

/** A capability: an object with the methods named, or a function. */
type CapabilitySpec = { methods: string[] } | { function: true };

/** One argument of the call: a JSON value, or a capability by name. */
type ArgumentSpec = { value: unknown } | { capability: string };

/** A module the call hands over in chunks: its type, and how large it is. */
interface ChunkedModule {
  type: "js" | "json" | "wasm";
  size: number;
}

/** One call, as core describes it. */
interface SessionCall {
  mainModule: string;
  modules: Record<string, string>;
  entrypoint: string;
  method: string;
  args: ArgumentSpec[];
  capabilities: Record<string, CapabilitySpec>;
  /** Whether the isolate gets `nodejs_compat`, the one flag a call may add. */
  nodejsCompat: boolean;
  /**
   * Core's own platform modules (the App compiler, the package
   * builder), too large for one message or not JavaScript, read through
   * the function capability `moduleReader` names.
   */
  chunkedModules: Record<string, ChunkedModule>;
  moduleReader: string | undefined;
  /**
   * The function capability that takes what the call writes with
   * `console`, bounded, once it settled: a draft's sealed preview's, for
   * the agent's check of it (@grasp-os/shared/quiet-isolate, `capturedModules`). None
   * for any other call, whose output is dropped.
   */
  consoleSink: string | undefined;
}

/** The most capabilities a call may name. */
const maxCapabilities = 32;

/** The most modules a call may hand over in chunks. */
const maxChunkedModules = 8;

/**
 * The most bytes a call's chunked modules may have together: the screen
 * compiler and what it knows of the kit, or the package builder and
 * esbuild's WebAssembly, with room to grow.
 */
const maxChunkedBytes = 64 * 1024 * 1024;

const moduleTypes = new Set(["js", "json", "wasm"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

const capabilitySpecOf = (value: unknown): CapabilitySpec | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.function === true) {
    return { function: true };
  }
  const methods = declaredMethodsOf(value.methods);
  return methods === undefined ? undefined : { methods };
};

const isChunkedModule = (value: unknown): value is ChunkedModule =>
  isRecord(value) &&
  typeof value.type === "string" &&
  moduleTypes.has(value.type) &&
  typeof value.size === "number" &&
  Number.isSafeInteger(value.size) &&
  value.size > 0;

/**
 * `value` as a call's chunked modules: at most {@link maxChunkedModules},
 * {@link maxChunkedBytes} together, none named as one of `modules`;
 * undefined for anything else.
 */
const chunkedModulesOf = (
  value: unknown,
  modules: Record<string, string>
): Record<string, ChunkedModule> | undefined => {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > maxChunkedModules) {
    return undefined;
  }
  let total = 0;
  const chunked: Record<string, ChunkedModule> = {};
  for (const [name, spec] of entries) {
    if (!isChunkedModule(spec) || Object.hasOwn(modules, name)) {
      return undefined;
    }
    total += spec.size;
    chunked[name] = { type: spec.type, size: spec.size };
  }
  return total <= maxChunkedBytes ? chunked : undefined;
};

/**
 * What `body` says of the call's platform code: its flag, its chunked
 * modules and their reader, which comes with chunked modules and only
 * with them, as a function capability of the call's own; undefined for
 * anything else.
 */
const platformOf = (
  body: Record<string, unknown>,
  modules: Record<string, string>,
  specs: Record<string, CapabilitySpec>
):
  | Pick<SessionCall, "nodejsCompat" | "chunkedModules" | "moduleReader">
  | undefined => {
  const { nodejsCompat, moduleReader } = body;
  const chunkedModules = chunkedModulesOf(body.chunkedModules, modules);
  if (
    chunkedModules === undefined ||
    (nodejsCompat !== undefined && typeof nodejsCompat !== "boolean")
  ) {
    return undefined;
  }
  if (Object.keys(chunkedModules).length === 0) {
    // No platform code: no reader, and no flag, which is for it alone.
    return moduleReader === undefined && nodejsCompat !== true
      ? { nodejsCompat: false, chunkedModules, moduleReader }
      : undefined;
  }
  const reader =
    typeof moduleReader === "string" ? specs[moduleReader] : undefined;
  if (
    typeof moduleReader !== "string" ||
    reader === undefined ||
    !("function" in reader)
  ) {
    return undefined;
  }
  return { nodejsCompat: nodejsCompat === true, chunkedModules, moduleReader };
};

/**
 * The call's console sink (`SessionCall`): a function capability by name,
 * none, or false when it names anything else.
 */
const consoleSinkOf = (
  name: unknown,
  specs: Readonly<Record<string, CapabilitySpec>>
): string | undefined | false => {
  if (name === undefined) {
    return undefined;
  }
  const spec = typeof name === "string" ? specs[name] : undefined;
  return typeof name === "string" && spec !== undefined && "function" in spec
    ? name
    : false;
};

/** `body` as a call, or undefined for anything else. */
export const sessionCallOf = (body: unknown): SessionCall | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }
  const { mainModule, modules, entrypoint, method, args, capabilities } = body;
  if (
    typeof mainModule !== "string" ||
    !isStringRecord(modules) ||
    typeof entrypoint !== "string" ||
    typeof method !== "string" ||
    !Array.isArray(args) ||
    !isRecord(capabilities) ||
    Object.keys(capabilities).length > maxCapabilities
  ) {
    return undefined;
  }
  const specs: Record<string, CapabilitySpec> = {};
  for (const [name, value] of Object.entries(capabilities)) {
    const spec = capabilitySpecOf(value);
    if (spec === undefined) {
      return undefined;
    }
    specs[name] = spec;
  }
  const argSpecs: ArgumentSpec[] = [];
  for (const arg of args) {
    if (isRecord(arg) && typeof arg.capability === "string") {
      if (specs[arg.capability] === undefined) {
        return undefined;
      }
      argSpecs.push({ capability: arg.capability });
    } else if (isRecord(arg) && "value" in arg) {
      argSpecs.push({ value: arg.value });
    } else {
      return undefined;
    }
  }
  const platform = platformOf(body, modules, specs);
  if (platform === undefined) {
    return undefined;
  }
  const consoleSink = consoleSinkOf(body.consoleSink, specs);
  if (consoleSink === false) {
    return undefined;
  }
  return {
    mainModule,
    modules,
    entrypoint,
    method,
    args: argSpecs,
    capabilities: specs,
    ...platform,
    consoleSink,
  };
};

/** What a Loader takes as a module that isn't JavaScript text. */
type LoadedModule = string | { json: unknown } | { wasm: ArrayBuffer };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * The call's chunked modules, read through `read` a chunk at a time, each
 * whole and in order, and made what the Loader takes. A chunk that isn't
 * bytes, is empty or runs past the module's size fails the call.
 */
export const readChunkedModules = async (
  chunked: Record<string, ChunkedModule>,
  read: (...args: unknown[]) => Promise<unknown>
): Promise<Record<string, LoadedModule>> => {
  const loaded: Record<string, LoadedModule> = {};
  for (const [name, { type, size }] of Object.entries(chunked)) {
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      // In order: each chunk starts where the last one ended.
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await read(name, offset);
      if (
        !(chunk instanceof Uint8Array) ||
        chunk.byteLength === 0 ||
        offset + chunk.byteLength > size
      ) {
        throw new TypeError(`Module ${name} didn't arrive as it was sent.`);
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (type === "wasm") {
      loaded[name] = { wasm: bytes.buffer };
    } else if (type === "json") {
      loaded[name] = { json: JSON.parse(utf8.decode(bytes)) };
    } else {
      loaded[name] = utf8.decode(bytes);
    }
  }
  return loaded;
};

/** What the isolate gets for capability `name`. */
const capabilityOf = (
  spec: CapabilitySpec,
  stub: unknown
): RpcTarget | ((...args: unknown[]) => Promise<unknown>) =>
  "function" in spec
    ? async (...args: unknown[]) =>
        await invoke(stub, "call", args.map(outward))
    : objectCapability(stub, spec.methods);

/**
 * The session's main object. Only core reaches it, over the supervisor's
 * private socket; App code only ever gets the capabilities of its own call.
 */
class Session extends CapnwebTarget {
  readonly #env: SessionEnv;
  readonly #settings: IsolateSettings;
  #runs = 0;

  constructor(env: SessionEnv, settings: IsolateSettings) {
    super();
    this.#env = env;
    this.#settings = settings;
  }

  /**
   * Runs a call in an isolate of its own: the session's call, and those
   * core nests in it (an App function's calls of its other functions),
   * all in this process, which is killed once the session ends.
   */
  async run(call: unknown, stubs: unknown): Promise<unknown> {
    // Never more than core lets one call run (call-limits.ts), retries
    // included, as a bound of its own: core refuses past it first.
    if (this.#runs >= sessionMaxRuns) {
      throw new Error("This session has run as many calls as one may.");
    }
    this.#runs += 1;
    const parsed = sessionCallOf(call);
    if (parsed === undefined || !isRecord(stubs)) {
      throw new TypeError("The call isn't in the expected shape.");
    }
    const given = (name: string) => {
      const spec = parsed.capabilities[name];
      if (spec === undefined || !(name in stubs)) {
        throw new TypeError(`No capability ${name} was passed.`);
      }
      return capabilityOf(spec, stubs[name]);
    };
    const args = parsed.args.map((arg) =>
      "capability" in arg ? given(arg.capability) : arg.value
    );
    const reader =
      parsed.moduleReader === undefined
        ? undefined
        : given(parsed.moduleReader);
    const chunked =
      typeof reader === "function"
        ? await readChunkedModules(parsed.chunkedModules, reader)
        : {};
    const { compatibilityFlags } = this.#settings;
    const nodejsCompat = hasNodeModules({
      compatibilityDate: this.#settings.compatibilityDate,
      compatibilityFlags: parsed.nodejsCompat
        ? [...compatibilityFlags, "nodejs_compat"]
        : compatibilityFlags,
    });
    const modules = { ...parsed.modules, ...chunked };
    // Printing nothing to the process's output, the deployment's logs;
    // recording what it writes instead for the sink core passed, if any.
    const sink =
      parsed.consoleSink === undefined ? undefined : given(parsed.consoleSink);
    const loaded =
      sink === undefined
        ? {
            mainModule: parsed.mainModule,
            modules: quietModules(parsed.mainModule, modules, {
              nodejsCompat,
            }),
          }
        : capturedModules(parsed.mainModule, modules, {
            nodejsCompat,
          });
    const isolate = this.#env.LOADER.get(null, () => ({
      ...this.#settings,
      compatibilityFlags: parsed.nodejsCompat
        ? [...compatibilityFlags, "nodejs_compat"]
        : compatibilityFlags,
      ...loaded,
      env: {},
      globalOutbound: null,
    }));
    if (sink !== undefined) {
      const captured: unknown = isolate.getEntrypoint(captureEntrypoint);
      return (
        (await invoke(captured, captureMethod, [
          parsed.entrypoint,
          parsed.method,
          args,
          sink,
        ])) ?? null
      );
    }
    const entrypoint: unknown = isolate.getEntrypoint(
      // `default`: the module's default export, as workerd names it.
      parsed.entrypoint === "default" ? undefined : parsed.entrypoint
    );
    // Never undefined, which capnweb would send as such: always a value.
    return (await invoke(entrypoint, parsed.method, args)) ?? null;
  }
}

/** Upgrades `request` to a session, with messages bounded. */
export const sessionResponse = (
  request: Request,
  env: SessionEnv,
  settings: IsolateSettings
): Response =>
  newWorkersWebSocketRpcResponse(request, new Session(env, settings), {
    limits: { maxMessageSize: 16 * 1024 * 1024, maxDepth: 64 },
  });
