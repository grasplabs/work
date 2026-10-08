import { z } from "zod";

import {
  canonicalGraph,
  dependencyMaxPackages,
  dependencyTargetSchema,
  exactVersionSchema,
  integritySchema,
  npmRegistryOrigin,
  packageNameSchema,
} from "./dependencies.ts";
import type {
  DependencyGraph,
  DependencyPackage,
  DependencyTarget,
} from "./dependencies.ts";
import { sha256Hex } from "./encoding.ts";
import { defineErrorFamily } from "./errors.ts";
import { appIdSchema } from "./ids.ts";
import { canonicalJson } from "./json.ts";

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
  "package.unsupported_source":
    "Packages come from the npm registry by version range only: no git, file, URL, alias or tag.",
  "package.unresolvable":
    "No version of a package meets what is asked of it and is at least three days old.",
  "package.peer_conflict":
    "A package needs another version of React, the UI kit or the SDK than the platform provides.",
  "package.quota": "The dependencies are larger than Grasp takes.",
  "package.refused":
    "A package needs something Grasp doesn't run: install scripts, native code, links or files outside itself.",
  "package.artifact_mismatch":
    "Building the packages made other files than the lock pinned for them.",
  "package.platform_changed":
    "The platform's React changed since these packages were resolved. Resolve them again.",
});

/**
 * How long a version must have been published before an App may newly
 * resolve to it: the repo's own rule for its dependencies. Versions
 * already in an App's approved lock stay usable.
 */
export const packageMaturityMs = 3 * 24 * 60 * 60 * 1000;

/**
 * How large an App's packages may be, from resolving to unpacking. Each is
 * measured on what is read or produced, never on what a package or the
 * registry says of itself. A deployment may set lower ones
 * (`packageLimitsOf`), never higher.
 */
export const packageLimits = {
  /** Longest chain of dependencies from a direct one. */
  graphDepth: 32,
  /** Packages in one graph. */
  graphPackages: dependencyMaxPackages,
  /**
   * Tarballs of one graph together, as fetched: all of them go to the
   * builder in one call, under the 32 MiB a Worker RPC message may be.
   */
  graphArchiveBytes: 24 * 1024 * 1024,
  /** What one package's tarball unpacks to (gzip's output). */
  extractedBytes: 64 * 1024 * 1024,
  /** Entries in one package's tarball. */
  extractedEntries: 20_000,
  /** What a whole graph's tarballs unpack to. */
  graphExtractedBytes: 256 * 1024 * 1024,
  /** Longest path in a tarball, in bytes, and most segments. */
  pathBytes: 1024,
  pathDepth: 64,
  /** The lock as core stores it. */
  lockBytes: 1024 * 1024,
  /** What one target's build makes, every file of it together. */
  artifactBytes: 16 * 1024 * 1024,
} as const;
export type PackageLimits = Record<keyof typeof packageLimits, number>;

const limitNames = Object.keys(packageLimits).filter(
  (name): name is keyof PackageLimits => Object.hasOwn(packageLimits, name)
);

/**
 * The limits a deployment set (`PACKAGE_LIMITS`, partial), each no higher
 * than the default: anything else is ignored.
 */
export const packageLimitsOf = (configured: unknown): PackageLimits => {
  const limits: PackageLimits = { ...packageLimits };
  if (typeof configured !== "object" || configured === null) {
    return limits;
  }
  for (const name of limitNames) {
    const value: unknown = Object.hasOwn(configured, name)
      ? Reflect.get(configured, name)
      : undefined;
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value > 0 &&
      value < limits[name]
    ) {
      limits[name] = value;
    }
  }
  return limits;
};

/**
 * The export conditions each target resolves a package's `exports` by,
 * in order: pinned in the lock, so a build reads the same files.
 */
export const targetConditions: Readonly<
  Record<DependencyTarget, readonly string[]>
> = {
  browser: ["browser", "import", "module", "default"],
  server: ["workerd", "worker", "import", "module", "default"],
  workflow: ["workerd", "worker", "import", "module", "default"],
  computation: ["workerd", "worker", "import", "module", "default"],
};

/**
 * What an App imports from its packages: a direct dependency's name, or
 * a subpath of it (`date-fns/format`), never a relative or absolute path.
 */
export const packageEntrySchema = z
  .string()
  .max(256)
  .regex(
    /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/u,
    "a package or one of its subpaths"
  );

/** The package an entry is of: `date-fns/format` is `date-fns`'s. */
export const entryPackage = (entry: string): string => {
  const segments = entry.split("/");
  return entry.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? entry);
};

/** What the source asks for: package.json's dependencies, and where they run. */
export const dependencyIntentSchema = z.strictObject({
  app: appIdSchema,
  sourceRevision: z.string().regex(/^[\w.:-]{1,128}$/u, "a source revision"),
  purpose: z.string().trim().min(1).max(500),
  targets: z
    .array(dependencyTargetSchema)
    .min(1)
    .refine((targets) => new Set(targets).size === targets.length, {
      message: "Each target once",
    }),
  /** package.json's `dependencies`: names and ranges. */
  dependencies: z
    .record(packageNameSchema, z.string().min(1).max(registryLimits.textLength))
    .refine((dependencies) => Object.keys(dependencies).length > 0, {
      message: "At least one dependency",
    })
    .refine(
      (dependencies) =>
        Object.keys(dependencies).length <= dependencyMaxPackages,
      { message: `At most ${dependencyMaxPackages} dependencies` }
    ),
  /**
   * What the App imports of them; each direct dependency's own name
   * unless given.
   */
  entries: z.array(packageEntrySchema).min(1).max(256).optional(),
});
export type DependencyIntent = z.input<typeof dependencyIntentSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

/** One package of the lock, by `name@version`. */
const lockedPackageSchema = z.strictObject({
  name: packageNameSchema,
  version: exactVersionSchema,
  integrity: integritySchema,
  license: z.string().min(1).max(128).nullable(),
  /** When the registry says it was published: why it was mature enough. */
  publishedAt: z.iso.datetime({ offset: true }),
  /** Each dependency's exact version, by name. */
  dependencies: z.record(packageNameSchema, exactVersionSchema),
  /**
   * Each peer: the range it states, and what meets it, the platform's
   * version or a package of the graph; null for an optional one unmet.
   */
  peers: z.record(
    packageNameSchema,
    z.strictObject({
      range: z.string().min(1).max(registryLimits.textLength),
      resolved: exactVersionSchema.nullable(),
      by: z.enum(["platform", "graph"]).nullable(),
    })
  ),
});
export type LockedPackage = z.infer<typeof lockedPackageSchema>;

/** What a target is built for: its export conditions and its entries. */
const targetConfigSchema = z.strictObject({
  conditions: z.array(z.string().max(32)).max(16),
  entries: z.array(packageEntrySchema).min(1).max(256),
});
export type TargetConfig = z.infer<typeof targetConfigSchema>;

/**
 * What one compiler built one target config to: the artifact's hash, the
 * file each entry resolved to, and when it was pinned (which pins are the
 * oldest, when there are too many to keep).
 */
const artifactPinSchema = z.strictObject({
  target: dependencyTargetSchema,
  hash: sha256Schema,
  exports: z.record(packageEntrySchema, z.string().max(1024)),
  pinnedAt: z.iso.datetime({ offset: true }),
});
export type ArtifactPin = z.infer<typeof artifactPinSchema>;

/**
 * `grasp.lock.json`: the exact graph an App's package.json resolved to.
 * Every package by exact version and integrity, each edge and peer
 * resolved, the platform's peers (never installed), and per target the
 * export conditions and entries a build resolves.
 */
export const graspLockSchema = z.strictObject({
  lockfileVersion: z.literal(1),
  registry: z.literal(npmRegistryOrigin),
  /** package.json's dependencies as they were resolved. */
  requested: z.record(packageNameSchema, z.string()),
  /** Each direct dependency's exact version. */
  direct: z.record(packageNameSchema, exactVersionSchema),
  platformPeers: z.record(packageNameSchema, exactVersionSchema),
  /**
   * Each target's config as the last resolve asked for it: what the next
   * build of the target builds.
   */
  targets: z.partialRecord(dependencyTargetSchema, targetConfigSchema),
  packages: z.record(z.string(), lockedPackageSchema),
  /**
   * What each target config was built to, by the compiler version that
   * built it and the config's hash (`targetConfigHash`, over the target,
   * its conditions and its entries). Pinned the first time a compiler
   * builds that config, and checked on every build of it after: the same
   * lock, config and compiler never make other bytes. A resolve that asks
   * for another config leaves every pin as it is; the new config gets its
   * own pin when it is built. Pins are dropped only when there are too
   * many to keep (build.ts), and the build that drops one records which.
   */
  artifacts: z
    .record(z.string().max(64), z.record(sha256Schema, artifactPinSchema))
    .optional(),
});
export type GraspLock = z.infer<typeof graspLockSchema>;

/**
 * The hash that names a target's config: of the target, its export
 * conditions and its entries, so a pin is only ever for the config it was
 * built from.
 */
export const targetConfigHash = async (
  target: DependencyTarget,
  config: TargetConfig
): Promise<string> =>
  await sha256Hex(
    canonicalJson({
      target,
      conditions: config.conditions,
      entries: config.entries,
    })
  );

/**
 * The graph a person approves, from a lock: what its hash names. With the
 * platform peers the lock itself names, the ones it was resolved against,
 * so a lock always hashes to the graph that was approved; whether those
 * are still this release's is the build's to check (`package.platform_changed`).
 */
export const lockGraph = (lock: GraspLock): DependencyGraph =>
  canonicalGraph({
    direct: Object.entries(lock.direct).map(([name, version]) => ({
      name,
      version,
    })),
    packages: Object.values(lock.packages).map((entry): DependencyPackage => ({
      name: entry.name,
      version: entry.version,
      origin: npmRegistryOrigin,
      integrity: entry.integrity,
      license: entry.license,
      dependencies: Object.entries(entry.dependencies).map(
        ([name, version]) => ({ name, version })
      ),
      peers: Object.entries(entry.peers).map(([name, peer]) => ({
        name,
        range: peer.range,
        resolved: peer.resolved,
      })),
    })),
    platformPeers: { ...lock.platformPeers },
  });

/**
 * What the package builder found in one tarball, unpacked in its own
 * isolate without running anything: its package.json's own say on what
 * it needs, and every reason it can't be used.
 */
export const packageInspectionSchema = z.strictObject({
  key: z.string(),
  /** Bytes unpacked and entries read. */
  bytes: z.int().nonnegative(),
  entries: z.int().nonnegative(),
  /** What its package.json says, when it could be read. */
  manifest: z
    .strictObject({
      name: z.string(),
      version: z.string(),
      dependencies: z.record(z.string(), z.string()),
      optionalDependencies: z.record(z.string(), z.string()),
      peerDependencies: z.record(z.string(), z.string()),
      /** Peers its package.json marks optional (`peerDependenciesMeta`). */
      optionalPeers: z.array(z.string()).max(256),
    })
    .nullable(),
  /** Why it can't be used: empty when nothing was found. */
  refusals: z.array(z.string().max(200)).max(16),
});
export type PackageInspection = z.infer<typeof packageInspectionSchema>;

/** One tarball for the builder, checked against `integrity` again there. */
export interface PackageTarball {
  key: string;
  name: string;
  version: string;
  integrity: string;
  tarball: Uint8Array;
}

/**
 * What a build of one target made, as the builder describes it: each
 * entry's module and stylesheet, the platform modules it imports, and
 * every file with its SHA-256, size and type. Core checks every hash
 * against the bytes before it keeps any.
 */
export const packageArtifactSchema = z.strictObject({
  target: dependencyTargetSchema,
  conditions: z.array(z.string().max(32)).max(16),
  entries: z.record(
    packageEntrySchema,
    z.strictObject({
      module: z.string().max(300).nullable(),
      css: z.string().max(300).nullable(),
      /** The file of the package it resolved to: `name@version/path`. */
      resolved: z.string().max(1024),
    })
  ),
  imports: z.array(z.string().max(64)).max(16),
  files: z.record(
    z.string().max(300),
    z.strictObject({
      sha256: sha256Schema,
      bytes: z.int().nonnegative(),
      type: z.string().max(64),
    })
  ),
});
export type PackageArtifact = z.infer<typeof packageArtifactSchema>;

/** How long a build took and how much it held, as the builder measured it. */
export const packageBuildStatsSchema = z.strictObject({
  /** The time esbuild took to start, and to build, in ms. */
  initializeMs: z.number().nonnegative(),
  buildMs: z.number().nonnegative(),
  /** esbuild's WebAssembly memory after the build, in bytes. */
  wasmMemoryBytes: z.int().nonnegative(),
  /** Files and bytes the build read from the packages. */
  inputFiles: z.int().nonnegative(),
  inputBytes: z.int().nonnegative(),
});
export type PackageBuildStats = z.infer<typeof packageBuildStatsSchema>;

/** What the builder answers a build with. */
export const packageBuildAnswerSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    artifact: packageArtifactSchema,
    files: z.record(
      z.string(),
      z.custom<Uint8Array>((value) => value instanceof Uint8Array)
    ),
    stats: packageBuildStatsSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    refusals: z.array(z.string().max(500)).min(1).max(50),
  }),
]);
export type PackageBuildAnswer = z.infer<typeof packageBuildAnswerSchema>;

/** What a build of an approved graph asks for. */
export const packageBuildRequestSchema = z.strictObject({
  app: appIdSchema,
  graphHash: z.string().regex(/^[0-9a-f]{64}$/u),
  target: dependencyTargetSchema,
  /** The dependency policy generation the caller read. */
  policyGeneration: z.int().nonnegative(),
});
export type PackageBuildRequest = z.input<typeof packageBuildRequestSchema>;

/**
 * Where core serves the files of an App's browser artifacts, each under
 * the artifact's address (`PackageBuild.address`), and nothing else.
 */
export const packageArtifactPath = "/package-artifacts";

/** Whether `pathname` is on the artifact path, a file of one or not. */
export const isPackageArtifactPath = (pathname: string): boolean =>
  pathname === packageArtifactPath ||
  pathname.startsWith(`${packageArtifactPath}/`);

/** A built target, as core keeps it: the artifact, by its hash. */
export interface PackageBuild {
  hash: string;
  artifact: PackageArtifact;
  /** The approval the build relied on. */
  approval: string;
  stats: PackageBuildStats | null;
  /**
   * For the browser target, where its files are served for the next few
   * hours: a path on this deployment ending in `/`, each file at its own
   * path under it. Null for the other targets, which never leave core.
   */
  address: string | null;
}
