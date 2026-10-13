import piAgentCore from "@earendil-works/pi-agent-core/package.json" with { type: "json" };
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { errorFields, log } from "@grasp-os/shared/log";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { compatibilityDate } from "@grasp-os/shared/runtime";
import { RpcPromise, RpcStub } from "capnweb";
import type { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import type { CodeRunStatus } from "./code-run-statuses.ts";
import { holdRunSession } from "./run-sessions.ts";
import {
  capability,
  functionCapability,
  runInSession,
  sandboxVerdictOf,
} from "./sandbox-session.ts";
import { sandbox } from "./sandbox.ts";
import { SandboxUnavailableError } from "./sandboxed.ts";

// Code Mode: the agent acts by writing code against typed APIs, and the
// code runs here, in a Dynamic Worker of its own, locked down like App code
// (sandbox.ts): no network (`globalOutbound: null`), no importable env or
// exports (`disallow_importable_env`), the same CPU limit per run, and on
// top a cap on its calls out. It has no Cache API (a cache shared between
// runs would let one chat hand data to another), and its env holds only
// the stubs it is given: loopback entrypoints of core whose props core
// sets, never a raw binding. What the code returns, logs or throws comes
// back as data, and core bounds it again: the code runs in the same
// isolate as the harness, so nothing the harness does is trusted.
//
// The code is a complete ES module whose default export is an async
// function of `(self, env, ctx)`: `self` is null (no originating-session
// capability is offered in this release), `env` holds the stubs, and `ctx`
// is the run's own, with nothing of core's in it. Two modules load: the
// harness, which core wrote, and the code. The harness's `verify` imports
// the code, so what its module does as it loads (it is untrusted too) runs
// under the same limits and is told apart from a failure of the function;
// `run` then calls it.
//
// The CPU limit is enforced by Cloudflare's runtime, not by plain workerd:
// on-prem, without that limit, a run could spin forever, so the agent
// needs a limit of its own there before it is used.

/**
 * How far one run may go beyond App code's CPU limit: the source the
 * model may send, calls out of the isolate (its API calls, which the
 * Workspace object counts on every call, `callFromCodeRun`; the runtime's
 * own cap too, where it enforces one: plain workerd doesn't), and
 * wall-clock time, which also ends a run that waits forever, counted from
 * before the code loads. Memory is the runtime's per-isolate limit; Worker
 * Loader has no setting for less.
 */
export const codeLimits = {
  sourceChars: 200_000,
  subRequests: 100,
  timeoutMs: 30_000,
  /**
   * Most UTF-8 bytes of output a run may have, shared by what it logs (as
   * it streams to the chat and as the model reads it), what it returns
   * and its error: one budget, so a flood of one leaves no room unbounded
   * for the others.
   */
  outputBytes: 64 * 1024,
  /** Of {@link outputBytes}, kept for how the run ended, whatever it logged. */
  diagnosticBytes: 1024,
  /** Most log lines a run may send back. */
  logLines: 1000,
} as const;

/**
 * What a run ran on, kept with its record (`chat_code_runs`): the agent
 * loop's exact version (pi-ai is pinned to the same one in the catalog,
 * and exports no version of its own to read), the runtime's compatibility
 * date, and whether the runtime enforces the isolate's CPU limit. Only a
 * deployment that says `RUNTIME_PROFILE=cloudflare` is taken to, or one
 * that binds `SANDBOX_HOST`, whose supervisor ends a run past its CPU time
 * (sandbox-session.ts): anything else (unset, plain workerd in tests,
 * local development, a typo) records `cpu_limit_unsupported`, so a record
 * never claims a limit nobody vouched for. On plain workerd without the
 * sandbox, a synchronous busy loop isn't even bounded by the wall clock:
 * it holds the thread the host's timer needs.
 */
export const codeRuntime = (
  env: Pick<Env, "RUNTIME_PROFILE" | "SANDBOX_HOST">
) => {
  const cloudflare = env.RUNTIME_PROFILE === "cloudflare";
  return {
    agent: `${piAgentCore.name}@${piAgentCore.version}`,
    compatibilityDate,
    runtime: cloudflare ? ("cloudflare" as const) : ("workerd" as const),
    // On-prem, the sandbox supervisor ends a run past its CPU time.
    cpuLimit:
      cloudflare || env.SANDBOX_HOST !== undefined
        ? ("enforced" as const)
        : ("cpu_limit_unsupported" as const),
  };
};

/** A module's SHA-256, in hex: what its run's record keeps of it. */
export const sourceHash = async (code: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Most characters of each part of a run that core takes from the isolate:
 * at least what fits in the output budget, so it can be told what was cut.
 */
const room = codeLimits.outputBytes;

/**
 * A run's wall-clock limit: {@link codeLimits}' `timeoutMs`, or less where
 * tests set `CODE_RUN_TIMEOUT_MS`; it is never set in wrangler.jsonc, and
 * never by the model.
 */
export const codeTimeoutMs = (
  env: Pick<Env, "CODE_RUN_TIMEOUT_MS">
): number => {
  const set = Number(env.CODE_RUN_TIMEOUT_MS);
  return Number.isInteger(set) && set > 0 && set < codeLimits.timeoutMs
    ? set
    : codeLimits.timeoutMs;
};

/** What the code must export, as the model is told when it doesn't. */
const exportNeeded =
  "The module's default export must be an async function: export default async (self, env, ctx) => { ... }";

/**
 * Runs in the isolate: takes what it needs of the language first, removes
 * the Cache API and takes over `console`, and only then loads the code,
 * which can't change what the harness already holds. `verify` imports the
 * code and checks its default export; `run` calls it with `(null, env,
 * ctx)`. Both return what was logged so far, from the code's module and
 * function alike. An env name the code wasn't given is refused by name,
 * instead of failing later as `undefined`.
 */
const harness = `
import { WorkerEntrypoint } from "cloudflare:workers";

// Everything the harness uses of the language, taken before the code
// loads: the code can replace any global or prototype after, never these.
const room = ${room};
const lines = ${codeLimits.logLines};
const exportNeeded = ${JSON.stringify(exportNeeded)};
const call = Function.prototype.call;
const bind = (method) => call.bind(method);
const slice = bind(String.prototype.slice);
const map = bind(Array.prototype.map);
const join = bind(Array.prototype.join);
const keys = Object.keys;
const freeze = Object.freeze;
const has = Reflect.has;
const get = Reflect.get;
const stringify = JSON.stringify;
const toText = String;
const ProxyOf = Proxy;
const ErrorOf = Error;
const tooLarge = {};
const undescribable = "(an error that can't be described)";
const then = bind(Promise.prototype.then);
const resolve = Promise.resolve.bind(Promise);
const create = Object.create;
const define = Object.defineProperty;
const isPrototypeOf = bind(Object.prototype.isPrototypeOf);
const streamPrototype = ReadableStream.prototype;
const getReader = bind(ReadableStream.prototype.getReader);
const readChunk = bind(ReadableStreamDefaultReader.prototype.read);
const cancelReader = bind(ReadableStreamDefaultReader.prototype.cancel);
const BytesOf = Uint8Array;
const setBytes = bind(Uint8Array.prototype.set);
const push = bind(Array.prototype.push);
// The most of a stream an API call carries: a call of an App's function's
// own bound, and one byte more, for the API to refuse it as too large.
const streamBytes = ${functionRequestMaxBytes} + 1;

Object.defineProperty(globalThis, "caches", { value: undefined });

// A value as text, never throwing, whatever the value does: serializing
// stops as soon as it would pass room, instead of building all of a huge
// value first.
const render = (value) => {
  if (typeof value === "string") {
    return value;
  }
  let size = 0;
  try {
    const json = stringify(value, (key, item) => {
      size += key.length + (typeof item === "string" ? item.length : 8);
      if (size > room) {
        throw tooLarge;
      }
      return item;
    });
    return json === undefined ? toText(value) : json;
  } catch (error) {
    if (error === tooLarge) {
      return "(a value too large to show, over " + room + " characters)";
    }
    try {
      return toText(value);
    } catch {
      return "(a value that can't be shown)";
    }
  }
};

// Never longer than room, and never throwing, whatever the value makes
// of itself (a \`toString\` of its own, say).
const show = (value) => {
  try {
    return slice(toText(render(value)), 0, room);
  } catch {
    return "(a value that can't be shown)";
  }
};

// What the code threw, as text: its stack when it has one, never
// throwing (a thrown Proxy's traps may throw anything).
const describe = (error) => {
  try {
    const stack =
      typeof error === "object" && error !== null ? get(error, "stack") : undefined;
    return show(typeof stack === "string" ? stack : error);
  } catch {
    return undescribable;
  }
};

// A stream's bytes, no more than streamBytes of them: the rest is
// left unread, and the stream cancelled.
const bytesOf = async (stream) => {
  const reader = getReader(stream);
  const chunks = [];
  let total = 0;
  try {
    while (total < streamBytes) {
      const { done, value } = await readChunk(reader);
      if (done) {
        break;
      }
      if (typeof value !== "object" || value === null || !isPrototypeOf(BytesOf.prototype, value)) {
        throw new ErrorOf("A stream an API takes carries bytes only.");
      }
      push(chunks, value);
      total += value.byteLength;
    }
  } finally {
    try {
      await cancelReader(reader);
    } catch {
      // Ended already.
    }
  }
  const bytes = new BytesOf(total < streamBytes ? total : streamBytes);
  let at = 0;
  for (let index = 0; index < chunks.length && at < bytes.length; index += 1) {
    const chunk = chunks[index];
    const room = bytes.length - at;
    setBytes(bytes, chunk.byteLength > room ? chunk.subarray(0, room) : chunk, at);
    at += chunk.byteLength > room ? room : chunk.byteLength;
  }
  return bytes;
};

// What the code logs, as it loads and as it runs: one run per isolate.
// Kept as the JSON of its lines, built from strings only: no array or
// object of the harness's that a prototype the code changed could reach
// (a setter on \`Array.prototype[0]\` fires on an array's [[Set]]).
let logsJson = "";
let logCount = 0;
// Each line also goes to the host as it is written (\`out\`, core's own
// callback, which the code never sees), in order, one after another
// (\`sent\`), and all of them before a call returns.
let left = room;
let out;
let sent = resolve();
const delivered = async () => {
  try {
    await sent;
  } catch {
    // A line the host didn't take is still in the outcome's logs.
  }
};
const write = (...parts) => {
  if (left > 0 && logCount < lines) {
    let line = "";
    for (let index = 0; index < parts.length; index += 1) {
      const part = show(parts[index]);
      line = line === "" ? part : line + " " + part;
    }
    line = slice(line, 0, left);
    left -= line.length + 1;
    const quoted = stringify(line);
    logsJson = logCount === 0 ? quoted : logsJson + "," + quoted;
    logCount += 1;
    if (out !== undefined) {
      const send = out;
      const next = () => send(line);
      // After the line before, however that went.
      sent = then(sent, next, next);
    }
  }
};

// An outcome as the one string a call returns: its fields are all
// primitives, put together as JSON by hand, so nothing the code changed
// runs as it is built or as the runtime sends it. A string can't make
// the call reject.
const outcome = (ok, loaded, field, text) => {
  try {
    return (
      '{"ok":' + (ok ? "true" : "false") +
      ',"loaded":' + (loaded ? "true" : "false") +
      ',"logs":[' + logsJson + "]" +
      (typeof text === "string" ? "," + stringify(field) + ":" + stringify(text) : "") +
      "}"
    );
  } catch {
    return '{"ok":false,"loaded":' + (loaded ? "true" : "false") + ',"logs":[],"error":"(an outcome that could not be sent)"}';
  }
};
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = write;
}

// The code's default export, once \`verify\` found it a function.
let code;

// Runs the code's function with \`raw\` as its env, once \`verify\` found it.
const runWith = async (own, raw, output) => {
  out = output;
  if (code === undefined) {
    return outcome(false, false, "error", exportNeeded);
  }
  try {
    const given = keys(raw);
    const env = new ProxyOf(raw, {
      get(target, name) {
        if (typeof name === "string" && name !== "then" && !has(target, name)) {
          throw new ErrorOf(
            "This chat has no API named env." + name + ". It has: " +
              (given.length === 0 ? "none" : join(map(given, (api) => "env." + api), ", ")) + "."
          );
        }
        return get(target, name);
      },
    });
    // The run's own context: waiting on more work extends nothing of
    // core's (the run's stubs answer only while the host keeps it open).
    const ctx = freeze({ waitUntil: (promise) => own.waitUntil(promise) });
    const value = await code(null, env, ctx);
    const result = value === undefined ? undefined : show(value);
    await delivered();
    return outcome(true, true, "result", result);
  } catch (error) {
    await delivered();
    return outcome(false, true, "error", describe(error));
  }
};

// Every outcome is returned, never thrown: a call that rejects was ended
// by the runtime, so the code can't choose how its run ends. Each call
// gets core's output callback anew: a stub works only in the call that
// brought it.
class Harness extends WorkerEntrypoint {
  async verify(output) {
    out = output;
    try {
      const { default: found } = await import("code.js");
      if (typeof found !== "function") {
        await delivered();
        return outcome(false, false, "error", exportNeeded);
      }
      code = found;
      await delivered();
      return outcome(true, true);
    } catch (error) {
      await delivered();
      return outcome(false, false, "error", describe(error));
    }
  }

  async run(output) {
    out = output;
    return await runWith(this.ctx, this.env, output);
  }

  // On-prem, one call in a sandbox session (sandbox-session.ts): verify,
  // then run, with the APIs as the session passes them, since a loaded
  // Worker's env can't hold them. Each API is a proxy whose methods go to
  // core through \`bridge\`, by the API's name: what the code may call is
  // what core's own stub of that API answers. Both outcomes, as JSON.
  async session(output, names, bridge) {
    const verified = await this.verify(output);
    if (code === undefined) {
      return "[" + stringify(verified) + ",null]";
    }
    const apis = create(null);
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      if (typeof name === "string") {
        const api = new ProxyOf(create(null), {
          get(target, method) {
            if (typeof method !== "string" || method === "then") {
              return undefined;
            }
            return async (...args) => {
              // A stream (an App call's request) crosses as its bytes, read
              // here no further than such a request may be: the bridge
              // takes no stream.
              const streamed = [];
              for (let at = 0; at < args.length; at += 1) {
                const arg = args[at];
                if (typeof arg === "object" && arg !== null && isPrototypeOf(streamPrototype, arg)) {
                  args[at] = await bytesOf(arg);
                  push(streamed, at);
                }
              }
              return await bridge.invoke(name, method, args, streamed);
            };
          },
        });
        define(apis, name, { value: api, enumerable: true });
      }
    }
    const ran = await runWith(this.ctx, apis, output);
    return "[" + stringify(verified) + "," + stringify(ran) + "]";
  }
}

// Frozen before the code loads: it can't replace \`verify\` or \`run\`, even
// by importing this module.
freeze(Harness.prototype);
freeze(Harness);

export default Harness;
`;

const logsSchema = z.array(z.string().max(room)).max(codeLimits.logLines);

/** All of what the isolate sends: the logs share one room, the rest another. */
const withinRoom = ({
  logs,
  result,
  error,
}: {
  logs: string[];
  result?: string;
  error?: string;
}): boolean =>
  logs.reduce((total, line) => total + line.length, 0) +
    (result?.length ?? 0) +
    (error?.length ?? 0) <=
  2 * room;

/**
 * What the isolate sends back, bounded here whatever the harness did: the
 * agent's code runs in the same isolate and can change anything there.
 */
const outcomeSchema = z
  .object({
    ok: z.boolean(),
    /** Whether the code's function was there to call (`verify` found it). */
    loaded: z.boolean(),
    logs: logsSchema,
    result: z.string().max(room).optional(),
    error: z.string().max(room).optional(),
  })
  .refine(withinRoom, { message: "More than a run may send back" });

/** One run of the agent's code, as the host ended it. */
export interface CodeRun {
  status: CodeRunStatus;
  logs: string[];
  result?: string;
  error?: string;
}

/**
 * The harness's entrypoint, as core calls it. What it says it returns is
 * checked, not trusted.
 */
interface Harness extends WorkerEntrypoint {
  verify: (output: (line: unknown) => void) => Promise<string>;
  run: (output: (line: unknown) => void) => Promise<string>;
}

/**
 * The message the runtime ends a run with when it used up its CPU time.
 * Matched only on a call that rejected, which the harness never makes
 * happen (it returns every outcome), and whole: the code can't make a
 * call reject, nor choose the message.
 */
const cpuExceeded = /^Worker exceeded CPU time limit\.?$/u;

/**
 * A message the runtime ends a run with when its code waits on nothing
 * that can ever settle (no timer, no call, no I/O): it would wait past its
 * wall-clock time, so it ends as if it had.
 */
const hung =
  "The Workers runtime canceled this request because it detected that your Worker's code had hung";

/** How a run the sandbox ended ends, by the sandbox's verdict. */
const sandboxStatuses: Readonly<Record<string, CodeRunStatus>> = {
  cpu: "cpu_exceeded",
  deadline: "wall_expired",
  memory: "crashed",
  crashed: "crashed",
  // What the code sent that a session doesn't take: the code's failure.
  refused: "threw",
  // Its person already runs as much code in the sandbox as they may.
  busy: "crashed",
};

/**
 * How a run ends that the on-prem sandbox ended, and said why; or that it
 * couldn't run, which ends it as a crash, not as anything its code did.
 * Undefined for any other failure.
 */
const sandboxEnded = (error: unknown): CodeRun | undefined => {
  if (error instanceof SandboxUnavailableError) {
    // How the deployment is wrong is for its operators' logs, never for a
    // run record people and the model read.
    log.error("code_mode.sandbox_unavailable", errorFields(error));
    return {
      status: "crashed",
      logs: [],
      error: "The sandbox that runs code isn't available right now.",
    };
  }
  const verdict = sandboxVerdictOf(error);
  if (verdict === undefined) {
    return undefined;
  }
  return {
    status: sandboxStatuses[verdict] ?? "crashed",
    logs: [],
    error: (error instanceof Error ? error.message : "").slice(0, room),
  };
};

/** Both of the harness's calls, as a run makes them. */
interface HarnessCalls {
  verify: () => Promise<unknown>;
  run: () => Promise<unknown>;
  /**
   * Settles once a run given up on (cancelled, past its time) has let go
   * of what it holds; on-prem, its sandbox process.
   */
  ended?: () => Promise<void>;
}

/** Both calls on one Loader isolate of core's own, `env` its APIs. */
const loaderCalls = (
  loader: WorkerLoader,
  code: string,
  env: Readonly<Record<string, Fetcher>>,
  stream: (line: unknown) => void
): HarnessCalls => {
  const worker = loader.load({
    ...sandbox,
    mainModule: "harness.js",
    modules: { "harness.js": harness, "code.js": code },
    env,
    limits: { ...sandbox.limits, subRequests: codeLimits.subRequests },
  });
  const entry = worker.getEntrypoint<Harness>();
  return {
    verify: async () => await entry.verify(stream),
    run: async () => await entry.run(stream),
  };
};

/** A method name the code may call on an API: never one every object has. */
const apiMethod = /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/u;

/**
 * Whether `name` is one a stub or any object answers itself (`then`,
 * `dup`, `hasOwnProperty`, ...), never an API's: read from the classes, so
 * a name either gains is refused too.
 */
const notApiMethod = (name: string): boolean =>
  name in Object.prototype ||
  name in RpcPromise.prototype ||
  name in RpcStub.prototype ||
  name === "connect" ||
  name === "dispose";

/** The one argument a stream may be passed as: an App call's request. */
const streamArguments: Readonly<Record<string, number>> = {
  "apps.call": 1,
};

/**
 * `args` with each argument `streamed` names, the bytes of a stream the
 * code passed (as the harness read it, no further than an App call's
 * request may be), a stream again: what the API takes. Only bytes become
 * one, and only where the API takes a stream (`streamArguments`); the
 * bridge itself takes no stream.
 */
const asStreams = (
  call: string,
  args: unknown[],
  streamed: unknown
): unknown[] => {
  const allowed = Object.hasOwn(streamArguments, call)
    ? streamArguments[call]
    : undefined;
  if (
    !Array.isArray(streamed) ||
    !streamed.every(
      (at: unknown): at is number =>
        typeof at === "number" &&
        at === allowed &&
        args[at] instanceof Uint8Array
    )
  ) {
    throw new TypeError("That isn't a call of one of this chat's APIs.");
  }
  return args.map((arg, at) =>
    streamed.includes(at) && arg instanceof Uint8Array
      ? new Blob([arg]).stream()
      : arg
  );
};

/**
 * The one capability a session's run reaches its APIs through: a call of
 * `method` on the API named `api`, on core's own stub of it, which answers
 * only while the run is open, as the code's env would.
 */
const apiBridge = (env: Readonly<Record<string, Fetcher>>) => ({
  invoke: async (
    api: unknown,
    method: unknown,
    args: unknown,
    streamed: unknown = []
  ) => {
    if (
      typeof api !== "string" ||
      !Object.hasOwn(env, api) ||
      typeof method !== "string" ||
      !apiMethod.test(method) ||
      notApiMethod(method) ||
      !Array.isArray(args)
    ) {
      throw new TypeError("That isn't a call of one of this chat's APIs.");
    }
    const fn: unknown = Reflect.get(env[api] ?? {}, method);
    if (typeof fn !== "function") {
      throw new TypeError(`env.${api} has no method ${method}.`);
    }
    const answer: unknown = await Reflect.apply(
      fn,
      env[api],
      asStreams(`${api}.${method}`, args, streamed)
    );
    return answer;
  },
});

/** The harness's answer to a session: its two outcomes, as text. */
const sessionAnswerSchema = z.tuple([z.string(), z.string().nullable()]);

/** Both calls in one sandbox session, on-prem (sandbox-session.ts). */
const sessionCalls = (
  host: Fetcher,
  code: string,
  env: Readonly<Record<string, Fetcher>>,
  stream: (line: unknown) => void,
  {
    timeoutMs,
    signal,
    owner,
    sessionKey,
  }: {
    timeoutMs: number;
    signal: AbortSignal;
    owner: string;
    sessionKey?: string;
  }
): HarnessCalls => {
  // Held only once the session is open.
  let letGoOfSession: (() => void) | undefined;
  const both = (async () => {
    const answer = await runInSession(
      host,
      {
        mainModule: "harness.js",
        modules: { "harness.js": harness, "code.js": code },
        entrypoint: "default",
        method: "session",
        args: [
          { capability: functionCapability(stream) },
          { value: Object.keys(env) },
          { capability: capability(apiBridge(env), ["invoke"]) },
        ],
        owner,
        cpuMs: sandbox.limits.cpuMs,
        wallMs: timeoutMs,
      },
      // A cancel or the run's wall-clock limit ends the session, and frees
      // its process at once. The App functions the run calls run in its
      // children (run-sessions.ts), named by its ID while it's open.
      {
        signal,
        ...(sessionKey === undefined
          ? {}
          : {
              opened: (callId: string) => {
                letGoOfSession = holdRunSession(sessionKey, callId);
              },
            }),
      }
    ).finally(() => {
      letGoOfSession?.();
    });
    // Not the harness's answer, the code changed it: no outcome at all.
    let json: unknown;
    try {
      json = typeof answer === "string" ? JSON.parse(answer) : undefined;
    } catch {
      json = undefined;
    }
    const pair = sessionAnswerSchema.safeParse(json);
    return pair.success ? pair.data : ([undefined, undefined] as const);
  })();
  return {
    verify: async () => {
      const [verified] = await both;
      return verified;
    },
    run: async () => {
      const [, ran] = await both;
      return ran;
    },
    ended: async () => {
      try {
        await both;
      } catch {
        // How it ended is the run's outcome, set already.
      }
    },
  };
};

/** Both calls where the run goes: its sandbox on-prem, else the loader. */
const harnessCalls = (
  where: {
    loader: WorkerLoader;
    sandbox: RunOptions["sandbox"];
    timeoutMs: number;
    signal: AbortSignal;
    owner: string;
    sessionKey?: string;
  },
  code: string,
  env: Readonly<Record<string, Fetcher>>,
  stream: (line: unknown) => void
): HarnessCalls => {
  const host = where.sandbox?.();
  return host === undefined
    ? loaderCalls(where.loader, code, env, stream)
    : sessionCalls(host, code, env, stream, where);
};

const ended = (status: CodeRunStatus, error: string): CodeRun => ({
  status,
  logs: [],
  error,
});

/**
 * The longest outcome string the harness can send for output within its
 * limits: every character of the logs and the result or error escaped as
 * JSON at its worst (six characters, as for \u0001 or a lone surrogate),
 * each log line's quotes and comma, and the field names and punctuation.
 * Past it, the string isn't the harness's; the decoded limits are checked
 * again once it is parsed (`outcomeSchema`).
 */
const maxOutcomeChars = 6 * 2 * room + 3 * codeLimits.logLines + 256;

/** What the isolate sent, or `undefined` for anything it may not send. */
const parsed = (
  outcome: unknown
): z.infer<typeof outcomeSchema> | undefined => {
  if (typeof outcome !== "string" || outcome.length > maxOutcomeChars) {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(outcome);
  } catch {
    return undefined;
  }
  const checked = outcomeSchema.safeParse(json);
  return checked.success ? checked.data : undefined;
};

/** Waits for a run given up on to let go of what it holds. */
const letGo = async (
  calls: HarnessCalls | undefined,
  signal: AbortSignal
): Promise<void> => {
  if (signal.aborted) {
    await calls?.ended?.();
  }
};

const notAResult = "The run returned more than it may, or not a result.";

/** How a run is limited and followed, besides its code and env. */
export interface RunOptions {
  /** Cancels the run. */
  signal?: AbortSignal;
  /** Its wall-clock limit ({@link codeTimeoutMs}). */
  timeoutMs?: number;
  /**
   * Gets each line the code logs as it is written, until the run ends:
   * a line after that is dropped, whenever the isolate sends it.
   */
  onOutput?: (line: string) => void;
  /**
   * The sandbox supervisor the run goes to on-prem, or undefined where it
   * runs in a Loader isolate of core's own (`sessionHost`, which refuses
   * where neither may run it: the run then ends as `crashed`). On-prem,
   * both of the harness's calls run in one session, its process killed
   * past the run's CPU time, which plain workerd's Loader doesn't bound.
   */
  sandbox?: () => Fetcher | undefined;
  /** Whose run it is, which the sandbox caps per owner: `person:` and an ID. */
  owner?: string;
  /**
   * The run's ID, under which its session is named while it's open, so
   * the App functions it calls run in its children (run-sessions.ts).
   */
  sessionKey?: string;
}

/**
 * Runs `code`, an ES module whose default export is an async function of
 * `(self, env, ctx)`, in a fresh locked isolate with `env` as its only way
 * out. Never throws: every way a run can end is a {@link CodeRunStatus}.
 * The wall-clock limit is set before the isolate is asked to load the
 * code, and covers loading it, its module's own code and the call.
 */
export const runCode = async (
  loader: WorkerLoader,
  code: string,
  env: Readonly<Record<string, Fetcher>>,
  {
    signal,
    timeoutMs = codeLimits.timeoutMs,
    onOutput,
    sandbox: sandboxOf,
    owner,
    sessionKey,
  }: RunOptions = {}
): Promise<CodeRun> => {
  const limit = deadline(timeoutMs, signal);
  let over = false;
  // What the isolate streams is checked like what it returns: a string,
  // no longer than a line may be, and only while the run is open.
  const stream = (line: unknown): void => {
    if (!over && typeof line === "string" && line.length <= room) {
      onOutput?.(line);
    }
  };
  // The phase it is in, for a failure the runtime throws: a module that
  // doesn't compile fails as it loads, before `run` is ever called.
  let phase: "load" | "run" = "load";
  let calls: HarnessCalls | undefined;
  try {
    if (code.length > codeLimits.sourceChars) {
      return ended(
        "refused",
        `The module is ${code.length} characters long; a run takes at most ${codeLimits.sourceChars}.`
      );
    }
    calls = harnessCalls(
      {
        loader,
        sandbox: sandboxOf,
        timeoutMs,
        signal: limit.signal,
        owner: owner ?? "code-mode",
        ...(sessionKey === undefined ? {} : { sessionKey }),
      },
      code,
      env,
      stream
    );
    const verified = parsed(
      await Promise.race([calls.verify(), whenAborted(limit.signal)])
    );
    // An outcome that isn't one the harness returns came from the code,
    // which may change anything in its isolate: it didn't load (verify)
    // or threw (run), never a status the host sets.
    if (verified === undefined) {
      return ended("load_failed", notAResult);
    }
    if (!verified.ok) {
      return {
        status: "load_failed",
        logs: verified.logs,
        error: verified.error ?? exportNeeded,
      };
    }
    phase = "run";
    const ran = parsed(
      await Promise.race([calls.run(), whenAborted(limit.signal)])
    );
    if (ran === undefined) {
      return ended("threw", notAResult);
    }
    const { ok, loaded, ...output } = ran;
    if (ok) {
      return { status: "completed", ...output };
    }
    // Its function wasn't there to call (the isolate started over since
    // `verify`): it never ran.
    return { status: loaded ? "threw" : "load_failed", ...output };
  } catch (error) {
    if (limit.stopped() === "cancelled") {
      return ended("cancelled", "The run was cancelled.");
    }
    if (limit.stopped() === "timeout") {
      return ended(
        "wall_expired",
        `The run took longer than ${timeoutMs / 1000} seconds, so it was stopped.`
      );
    }
    const sandboxed = sandboxEnded(error);
    if (sandboxed !== undefined) {
      return sandboxed;
    }
    // A rejection is the runtime's, never the code's (the harness returns
    // every outcome): the module didn't compile (a syntax error, say) as
    // it loaded, or the runtime stopped it (CPU time, memory, a hang).
    // Its message is about the code, never core.
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, room);
    if (cpuExceeded.test(message)) {
      return ended("cpu_exceeded", message);
    }
    if (message.startsWith(hung)) {
      return ended(
        "wall_expired",
        "The run waits for something that can never come, so it was stopped."
      );
    }
    return ended(phase === "load" ? "load_failed" : "crashed", message);
  } finally {
    over = true;
    limit.clear();
    // A run given up on is answered only once its session has asked the
    // supervisor to free its process: past the answer, the request that
    // would ask may itself be cancelled.
    await letGo(calls, limit.signal);
  }
};

const encoder = new TextEncoder();

/** The UTF-8 bytes of `text`. */
export const utf8Bytes = (text: string): number => encoder.encode(text).length;

/** `text` cut to at most `bytes` UTF-8 bytes, never inside a character. */
export const cutToBytes = (text: string, bytes: number): string => {
  if (bytes <= 0) {
    return "";
  }
  // Text no longer than this in characters can't be longer in bytes:
  // only longer text is measured, at most four bytes a character.
  if (text.length * 3 <= bytes) {
    return text;
  }
  const { read } = encoder.encodeInto(text, new Uint8Array(bytes));
  return text.slice(0, read);
};

/** The marker where output was cut, saying where. */
export const cutMarker = `\n… (cut: over ${codeLimits.outputBytes} bytes of output)`;

/**
 * Credentials as text that could only leak through output, each with what
 * it becomes. Covered: bearer and basic authorization values; Stripe keys
 * (`sk_`, `pk_`, `rk_` live and test); `sk-`, `pk-` and `rk-` style
 * provider keys; GitHub tokens (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`,
 * `github_pat_`); Slack tokens (`xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`);
 * Google API keys (`AIza`); JSON Web Tokens; PEM private keys, an
 * unfinished block to the end of the text; AWS access key IDs; and the
 * whole value of an `api_key`, `apikey`, `token`, `secret`, `password` or
 * `authorization` written as `name=value` or `name: value`: quoted, to
 * its closing quote (or the end of the line), spaces included; unquoted,
 * to the next space or separator, with a `Bearer` or `Basic` scheme of
 * any length taken with it. Anything else
 * shaped like a secret is not caught: this is a net for what an outside
 * system's data may carry, not a guarantee (a run holds no secret of its
 * own). Applied to what streams to the chat and to what the model reads,
 * over the whole text, so a credential split across lines is caught.
 */
/**
 * An assignment's value as {@link credentials} redacts it: the name and
 * separator kept, the value replaced, and its quotes kept where it had
 * them.
 */
const redactedAssignment = (...args: unknown[]): string => {
  const groups: unknown = args.at(-1);
  const part = (name: string): string => {
    const value: unknown =
      typeof groups === "object" && groups !== null
        ? Reflect.get(groups, name)
        : undefined;
    return typeof value === "string" ? value : "";
  };
  return `${part("name")}${part("between")}${part("quote")}[redacted]${part("close")}`;
};

const credentials: readonly (readonly [
  RegExp,
  string | ((...args: unknown[]) => string),
])[] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
    "[redacted]",
  ],
  [/\b(?:bearer|basic)\s+[\w\-.~+/]{16,}=*/giu, "[redacted]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/gu, "[redacted]"],
  [/\b(?:sk|pk|rk)-[\w-]{16,}/gu, "[redacted]"],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[0-9A-Za-z]{20,}/gu, "[redacted]"],
  [/\bgithub_pat_[0-9A-Za-z_]{20,}/gu, "[redacted]"],
  [/\bxox[abpr]-[0-9A-Za-z-]{10,}/gu, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{35}/gu, "[redacted]"],
  // Not a word boundary: between "-" and "e" one holds at every step of a
  // flood like "eyJ-eyJ-…", which made the match quadratic.
  [/(?<![\w-])eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/gu, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/gu, "[redacted]"],
  // Each character of a quoted value is taken by one alternative only
  // (an escape, or anything but the quote, a backslash or a newline): it
  // stays linear.
  [
    /\b(?<name>api[_-]?key|apikey|token|secret|password|authorization)(?<between>["']?\s*[:=]\s*)(?:(?<quote>["'])(?:\\.|(?!\k<quote>)[^\\\n])*(?<close>\k<quote>)?|(?:(?:bearer|basic)\s+)?[^\s"'&,;]+)/giu,
    redactedAssignment,
  ],
];

/** `text` with every credential in it ({@link credentials}) redacted. */
export const redact = (text: string): string => {
  let redacted = text;
  for (const [pattern, replacement] of credentials) {
    redacted =
      typeof replacement === "string"
        ? redacted.replace(pattern, replacement)
        : redacted.replace(pattern, replacement);
  }
  return redacted;
};

/**
 * A run as the model reads it: its logs, then its result or, for a run
 * that didn't complete, its error under its status, redacted, in at most
 * {@link codeLimits}' `outputBytes` UTF-8 bytes. Logs and result share the
 * budget less `diagnosticBytes`, which stay for the error, so a flood of
 * logs never hides how a run ended. Cut text ends with {@link cutMarker}.
 */
export const describeRun = ({
  status,
  logs,
  result,
  error,
}: CodeRun): string => {
  const { outputBytes, diagnosticBytes } = codeLimits;
  const markerBytes = utf8Bytes(cutMarker);
  const parts: string[] = [];
  if (logs.length > 0) {
    parts.push(`Logs:\n${logs.join("\n")}`);
  }
  if (status === "completed" && result !== undefined) {
    parts.push(`Returned:\n${result}`);
  }
  const body = redact(parts.join("\n\n"));
  const ending =
    status === "completed"
      ? ""
      : redact(`Error (${status}):\n${error ?? "The run failed."}`);
  // The body's share: everything but the ending, or the reserve for one.
  const bodyRoom =
    outputBytes - Math.min(utf8Bytes(ending), diagnosticBytes) - 2;
  const bodyCut = utf8Bytes(body) > bodyRoom;
  const shownBody = bodyCut
    ? `${cutToBytes(body, bodyRoom - markerBytes)}${cutMarker}`
    : body;
  if (ending === "") {
    return shownBody === "" ? "(no logs, returned nothing)" : shownBody;
  }
  const lead = shownBody === "" ? "" : `${shownBody}\n\n`;
  const endingRoom = outputBytes - utf8Bytes(lead);
  const shownEnding =
    utf8Bytes(ending) > endingRoom
      ? `${cutToBytes(ending, endingRoom - markerBytes)}${cutMarker}`
      : ending;
  return `${lead}${shownEnding}`;
};
