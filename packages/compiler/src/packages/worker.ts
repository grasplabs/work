import { chunkBytes, readWhole } from "@grasp-os/shared/chunks";
import type { ChunkRead } from "@grasp-os/shared/chunks";
/**
 * The package builder, as it runs in its own isolate (a Dynamic Worker
 * core starts for each use, see `startPackageBuilder`): no bindings, no
 * network, no Node.js compatibility, and a CPU limit. It is handed npm
 * tarballs as bytes, checks each against its integrity hash, unpacks it
 * in memory and reads or bundles it; nothing it is handed ever runs. This
 * is the quarantine a package's bytes stay in until a person approved
 * them, and where approved ones are built.
 *
 * esbuild is its WebAssembly build, loaded with the isolate as a compiled
 * module (`esbuild.wasm`, from core's static assets): this isolate can't
 * compile WebAssembly from bytes, and doesn't need to.
 */
import type {
  PackageBuildAnswer,
  PackageInspection,
  PackageLimits,
  PackageTarball,
} from "@grasp-os/shared/packages";
import { WorkerEntrypoint } from "cloudflare:workers";

import { assertNoBindings } from "../authority.ts";
import { buildTarget } from "./build.ts";
import type { BuildRequest } from "./build.ts";
import esbuildWasm from "./esbuild.wasm";
import { inspectPackage } from "./inspect.ts";

/** What core asks the builder to inspect. */
export interface InspectRequest {
  limits: PackageLimits;
  packages: PackageTarball[];
}

export type { BuildRequest } from "./build.ts";

/** A tarball as the on-prem sandbox host hands it over: its size, not its bytes. */
export type TarballHeader = Omit<PackageTarball, "tarball"> & { size: number };

/**
 * Writes the next chunk of the artifact's file at `path`, at most
 * `chunkBytes` of it.
 */
type WriteChunk = (path: string, chunk: Uint8Array) => Promise<unknown>;

/** The most tarballs one request may hand over. */
const maxHeaders = 10_000;

/**
 * Each tarball `headers` names, read through `read` a chunk at a time,
 * whole and in order. A chunk that isn't bytes, is empty or runs past the
 * tarball's size fails the call, as a tarball that doesn't match its
 * integrity would.
 */
const readTarballs = async (
  headers: readonly TarballHeader[],
  read: ChunkRead
): Promise<PackageTarball[]> => {
  if (headers.length > maxHeaders) {
    throw new TypeError("The tarballs aren't in the expected shape.");
  }
  const tarballs: PackageTarball[] = [];
  for (const { key, name, version, integrity, size } of headers) {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new TypeError(`The tarball of ${key} has no size.`);
    }
    // In order: each tarball after the one before.
    // oxlint-disable-next-line no-await-in-loop
    const tarball = await readWhole(read, key, size);
    tarballs.push({ key, name, version, integrity, tarball });
  }
  return tarballs;
};

export default class PackageBuilder extends WorkerEntrypoint {
  /**
   * Unpacks and reads each tarball, one after another, without running
   * any of it: what each says it needs, and why it can't be used.
   */
  // RPC exposes prototype methods only, so these can't be static.
  async inspect({
    limits,
    packages,
  }: InspectRequest): Promise<PackageInspection[]> {
    assertNoBindings(this.env, "The package builder");
    const inspected: PackageInspection[] = [];
    for (const tarball of packages) {
      // One at a time: each holds its unpacked files in memory.
      // oxlint-disable-next-line no-await-in-loop
      inspected.push(await inspectPackage(tarball, limits));
    }
    return inspected;
  }

  /** Builds one target of an approved lock (build.ts). */
  async build(request: BuildRequest): Promise<PackageBuildAnswer> {
    assertNoBindings(this.env, "The package builder");
    return await buildTarget(request, esbuildWasm);
  }

  /**
   * `inspect`, with the tarballs read through `read`: on the on-prem
   * sandbox host, where one message can't carry both this module and a
   * graph's tarballs (apps/core/src/packages/builder.ts).
   */
  async inspectRead(
    limits: PackageLimits,
    headers: TarballHeader[],
    read: ChunkRead
  ): Promise<PackageInspection[]> {
    return await this.inspect({
      limits,
      packages: await readTarballs(headers, read),
    });
  }

  /**
   * `build`, with the tarballs read through `read` and the artifact's
   * files written back through `write`, a chunk at a time: what it answers
   * has no files of its own, as the artifact may be larger than a
   * message.
   */
  async buildRead(
    request: Omit<BuildRequest, "packages"> & { packages: TarballHeader[] },
    read: ChunkRead,
    write: WriteChunk
  ): Promise<PackageBuildAnswer> {
    const answer = await this.build({
      ...request,
      packages: await readTarballs(request.packages, read),
    });
    if (!answer.ok) {
      return answer;
    }
    for (const [path, bytes] of Object.entries(answer.files)) {
      for (let at = 0; at < bytes.byteLength; at += chunkBytes) {
        // In order: core appends each chunk to the file's last.
        // oxlint-disable-next-line no-await-in-loop
        await write(path, bytes.slice(at, at + chunkBytes));
      }
    }
    return { ...answer, files: {} };
  }
}
