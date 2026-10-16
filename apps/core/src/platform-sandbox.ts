import {
  loadScreenCompiler,
  packageBuilderCode,
  platformCodeReadMs,
  screenCompilerCode,
  startPackageBuilder,
  startScreenCompiler,
} from "@grasp-os/compiler";
import type { PlatformCode } from "@grasp-os/compiler";

import {
  functionCapability,
  noPlaceOf,
  runInSession,
  sandboxVerdictOf,
  sessionCallMs,
} from "./sandbox-session.ts";
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
//   machine count) or a `crashed` process (the kernel's OOM killer, which
//   a full cgroup sends to any process) is never kept as the input's
//   verdict. A process that ended itself (V8 at its heap limit) is
//   `memory`: the supervisor tells the two apart by how it died.
// - On Cloudflare every App's screens compile in one warm, shared
//   isolate, whose limits are theirs together: one App's heavy builds
//   could get another's screen kept as failed. A stop there is tried once
//   more in a fresh isolate of the build's own, and only that is kept.
// - The input is made to stop the same way on Cloudflare and on-prem but
//   is judged differently, so one path recompiles a screen on every view
//   at 20 s of CPU, or refuses a package the other accepts. Both run
//   through one runner (`platformRunner`), whose stops map to the same
//   verdicts.
// - One shared build multiplies under load: every request waiting on one
//   that was cancelled starts its own. Waiters share one replacement
//   (`sharedRun`), and wait as long as the call's own bounds allow
//   (`PlatformRunner.callMs`).
// - Builds take every sandbox process, starving App code (or App code
//   starves builds). Each kind runs as one owner of its own
//   (`platform:builder`, `platform:extractor`), held to the supervisor's
//   per-owner share of the pool like any App; past it, or with the pool
//   full, the call is refused as the sandbox unavailable, before it
//   started (`noPlaceOf`), never as the input's fault.
// - One App's builds take the whole builder's share (many distinct
//   screens, or builds that run to their deadline, which isn't cached),
//   so every other App's are refused as busy. Each build names whose it
//   is (`platformRunner`'s `whose`, the App or independent workflow, from
//   core's own record), sent as the session's sub-owner; the supervisor
//   holds one sub-owner to part of its owner's share, places and waiting
//   room both (`maxPerSubOwner`, half of it, at least one), leaving the
//   rest to other Apps. A build with no place asks again within the
//   build wait (`askingForPlace`), so a save's three compiles wait for
//   the App's part rather than be refused. The part is per App, not per
//   author: an App's builders share it (accepted, GRA-563). Only core
//   reaches the supervisor's socket, so no
//   App names another's sub-owner. Enforced there rather than in core,
//   where builds run in many isolates and objects, and with no queue of
//   its own: the supervisor holds the places already.
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
 * How the runtime says it stopped a Loader isolate over its limits, and
 * nothing else: exactly "Worker exceeded CPU time limit." or "Worker
 * exceeded memory limit.", never a message that only mentions them (a
 * file a hostile tarball names, a path a compiler error quotes).
 */
const overLimit = /^Worker exceeded (?<limit>CPU time|memory) limit\.?$/u;

/** The verdict for each limit the runtime names. */
const limitVerdicts = new Map([
  ["CPU time", "cpu"],
  ["memory", "memory"],
]);

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
  const verdict = limitVerdicts.get(limit ?? "") ?? sandboxVerdictOf(error);
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
  /** Whose build it is, within that owner's share (an App's ID). */
  readonly subOwner?: string;
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
  { method, args, wallMs, owner, subOwner, memoryMib }: PlatformCall
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
      ...(subOwner === undefined ? {} : { subOwner }),
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

/** The release's platform code, run where it is bounded. */
export interface PlatformRunner {
  /**
   * Whether it runs in core's own Loader (Cloudflare), not on the sandbox
   * host: where a caller hands values rather than readers (builder.ts).
   */
  readonly inCore: boolean;
  /**
   * What `method` of `program` answers for `args`: values, and functions
   * the program may call back. Throws as {@link runPlatformCode} does,
   * wherever it runs.
   */
  readonly run: (
    program: PlatformProgram,
    method: string,
    args: readonly unknown[]
  ) => Promise<unknown>;
  /**
   * The longest one call of `program` may take here, from reading its code
   * to its end, every bound and wait included: how long something waiting
   * on another request's call waits before taking it for abandoned.
   */
  readonly callMs: (program: PlatformProgram) => number;
}

/**
 * What `method` of `entrypoint` answers for `args` in a Loader isolate,
 * a stop at the isolate's limits thrown as {@link PlatformBoundError}.
 */
const loaderCall = async (
  entrypoint: unknown,
  method: string,
  args: readonly unknown[]
): Promise<unknown> =>
  await boundedInCore(async () => await callStub(entrypoint, method, args));

/**
 * The runner in core's own Loader. The compiler runs warm in its named
 * isolate, which every App's builds share, so its limits are theirs
 * together: one heavy build beside another can stop both. A stop there is
 * tried once more in a fresh isolate of the build's own
 * (`loadScreenCompiler`), whose stop is the build's alone, and only that
 * is answered: a build is never kept as failed for what another did. The
 * builder runs in a fresh isolate per runner, so nothing one App's
 * packages leave in memory is there for the next, and its stops are its
 * own already.
 */
const inCore = (env: PlatformEnv): PlatformRunner => {
  let builder: ReturnType<typeof startPackageBuilder> | undefined;
  const compile = async (
    method: string,
    args: readonly unknown[]
  ): Promise<unknown> => {
    try {
      return await loaderCall(
        startScreenCompiler(env.LOADER, env.ASSETS),
        method,
        args
      );
    } catch (error) {
      if (!(error instanceof PlatformBoundError)) {
        throw error;
      }
      return await loaderCall(
        await loadScreenCompiler(env.LOADER, env.ASSETS),
        method,
        args
      );
    }
  };
  return {
    inCore: true,
    run: async (program, method, args) => {
      if (program === "compiler") {
        return await compile(method, args);
      }
      builder ??= startPackageBuilder(env.LOADER, env.ASSETS);
      return await loaderCall(await builder, method, args);
    },
    // No wall-clock bound in core: the runtime bounds each call's CPU.
    // Two calls at most (a compile tried again), each as long as one may
    // take on the sandbox host.
    callMs: (program) =>
      2 * (platformCodeReadMs + sessionCallMs(programWallMs[program])),
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

/** `args` as a session carries them: values, and functions as capabilities. */
const sessionArgs = (args: readonly unknown[]): SessionArgument[] =>
  args.map((arg) =>
    typeof arg === "function"
      ? {
          capability: functionCapability((...called: never[]): unknown =>
            Reflect.apply(arg, undefined, called)
          ),
        }
      : { value: arg }
  );

/**
 * How long a build asks again for a place in the builder's share while it
 * has none (`noPlaceOf`): as long as a caller waits for a build at most
 * (screens.ts, `buildWaitMs`), so a compile its own App's other builds
 * hold up waits its turn rather than fail.
 */
const placeWaitMs = 15_000;

/**
 * The longest one platform call waits for its place, every ask included
 * ({@link placeWaitMs}): what a caller that asks again past it counts as
 * one ask (app-tests.ts, a version's test build).
 */
export const platformPlaceWaitMs = placeWaitMs;

/** The longest a build waits between asks for a place. */
const placeRetryMs = 2000;

/**
 * The longest one ask may wait in the supervisor before it is refused: for
 * its owner's place, then for a process.
 */
const placeAskMs = 2 * sandboxWaitMs;

/**
 * Runs `build`, asking again while the supervisor has no place for it
 * (`noPlaceOf`: refused before anything ran, so nothing it was handed was
 * read), backing off up to {@link placeRetryMs}, for up to
 * {@link placeWaitMs}: the App's other builds (a save's other compiles,
 * or builds in other isolates) may hold its part of the share for a
 * moment. Holds nothing while it waits: a cancelled request's waits end
 * with it.
 */
const askingForPlace = async <T>(build: () => Promise<T>): Promise<T> => {
  const until = Date.now() + placeWaitMs;
  for (let wait = 250; ; wait = Math.min(wait * 2, placeRetryMs)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one ask at a time
      return await build();
    } catch (error) {
      // No ask starts that could still be waiting past the wait.
      if (!noPlaceOf(error) || Date.now() + wait + placeAskMs > until) {
        throw error;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- backing off between asks
    await scheduler.wait(wait);
  }
};

/**
 * The runner on the sandbox host: a session for each call, as
 * `platform:builder`, each of `whose` builds within its share, asking
 * again for a place while it has none. Nothing is queued in core: a
 * request workerd cancels never runs its continuations or `finally`
 * (@grasp-os/shared/shared-runs), so a queue here would wait for a build
 * that never ends; the supervisor's waiting room is the one queue.
 */
const onHost = (
  env: PlatformEnv,
  host: Fetcher,
  whose: string
): PlatformRunner => {
  const wallMs = (program: PlatformProgram): number =>
    platformWallMs(env, programWallMs[program]);
  return {
    inCore: false,
    run: async (program, method, args) => {
      const code = await programCode[program](env.ASSETS);
      const passed = sessionArgs(args);
      return await askingForPlace(
        async () =>
          await runPlatformCode(host, code, {
            method,
            args: passed,
            wallMs: wallMs(program),
            owner: builderOwner,
            subOwner: whose,
            memoryMib: builderMemoryMib,
          })
      );
    },
    // Its place waited for too, beyond one call's own bounds.
    callMs: (program) =>
      platformCodeReadMs + placeWaitMs + sessionCallMs(wallMs(program)),
  };
};

/**
 * The runner of the release's platform code for `env`, building for
 * `whose` (the App, or the independent workflow, whose build it is; core's
 * own record, never App code's word): on the sandbox host where
 * `SANDBOX_HOST` is bound, held to that sub-owner's part of the builder's
 * share (scripts/workerd-sandbox.ts, `maxPerSubOwner`), so one App's
 * builds never keep every other App's out; else in core's Loader where the
 * runtime bounds it (`sessionHost`). Throws `SandboxUnavailableError`, at
 * once, where nothing bounds it: before anything is read or fetched for it.
 */
export const platformRunner = (
  env: PlatformEnv,
  whose: string
): PlatformRunner => {
  const host = sessionHost(env);
  return host === undefined ? inCore(env) : onHost(env, host, whose);
};
