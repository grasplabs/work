import {
  packageBuilderCode,
  screenCompilerCode,
  startPackageBuilder,
  startScreenCompiler,
} from "@grasp-os/compiler";
import type { PlatformCode } from "@grasp-os/compiler";

import { runInSession, sandboxVerdictOf } from "./sandbox-session.ts";
import type { SessionArgument } from "./sandbox-session.ts";
import {
  callStub,
  SandboxUnavailableError,
  sandboxWaitMs,
  sessionHost,
} from "./sandboxed.ts";

// The release's platform code (the screen compiler, the package builder,
// the file extractor), which reads hostile input (an App's source; npm
// tarballs; uploads) without running it, run where it is bounded: on
// Cloudflare in a Dynamic Worker of core's own, whose CPU and memory the
// runtime bounds; on-prem in a session on the sandbox host
// (sandbox-session.ts), whose supervisor (scripts/workerd-sandbox.ts)
// kills the process past its CPU time, memory or wall-clock time. Plain
// workerd bounds nothing in core and runs a process's requests on one
// thread, so it never runs in core's own process there. Threat model, and
// how each is closed:
// - A type built to recurse holds TypeScript's checker for good, whatever
//   the source's size; a package (a decompression bomb, a vast graph, a
//   file that takes esbuild over) holds the builder or fills its memory.
//   The runtime or the supervisor ends the call at its bound (its CPU
//   time, its wall-clock time, or `builderMemoryMib` of memory: more than
//   App code gets, as TypeScript needs it, and asked for by core alone),
//   and core reads why (`stopOf`, the one mapping of a stop to a verdict
//   wherever it ran) as a `PlatformBoundError`, and keeps serving
//   meanwhile, as nothing of it ran in core's process.
// - A stop the load caused is taken for the input's fault, and kept: a
//   screen pinned as failed until the next release, a package refused.
//   Only `cpu`, `memory` and `refused` are the input's own, whatever the
//   load (`PlatformBoundError.own`); a `deadline` (waits for the shared
//   machine count) or a `crashed` process (the shared cgroup or the kernel
//   can kill it under load) is never kept as the input's verdict.
// - The input is made to stop the same way on Cloudflare and on-prem but
//   is judged differently, so one path recompiles a screen on every view
//   at 20 s of CPU, or refuses a package the other accepts. Both run
//   through one runner (`platformRunner`), the same methods with the same
//   arguments, whose stops map to the same verdicts.
// - Builds take every sandbox process, starving App code (or App code
//   starves builds). Each kind runs as one owner of its own
//   (`platform:builder`, `platform:extractor`), held to the supervisor's
//   per-owner share of the pool like any App; past it, or with the pool
//   full, the call is refused as the sandbox unavailable, before it
//   started (`noPlaceOf`), never as the input's fault.
// - One owner's build reaches another's, or an App's code. One call per
//   process, killed once the session ends: nothing a build leaves in
//   memory is there for the next call, whoever's it is. The isolate gets
//   no env and no network, as App code doesn't.
// - The platform code is far larger than a session's message (the compiler
//   and what it knows of the kit, about 15 MB; esbuild's WebAssembly, about
//   12 MB), and not all JavaScript. Core hands it over as its sizes and the
//   sandbox host reads it a chunk at a time, in order and once
//   (`inOrderReader`); it takes only so many modules, and only so much
//   (on-prem/sandbox-session.ts). The one flag a call may add is
//   `nodejs_compat`, which the compiler needs.
// Chosen over keeping the platform modules on the sandbox host itself, to
// stay warm: with one call per process nothing stays warm across builds,
// and holding them there would put the compiler in every process of the
// pool (App code's too), and tie the supervisor to the release's build
// output. Handing them over on a local socket costs milliseconds; loading
// the compiler, about a second per build that isn't cached. Cloudflare
// keeps the compiler warm in its Loader (`startScreenCompiler`).

/** What builds run as on the sandbox host: one owner of their own. */
export const builderOwner = "platform:builder";

/**
 * The resident memory a build's process may use, in MiB: what the
 * supervisor allows at most by default. TypeScript's checker, on plain
 * workerd with no heap limit to collect against, grows well past the
 * 128 MB Cloudflare's isolate holds it to: about 400 MB for one screen.
 */
const builderMemoryMib = 1024;

/** The verdicts the input reaches whatever the load: no retry changes them. */
const ownVerdicts = new Set(["cpu", "memory", "refused"]);

/** The verdicts the load can make the input reach: tried again, never kept. */
const loadVerdicts = new Set(["deadline", "crashed"]);

/** The sandbox ended platform code for what it was handed: its own bound, and why. */
export class PlatformBoundError extends Error {
  override name = "PlatformBoundError";
  /**
   * Which bound: `cpu`, `memory` or `refused` (it answered or sent more
   * than a session takes), which the input reaches whatever the load; or
   * `deadline` (wall-clock time) or `crashed`, which the load can make it
   * reach.
   */
  readonly verdict: string;
  /** Whether the input reaches it whatever the load: a verdict to keep. */
  readonly own: boolean;

  constructor(message: string, options: ErrorOptions & { verdict: string }) {
    super(message, options);
    this.verdict = options.verdict;
    this.own = ownVerdicts.has(options.verdict);
  }
}

/**
 * Whether the sandbox refused a call before any of it ran, for want of a
 * place: its owner at its share (`busy`, or 429 once `runPlatformCode`
 * said so), or the pool full (503).
 */
export const noPlaceOf = (error: unknown): boolean =>
  sandboxVerdictOf(error) === "busy" ||
  (error instanceof SandboxUnavailableError &&
    !error.started &&
    (error.status === 429 || error.status === 503));

/**
 * The wall-clock time a call may take on the sandbox host: `defaultMs`,
 * or less where tests set `SANDBOX_DEADLINE_MS`.
 */
export const platformWallMs = (
  env: Pick<Env, "SANDBOX_DEADLINE_MS">,
  defaultMs: number
): number => {
  const set = Number(env.SANDBOX_DEADLINE_MS);
  return Number.isInteger(set) && set > 0 && set < defaultMs ? set : defaultMs;
};

/**
 * How the runtime says it stopped a Loader isolate over its limits:
 * "Worker exceeded CPU time limit." or "… memory limit."
 */
const overLimit = /exceeded (?:its )?(?<limit>CPU|memory)/iu;

/**
 * What `error`, which ended a call of platform code, says of how it was
 * stopped: the {@link PlatformBoundError} or the place refused, or
 * `error` itself when it wasn't stopped (the code threw). `inCore` for a
 * call in core's own Loader, where only the runtime's message says it; a
 * message never counts on the sandbox host, where the supervisor's
 * verdict does and the code's own message could say anything.
 */
const stopOf = (error: unknown, inCore: boolean): unknown => {
  const message = error instanceof Error ? error.message : String(error);
  const limit = inCore ? overLimit.exec(message)?.groups?.limit : undefined;
  const verdict = limit?.toLowerCase() ?? sandboxVerdictOf(error);
  if (
    verdict !== undefined &&
    (ownVerdicts.has(verdict) || loadVerdicts.has(verdict))
  ) {
    return new PlatformBoundError(message, { cause: error, verdict });
  }
  if (verdict === "busy") {
    // Its owner holds as many sessions as it may: nothing the input did,
    // and refused before anything ran.
    return new SandboxUnavailableError(message, {
      cause: error,
      status: 429,
      started: false,
    });
  }
  return error;
};

/**
 * What `call` answers, a call of platform code in a Loader isolate of
 * core's own: a stop at the isolate's limits thrown as
 * {@link PlatformBoundError}, as the sandbox host's are.
 */
export const boundedInCore = async (
  call: () => Promise<unknown>
): Promise<unknown> => {
  try {
    return await call();
  } catch (error) {
    throw stopOf(error, true);
  }
};

/** Platform code as the sandbox host runs it, and as whom. */
export interface PlatformCall {
  readonly method: string;
  readonly args: readonly SessionArgument[];
  readonly wallMs: number;
  /** Who it runs as: an owner of the platform's own (`builderOwner`). */
  readonly owner: string;
  /** Its process's memory, where it needs more than App code gets. */
  readonly memoryMib?: number;
}

/**
 * What `method` of `code`'s default entrypoint answers for `args`, run on
 * the sandbox host in a session of its own. Throws
 * {@link PlatformBoundError} when the sandbox ended it at a bound,
 * {@link SandboxUnavailableError} when it had no place for it (429,
 * `started: false`) or didn't answer, and whatever the platform code
 * threw otherwise.
 */
export const runPlatformCode = async (
  host: Fetcher,
  code: PlatformCode,
  { method, args, wallMs, owner, memoryMib }: PlatformCall
): Promise<unknown> => {
  try {
    return await runInSession(host, {
      mainModule: code.mainModule,
      modules: {},
      platformModules: code.modules,
      nodejsCompat: code.nodejsCompat,
      entrypoint: "default",
      method,
      args,
      cpuMs: code.cpuMs,
      wallMs,
      ...(memoryMib === undefined ? {} : { memoryMib }),
      owner,
    });
  } catch (error) {
    throw stopOf(error, false);
  }
};

/** The platform programs a runner runs, by name. */
export type PlatformProgram = "compiler" | "package-builder";

/**
 * The wall-clock time a call of each program may take on the sandbox host,
 * loading it included: past its CPU time (20 s and 30 s), which bounds
 * the work. The compiler's is past the build wait too (screens.ts), so a
 * late build still lands in the cache; the builder's takes in the reads
 * of its tarballs and the writes of its artifact.
 */
const programWallMs: Record<PlatformProgram, number> = {
  compiler: 30_000,
  "package-builder": 60_000,
};

/** How much longer than its wall-clock time a call may take, waits included. */
const callMarginMs = sandboxWaitMs + 2000;

/**
 * The longest one call of `program` may take, from asking for a place to
 * its answer: what something waiting on it waits at most.
 */
export const platformCallMs = (
  env: Pick<Env, "SANDBOX_DEADLINE_MS">,
  program: PlatformProgram
): number => platformWallMs(env, programWallMs[program]) + callMarginMs;

/** What a runner reads from core's env. */
export type PlatformEnv = Pick<
  Env,
  | "ASSETS"
  | "LOADER"
  | "RUNTIME_PROFILE"
  | "SANDBOX_DEADLINE_MS"
  | "SANDBOX_HOST"
  | "SANDBOX_IN_PROCESS"
>;

/**
 * Runs `method` of `program` with `args`, wherever the runner runs it.
 * Throws as {@link runPlatformCode} does, wherever that is.
 */
export type PlatformRun = (
  program: PlatformProgram,
  method: string,
  args: readonly SessionArgument[]
) => Promise<unknown>;

/** `args` as a Loader isolate takes them: values, and functions as RPC stubs. */
const loaderArgs = (args: readonly SessionArgument[]): unknown[] =>
  args.map((arg) => {
    if ("value" in arg) {
      return arg.value;
    }
    const call: unknown = Reflect.get(arg.capability.target, "call");
    if (!arg.capability.function || typeof call !== "function") {
      throw new TypeError(
        "Platform code takes only functions as capabilities."
      );
    }
    return call;
  });

/**
 * The runner in core's own Loader: the compiler warm in its named isolate,
 * the builder in a fresh one per runner, so nothing one App's packages
 * leave in memory is there for the next.
 */
const inCore = (env: PlatformEnv): PlatformRun => {
  let builder: ReturnType<typeof startPackageBuilder> | undefined;
  const entrypointOf = async (program: PlatformProgram): Promise<unknown> => {
    if (program === "compiler") {
      return startScreenCompiler(env.LOADER, env.ASSETS);
    }
    builder ??= startPackageBuilder(env.LOADER, env.ASSETS);
    return await builder;
  };
  return async (program, method, args) => {
    const entrypoint = await entrypointOf(program);
    return await boundedInCore(
      async () => await callStub(entrypoint, method, loaderArgs(args))
    );
  };
};

/** The code of each program, as the sandbox host loads it. */
const programCode: Record<
  PlatformProgram,
  (assets: Fetcher) => Promise<PlatformCode>
> = {
  compiler: screenCompilerCode,
  "package-builder": packageBuilderCode,
};

/** The runner on the sandbox host: a session for each call, as `platform:builder`. */
const onHost =
  (env: PlatformEnv, host: Fetcher): PlatformRun =>
  async (program, method, args) =>
    await runPlatformCode(host, await programCode[program](env.ASSETS), {
      method,
      args,
      wallMs: platformWallMs(env, programWallMs[program]),
      owner: builderOwner,
      memoryMib: builderMemoryMib,
    });

/**
 * The runner of the release's platform code for `env`: on the sandbox host
 * where `SANDBOX_HOST` is bound, else in core's Loader where the runtime
 * bounds it (`sessionHost`). Throws `SandboxUnavailableError`, at once,
 * where nothing bounds it: before anything is read or fetched for it.
 */
export const platformRunner = (env: PlatformEnv): PlatformRun => {
  const host = sessionHost(env);
  return host === undefined ? inCore(env) : onHost(env, host);
};
