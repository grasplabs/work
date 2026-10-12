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
//   kills the process whose call runs past {@link sandboxDeadlineMs} and
//   answers 504: a refusal of the App's code, as if it had thrown.
// - The supervisor itself is gone or stuck. Core gives up a little past the
//   deadline on its own clock, which nothing in the sandbox can hold, and
//   says the sandbox is unavailable (`SandboxUnavailableError`), which
//   isn't the App's fault.
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

/** How much longer than the deadline core waits for the supervisor's answer. */
const backstopMs = 2000;

/** The header core gives a call's deadline in, in milliseconds. */
export const sandboxDeadlineHeader = "x-grasp-sandbox-deadline-ms";

/** What a sandboxed call reads from core's env (src/env.d.ts). */
export type SandboxedEnv = Pick<
  Env,
  "LOADER" | "SANDBOX_HOST" | "SANDBOX_DEADLINE_MS"
>;

/** The isolate a call runs in: no env and no network, whatever runs it. */
export interface SandboxedWorker {
  mainModule: string;
  modules: Record<string, string>;
}

/** The sandbox host didn't answer: nothing the App's code did. */
export class SandboxUnavailableError extends Error {
  override name = "SandboxUnavailableError";
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

/** What the sandbox host answers a call: its result, or why it threw. */
const answerOf = (body: unknown): unknown => {
  if (isRecord(body) && body.ok === true && "value" in body) {
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
      },
      body: JSON.stringify({
        worker: {
          compatibilityDate: sandbox.compatibilityDate,
          compatibilityFlags: sandbox.compatibilityFlags,
          limits: sandbox.limits,
          mainModule: worker.mainModule,
          modules: worker.modules,
        },
        entrypoint,
        method,
        args: [],
      }),
      signal: AbortSignal.timeout(deadlineMs + backstopMs),
    });
  } catch (error) {
    throw new SandboxUnavailableError("The sandbox host didn't answer.", {
      cause: error,
    });
  }
  if (response.status === 504) {
    await response.body?.cancel();
    // The App's code, refused as anything else it threw.
    throw new Error(`The App's code ran past its time (${deadlineMs} ms).`);
  }
  if (!response.ok) {
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
 * What `method` of `entrypoint` answers in an isolate of `worker`'s code,
 * with no env and no network: in a Loader isolate of core's own where the
 * runtime bounds its CPU (Cloudflare, or wherever `SANDBOX_HOST` isn't
 * bound), or on the sandbox host within {@link sandboxDeadlineMs}. Throws
 * what the App's code threw, an error saying it ran past its time past the
 * deadline, or {@link SandboxUnavailableError} if the sandbox host didn't answer.
 */
export const callSandboxed = async (
  env: SandboxedEnv,
  worker: SandboxedWorker,
  entrypoint: string,
  method: string
): Promise<unknown> => {
  const host = env.SANDBOX_HOST;
  if (host === undefined) {
    const stub = env.LOADER.get(null, () => ({
      ...sandbox,
      ...worker,
      env: {},
    })).getEntrypoint(entrypoint);
    return await callStub(stub, method);
  }
  return await onHost(host, deadlineOf(env), worker, entrypoint, method);
};
