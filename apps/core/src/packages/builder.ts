import { packageBuilderCode, startPackageBuilder } from "@grasp-os/compiler";
import type { BuildRequest } from "@grasp-os/compiler";
import type { PackageLimits, PackageTarball } from "@grasp-os/shared/packages";

import {
  PlatformBoundError,
  platformWallMs,
  runPlatformCode,
} from "../platform-sandbox.ts";
import { functionCapability, inOrderReader } from "../sandbox-session.ts";
import { sessionHost } from "../sandboxed.ts";

// The package builder, wherever it runs: on Cloudflare in a Dynamic Worker
// of core's own, whose CPU the runtime bounds; on-prem on the sandbox host
// (platform-sandbox.ts), whose supervisor bounds it; nowhere else
// (`sessionHost` refuses). On the sandbox host a graph's tarballs and the
// artifact are larger than a session's message, so the builder reads the
// tarballs a chunk at a time, in order and once (`inOrderReader`), and
// writes the artifact's files back a chunk at a time, which core takes up
// to the artifact's limit and no further.

/** What the builder does for core: what resolve.ts and build.ts call. */
export interface PackageBuilderRun {
  /** Unpacks and reads `packages` (resolve.ts); throws as `run` does. */
  inspect: (
    limits: PackageLimits,
    packages: PackageTarball[]
  ) => Promise<unknown>;
  /** Builds one target of an approved lock (build.ts); throws as `run` does. */
  build: (request: BuildRequest) => Promise<unknown>;
}

/** How the runtime says it stopped an isolate over its limits. */
const overLimit = /exceeded (?:its )?(?:CPU|memory)/iu;

/**
 * The wall-clock time one call may take on the sandbox host, the reads of
 * its tarballs and the writes of its artifact included: past its CPU time
 * (30 s), which bounds the work.
 */
const builderWallMs = 60_000;

/** What the package builder reads from core's env. */
export type PackageBuilderEnv = Pick<
  Env,
  | "ASSETS"
  | "LOADER"
  | "RUNTIME_PROFILE"
  | "SANDBOX_DEADLINE_MS"
  | "SANDBOX_HOST"
  | "SANDBOX_IN_PROCESS"
>;

/** The tarballs as the sandbox host's isolate reads them: sizes, and a reader. */
const handedOver = (packages: readonly PackageTarball[]) => ({
  headers: packages.map(({ tarball, ...header }) => ({
    ...header,
    size: tarball.byteLength,
  })),
  read: functionCapability(
    inOrderReader(packages.map(({ key, tarball }) => [key, tarball] as const))
  ),
});

/**
 * A writer of the artifact's files, a chunk at a time, each appended to
 * its file's last: at most `maxBytes` together, refused past them.
 */
const artifactWriter = (maxBytes: number) => {
  const chunks = new Map<string, Uint8Array[]>();
  let written = 0;
  const write = (path: unknown, chunk: unknown): void => {
    if (
      typeof path !== "string" ||
      !(chunk instanceof Uint8Array) ||
      chunk.byteLength === 0
    ) {
      throw new TypeError("A chunk of the artifact isn't in its shape.");
    }
    written += chunk.byteLength;
    if (written > maxBytes) {
      throw new RangeError("The artifact is larger than it may be.");
    }
    const parts = chunks.get(path) ?? [];
    parts.push(chunk);
    chunks.set(path, parts);
  };
  /** The files written, by path: each one's chunks, in order, as one. */
  const files = (): Record<string, Uint8Array> =>
    Object.fromEntries(
      [...chunks].map(([path, parts]) => {
        const file = new Uint8Array(
          parts.reduce((total, part) => total + part.byteLength, 0)
        );
        let at = 0;
        for (const part of parts) {
          file.set(part, at);
          at += part.byteLength;
        }
        return [path, file];
      })
    );
  return { write, files };
};

/**
 * What the builder answered on the sandbox host for a build, its files
 * put back from what it wrote: a file it described and never wrote is
 * empty, which core's check of every file's hash then holds it to.
 */
const withWrittenFiles = (
  answer: unknown,
  files: Record<string, Uint8Array>
): unknown => {
  if (
    typeof answer !== "object" ||
    answer === null ||
    !("ok" in answer) ||
    answer.ok !== true ||
    !("artifact" in answer) ||
    typeof answer.artifact !== "object" ||
    answer.artifact === null ||
    !("files" in answer.artifact) ||
    typeof answer.artifact.files !== "object" ||
    answer.artifact.files === null
  ) {
    return answer;
  }
  const described = Object.keys(answer.artifact.files);
  return {
    ...answer,
    files: Object.fromEntries(
      described.map((path) => [path, files[path] ?? new Uint8Array()])
    ),
  };
};

/** The builder on the sandbox host: a session for each call. */
const onHost = (env: PackageBuilderEnv, host: Fetcher): PackageBuilderRun => {
  const wallMs = platformWallMs(env, builderWallMs);
  return {
    inspect: async (limits, packages) => {
      const { headers, read } = handedOver(packages);
      return await runPlatformCode(host, await packageBuilderCode(env.ASSETS), {
        method: "inspectRead",
        args: [{ value: limits }, { value: headers }, { capability: read }],
        wallMs,
      });
    },
    build: async (request) => {
      const { headers, read } = handedOver(request.packages);
      const writer = artifactWriter(request.limits.artifactBytes);
      const answer = await runPlatformCode(
        host,
        await packageBuilderCode(env.ASSETS),
        {
          method: "buildRead",
          args: [
            { value: { ...request, packages: headers } },
            { capability: read },
            { capability: functionCapability(writer.write) },
          ],
          wallMs,
        }
      );
      return withWrittenFiles(answer, writer.files());
    },
  };
};

/**
 * Throws what `run` threw, a stop at the isolate's limits as
 * {@link PlatformBoundError}, as the sandbox host's verdicts are.
 */
const boundedInCore = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && overLimit.test(error.message)) {
      throw new PlatformBoundError(error.message, { cause: error });
    }
    throw error;
  }
};

/** The builder in a Dynamic Worker of core's own, one per run, as before. */
const inCore = async (env: PackageBuilderEnv): Promise<PackageBuilderRun> => {
  const builder = await startPackageBuilder(env.LOADER, env.ASSETS);
  return {
    inspect: async (limits, packages) =>
      await boundedInCore(
        async () => await builder.inspect({ limits, packages })
      ),
    build: async (request) =>
      await boundedInCore(async () => await builder.build(request)),
  };
};

/**
 * Refuses, with `SandboxUnavailableError`, where nothing bounds the
 * builder: off Cloudflare without `SANDBOX_HOST`, unless the deployment
 * accepts that nothing does. Called before any tarball is fetched.
 */
export const requireBuilderBound = (env: PackageBuilderEnv): void => {
  sessionHost(env);
};

/**
 * The package builder for one resolve or build. Each call throws
 * {@link PlatformBoundError} when the builder was stopped at its bounds
 * (the packages' doing), `SandboxUnavailableError` when the sandbox had
 * no place for it, and what the builder threw otherwise.
 */
export const packageBuilder = async (
  env: PackageBuilderEnv
): Promise<PackageBuilderRun> => {
  const host = sessionHost(env);
  return host === undefined ? await inCore(env) : onHost(env, host);
};
