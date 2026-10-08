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

export default class PackageBuilder extends WorkerEntrypoint {
  /**
   * Unpacks and reads each tarball, one after another, without running
   * any of it: what each says it needs, and why it can't be used.
   */
  // RPC exposes prototype methods only, so these can't be static.
  // oxlint-disable-next-line class-methods-use-this
  async inspect({
    limits,
    packages,
  }: InspectRequest): Promise<PackageInspection[]> {
    const inspected: PackageInspection[] = [];
    for (const tarball of packages) {
      // One at a time: each holds its unpacked files in memory.
      // oxlint-disable-next-line no-await-in-loop
      inspected.push(await inspectPackage(tarball, limits));
    }
    return inspected;
  }

  /** Builds one target of an approved lock (build.ts). */
  // oxlint-disable-next-line class-methods-use-this
  async build(request: BuildRequest): Promise<PackageBuildAnswer> {
    return await buildTarget(request, esbuildWasm);
  }
}
