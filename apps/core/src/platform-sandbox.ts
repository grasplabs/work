import type { PlatformCode } from "@grasp-os/compiler";

import { runInSession, sandboxVerdictOf } from "./sandbox-session.ts";
import type { SessionArgument } from "./sandbox-session.ts";
import { SandboxUnavailableError } from "./sandboxed.ts";

// The screen compiler and the package builder on the on-prem sandbox host.
// Both read hostile input (an App's source; npm tarballs) without running
// it, in a Dynamic Worker whose CPU Cloudflare's runtime bounds. Plain
// workerd bounds nothing and runs a process's requests on one thread, so
// on-prem they run where App code runs: in a session on the sandbox host
// (sandbox-session.ts), whose supervisor (scripts/workerd-sandbox.ts)
// kills the process past its CPU time, memory or wall-clock time. Threat
// model, and how each is closed:
// - A type built to recurse holds TypeScript's checker for good, whatever
//   the source's size; a package (a decompression bomb, a vast graph, a
//   file that takes esbuild over) holds the builder or fills its memory.
//   The supervisor ends the call at its bound (its CPU time, its wall-clock
//   time, or `builderMemoryMib` of memory: more than App code gets, as
//   TypeScript needs it, and asked for by core alone) and kills its
//   process; core reads its verdict and refuses the build
//   (`PlatformBoundError`), and keeps serving meanwhile, as nothing of it
//   ran in core's process.
// - Builds take every sandbox process, starving App code (or App code
//   starves builds). Both run as one owner of their own,
//   `platform:builder`, held to the supervisor's per-owner share of the
//   pool like any App; past it, or with the pool full, a build is refused
//   as the sandbox unavailable (`busy`), not as the files' fault.
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
// keeps the compiler warm in its Loader (screens.ts).

/** What builds run as on the sandbox host: one owner of their own. */
export const builderOwner = "platform:builder";

/**
 * The resident memory a build's process may use, in MiB: what the
 * supervisor allows at most by default. TypeScript's checker, on plain
 * workerd with no heap limit to collect against, grows well past the
 * 128 MB Cloudflare's isolate holds it to: about 400 MB for one screen.
 */
const builderMemoryMib = 1024;

/**
 * The supervisor's verdicts that say the input made the platform code run
 * too long, use too much, crash or answer too much: no retry changes them.
 */
const boundVerdicts = new Set([
  "deadline",
  "cpu",
  "memory",
  "crashed",
  "refused",
]);

/** The sandbox ended a build for what it was handed: its own bound, and why. */
export class PlatformBoundError extends Error {
  override name = "PlatformBoundError";
}

/**
 * The wall-clock time a build may take on the sandbox host: `defaultMs`,
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
 * What `method` of `code`'s default entrypoint answers for `args`, run on
 * the sandbox host in a session of its own, as `platform:builder`. Throws
 * {@link PlatformBoundError} when the sandbox ended it at a bound,
 * {@link SandboxUnavailableError} when it had no place for it or didn't
 * answer, and whatever the platform code threw otherwise.
 */
export const runPlatformCode = async (
  host: Fetcher,
  code: PlatformCode,
  {
    method,
    args,
    wallMs,
  }: { method: string; args: readonly SessionArgument[]; wallMs: number }
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
      memoryMib: builderMemoryMib,
      owner: builderOwner,
    });
  } catch (error) {
    const verdict = sandboxVerdictOf(error);
    const message = error instanceof Error ? error.message : String(error);
    if (verdict !== undefined && boundVerdicts.has(verdict)) {
      throw new PlatformBoundError(message, { cause: error });
    }
    if (verdict === "busy") {
      // Its owner holds as many sessions as it may: nothing the input did.
      throw new SandboxUnavailableError(message, { cause: error, status: 429 });
    }
    throw error;
  }
};
