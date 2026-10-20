/**
 * A standalone definition project's lockfile (package-definition-lib.ts):
 * pnpm's `pnpm-lock.yaml`, naming every package the project installs at
 * an exact version with the SHA-512 of its tarball, so a frozen install
 * fetches nothing else and refuses a tarball that isn't the one pinned.
 *
 * Threat model (GRA-723), and how each is closed:
 *
 * - The registry, a mirror or a proxy serves another tarball for a pinned
 *   version: every package carries its integrity, which pnpm checks
 *   against what it fetches. The vendored kit's and the project's own
 *   packages take theirs from the checkout's lockfile, which installed
 *   them; the App's and its workflows' from their own locks, which the
 *   platform resolved and checked.
 * - A dependency of a dependency moves: the whole graph is pinned, the
 *   catalog packages' transitive dependencies included, as the checkout
 *   resolved them. Nothing is left for an install to resolve.
 * - An install resolves past the lockfile: the project is pnpm's, its
 *   package manager pinned (`packageManager`), its installs frozen and
 *   its supply-chain settings written out (pnpm-workspace.yaml), its own
 *   packages linked by `link:`, which npm refuses, and its `preinstall`
 *   failing any install that isn't pnpm's (Yarn's or Bun's, which accept
 *   `link:` and would ignore the lockfile).
 * - An App's or workflow's lock swaps a package the kit installs: one
 *   named at a version the checkout or another lock also pins must carry
 *   the same integrity and the same edges, or packaging is refused (and
 *   a lock that names a package the project pins itself is refused
 *   before, package-definition-lib.ts).
 * - A package is locked by anything but its integrity (a tarball URL, a
 *   git or file resolution): refused, for every package the project
 *   installs.
 * - The lockfile is written from what a package names: names and
 *   versions are schema-checked, and the lockfile is written as JSON,
 *   which YAML reads as it is, so no value can add structure.
 * - A peer met by a version nothing approved: a kit package's peers only
 *   from the kit's own graph, as the checkout met them, never from a
 *   lock's packages; a lock's package's as its lock met them, its
 *   platform peers (and the lock's `platformPeers`) only by the very
 *   versions the project installs. Every met peer is within its range; a
 *   required peer with no version, or a mismatch, refuses packaging.
 * - Packaging reaches the network: it reads the checkout's lockfile and
 *   the package, nothing else.
 */
import { integritySchema } from "@grasp-os/shared/dependencies";
import type { GraspLock } from "@grasp-os/shared/packages";
import { satisfies } from "semver";
import { parse } from "yaml";
import { z } from "zod";

/** Why the lockfile can't be written, naming what. */
export class LockfileError extends Error {
  override readonly name = "LockfileError";
}

const refuse = (message: string): never => {
  throw new LockfileError(message);
};

const stringRecord = z.record(z.string(), z.string());

/** What the checkout's pnpm-lock.yaml says of each package and snapshot. */
const checkoutLockSchema = z.object({
  lockfileVersion: z.literal("9.0"),
  packages: z.record(
    z.string(),
    z.looseObject({
      resolution: z.looseObject({ integrity: z.string() }),
      peerDependencies: stringRecord.optional(),
      peerDependenciesMeta: z
        .record(z.string(), z.object({ optional: z.boolean().optional() }))
        .optional(),
    })
  ),
  snapshots: z.record(
    z.string(),
    z
      .object({
        dependencies: stringRecord.optional(),
        optionalDependencies: stringRecord.optional(),
      })
      .nullable()
  ),
});

type PackageMeta = z.infer<typeof checkoutLockSchema>["packages"][string];

/** How every package the project installs is locked: its integrity, alone. */
const resolutionSchema = z.strictObject({ integrity: integritySchema });

/** A package's own edges, peers apart, by name: exact versions. */
interface Edges {
  readonly dependencies: Map<string, string>;
  readonly optionalDependencies: Map<string, string>;
}

/** A project directory's manifest, as the lockfile records it. */
export interface Importer {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

/** What the lockfile is written from. */
export interface LockfileInput {
  /** The checkout's pnpm-lock.yaml, as text. */
  readonly checkoutLock: string;
  /** Each project directory (`.`, `vendor/@grasp-os/sdk`) and its manifest. */
  readonly importers: Readonly<Record<string, Importer>>;
  /** The App's and its workflows' locks, each with whose it is. */
  readonly locks: readonly {
    readonly owner: string;
    readonly lock: Omit<GraspLock, "artifacts">;
  }[];
}

/** `name@version`, a package's key in the lockfile. */
const keyOf = (name: string, version: string): string => `${name}@${version}`;

/**
 * A snapshot's key or an edge's version without the peers pnpm resolved
 * it with: `react-dom@19.3.0(react@19.3.0)` is `react-dom@19.3.0`.
 */
const withoutPeers = (text: string): string => {
  const at = text.indexOf("(");
  return at === -1 ? text : text.slice(0, at);
};

const sortedRecord = <Value>(
  entries: Iterable<[string, Value]>
): Record<string, Value> =>
  Object.fromEntries([...entries].toSorted(([a], [b]) => (a < b ? -1 : 1)));

/**
 * The checkout's packages and their own edges, peers apart: what pnpm
 * resolved each peer to there is the checkout's, not the project's.
 */
const readCheckout = (
  text: string
): {
  meta: Map<string, PackageMeta>;
  edges: Map<string, Edges>;
  peersMet: Map<string, Map<string, Set<string>>>;
} => {
  const read = checkoutLockSchema.safeParse(parse(text));
  if (!read.success) {
    return refuse("The checkout's pnpm-lock.yaml isn't one this reads.");
  }
  const meta = new Map(Object.entries(read.data.packages));
  const edges = new Map<string, Edges>();
  const peersMet = new Map<string, Map<string, Set<string>>>();
  for (const [snapshot, value] of Object.entries(read.data.snapshots)) {
    const key = withoutPeers(snapshot);
    const peers = new Set(Object.keys(meta.get(key)?.peerDependencies ?? {}));
    const own: Edges = edges.get(key) ?? {
      dependencies: new Map(),
      optionalDependencies: new Map(),
    };
    for (const [field, kind] of [
      [value?.dependencies, own.dependencies],
      [value?.optionalDependencies, own.optionalDependencies],
    ] as const) {
      for (const [name, version] of Object.entries(field ?? {})) {
        const exact = withoutPeers(version);
        if (peers.has(name)) {
          const met = peersMet.get(key) ?? new Map<string, Set<string>>();
          met.set(name, (met.get(name) ?? new Set<string>()).add(exact));
          peersMet.set(key, met);
          continue;
        }
        const before = kind.get(name);
        if (before !== undefined && before !== exact) {
          refuse(`${key} depends on two versions of ${name} in the checkout.`);
        }
        kind.set(name, exact);
      }
    }
    edges.set(key, own);
  }
  return { meta, edges, peersMet };
};

/** Edges by name, as one text to compare. */
const edgesText = (edges: ReadonlyMap<string, string>): string =>
  JSON.stringify([...edges].toSorted(([a], [b]) => (a < b ? -1 : 1)));

/**
 * Adds a lock's packages to `meta` and `edges`: its integrity, peers and
 * dependencies. One the checkout also pins must carry its integrity.
 */
const addLock = (
  { owner, lock }: LockfileInput["locks"][number],
  { meta, edges, peersMet }: ReturnType<typeof readCheckout>,
  fromLocks: Map<string, LockedPeers>,
  lockMet: Map<string, Map<string, string>>
): void => {
  for (const entry of Object.values(lock.packages)) {
    const key = keyOf(entry.name, entry.version);
    const peers = Object.entries(entry.peers);
    // A peer the lock met within its graph is installed with it, as the
    // lock resolved it; one the platform met is the project's own.
    const graphPeers = peers.flatMap(([name, peer]) =>
      peer.by === "graph" && peer.resolved !== null
        ? [[name, peer.resolved] as const]
        : []
    );
    const known = meta.get(key);
    if (known !== undefined) {
      // Already pinned, by the checkout or another lock: the same tarball,
      // with the same edges, or the project would install a graph this
      // lock didn't resolve.
      if (known.resolution.integrity !== entry.integrity) {
        refuse(`${key} in ${owner}'s lock isn't the tarball the kit installs.`);
      }
      const own = edges.get(key)?.dependencies ?? new Map<string, string>();
      const lockEdges = fromLocks.has(key)
        ? [...Object.entries(entry.dependencies), ...graphPeers]
        : Object.entries(entry.dependencies);
      const peersAgree =
        fromLocks.has(key) ||
        graphPeers.every(([name, version]) => {
          const met = [...(peersMet.get(key)?.get(name) ?? [])];
          return met.length === 1 && met[0] === version;
        });
      if (!peersAgree || edgesText(new Map(lockEdges)) !== edgesText(own)) {
        refuse(
          `${key} in ${owner}'s lock depends on other versions than the project installs it with.`
        );
      }
      // A kit package's peer a lock met in its graph: the project must
      // meet it the same way (`kitPeer` alone could leave it unmet).
      if (!fromLocks.has(key)) {
        const met = lockMet.get(key) ?? new Map<string, string>();
        for (const [name, version] of graphPeers) {
          met.set(name, version);
        }
        lockMet.set(key, met);
      }
      continue;
    }
    fromLocks.set(key, entry.peers);
    meta.set(key, {
      resolution: { integrity: entry.integrity },
      ...(peers.length === 0
        ? {}
        : {
            peerDependencies: sortedRecord(
              peers.map(([name, peer]) => [name, peer.range])
            ),
          }),
      ...(peers.some(([, peer]) => peer.resolved === null)
        ? {
            peerDependenciesMeta: sortedRecord(
              peers
                .filter(([, peer]) => peer.resolved === null)
                .map(([name]) => [name, { optional: true }])
            ),
          }
        : {}),
    });
    edges.set(key, {
      dependencies: new Map([
        ...Object.entries(entry.dependencies),
        ...graphPeers,
      ]),
      optionalDependencies: new Map(),
    });
    peersMet.set(
      key,
      new Map(graphPeers.map(([name, version]) => [name, new Set([version])]))
    );
  }
};

/** A locked package's peers, as its lock met them. */
type LockedPeers = GraspLock["packages"][string]["peers"];

/** Whether `version` is within `range`, prereleases included. */
const within = (version: string, range: string): boolean =>
  satisfies(version, range, { includePrerelease: true });

/** Every package reachable from `roots` through `follow`, by key. */
const reachable = (
  roots: Iterable<string>,
  follow: (key: string) => Iterable<string>
): Set<string> => {
  const seen = new Set<string>();
  const queue = [...roots];
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    if (!seen.has(key)) {
      seen.add(key);
      queue.push(...follow(key));
    }
  }
  return seen;
};

const isLink = (version: string): boolean => version.startsWith("link:");

/**
 * Refuses a lock whose package's peer the platform met at a version the
 * project doesn't install (`kitVersions`), whatever package it is: one
 * the checkout or an earlier lock already pins too (`addLock` keeps that
 * package as it is) must still be met as this lock met it.
 */
const checkPlatformPeers = (
  locks: LockfileInput["locks"],
  kitVersions: ReadonlyMap<string, string>
): void => {
  for (const { lock } of locks) {
    for (const entry of Object.values(lock.packages)) {
      for (const [name, peer] of Object.entries(entry.peers)) {
        if (
          peer.by === "platform" &&
          peer.resolved !== null &&
          kitVersions.get(name) !== peer.resolved
        ) {
          refuse(
            `${keyOf(entry.name, entry.version)}'s peer ${name} was met at ${peer.resolved} by the platform, which the project doesn't install.`
          );
        }
      }
    }
  }
};

/**
 * The project's pnpm-lock.yaml, as text: its importers as their manifests
 * name their dependencies, and every package they reach, each with its
 * integrity, its peers met by the project's one version of each.
 */
export const projectLockfile = (input: LockfileInput): string => {
  const checkout = readCheckout(input.checkoutLock);
  const { meta, edges, peersMet } = checkout;
  const fromLocks = new Map<string, LockedPeers>();
  const lockMet = new Map<string, Map<string, string>>();
  for (const lock of input.locks) {
    addLock(lock, checkout, fromLocks, lockMet);
  }
  const importers = Object.entries(input.importers);
  const registryDependencies = (importer: Importer): [string, string][] =>
    Object.entries({
      ...importer.dependencies,
      ...importer.devDependencies,
    }).filter(([, version]) => !isLink(version));
  // What the locks add to the root: never what meets the kit's peers.
  const lockDirect = new Set(
    input.locks.flatMap(({ lock }) => Object.keys(lock.direct))
  );
  // The kit's own versions, which meet its packages' peers and the
  // platform's peers of the locks' packages: the vendored packages' and
  // the project's own dependencies, never a lock's; and every version the
  // root installs, which a lock's graph must not meet a peer against.
  const kitVersions = new Map<string, string>();
  const rootVersions = new Map<string, string>();
  for (const [dir, importer] of importers) {
    for (const [name, version] of registryDependencies(importer)) {
      if (dir === "." || !rootVersions.has(name)) {
        rootVersions.set(name, version);
      }
      const kit = dir !== "." || !lockDirect.has(name);
      const before = kitVersions.get(name);
      if (kit && before !== undefined && before !== version) {
        refuse(`The kit installs two versions of ${name}.`);
      }
      if (kit) {
        kitVersions.set(name, version);
      }
    }
  }
  checkPlatformPeers(input.locks, kitVersions);
  const edgesOf = (key: string): Edges => {
    const own = edges.get(key);
    if (own === undefined || !meta.has(key)) {
      return refuse(`${key} is in no lock the project installs from.`);
    }
    return own;
  };
  /**
   * The package an edge names: by its name and version, or, for an alias
   * (`h3-v2: h3@2.0.1-rc.20`), the package its version names.
   */
  const keyOfEdge = ([name, version]: readonly [string, string]): string =>
    meta.has(version) ? version : keyOf(name, version);
  const allEdges = (key: string): string[] =>
    [...edgesOf(key).dependencies, ...edgesOf(key).optionalDependencies].map(
      keyOfEdge
    );
  const roots = importers.flatMap(([, importer]) =>
    registryDependencies(importer).map(([name, version]) =>
      keyOf(name, version)
    )
  );
  const required = reachable(roots, (key) =>
    [...edgesOf(key).dependencies].map(keyOfEdge)
  );
  const all = reachable(roots, allEdges);
  // The kit's own graph: what the checkout installed for it, which alone
  // meets its packages' peers. A lock's package never does.
  const kitAll = reachable(
    [...kitVersions].map(([name, version]) => keyOf(name, version)),
    allEdges
  );
  for (const key of all) {
    const resolution = resolutionSchema.safeParse(meta.get(key)?.resolution);
    if (!resolution.success) {
      refuse(`${key} is locked by something other than its integrity.`);
    }
  }
  for (const { owner, lock } of input.locks) {
    for (const [name, version] of Object.entries(lock.platformPeers)) {
      if (kitVersions.get(name) !== version) {
        refuse(
          `${owner}'s lock was resolved against ${name}@${version}, which the project doesn't install.`
        );
      }
    }
  }
  /**
   * What meets a kit package's peer: the version the checkout met it
   * with, within the kit's graph; the kit's own version of it agreeing.
   * An optional peer the checkout didn't meet, or met with a version the
   * kit doesn't install, stays unmet; a required one is refused. (The
   * project installs the compiler's TypeScript, not the checkout's own,
   * so an optional `typescript` peer the checkout met is left unmet.)
   */
  const kitPeer = (
    of: string,
    name: string,
    optional: boolean
  ): string | undefined => {
    const metThere = [...(peersMet.get(of)?.get(name) ?? [])];
    const kit = kitVersions.get(name);
    if (kit !== undefined) {
      if (metThere.length > 0 && !metThere.includes(kit)) {
        if (optional) {
          return undefined;
        }
        return refuse(
          `${of}'s peer ${name} was met at ${metThere.join(", ")} in the checkout, but the kit installs ${kit}.`
        );
      }
      return kit;
    }
    const inKit = metThere.filter((version) =>
      kitAll.has(keyOf(name, version))
    );
    if (inKit.length === 1) {
      return inKit[0];
    }
    if (optional) {
      return undefined;
    }
    return refuse(
      `${of}'s peer ${name} has no one version in the kit to meet it.`
    );
  };
  /** What meets a lock's package's peer: as its lock met it, or refused. */
  const lockPeer = (
    of: string,
    name: string,
    peer: LockedPeers[string]
  ): string | undefined => {
    if (peer.resolved === null) {
      return undefined;
    }
    if (peer.by === "platform") {
      if (kitVersions.get(name) !== peer.resolved) {
        return refuse(
          `${of}'s peer ${name} was met at ${peer.resolved} by the platform, which the project doesn't install.`
        );
      }
      return peer.resolved;
    }
    const root = rootVersions.get(name);
    if (peer.by !== "graph" || (root !== undefined && root !== peer.resolved)) {
      return refuse(
        `${of}'s peer ${name} is met at ${peer.resolved} by its lock and at ${root ?? "another version"} by the project.`
      );
    }
    return peer.resolved;
  };
  const snapshots = sortedRecord(
    [...all].map((key) => {
      const own = edgesOf(key);
      const { peerDependencies = {}, peerDependenciesMeta = {} } =
        meta.get(key) ?? {};
      const lockPeers = fromLocks.get(key);
      const peers: [string, string][] = [];
      for (const [name, range] of Object.entries(peerDependencies)) {
        const lockedPeer = lockPeers?.[name];
        const version =
          lockedPeer === undefined
            ? kitPeer(key, name, peerDependenciesMeta[name]?.optional === true)
            : lockPeer(key, name, lockedPeer);
        const lockedThere = lockMet.get(key)?.get(name);
        if (lockedThere !== undefined && lockedThere !== version) {
          refuse(
            `${key}'s peer ${name} is met at ${lockedThere} by a lock and at ${version ?? "no version"} in the project.`
          );
        }
        if (version !== undefined) {
          if (!within(version, range)) {
            refuse(`${key}'s peer ${name}@${version} isn't within ${range}.`);
          }
          peers.push([name, version]);
        }
      }
      const dependencies = sortedRecord([...own.dependencies, ...peers]);
      const optionalDependencies = sortedRecord(own.optionalDependencies);
      return [
        key,
        {
          ...(Object.keys(dependencies).length === 0 ? {} : { dependencies }),
          ...(Object.keys(optionalDependencies).length === 0
            ? {}
            : { optionalDependencies }),
          ...(required.has(key) ? {} : { optional: true }),
        },
      ];
    })
  );
  const importerEntries = (
    dir: string,
    importer: Importer
  ): Record<string, unknown> => {
    // Peers it doesn't depend on itself, installed as pnpm's
    // `autoInstallPeers` does: by their range, at the root's version.
    const peers = Object.fromEntries(
      Object.entries(importer.peerDependencies).filter(
        ([name]) =>
          !Object.hasOwn(importer.dependencies, name) &&
          !Object.hasOwn(importer.devDependencies, name)
      )
    );
    for (const [name, range] of Object.entries(peers)) {
      const version = kitVersions.get(name);
      if (version === undefined || !within(version, range)) {
        refuse(`${dir}'s peer ${name} has no version within ${range}.`);
      }
    }
    const field = (specs: Readonly<Record<string, string>>) =>
      sortedRecord(
        Object.entries(specs).map(([name, specifier]) => [
          name,
          {
            specifier,
            // An exact version, or a link, as written; a peer at the
            // kit's version.
            version: Object.hasOwn(peers, name)
              ? (kitVersions.get(name) ?? specifier)
              : specifier,
          },
        ])
      );
    const dependencies = field({ ...peers, ...importer.dependencies });
    const devDependencies = field(importer.devDependencies);
    return {
      ...(Object.keys(dependencies).length === 0 ? {} : { dependencies }),
      ...(Object.keys(devDependencies).length === 0 ? {} : { devDependencies }),
    };
  };
  const lockfile = {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: sortedRecord(
      importers.map(([dir, importer]) => [dir, importerEntries(dir, importer)])
    ),
    packages: sortedRecord([...all].map((key) => [key, meta.get(key)])),
    snapshots,
  };
  // JSON is YAML: written so, nothing a value holds can add structure.
  return `${JSON.stringify(lockfile, null, 2)}\n`;
};
