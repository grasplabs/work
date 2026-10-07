import {
  platformPeers,
  platformScope,
  startPackageBuilder,
} from "@grasp-os/compiler";
import {
  canonicalGraph,
  dependencyErrors,
  dependencyGraphHash,
  npmRegistryOrigin,
  packageKey,
} from "@grasp-os/shared/dependencies";
import type {
  DependencyGraph,
  DependencyPackage,
  DependencyRequest,
} from "@grasp-os/shared/dependencies";
import { canonicalJson } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import {
  dependencyIntentSchema,
  entryPackage,
  graspLockSchema,
  packageErrors,
  packageInspectionSchema,
  packageLimitsOf,
  packageMaturityMs,
  targetConditions,
} from "@grasp-os/shared/packages";
import type {
  GraspLock,
  LockedPackage,
  NpmMetadata,
  NpmVersion,
  PackageInspection,
  PackageLimits,
  PackageTarball,
} from "@grasp-os/shared/packages";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import rcompare from "semver/functions/rcompare";
import satisfies from "semver/functions/satisfies";
import validRange from "semver/ranges/valid";
import { z } from "zod";

import { appFor } from "../apps.ts";
import type { Acting } from "../auth/identity.ts";
import { dependencyLocks, dependencyRequests } from "../db/core/schema.ts";
import { proposeDependencies } from "../dependencies/requests.ts";
import { verifiedTarball } from "./tarballs.ts";

// Resolving what an App's package.json asks for into one exact graph, and
// proposing it for a person's approval (dependencies/requests.ts). Every
// byte comes from the npm registry through connect; every tarball is
// unpacked and read in the package builder's isolate, which has no
// network and runs nothing. Nothing resolved here is usable: the graph is
// a pending request until a person approves it, and only then can a
// build use it (admitDependencies). What could go wrong, and what stops
// it:
//
// - Sources other than the registry: git, file, URL, alias (`npm:`),
//   workspace and tag specs are refused, in the App's package.json and in
//   every package's own dependencies (`package.unsupported_source`).
// - A brand-new release, perhaps a compromised one: a version is newly
//   resolved to only once it has been published for three days, and only
//   with a SHA-512 integrity. Versions already in the App's approved lock
//   stay usable (`package.unresolvable`).
// - A second React, UI kit or SDK: the platform's React and React DOM
//   meet every dependency and peer on them, or the graph is refused; a
//   package in the platform's own scope (`@grasp-os/`) is someone else's
//   on the registry, and refused (`package.peer_conflict`).
// - A graph too deep, too wide or too heavy: depth and package count are
//   checked as it grows, tarball bytes as they are fetched and unpacked
//   bytes as the builder reports them (`package.quota`).
// - A package that needs install scripts, native code, links, files
//   outside itself or bundled packages, or whose tarball says other
//   dependencies than the registry's metadata: refused, every reason
//   listed (`package.refused`).
// - Registry credentials or a package manager reaching an agent: there is
//   no shell here, no credentials, and the agent gets only this function's
//   result.

/** Most metadata requests to connect at once. */
const metadataConcurrency = 6;

/** Most bytes of tarballs handed to the builder in one call. */
const inspectBatchBytes = 8 * 1024 * 1024;

/** Most refusals one resolve reports. */
const maxRefusals = 50;

/** How the runtime says it stopped an isolate over its limits. */
const overLimit = /exceeded (?:its )?(?:CPU|memory)/iu;

/**
 * Refusals as they are found, each once, keeping the first
 * `maxRefusals`: never every one of a large graph's.
 */
interface Refusals {
  add: (refusal: string) => void;
  readonly kept: ReadonlySet<string>;
  /** How many were found, kept or not. */
  total: () => number;
}

const refusalCollector = (): Refusals => {
  const kept = new Set<string>();
  let total = 0;
  return {
    add: (refusal) => {
      total += 1;
      if (kept.size < maxRefusals) {
        kept.add(refusal);
      }
    },
    kept,
    total: () => total,
  };
};

/** A package resolved into the graph, while the graph is being built. */
interface Node {
  name: string;
  version: string;
  integrity: string;
  publishedAt: string;
  meta: NpmVersion;
  depth: number;
  dependencies: Map<string, string>;
  peers: Map<string, LockedPackage["peers"][string]>;
}

/** One dependency or peer still to resolve, from the package that asks. */
interface Edge {
  name: string;
  range: string;
  depth: number;
  /** The package that asks; undefined for the App's own package.json. */
  from: Node | undefined;
  kind: "dependency" | "peer";
}

/** Runs `tasks` at most `limit` at a time, in order. */
const limited = async <T>(
  items: readonly string[],
  limit: number,
  task: (item: string) => Promise<T>
): Promise<void> => {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      // One at a time per worker: the limit is the number of workers.
      // oxlint-disable-next-line no-await-in-loop
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
};

/** The range a dependency is asked by, or refused if it isn't one. */
const registryRange = (name: string, range: string, from?: Node): string => {
  if (validRange(range) === null) {
    throw packageErrors.create("package.unsupported_source", {
      package: from ? packageKey(from) : "package.json",
      dependency: name,
      spec: range.slice(0, 128),
    });
  }
  return range;
};

/** A dependency's ranges without those npm leaves out as optional. */
const requiredDependencies = (meta: {
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}): Record<string, string> =>
  Object.fromEntries(
    Object.entries(meta.dependencies).filter(
      ([name]) => !Object.hasOwn(meta.optionalDependencies, name)
    )
  );

/** Why a version can't be resolved to newly, or undefined if it can. */
const immature = (version: NpmVersion, now: number): string | undefined => {
  if (version.integrity === null) {
    return "has no SHA-512 integrity";
  }
  if (version.publishedAt === null) {
    return "has no publication time";
  }
  return Date.parse(version.publishedAt) > now - packageMaturityMs
    ? "was published less than three days ago"
    : undefined;
};

/** What the registry says about a version, to refuse it for. */
const metadataRefusals = (version: NpmVersion): string[] => [
  ...(version.installScripts.length > 0
    ? [`it has install scripts: ${version.installScripts.join(", ")}`]
    : []),
  ...(version.gypfile ? ["it builds native code (binding.gyp)"] : []),
  ...(version.os.length > 0 || version.cpu.length > 0
    ? ["it runs only on some operating systems or processors"]
    : []),
  ...(version.bundlesDependencies
    ? ["it bundles packages the graph doesn't name"]
    : []),
];

/** One resolve's state: the graph so far, and what it read. */
class Resolution {
  readonly nodes = new Map<string, Node>();
  /** Each of package.json's dependencies the graph resolved, by name. */
  readonly direct = new Map<string, string>();
  readonly #metadata = new Map<string, Promise<NpmMetadata>>();
  readonly #env: Env;
  readonly #limits: PackageLimits;
  readonly #previous: GraspLock | undefined;
  readonly #now = Date.now();

  constructor(
    env: Env,
    limits: PackageLimits,
    previous: GraspLock | undefined
  ) {
    this.#env = env;
    this.#limits = limits;
    this.#previous = previous;
  }

  /** A package's metadata, asked of connect once per resolve. */
  async metadataOf(name: string): Promise<NpmMetadata> {
    let metadata = this.#metadata.get(name);
    if (metadata === undefined) {
      metadata = this.#env.CONNECT.npmMetadata(name);
      this.#metadata.set(name, metadata);
    }
    return await metadata;
  }

  /** The highest version of `name` in the graph that meets `range`. */
  #inGraph(name: string, range: string): Node | undefined {
    return [...this.nodes.values()]
      .filter((node) => node.name === name && satisfies(node.version, range))
      .toSorted((a, b) => rcompare(a.version, b.version))[0];
  }

  /**
   * The version to resolve `name` to: the App's approved lock's, if it
   * has one that meets the range; otherwise the highest that meets it and
   * is mature.
   */
  async #choose(
    name: string,
    range: string
  ): Promise<{ version: NpmVersion; integrity: string; publishedAt: string }> {
    const { versions } = await this.metadataOf(name);
    const meeting = versions
      .filter((version) => satisfies(version.version, range))
      .toSorted((a, b) => rcompare(a.version, b.version));
    const [locked] = Object.values(this.#previous?.packages ?? {})
      .filter((entry) => entry.name === name && satisfies(entry.version, range))
      .toSorted((a, b) => rcompare(a.version, b.version));
    const kept = meeting.find(
      (version) =>
        version.version === locked?.version &&
        version.integrity === locked.integrity
    );
    if (kept && locked) {
      return {
        version: kept,
        integrity: locked.integrity,
        publishedAt: kept.publishedAt ?? locked.publishedAt,
      };
    }
    for (const version of meeting) {
      if (
        immature(version, this.#now) === undefined &&
        version.integrity !== null &&
        version.publishedAt !== null
      ) {
        return {
          version,
          integrity: version.integrity,
          publishedAt: version.publishedAt,
        };
      }
    }
    const [newest] = meeting;
    throw packageErrors.create("package.unresolvable", {
      package: name,
      range: range.slice(0, 128),
      reason:
        newest === undefined
          ? "no version meets the range"
          : `${packageKey({ name, version: newest.version })} ${immature(newest, this.#now) ?? ""}`,
    });
  }

  /** Adds `version` of `name` to the graph, with the edges it brings. */
  #add(
    name: string,
    chosen: { version: NpmVersion; integrity: string; publishedAt: string },
    depth: number
  ): {
    node: Node;
    edges: Edge[];
  } {
    const { version } = chosen;
    if (this.nodes.size >= this.#limits.graphPackages) {
      throw packageErrors.create("package.quota", {
        quota: "graphPackages",
        limit: this.#limits.graphPackages,
      });
    }
    const node: Node = {
      name,
      version: version.version,
      integrity: chosen.integrity,
      publishedAt: chosen.publishedAt,
      meta: version,
      depth,
      dependencies: new Map(),
      peers: new Map(),
    };
    this.nodes.set(packageKey(node), node);
    const required = requiredDependencies(version);
    const edges: Edge[] = [
      ...Object.entries(required).map(([dependency, range]) => ({
        name: dependency,
        range,
        depth: depth + 1,
        from: node,
        kind: "dependency" as const,
      })),
      ...Object.entries(version.peerDependencies).map(([peer, range]) => ({
        name: peer,
        range,
        depth,
        from: node,
        kind: "peer" as const,
      })),
    ];
    return { node, edges };
  }

  /**
   * Resolves one edge: to the platform's own package, to a version
   * already in the graph, or to a new one. Returns the edges a new
   * package brings.
   */
  async resolve(edge: Edge): Promise<Edge[]> {
    const { name, from, kind } = edge;
    const asking = from ? packageKey(from) : "package.json";
    if (name.startsWith(platformScope)) {
      throw packageErrors.create("package.peer_conflict", {
        package: asking,
        peer: name,
        reason: "the platform's own scope is never an npm package",
      });
    }
    const range = registryRange(name, edge.range, from);
    const optional =
      kind === "peer" && (from?.meta.optionalPeers.includes(name) ?? false);
    const platform = Object.hasOwn(platformPeers, name)
      ? platformPeers[name]
      : undefined;
    if (platform !== undefined) {
      if (!satisfies(platform, range)) {
        throw packageErrors.create("package.peer_conflict", {
          package: asking,
          peer: name,
          range: range.slice(0, 128),
          platform,
        });
      }
      this.#record(edge, platform, "platform");
      return [];
    }
    if (optional) {
      // An optional peer is met only by what the graph has anyway
      // (`completeOptionalPeers`), never added for it.
      return [];
    }
    const existing = this.#inGraph(name, range);
    if (existing) {
      this.#record(edge, existing.version, "graph");
      return [];
    }
    if (kind === "peer") {
      // A peer is shared with whoever else uses the package, as npm
      // resolves it: a version the graph has that doesn't meet the range
      // is a conflict (npm's ERESOLVE), never a second copy for the peer.
      const other = [...this.nodes.values()].find((node) => node.name === name);
      if (other) {
        throw packageErrors.create("package.peer_conflict", {
          package: asking,
          peer: name,
          range: range.slice(0, 128),
          graph: other.version,
        });
      }
    }
    if (edge.depth > this.#limits.graphDepth) {
      throw packageErrors.create("package.quota", {
        quota: "graphDepth",
        limit: this.#limits.graphDepth,
      });
    }
    const chosen = await this.#choose(name, range);
    // Another edge of this level may have added a version that meets it.
    const raced = this.#inGraph(name, range);
    if (raced) {
      this.#record(edge, raced.version, "graph");
      return [];
    }
    const { node, edges } = this.#add(name, chosen, edge.depth);
    this.#record(edge, node.version, "graph");
    return edges;
  }

  #record(
    { name, range, from, kind }: Edge,
    version: string,
    by: "platform" | "graph"
  ): void {
    if (from === undefined) {
      if (by === "graph") {
        this.direct.set(name, version);
      }
      return;
    }
    if (kind === "dependency") {
      from.dependencies.set(name, version);
    } else {
      from.peers.set(name, { range, resolved: version, by });
    }
  }

  /** Optional peers the graph happens to meet; the rest left unmet. */
  completeOptionalPeers(): void {
    for (const node of this.nodes.values()) {
      for (const [peer, range] of Object.entries(node.meta.peerDependencies)) {
        if (!node.peers.has(peer)) {
          const met = this.#inGraph(peer, range);
          node.peers.set(peer, {
            range,
            resolved: met?.version ?? null,
            by: met ? "graph" : null,
          });
        }
      }
    }
  }
}

/**
 * Resolves the App's direct dependencies breadth first, one level at a
 * time, in name order, so the same package.json and registry resolve to
 * the same graph.
 */
const resolveGraph = async (
  resolution: Resolution,
  dependencies: Record<string, string>
): Promise<void> => {
  let level: Edge[] = Object.entries(dependencies)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, range]) => ({
      name,
      range,
      depth: 1,
      from: undefined,
      kind: "dependency" as const,
    }));
  while (level.length > 0) {
    // Every package of the level is asked of connect before it is needed.
    const names = [
      ...new Set(
        level
          .filter(({ name }) => !Object.hasOwn(platformPeers, name))
          .map(({ name }) => name)
      ),
    ];
    // oxlint-disable-next-line no-await-in-loop
    await limited(names, metadataConcurrency, async (name) => {
      try {
        await resolution.metadataOf(name);
      } catch {
        // Whichever edge needs it says why, in order.
      }
    });
    const next: Edge[] = [];
    for (const edge of level) {
      // In order: which version an edge gets can depend on the ones before.
      // oxlint-disable-next-line no-await-in-loop
      next.push(...(await resolution.resolve(edge)));
    }
    level = next.toSorted((a, b) =>
      `${a.from ? packageKey(a.from) : ""} ${a.name}` <
      `${b.from ? packageKey(b.from) : ""} ${b.name}`
        ? -1
        : 1
    );
  }
  resolution.completeOptionalPeers();
};

/** The graph a person approves, from the lock: what its hash names. */
export const graphOfLock = (lock: GraspLock): DependencyGraph =>
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
    platformPeers: { ...platformPeers },
  });

/** The App's approved lock last approved, if any: what it keeps. */
const previousLock = async (
  env: Env,
  app: string
): Promise<GraspLock | undefined> => {
  const row = await drizzle(env.DB)
    .select({ lock: dependencyLocks.lock })
    .from(dependencyRequests)
    .innerJoin(
      dependencyLocks,
      and(
        eq(dependencyLocks.appId, dependencyRequests.appId),
        eq(dependencyLocks.graphHash, dependencyRequests.graphHash)
      )
    )
    .where(
      and(
        eq(dependencyRequests.appId, app),
        eq(dependencyRequests.status, "approved")
      )
    )
    .orderBy(desc(dependencyRequests.decidedAt))
    .limit(1)
    .get();
  return row ? graspLockSchema.parse(JSON.parse(row.lock)) : undefined;
};

/** The ranges two manifests state, as one comparable text. */
const statedRanges = (meta: {
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}): string =>
  canonicalJson({
    dependencies: requiredDependencies(meta),
    optionalDependencies: meta.optionalDependencies,
    peerDependencies: meta.peerDependencies,
  });

/** What the builder answered, checked as any input is. */
const inspectionsSchema = z.array(packageInspectionSchema);

/**
 * Fetches every package's tarball (checked against its integrity) and
 * has the builder unpack and read them, in batches, counting bytes
 * against the graph's limits. Returns every reason a package is refused.
 */
const inspectGraph = async (
  env: Env,
  nodes: readonly Node[],
  limits: PackageLimits,
  refusals: Refusals
): Promise<void> => {
  const builder = await startPackageBuilder(env.LOADER, env.ASSETS);
  let archiveBytes = 0;
  let extractedBytes = 0;
  const pending = [...nodes];
  while (pending.length > 0) {
    const batch: PackageTarball[] = [];
    let batchBytes = 0;
    while (pending.length > 0 && batchBytes < inspectBatchBytes) {
      const node = pending.shift();
      if (node === undefined) {
        break;
      }
      const request = {
        name: node.name,
        version: node.version,
        integrity: node.integrity,
      };
      // In order: each tarball's size decides whether the batch is full.
      // oxlint-disable-next-line no-await-in-loop
      const tarball = await verifiedTarball(env, request);
      archiveBytes += tarball.byteLength;
      batchBytes += tarball.byteLength;
      if (archiveBytes > limits.graphArchiveBytes) {
        throw packageErrors.create("package.quota", {
          quota: "graphArchiveBytes",
          limit: limits.graphArchiveBytes,
        });
      }
      batch.push({ key: packageKey(node), ...request, tarball });
    }
    let answer: unknown;
    try {
      // oxlint-disable-next-line no-await-in-loop
      answer = await builder.inspect({ limits, packages: batch });
    } catch (error) {
      if (error instanceof Error && overLimit.test(error.message)) {
        throw packageErrors.create("package.refused", {
          refusals: ["unpacking the packages took more than the builder may"],
        });
      }
      throw error;
    }
    const inspected: PackageInspection[] = inspectionsSchema.parse(answer);
    const asked = batch.map(({ key }) => key).toSorted();
    const answered = inspected.map(({ key }) => key).toSorted();
    if (canonicalJson(asked) !== canonicalJson(answered)) {
      throw new Error(
        "The package builder didn't inspect the packages it was handed"
      );
    }
    for (const inspection of inspected) {
      // The builder's count of what it unpacked: its code is Grasp's and
      // the count is gzip's output as it read it, so a package can't
      // understate it; the builder's own per-package limit bounds it too.
      extractedBytes += inspection.bytes;
      const node = nodes.find((each) => packageKey(each) === inspection.key);
      const reasons = [...inspection.refusals];
      if (
        node &&
        inspection.manifest &&
        statedRanges(inspection.manifest) !== statedRanges(node.meta)
      ) {
        reasons.push(
          "its package.json states other dependencies than the registry's metadata"
        );
      }
      for (const reason of reasons) {
        refusals.add(`${inspection.key}: ${reason}`);
      }
    }
    if (extractedBytes > limits.graphExtractedBytes) {
      throw packageErrors.create("package.quota", {
        quota: "graphExtractedBytes",
        limit: limits.graphExtractedBytes,
      });
    }
  }
};

/** The lock for a resolved graph. */
const lockOf = (
  dependencies: Record<string, string>,
  direct: Map<string, string>,
  nodes: readonly Node[],
  targets: GraspLock["targets"]
): GraspLock => ({
  lockfileVersion: 1,
  registry: npmRegistryOrigin,
  requested: Object.fromEntries(
    Object.entries(dependencies).toSorted(([a], [b]) => (a < b ? -1 : 1))
  ),
  direct: Object.fromEntries(
    [...direct].toSorted(([a], [b]) => (a < b ? -1 : 1))
  ),
  platformPeers: { ...platformPeers },
  targets,
  packages: Object.fromEntries(
    nodes
      .toSorted((a, b) => (packageKey(a) < packageKey(b) ? -1 : 1))
      .map((node) => [
        packageKey(node),
        {
          name: node.name,
          version: node.version,
          integrity: node.integrity,
          license: node.meta.license,
          publishedAt: node.publishedAt,
          dependencies: Object.fromEntries(
            [...node.dependencies].toSorted(([a], [b]) => (a < b ? -1 : 1))
          ),
          peers: Object.fromEntries(
            [...node.peers].toSorted(([a], [b]) => (a < b ? -1 : 1))
          ),
        },
      ])
  ),
});

/** How often storing a lock starts over when another resolve wrote first. */
const lockTries = 3;

/**
 * The lock kept for a graph once `fresh` is added to it. The packages are
 * the graph's, the same whichever resolve named them (the graph's hash
 * covers every version, integrity and edge): the first lock's ranges and
 * times stay as its provenance. Targets aren't part of the graph's hash,
 * so each resolve sets the targets it asks for, with their conditions and
 * entries; the others stay as they were.
 */
export const mergedLock = (
  existing: GraspLock,
  fresh: GraspLock
): GraspLock => ({
  ...existing,
  targets: { ...existing.targets, ...fresh.targets },
});

/**
 * Stores `fresh` as the lock of an App's graph, or adds its targets to
 * the one stored, and returns the lock that holds. One conditional write
 * on the lock as it was read; a resolve that loses the race starts over.
 */
const storeLock = async (
  env: Env,
  app: string,
  graphHash: string,
  fresh: GraspLock,
  limits: PackageLimits
): Promise<GraspLock> => {
  const db = drizzle(env.DB);
  const where = and(
    eq(dependencyLocks.appId, app),
    eq(dependencyLocks.graphHash, graphHash)
  );
  for (let attempt = 0; attempt < lockTries; attempt += 1) {
    // Each attempt reads the lock as it is now.
    // oxlint-disable-next-line no-await-in-loop
    const row = await db
      .select({ lock: dependencyLocks.lock })
      .from(dependencyLocks)
      .where(where)
      .get();
    const next = row
      ? mergedLock(graspLockSchema.parse(JSON.parse(row.lock)), fresh)
      : fresh;
    const stored = canonicalJson(graspLockSchema.parse(next));
    if (new TextEncoder().encode(stored).byteLength > limits.lockBytes) {
      throw packageErrors.create("package.quota", {
        quota: "lockBytes",
        limit: limits.lockBytes,
      });
    }
    if (row?.lock === stored) {
      return next;
    }
    const write = row
      ? db
          .update(dependencyLocks)
          .set({ lock: stored })
          .where(and(where, eq(dependencyLocks.lock, row.lock)))
          .returning({ lock: dependencyLocks.lock })
      : db
          .insert(dependencyLocks)
          .values({
            appId: app,
            graphHash,
            lock: stored,
            createdAt: new Date(),
          })
          .onConflictDoNothing()
          .returning({ lock: dependencyLocks.lock });
    // oxlint-disable-next-line no-await-in-loop
    const written = await write;
    if (written.length > 0) {
      return next;
    }
  }
  throw dependencyErrors.create("dependency.stale");
};

/** What a resolve gives back: the request it proposed, and its lock. */
export interface Resolved {
  request: DependencyRequest;
  lock: GraspLock;
}

/**
 * Resolves what an App's package.json asks for (`intent`) into an exact
 * graph and lock, checks every package's bytes without running them, and
 * proposes the graph for a person's approval. For one of the App's
 * builders, or the chat's agent acting for one; never Grasp staff.
 */
export const resolveDependencies = async (
  env: Env,
  by: Acting,
  input: unknown
): Promise<Resolved> => {
  const intent = dependencyErrors.parse(
    "dependency.invalid",
    dependencyIntentSchema,
    input
  );
  if (by.staff) {
    throw dependencyErrors.create("dependency.forbidden");
  }
  await appFor(env, by, intent.app, "builder");
  const limits = packageLimitsOf(env.PACKAGE_LIMITS);
  for (const [name, range] of Object.entries(intent.dependencies)) {
    registryRange(name, range);
  }
  const entries = intent.entries ?? Object.keys(intent.dependencies).toSorted();
  const unknown = entries.filter(
    (entry) => !Object.hasOwn(intent.dependencies, entryPackage(entry))
  );
  if (unknown.length > 0) {
    throw dependencyErrors.create("dependency.invalid", {
      issues: unknown.map((entry) => `entries: ${entry} isn't a dependency`),
    });
  }
  const resolution = new Resolution(
    env,
    limits,
    await previousLock(env, intent.app)
  );
  await resolveGraph(resolution, intent.dependencies);
  const nodes = [...resolution.nodes.values()];
  if (nodes.length === 0) {
    throw dependencyErrors.create("dependency.invalid", {
      issues: ["dependencies: the platform provides every one of them"],
    });
  }
  const refusals = refusalCollector();
  for (const node of nodes) {
    for (const reason of metadataRefusals(node.meta)) {
      refusals.add(`${packageKey(node)}: ${reason}`);
    }
  }
  await inspectGraph(env, nodes, limits, refusals);
  if (refusals.total() > 0) {
    log.info("packages.refused", {
      app: intent.app,
      refusals: refusals.total(),
    });
    throw packageErrors.create("package.refused", {
      refusals: [...refusals.kept],
    });
  }
  const lock = lockOf(
    intent.dependencies,
    resolution.direct,
    nodes,
    Object.fromEntries(
      intent.targets.map((target) => [
        target,
        { conditions: [...targetConditions[target]], entries },
      ])
    )
  );
  const graph = graphOfLock(lock);
  const graphHash = await dependencyGraphHash(graph);
  // The lock first: a request is never without the lock its graph names.
  const kept = await storeLock(env, intent.app, graphHash, lock, limits);
  const request = await proposeDependencies(env, by, {
    app: intent.app,
    sourceRevision: intent.sourceRevision,
    purpose: intent.purpose,
    targets: intent.targets,
    graph,
    findings: [],
    refused: [],
  });
  return { request, lock: kept };
};
