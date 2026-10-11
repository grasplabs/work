import piAgentCore from "@earendil-works/pi-agent-core/package.json" with { type: "json" };
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { compatibilityDate } from "@grasp-os/shared/runtime";
import type { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import type { CodeRunStatus } from "./code-run-statuses.ts";
import { sandbox } from "./sandbox.ts";

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
  /** Most characters of logs and result that go back to the model. */
  outputChars: 32 * 1024,
  /** Most log lines a run may send back. */
  logLines: 1000,
} as const;

/**
 * What a run ran on, kept with its record (`chat_code_runs`): the agent
 * loop's exact version (pi-ai is pinned to the same one in the catalog,
 * and exports no version of its own to read), the runtime's compatibility
 * date, and whether the runtime enforces the isolate's CPU limit. Only a
 * deployment that says `RUNTIME_PROFILE=cloudflare` is taken to: anything
 * else (unset, plain workerd in tests, local development and on-prem, a
 * typo) records `cpu_limit_unsupported`, so a record never claims a limit
 * nobody vouched for. On plain workerd a synchronous busy loop isn't even
 * bounded by the wall clock: it holds the thread the host's timer needs.
 */
export const codeRuntime = (env: Pick<Env, "RUNTIME_PROFILE">) => {
  const cloudflare = env.RUNTIME_PROFILE === "cloudflare";
  return {
    agent: `${piAgentCore.name}@${piAgentCore.version}`,
    compatibilityDate,
    runtime: cloudflare ? ("cloudflare" as const) : ("workerd" as const),
    cpuLimit: cloudflare
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
 * more than the model reads, so it can be told what was cut.
 */
const room = 2 * codeLimits.outputChars;

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

// What the code logs, as it loads and as it runs: one run per isolate.
// Kept as the JSON of its lines, built from strings only: no array or
// object of the harness's that a prototype the code changed could reach
// (a setter on \`Array.prototype[0]\` fires on an array's [[Set]]).
let logsJson = "";
let logCount = 0;
let left = room;
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

// Every outcome is returned, never thrown: a call that rejects was ended
// by the runtime, so the code can't choose how its run ends.
class Harness extends WorkerEntrypoint {
  async verify() {
    try {
      const { default: found } = await import("code.js");
      if (typeof found !== "function") {
        return outcome(false, false, "error", exportNeeded);
      }
      code = found;
      return outcome(true, true);
    } catch (error) {
      return outcome(false, false, "error", describe(error));
    }
  }

  async run() {
    if (code === undefined) {
      return outcome(false, false, "error", exportNeeded);
    }
    try {
      const given = keys(this.env);
      const env = new ProxyOf(this.env, {
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
      const own = this.ctx;
      const ctx = freeze({ waitUntil: (promise) => own.waitUntil(promise) });
      const value = await code(null, env, ctx);
      return outcome(true, true, "result", value === undefined ? undefined : show(value));
    } catch (error) {
      return outcome(false, true, "error", describe(error));
    }
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
  verify: () => Promise<string>;
  run: () => Promise<string>;
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

const notAResult = "The run returned more than it may, or not a result.";

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
  signal?: AbortSignal,
  timeoutMs: number = codeLimits.timeoutMs
): Promise<CodeRun> => {
  const limit = deadline(timeoutMs, signal);
  // The phase it is in, for a failure the runtime throws: a module that
  // doesn't compile fails as it loads, before `run` is ever called.
  let phase: "load" | "run" = "load";
  try {
    if (code.length > codeLimits.sourceChars) {
      return ended(
        "refused",
        `The module is ${code.length} characters long; a run takes at most ${codeLimits.sourceChars}.`
      );
    }
    const worker = loader.load({
      ...sandbox,
      mainModule: "harness.js",
      modules: { "harness.js": harness, "code.js": code },
      env,
      limits: { ...sandbox.limits, subRequests: codeLimits.subRequests },
    });
    const entry = worker.getEntrypoint<Harness>();
    const verified = parsed(
      await Promise.race([entry.verify(), whenAborted(limit.signal)])
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
      await Promise.race([entry.run(), whenAborted(limit.signal)])
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
    limit.clear();
  }
};

/**
 * A run as the model reads it: its logs, then its result or, for a run
 * that didn't complete, its error under its status, at most `outputChars`
 * of it. Built only that far, however much the run sent.
 */
export const describeRun = ({
  status,
  logs,
  result,
  error,
}: CodeRun): string => {
  const max = codeLimits.outputChars;
  let text = "";
  // One character past `max` at most: enough to know it was cut.
  const add = (piece: string) => {
    text += piece.slice(0, Math.max(0, max + 1 - text.length));
  };
  const part = (title: string, lines: readonly string[]) => {
    add(text === "" ? `${title}:` : `\n\n${title}:`);
    for (const line of lines) {
      add(`\n${line}`);
    }
  };
  if (logs.length > 0) {
    part("Logs", logs);
  }
  if (status === "completed" && result !== undefined) {
    part("Returned", [result]);
  }
  if (status !== "completed") {
    part(`Error (${status})`, [error ?? "The run failed."]);
  }
  if (text === "") {
    return "(no logs, returned nothing)";
  }
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (cut: longer than ${max} characters)`;
};
