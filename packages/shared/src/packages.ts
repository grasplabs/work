import { z } from "zod";

import {
  exactVersionSchema,
  integritySchema,
  packageNameSchema,
} from "./dependencies.ts";
import { defineErrorFamily } from "./errors.ts";

// npm packages as the registry has them, as connect fetches them for core.
// Connect is the only part of Grasp that talks to the registry: core asks
// it for a package's metadata and for one version's tarball by its
// integrity hash, and gets back data it checks again. What a package's
// metadata or bytes say is the package's own words, never instructions.

/** What connect reads of the registry, at most, per answer. */
export const registryLimits = {
  /**
   * A package's metadata (its "packument"), as sent: React's is about
   * 7 MB, TypeScript's 16. Measured on the bytes read, never on what a
   * Content-Length says.
   */
  metadataBytes: 24 * 1024 * 1024,
  /** One version's tarball, as sent. */
  archiveBytes: 16 * 1024 * 1024,
  /** Redirects followed, each within the registry's own origin. */
  redirects: 3,
  /** Versions of one package connect passes on, newest kept. */
  versions: 5000,
  /** Longest dependency range or other text of a version kept. */
  textLength: 256,
  /** Most dependencies, peers or optional dependencies a version may list. */
  edges: 256,
} as const;

/** A dependency as a version lists it: the range, or whatever it names. */
const rangesSchema = z.record(
  packageNameSchema,
  z.string().max(registryLimits.textLength)
);

/**
 * One version of a package, as connect passes it on: what resolving and
 * reviewing it needs, nothing of its README or other text.
 */
export const npmVersionSchema = z.strictObject({
  version: exactVersionSchema,
  /** When the registry says it was published (ISO 8601); null when it doesn't. */
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Its tarball's SHA-512; null when the registry has none (only SHA-1). */
  integrity: integritySchema.nullable(),
  /** The licence it reports, as it reports it; null when none. */
  license: z.string().min(1).max(128).nullable(),
  dependencies: rangesSchema,
  optionalDependencies: rangesSchema,
  peerDependencies: rangesSchema,
  /** Peers it marks optional (`peerDependenciesMeta`). */
  optionalPeers: z.array(packageNameSchema).max(registryLimits.edges),
  /** Whether it bundles dependencies inside its own tarball. */
  bundlesDependencies: z.boolean(),
  /**
   * Install scripts its metadata names (`preinstall`, `install`,
   * `postinstall`), or `hasInstallScript` when the registry only says
   * there are some. The tarball's own package.json is checked too.
   */
  installScripts: z.array(z.string().max(32)).max(8),
  /** Whether it builds native code (`gypfile`, a binding.gyp). */
  gypfile: z.boolean(),
  /** Platforms it limits itself to (`os`, `cpu`); empty for any. */
  os: z.array(z.string().max(32)).max(32),
  cpu: z.array(z.string().max(32)).max(32),
  /** Whether its publisher deprecated it. */
  deprecated: z.boolean(),
});
export type NpmVersion = z.infer<typeof npmVersionSchema>;

/** A package's metadata as connect passes it on. */
export const npmMetadataSchema = z.strictObject({
  name: packageNameSchema,
  versions: z.array(npmVersionSchema).max(registryLimits.versions),
});
export type NpmMetadata = z.infer<typeof npmMetadataSchema>;

/** One version's tarball, as core asks connect for it: by its integrity. */
export const npmTarballRequestSchema = z.strictObject({
  name: packageNameSchema,
  version: exactVersionSchema,
  integrity: integritySchema,
});
export type NpmTarballRequest = z.infer<typeof npmTarballRequestSchema>;

/** The registry, as connect reaches it for core. */
export interface PackageRegistryApi {
  /** A package's metadata, or `package.not_found`. */
  npmMetadata: (name: string) => Promise<NpmMetadata>;
  /**
   * One version's tarball, whose SHA-512 is `integrity`: its bytes, or
   * `package.integrity_mismatch` when the registry sent others.
   */
  npmTarball: (request: NpmTarballRequest) => Promise<Uint8Array>;
}

/** Why fetching, unpacking, resolving or building a package was refused. */
export const packageErrors = defineErrorFamily({
  "package.invalid": "That isn't a package name, version or integrity hash.",
  "package.not_found": "The registry has no such package or version.",
  "package.registry_unavailable":
    "The package registry couldn't be reached. Try again in a minute.",
  "package.redirect_refused":
    "The registry sent the request somewhere other than the registry.",
  "package.too_large": "The package is larger than Grasp takes.",
  "package.integrity_mismatch":
    "The registry sent other bytes than the package's integrity hash names.",
});
