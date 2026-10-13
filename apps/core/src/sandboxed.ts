import { sandboxDeadlineHeader, sandboxWaitHeader } from "./sandbox-headers.ts";
import { sandbox } from "./sandbox.ts";

// Running an env-less untrusted isolate (an App's inspection, app-releases.ts)
// with a bound on its time, on either profile. Threat model, and how each
// is closed:
// - App code never returns (a busy loop in its module startup or in the
//   method called), to stall core. On Cloudflare the runtime ends it at
//   `sandbox.limits.cpuMs`. Plain workerd enforces no CPU limit and runs a
//   process's requests on one thread, so there the loop would hold all of
//   core: on-prem binds `SANDBOX_HOST`, a supervisor
//   (scripts/workerd-sandbox.ts) serving the sandbox host
//   (on-prem/sandbox-host.ts) in a pool of workerd processes of its own. It
//   kills the process whose call runs past {@link sandboxDeadlineMs}, uses
//   too much memory or crashes, and answers so: a refusal of the App's code.
// - A deployment off Cloudflare forgets `SANDBOX_HOST`, and App code runs in
//   core unbounded again. Refused: without it, only `RUNTIME_PROFILE`
//   `cloudflare` runs App code in core, or an explicit
//   `SANDBOX_IN_PROCESS=unbounded` (tests and local development, which
//   accept that a busy loop holds them).
// - App code makes its failure look like an outage (an answer of nothing,
//   or of something else than text). Every well-formed answer the
//   supervisor gives is the App's: only a failed transport, another status
//   than 200 (a proxy's 504 too) or a body that isn't one makes the sandbox
//   unavailable (`SandboxUnavailableError`).
// - The supervisor itself is gone or stuck. Core gives up a little past the
//   longest the supervisor may take (the wait for a process, then the
//   deadline) on its own clock, which nothing in the sandbox can hold.
// - App code answers more than core should read. The supervisor bounds the
//   answer; the caller bounds what it takes from it.
// Only isolates with no env go to the sandbox host: a stub can't cross a
// process (workerd: "RpcStub cannot be serialized in this context").

/**
 * How long an untrusted call may run on the sandbox host before its process
 * is killed: the sandbox's CPU limit, which Cloudflare's runtime enforces.
 * Wall time is never less than CPU time, so on-prem is never looser.
 */
export const sandboxDeadlineMs = sandbox.limits.cpuMs;

/** How long a call may wait for a free sandbox process before it's refused. */
export const sandboxWaitMs = 3000;

/** How much longer than the supervisor may take core waits for its answer. */
const backstopMs = 2000;

/** What a sandboxed call reads from core's env (src/env.d.ts). */
export type SandboxedEnv = Pick<
  Env,
  | "LOADER"
  | "RUNTIME_PROFILE"
  | "SANDBOX_HOST"
  | "SANDBOX_DEADLINE_MS"
  | "SANDBOX_IN_PROCESS"
>;

/** The isolate a call runs in: no env and no network, whatever runs it. */
export interface SandboxedWorker {
  mainModule: string;
  modules: Record<string, string>;
}

/** The sandbox didn't answer, or can't run here: nothing the App's code did. */
export class SandboxUnavailableError extends Error {
  override name = "SandboxUnavailableError";
  /**
   * The status the sandbox host refused with, where it refused (503: no
   * room in its pool, or no process free in time); undefined otherwise.
   */
  readonly status: number | undefined;

  constructor(message: string, options?: ErrorOptions & { status?: number }) {
    super(message, options);
    this.status = options?.status;
  }
}

/** The call's deadline: {@link sandboxDeadlineMs}, or less where tests set it. */
const deadlineOf = (env: SandboxedEnv): number => {
  const set = Number(env.SANDBOX_DEADLINE_MS);
  return Number.isInteger(set) && set > 0 && set < sandboxDeadlineMs
    ? set
    : sandboxDeadlineMs;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Calls `method` on a stub, as an RPC stub answers any method name. */
const callStub = async (stub: unknown, method: string): Promise<unknown> => {
  const fn: unknown =
    isRecord(stub) || typeof stub === "function"
      ? Reflect.get(stub, method)
      : undefined;
  if (typeof fn !== "function") {
    throw new TypeError(`The entrypoint has no method ${method}.`);
  }
  return await Reflect.apply(fn, stub, []);
};

/**
 * What the supervisor answered for the App's code: its result, or an error
 * with why it failed (it threw, ran past its time, used too much memory,
 * crashed its process). Any well-formed answer is the App's, `ok: true`
 * with no value too: the caller refuses what isn't the result it wants.
 */
const answerOf = (body: unknown): unknown => {
  if (isRecord(body) && body.ok === true) {
    return body.value;
  }
  if (isRecord(body) && body.ok === false && typeof body.message === "string") {
    throw new Error(body.message);
  }
  throw new SandboxUnavailableError(
    "The sandbox host answered something else than a call's result."
  );
};

/** The call on the sandbox host, through the supervisor. */
const onHost = async (
  host: Fetcher,
  deadlineMs: number,
  worker: SandboxedWorker,
  entrypoint: string,
  method: string
): Promise<unknown> => {
  let response: Response;
  try {
    response = await host.fetch("http://sandbox/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [sandboxDeadlineHeader]: String(deadlineMs),
        [sandboxWaitHeader]: String(sandboxWaitMs),
      },
      // Only the code: the sandbox host sets everything else itself.
      body: JSON.stringify({
        worker: { mainModule: worker.mainModule, modules: worker.modules },
        entrypoint,
        method,
        args: [],
      }),
      signal: AbortSignal.timeout(sandboxWaitMs + deadlineMs + backstopMs),
    });
  } catch (error) {
    throw new SandboxUnavailableError("The sandbox host didn't answer.", {
      cause: error,
    });
  }
  // Only the supervisor's own answer speaks for the App's code: anything
  // else (its refusals, a proxy's 504) is the sandbox being unavailable.
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new SandboxUnavailableError(
      `The sandbox host answered ${response.status}.`
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new SandboxUnavailableError("The sandbox host's answer isn't JSON.", {
      cause: error,
    });
  }
  return answerOf(body);
};

/**
 * Refuses, with {@link SandboxUnavailableError}, to run `what` (App code
 * core loads itself and no sandbox bounds yet: a workflow's run, an App's
 * server object) except where the runtime bounds its CPU
 * (`RUNTIME_PROFILE` `cloudflare`) or the deployment accepts that nothing
 * does (`SANDBOX_IN_PROCESS=unbounded`). A bound `SANDBOX_HOST` doesn't
 * allow it: nothing runs this code on the sandbox host.
 */
export const requireBoundedHere = (
  env: Pick<Env, "RUNTIME_PROFILE" | "SANDBOX_IN_PROCESS">,
  what: string
): void => {
  if (
    env.RUNTIME_PROFILE !== "cloudflare" &&
    env.SANDBOX_IN_PROCESS !== "unbounded"
  ) {
    throw new SandboxUnavailableError(
      `No sandbox bounds ${what} here yet, not even with SANDBOX_HOST bound: run on Cloudflare, or set SANDBOX_IN_PROCESS=unbounded to accept that nothing bounds it.`
    );
  }
};

/**
 * The sandbox supervisor an isolate that reaches back into core runs on
 * (sandbox-session.ts), or undefined where the caller loads it itself: on
 * Cloudflare, whose runtime bounds its CPU, or where the deployment
 * accepts that nothing does (`SANDBOX_IN_PROCESS=unbounded`). Anywhere
 * else it refuses with {@link SandboxUnavailableError}, as for inspection.
 */
export const sessionHost = (
  env: Pick<Env, "RUNTIME_PROFILE" | "SANDBOX_HOST" | "SANDBOX_IN_PROCESS">
): Fetcher | undefined => {
  if (env.SANDBOX_HOST !== undefined) {
    return env.SANDBOX_HOST;
  }
  if (
    env.RUNTIME_PROFILE !== "cloudflare" &&
    env.SANDBOX_IN_PROCESS !== "unbounded"
  ) {
    throw new SandboxUnavailableError(
      "No sandbox bounds App code here: bind SANDBOX_HOST to the sandbox supervisor."
    );
  }
  return undefined;
};

/**
 * What `method` of `entrypoint` answers in an isolate of `worker`'s code,
 * with no env and no network: on the sandbox host where `SANDBOX_HOST` is
 * bound, within {@link sandboxDeadlineMs}; otherwise in a Loader isolate of
 * core's own, only where the runtime bounds its CPU (`RUNTIME_PROFILE`
 * `cloudflare`) or the deployment accepts that nothing does
 * (`SANDBOX_IN_PROCESS=unbounded`). Throws what the App's code threw, an
 * error saying why the sandbox ended it, or {@link SandboxUnavailableError}
 * if the sandbox didn't answer or can't run here.
 */
export const callSandboxed = async (
  env: SandboxedEnv,
  worker: SandboxedWorker,
  entrypoint: string,
  method: string
): Promise<unknown> => {
  const host = env.SANDBOX_HOST;
  if (host !== undefined) {
    return await onHost(host, deadlineOf(env), worker, entrypoint, method);
  }
  if (
    env.RUNTIME_PROFILE !== "cloudflare" &&
    env.SANDBOX_IN_PROCESS !== "unbounded"
  ) {
    throw new SandboxUnavailableError(
      "No sandbox bounds App code here: bind SANDBOX_HOST to the sandbox supervisor."
    );
  }
  const stub = env.LOADER.get(null, () => ({
    ...sandbox,
    ...worker,
    env: {},
  })).getEntrypoint(entrypoint);
  return await callStub(stub, method);
};
