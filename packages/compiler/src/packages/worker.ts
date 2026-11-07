import { chunkBytes, readWhole } from "@grasp-os/shared/chunks";
import type { ChunkRead } from "@grasp-os/shared/chunks";
/**
 * The package builder, as it runs in its own isolate (a Dynamic Worker
 * core starts for each build, see `startPackageBuilder`): no bindings, no
 * network, no Node.js compatibility, and a CPU limit. It is handed an
 * approved lock and its tarballs, which core checked against the lock's
 * integrity, and bundles them (build.ts); nothing it is handed ever runs.
 *
 * esbuild is its WebAssembly build, loaded with the isolate as a compiled
 * module (`esbuild.wasm`, from core's static assets): this isolate can't
 * compile WebAssembly from bytes, and doesn't need to.
 */
import type {
  GraspLock,
  PackageBuildAnswer,
  PackageTarball,
} from "@grasp-os/shared/packages";
import { WorkerEntrypoint } from "cloudflare:workers";

import { assertNoBindings } from "../authority.ts";
import { buildLock } from "./build.ts";
import esbuildWasm from "./esbuild.wasm";

/** A tarball as the on-prem sandbox host hands it over: its size, not its bytes. */
export interface TarballHeader {
  key: string;
  size: number;
}

/** Writes the next chunk of entry `entry`'s module, at most `chunkBytes`. */
type WriteChunk = (entry: string, chunk: Uint8Array) => Promise<unknown>;

const encoder = new TextEncoder();

export default class PackageBuilder extends WorkerEntrypoint {
  /** Builds each entry of `lock` from `tarballs` (build.ts). */
  // RPC exposes prototype methods only, so these can't be static.
  async build(
    lock: GraspLock,
    tarballs: PackageTarball[]
  ): Promise<PackageBuildAnswer> {
    assertNoBindings(this.env, this.ctx.props, "The package builder");
    return await buildLock(lock, tarballs, esbuildWasm);
  }

  /**
   * `build`, with the tarballs read through `read` and each module written
   * back through `write`, a chunk at a time, on the on-prem sandbox host,
   * where one message carries neither (apps/core/src/packages/builder.ts):
   * the answer's modules are then empty.
   */
  async buildRead(
    lock: GraspLock,
    headers: TarballHeader[],
    read: ChunkRead,
    write: WriteChunk
  ): Promise<PackageBuildAnswer> {
    // Before a tarball is read: the isolate is checked as it is called.
    assertNoBindings(this.env, this.ctx.props, "The package builder");
    const tarballs: PackageTarball[] = [];
    for (const { key, size } of headers) {
      // In order: each tarball after the one before.
      // oxlint-disable-next-line no-await-in-loop
      tarballs.push({ key, tarball: await readWhole(read, key, size) });
    }
    const answer = await this.build(lock, tarballs);
    if (!answer.ok) {
      return answer;
    }
    const modules: Record<string, string> = {};
    for (const [entry, text] of Object.entries(answer.modules)) {
      const bytes = encoder.encode(text);
      for (let at = 0; at < bytes.byteLength; at += chunkBytes) {
        // In order: core appends each chunk to the module's last.
        // oxlint-disable-next-line no-await-in-loop
        await write(entry, bytes.slice(at, at + chunkBytes));
      }
      modules[entry] = "";
    }
    return { ok: true, modules };
  }
}
