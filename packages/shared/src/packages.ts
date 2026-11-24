import { z } from "zod";

import {
  dependencyMaxPackages,
  exactVersionSchema,
  integritySchema,
  npmRegistryOrigin,
  packageNameSchema,
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
  /** The registry's answer of advisories for one graph, as sent (GRA-699). */
  advisoryBytes: 4 * 1024 * 1024,
  /** Most advisories connect passes on for one package. */
  advisoriesPerPackage: 1000,
  /** OSV.dev's answer for one graph's versions, as sent (GRA-749). */
  osvBytes: 4 * 1024 * 1024,
  /** Most OSV entries one version may carry on one page, as OSV sends. */
  osvEntriesPerVersion: 1000,
  /** Most pages of OSV's answer asked for one graph. */
  osvPages: 5,
  /** Most OSV entries read for one graph, over every page. */
  osvEntries: 20_000,
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

/**
 * What to look up advisories for (GRA-699): each package of a graph by
 * name, with its exact versions; at most a graph's packages in all.
 */
export const npmAdvisoriesRequestSchema = z
  .record(
    packageNameSchema,
    z.array(exactVersionSchema).min(1).max(dependencyMaxPackages)
  )
  .refine(
    (asked) =>
      Object.values(asked).reduce(
        (all, versions) => all + versions.length,
        0
      ) <= dependencyMaxPackages,
    { message: `At most ${dependencyMaxPackages} versions` }
  );
export type NpmAdvisoriesRequest = z.infer<typeof npmAdvisoriesRequestSchema>;

/** The severities the registry's advisories carry, as findings do. */
export const advisorySeverities = [
  "info",
  "low",
  "moderate",
  "high",
  "critical",
] as const;

/**
 * One advisory the registry knows for a package, as connect passes it on:
 * which one (its GitHub advisory ID, or the registry's own number), how
 * grave, its title, and the range of versions it affects, which core
 * holds each version to. Nothing else of what the registry sends.
 */
export const npmAdvisorySchema = z.strictObject({
  id: z.string().min(1).max(128),
  severity: z.enum(advisorySeverities),
  title: z.string().min(1).max(300),
  vulnerableVersions: z.string().min(1).max(registryLimits.textLength),
  /**
   * Whether it reports the package as malware: classified CWE-506,
   * Embedded Malicious Code, the closest the registry's bulk answer comes
   * to a malware verdict (it carries no type). Core refuses a graph with
   * a version it affects (GRA-699, Nick's decision of 2026-10-19).
   */
  malware: z.boolean(),
});
export type NpmAdvisory = z.infer<typeof npmAdvisorySchema>;

/** The advisories of each package asked about, by name: only those. */
export type NpmAdvisories = Record<string, NpmAdvisory[]>;

/**
 * An OpenSSF malicious-packages report (`MAL-2026-12435`), as OSV.dev
 * names one, the way connect passes it on (GRA-749): the ID alone, in
 * the form OSV gives every `MAL-` entry.
 */
export const malwareReportIdSchema = z.string().regex(/^MAL-\d{4}-\d{1,12}$/u);

/**
 * The versions OSV.dev reports as malware (GRA-749), among those asked:
 * each with the report that says so. None, when it reports none.
 */
export const npmMalwareReportsSchema = z
  .array(
    z.strictObject({
      name: packageNameSchema,
      version: exactVersionSchema,
      id: malwareReportIdSchema,
    })
  )
  .max(dependencyMaxPackages * 16);
export type NpmMalwareReports = z.infer<typeof npmMalwareReportsSchema>;

/** The registry, as connect reaches it for core. */
export interface PackageRegistryApi {
  /** A package's metadata, or `package.not_found`. */
  npmMetadata: (name: string) => Promise<NpmMetadata>;
  /**
   * One version's tarball, whose SHA-512 is `integrity`: its bytes, or
   * `package.integrity_mismatch` when the registry sent others.
   */
  npmTarball: (request: NpmTarballRequest) => Promise<Uint8Array>;
  /**
   * The advisories the registry knows for the packages `request` names
   * (GRA-699), or `package.registry_unavailable`: never an empty answer
   * for one it couldn't read. `package.advisories_unchecked` for a request
   * naming `constructor`, which the registry never answers.
   */
  npmAdvisories: (request: NpmAdvisoriesRequest) => Promise<NpmAdvisories>;
  /**
   * The versions `request` names that OSV.dev reports as malware
   * (GRA-749), or `package.malware_unchecked`: never an empty answer for
   * one it couldn't read.
   */
  npmMalwareReports: (
    request: NpmAdvisoriesRequest
  ) => Promise<NpmMalwareReports>;
}

/** Why fetching, resolving or building a package was refused. */
export const packageErrors = defineErrorFamily({
  "package.invalid": "That isn't a package name, version or integrity hash.",
  "package.not_found": "The registry has no such package or version.",
  "package.registry_unavailable":
    "The package registry couldn't be reached. Try again in a minute.",
  "package.registry_busy":
    "Too many packages are being read from the registry at once. Try again in a moment.",
  "package.redirect_refused":
    "The registry sent the request somewhere other than the registry.",
  "package.too_large": "The package is larger than Grasp takes.",
  "package.malware_unchecked":
    "Known malware couldn't be checked: OSV.dev couldn't be reached or answered unreadably. Try again in a minute.",
  "package.advisories_unchecked":
    "Advisories can't be checked for constructor: the npm registry refuses to answer for a package of that name.",
  "package.integrity_mismatch":
    "The registry sent other bytes than the package's integrity hash names.",
  "package.unsupported_source":
    "Packages come from the npm registry by version range only: no repository, file, URL, alias or tag.",
  "package.unresolvable":
    "No version of a package meets what is asked of it and is at least three days old.",
  "package.quota": "The dependencies are larger than Grasp takes.",
  "package.refused": "The packages couldn't be built.",
});

/**
 * How long a version must have been published before it is resolved to:
 * the repo's own rule for its dependencies (pnpm's `minimumReleaseAge`).
 */
export const packageMaturityMs = 3 * 24 * 60 * 60 * 1000;

/**
 * What one build holds, in the package builder's 128 MB isolate: past
 * these a build is refused with a reason rather than stopped by the
 * runtime.
 */
export const packageLimits = {
  /** A graph's tarballs together, as fetched: one call's values. */
  archiveBytes: 24 * 1024 * 1024,
  /** What they unpack to, together. */
  extractedBytes: 40 * 1024 * 1024,
} as const;

/**
 * What code imports of its packages: a direct dependency's name, or a
 * subpath of it (`date-fns/format`), never a relative or absolute path.
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

/** What the source asks for: its dependencies, and why. */
export const dependencyIntentSchema = z
  .strictObject({
    /** Whose they are: an App's. */
    app: appIdSchema,
    purpose: z.string().trim().min(1).max(500),
    /**
     * package.json's `dependencies`: each name and its range, as pairs,
     * never an object keyed by name. Grasp's RPC (Cap'n Web) deletes every
     * key an object inherits from Object.prototype as it decodes one, so
     * a dependency named `constructor` would vanish on the way in.
     */
    dependencies: z
      .array(
        z.strictObject({
          name: packageNameSchema,
          range: z.string().min(1).max(registryLimits.textLength),
        })
      )
      .max(dependencyMaxPackages)
      .refine(
        (pairs) => new Set(pairs.map(({ name }) => name)).size === pairs.length,
        { message: "Each dependency once" }
      ),
    /** What the code imports of them; each dependency's own name unless given. */
    entries: z.array(packageEntrySchema).min(1).max(256).optional(),
    /**
     * Packages of the approved set to take out, by name. Everything else
     * approved stays: a request adds to the set.
     */
    remove: z.array(packageNameSchema).max(dependencyMaxPackages).optional(),
  })
  .refine(
    ({ dependencies, remove }) =>
      dependencies.length > 0 || (remove?.length ?? 0) > 0,
    { message: "Ask for a package or remove one", path: ["dependencies"] }
  );
export type DependencyIntent = z.input<typeof dependencyIntentSchema>;

/** One package of a lock, by `name@version`. */
const lockedPackageSchema = z.strictObject({
  name: packageNameSchema,
  version: exactVersionSchema,
  integrity: integritySchema,
  license: z.string().min(1).max(128).nullable(),
  /** When the registry says it was published: why it was mature enough. */
  publishedAt: z.iso.datetime({ offset: true }),
  /**
   * The exact version each of its dependencies and required peers
   * resolved to, by name: peers are installed, as npm 7 and later do.
   */
  dependencies: z.record(packageNameSchema, exactVersionSchema),
});
export type LockedPackage = z.infer<typeof lockedPackageSchema>;

/**
 * `grasp.lock.json`: the exact graph a source's dependencies resolved to.
 * Every package by exact version and integrity, with each edge resolved,
 * and the entries the code imports. What an approval names, by its hash
 * (`graspLockHash`): any other package, version, byte, edge or entry is
 * another graph.
 */
export const graspLockSchema = z
  .strictObject({
    lockfileVersion: z.literal(2),
    registry: z.literal(npmRegistryOrigin),
    /** The dependencies as they were asked for. */
    requested: z.record(packageNameSchema, z.string()),
    /** Each direct dependency's exact version. */
    direct: z.record(packageNameSchema, exactVersionSchema),
    entries: z.array(packageEntrySchema).max(256),
    packages: z.record(z.string(), lockedPackageSchema),
  })
  .superRefine(({ direct, packages }, context) => {
    // Closed: every edge leads to a package of the lock, so a build never
    // reaches one nobody approved.
    const edges = [
      ...Object.entries(direct),
      ...Object.values(packages).flatMap((entry) =>
        Object.entries(entry.dependencies)
      ),
    ];
    for (const [name, version] of edges) {
      if (!Object.hasOwn(packages, `${name}@${version}`)) {
        context.addIssue({
          code: "custom",
          path: ["packages"],
          message: `${name}@${version} isn't a package of the lock`,
        });
      }
    }
    if (Object.keys(packages).length > dependencyMaxPackages) {
      context.addIssue({
        code: "custom",
        path: ["packages"],
        message: `At most ${dependencyMaxPackages} packages`,
      });
    }
  });
export type GraspLock = z.infer<typeof graspLockSchema>;

/**
 * What names a lock, and so a graph: the SHA-256 of its canonical JSON,
 * but for the ranges it was asked with, which install nothing: the same
 * packages asked for by other ranges are the same graph. It says which
 * graph, never that the graph is safe.
 */
export const graspLockHash = async ({
  requested: _ranges,
  ...graph
}: GraspLock): Promise<string> => await sha256Hex(canonicalJson(graph));

/** One tarball for the builder, by its `name@version`. */
export interface PackageTarball {
  key: string;
  tarball: Uint8Array;
}

/**
 * What the builder answers a build with: each entry's module, and why
 * each entry that doesn't build for its target doesn't; or why nothing
 * could be read.
 */
export const packageBuildAnswerSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    modules: z.record(packageEntrySchema, z.string()),
    refused: z.record(packageEntrySchema, z.array(z.string().max(500)).max(50)),
  }),
  z.strictObject({
    ok: z.literal(false),
    refusals: z.array(z.string().max(500)).min(1).max(50),
  }),
]);
export type PackageBuildAnswer = z.infer<typeof packageBuildAnswerSchema>;
