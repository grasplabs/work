/**
 * The package builder, as it runs in its own isolate (a Dynamic Worker
 * core starts for each use, see `startPackageBuilder`): no bindings, no
 * network, no Node.js compatibility, and a CPU limit. It is handed npm
 * tarballs as bytes, checks each against its integrity hash, unpacks it
 * in memory and reads it; nothing it is handed ever runs. This is the
 * quarantine a package's bytes stay in until a person approved them.
 */
import type {
  PackageInspection,
  PackageLimits,
  PackageTarball,
} from "@grasp-os/shared/packages";
import { WorkerEntrypoint } from "cloudflare:workers";

import { inspectPackage } from "./inspect.ts";

/** What core asks the builder to inspect. */
export interface InspectRequest {
  limits: PackageLimits;
  packages: PackageTarball[];
}

export default class PackageBuilder extends WorkerEntrypoint {
  /**
   * Unpacks and reads each tarball, one after another, without running
   * any of it: what each says it needs, and why it can't be used.
   */
  // RPC exposes prototype methods only, so this can't be static.
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
}
