/**
 * The on-prem profile's sandbox host: where core's untrusted isolates run
 * on plain workerd, in a workerd process of their own.
 *
 * Plain workerd enforces no `limits.cpuMs`, and runs a process's requests
 * on one thread: a busy loop in a Loader isolate holds every Worker in its
 * process, core's own timers included, until it ends. Nothing inside a
 * process can interrupt it. So on-prem, core doesn't load untrusted code
 * itself: it sends the isolate to this Worker, which a supervisor
 * (scripts/workerd-sandbox.ts) serves in a pool of workerd processes,
 * one call per process at a time, and kills the process whose call runs
 * past its deadline. A busy loop then costs its own call and one process,
 * never core.
 *
 * Core never sees this module. On Cloudflare, whose runtime enforces
 * `cpuMs`, core loads the isolate with its own Loader, as it always has
 * (apps/core/src/sandboxed.ts). An env-less isolate comes as one call,
 * modules in and JSON out (`/call`). One that reaches back into core comes
 * as a session (`/session`, sandbox-session.ts): a WebSocket per call that
 * carries the capabilities core passes it, as no workerd stub crosses a
 * process.
 *
 * Whatever it's sent, the isolate gets no env and no network: this Worker
 * sets both itself. Nor does it print anything to the process's output,
 * which the deployment's logs share (quiet-isolate.ts). It has no binding but its Loader, so code that escaped
 * its isolate would find nothing here: no storage, no secrets.
 */

import { quietModules } from "./quiet-isolate.ts";
import { sessionResponse } from "./sandbox-session.ts";
import { isolateSettings } from "./sandbox-settings.ts";

/** What the workerd config gives this Worker. */
interface SandboxHostEnv {
  LOADER: WorkerLoader;
}

/** The isolate's code: its modules, and which is its main one. */
interface IsolateCode {
  mainModule: string;
  modules: Record<string, string>;
}

/** One call: the isolate's code, and which entrypoint method to call with what. */
interface SandboxCall {
  worker: IsolateCode;
  entrypoint: string;
  method: string;
  args: unknown[];
}

/** What a call comes to: its JSON result, or why it threw. */
type SandboxAnswer =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/** The most of an error's message a refusal keeps. */
const maxMessage = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

/**
 * `body` as a call, or undefined for anything else. Only the code is read
 * from it: anything else it carries (an env, an outbound, flags, limits)
 * is ignored.
 */
const callOf = (body: unknown): SandboxCall | undefined => {
  if (!isRecord(body) || !isRecord(body.worker)) {
    return undefined;
  }
  const { worker, entrypoint, method, args } = body;
  const { mainModule, modules } = worker;
  if (
    typeof mainModule !== "string" ||
    !isStringRecord(modules) ||
    typeof entrypoint !== "string" ||
    typeof method !== "string" ||
    !Array.isArray(args)
  ) {
    return undefined;
  }
  return { worker: { mainModule, modules }, entrypoint, method, args };
};

/** Runs `call` in an isolate of its own: no env, no network, no cache. */
const run = async (
  env: SandboxHostEnv,
  { worker, entrypoint, method, args }: SandboxCall
): Promise<SandboxAnswer> => {
  try {
    const stub: unknown = env.LOADER.get(null, () => ({
      ...isolateSettings,
      mainModule: worker.mainModule,
      // Printing nothing to the process's output, the deployment's logs.
      modules: quietModules(worker.mainModule, worker.modules),
      env: {},
      globalOutbound: null,
    })).getEntrypoint(entrypoint);
    // An RPC stub answers any method name with a function.
    const fn: unknown =
      isRecord(stub) || typeof stub === "function"
        ? Reflect.get(stub, method)
        : undefined;
    if (typeof fn !== "function") {
      return { ok: false, message: "The entrypoint has no such method." };
    }
    const value: unknown = await Reflect.apply(fn, stub, args);
    // Never undefined, which JSON drops: an answer always carries its value,
    // so whatever the App's code returns reads as its answer, never as an
    // outage (apps/core/src/sandboxed.ts).
    return { ok: true, value: value ?? null };
  } catch (error) {
    return {
      ok: false,
      message: (error instanceof Error ? error.message : String(error)).slice(
        0,
        maxMessage
      ),
    };
  }
};

export default {
  async fetch(request: Request, env: SandboxHostEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") {
      return new Response("ok");
    }
    if (
      pathname === "/session" &&
      request.headers.get("upgrade") === "websocket"
    ) {
      return sessionResponse(request, env, isolateSettings);
    }
    if (pathname !== "/call" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("The call isn't JSON.", { status: 400 });
    }
    const call = callOf(body);
    if (call === undefined) {
      return new Response("The call isn't in the expected shape.", {
        status: 400,
      });
    }
    const answer = await run(env, call);
    try {
      return Response.json(answer);
    } catch {
      // What the App's code answered doesn't serialize: its failure.
      return Response.json({ ok: false, message: "The answer isn't JSON." });
    }
  },
} satisfies ExportedHandler<SandboxHostEnv>;
