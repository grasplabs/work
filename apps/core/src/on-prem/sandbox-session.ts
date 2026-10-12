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
 * this module sets both. Capabilities arrive as the call's arguments only;
 * workerd refuses an RpcTarget in a loaded Worker's env ("Remote RPC
 * references can only be serialized for RPC").
 */
import {
  // oxlint-disable-next-line no-restricted-imports -- its only caller is core, over the supervisor's private socket: nothing untrusted calls it
  RpcTarget as CapnwebTarget,
  newWorkersWebSocketRpcResponse,
} from "capnweb";
import type { RpcTarget } from "cloudflare:workers";

import { invoke, objectCapability, outward } from "./sandbox-capability.ts";

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

/** One call, as core describes it. */
interface SessionCall {
  mainModule: string;
  modules: Record<string, string>;
  entrypoint: string;
  method: string;
  args: ArgumentSpec[];
  capabilities: Record<string, CapabilitySpec>;
}

/** The most capabilities, and methods of one, a call may name. */
const maxCapabilities = 32;
const maxMethods = 64;

/** A method name a capability may have: no getters, nothing internal. */
const methodName = /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/u;
const reserved = new Set([
  "constructor",
  "fetch",
  "connect",
  // What a Cap'n Web stub's prototype has of its own: never a capability's.
  "then",
  "catch",
  "finally",
  "map",
  "onRpcBroken",
  "dup",
  "dispose",
  "toString",
  "valueOf",
]);

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
  const { methods } = value;
  if (
    Array.isArray(methods) &&
    methods.length <= maxMethods &&
    methods.every(
      (name) =>
        typeof name === "string" && methodName.test(name) && !reserved.has(name)
    )
  ) {
    return { methods: methods.map(String) };
  }
  return undefined;
};

/** `body` as a call, or undefined for anything else. */
const sessionCallOf = (body: unknown): SessionCall | undefined => {
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
  return {
    mainModule,
    modules,
    entrypoint,
    method,
    args: argSpecs,
    capabilities: specs,
  };
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

/** The session's main object, which core calls once. */
class Session extends CapnwebTarget {
  readonly #env: SessionEnv;
  readonly #settings: IsolateSettings;
  #ran = false;

  constructor(env: SessionEnv, settings: IsolateSettings) {
    super();
    this.#env = env;
    this.#settings = settings;
  }

  /** Runs the call once: a session is one call. */
  async run(call: unknown, stubs: unknown): Promise<unknown> {
    if (this.#ran) {
      throw new Error("A session runs one call.");
    }
    this.#ran = true;
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
    const entrypoint: unknown = this.#env.LOADER.get(null, () => ({
      ...this.#settings,
      mainModule: parsed.mainModule,
      modules: parsed.modules,
      env: {},
      globalOutbound: null,
    })).getEntrypoint(parsed.entrypoint);
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
