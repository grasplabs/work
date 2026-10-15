import type { BuildRequest } from "@grasp-os/compiler";
import { packageErrors } from "@grasp-os/shared/packages";
import type { PackageLimits, PackageTarball } from "@grasp-os/shared/packages";

import { PlatformBoundError, platformRunner } from "../platform-sandbox.ts";
import type { PlatformEnv } from "../platform-sandbox.ts";
import { functionCapability, inOrderReader } from "../sandbox-session.ts";
import { SandboxUnavailableError, sessionHost } from "../sandboxed.ts";

// The package builder, wherever it runs (platform-sandbox.ts): on
// Cloudflare in a Dynamic Worker of core's own, whose CPU the runtime
// bounds; on-prem on the sandbox host, whose supervisor bounds it; nowhere
// else (`sessionHost` refuses). On the sandbox host a graph's tarballs and
// the artifact are larger than a session's message, so the builder reads
// the tarballs a chunk at a time, in order and once (`inOrderReader`), and
// writes the artifact's files back a chunk at a time, which core takes up
// to the artifact's limit and no further. It does the same in core's
// Loader, so both run one code path and are judged the same.

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

/** What the package builder reads from core's env. */
export type PackageBuilderEnv = PlatformEnv;

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

/**
 * `error`, which a builder's call threw, as resolve.ts and build.ts throw
 * it: a stop the packages reach whatever the load refuses them, for
 * `refusal`; one the load can cause (the deadline, a process killed) is
 * the sandbox unavailable, to try again, never the packages' fault;
 * anything else as it came.
 */
export const builderFailure = (error: unknown, refusal: string): unknown => {
  if (!(error instanceof PlatformBoundError)) {
    return error;
  }
  if (error.own) {
    return packageErrors.create("package.refused", { refusals: [refusal] });
  }
  return new SandboxUnavailableError(
    `The package builder was stopped before it finished: ${error.message}`,
    { cause: error }
  );
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
 * The package builder for one resolve or build, wherever the runner runs
 * it (platform-sandbox.ts): the same methods either way, the tarballs
 * read and the artifact written back a chunk at a time. Each call throws
 * {@link PlatformBoundError} when the builder was stopped at its bounds
 * (`own` when the packages reach it whatever the load),
 * `SandboxUnavailableError` when the sandbox had no place for it, and
 * what the builder threw otherwise.
 */
export const packageBuilder = (env: PackageBuilderEnv): PackageBuilderRun => {
  const run = platformRunner(env);
  return {
    inspect: async (limits, packages) => {
      const { headers, read } = handedOver(packages);
      return await run("package-builder", "inspectRead", [
        { value: limits },
        { value: headers },
        { capability: read },
      ]);
    },
    build: async (request) => {
      const { headers, read } = handedOver(request.packages);
      const writer = artifactWriter(request.limits.artifactBytes);
      const answer = await run("package-builder", "buildRead", [
        { value: { ...request, packages: headers } },
        { capability: read },
        { capability: functionCapability(writer.write) },
      ]);
      return withWrittenFiles(answer, writer.files());
    },
  };
};
