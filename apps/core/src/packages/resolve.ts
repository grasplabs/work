import { actorOf } from "@grasp-os/shared/audit";
import {
  dependencyErrors,
  dependencyMaxFindings,
  dependencyMaxPackages,
  findingGravity,
  npmRegistryOrigin,
  packageKey,
  subjectOfRef,
} from "@grasp-os/shared/dependencies";
import type {
  DependencyFinding,
  DependencyRequest,
} from "@grasp-os/shared/dependencies";
import {
  dependencyIntentSchema,
  entryPackage,
  packageErrors,
  packageMaturityMs,
} from "@grasp-os/shared/packages";
import type {
  GraspLock,
  LockedPackage,
  NpmVersion,
} from "@grasp-os/shared/packages";
import rcompare from "semver/functions/rcompare";
import satisfies from "semver/functions/satisfies";
import validRange from "semver/ranges/valid";

import type { Acting } from "../auth/identity.ts";
import { latestApprovedLock, refuseMalware } from "./approvals.ts";
import { lookalikeFindings } from "./lookalikes.ts";
import { scanPackages, whenFree } from "./malware.ts";
import { propose } from "./requests.ts";
import { builtSubject } from "./subjects.ts";

// Resolving what a source asks for into one exact graph, and proposing it
// for its builder's approval (requests.ts). Every version comes from the
// npm registry's metadata through connect, resolved with npm's own range
// rules (semver); nothing is fetched or unpacked until an approved graph
// is built (build.ts). What could go wrong, and what stops it:
//
// - Sources other than the registry: a range semver can't read (a
//   repository, file, URL, alias or tag) is refused, in the source and in
//   every package's own dependencies (`package.unsupported_source`).
// - A brand-new release, perhaps a compromised one: a version is resolved
//   to only once it has been published for three days, and only with a
//   SHA-512 integrity, which every later fetch is checked against.
// - Someone else's package in the platform's name: the SDK and UI kit are
//   never npm packages, so one in the `@grasp-os/` scope is refused.
// - Known malware: refused before anything is proposed, audited. Every
//   other finding (a lookalike name, an advisory) is shown to the builder.

/** Most metadata reads at once: a package's metadata can be tens of MiB in connect's isolate. */
const metadataConcurrency = 2;

/** The platform's own scope, never an npm package's. */
const platformScope = "@grasp-os/";

/** One edge to resolve: a package by range, for a package of the graph or the source. */
interface Edge {
  name: string;
  range: string;
  from: LockedPackage | undefined;
}

/** The range an edge asks for, or refused if it isn't one. */
const registryRange = (edge: Edge): Edge => {
  if (validRange(edge.range) === null || edge.name.startsWith(platformScope)) {
    throw packageErrors.create("package.unsupported_source", {
      package: edge.from ? packageKey(edge.from) : "the source",
      dependency: edge.name,
      spec: edge.range.slice(0, 128),
    });
  }
  return edge;
};

/** The edges `version` brings: its dependencies and required peers, as npm 7 installs them. */
const edgesOf = (version: NpmVersion, from: LockedPackage): Edge[] =>
  [
    ...Object.entries(version.dependencies).filter(
      ([name]) => !Object.hasOwn(version.optionalDependencies, name)
    ),
    ...Object.entries(version.peerDependencies).filter(
      ([name]) => !version.optionalPeers.includes(name)
    ),
  ].map(([name, range]) => registryRange({ name, range, from }));

/**
 * The exact graph `requested` resolves to: level by level, each edge to a
 * version already in the graph that meets it, else to the highest mature
 * version with an integrity.
 */
const resolveGraph = async (
  env: Env,
  requested: Record<string, string>,
  entries: string[]
): Promise<GraspLock> => {
  const mature = Date.now() - packageMaturityMs;
  const metadata = new Map<string, Promise<NpmVersion[]>>();
  const readVersions = async (name: string): Promise<NpmVersion[]> => {
    const { versions } = await whenFree(
      async () => await env.CONNECT.npmMetadata(name)
    );
    return versions;
  };
  const versionsOf = async (name: string): Promise<NpmVersion[]> => {
    const read = metadata.get(name) ?? readVersions(name);
    metadata.set(name, read);
    return await read;
  };
  const direct: Record<string, string> = {};
  const packages: Record<string, LockedPackage> = {};
  /** The highest mature version of `name` with an integrity that meets `range`. */
  const newest = (
    versions: readonly NpmVersion[],
    name: string,
    range: string
  ): LockedPackage & { edges: NpmVersion } => {
    const [chosen] = versions
      .filter(
        (candidate) =>
          candidate.integrity !== null &&
          candidate.publishedAt !== null &&
          Date.parse(candidate.publishedAt) <= mature &&
          satisfies(candidate.version, range)
      )
      .toSorted((a, b) => rcompare(a.version, b.version));
    if (
      chosen === undefined ||
      chosen.integrity === null ||
      chosen.publishedAt === null
    ) {
      throw packageErrors.create("package.unresolvable", {
        package: name,
        range: range.slice(0, 128),
      });
    }
    return {
      name,
      version: chosen.version,
      integrity: chosen.integrity,
      license: chosen.license,
      publishedAt: chosen.publishedAt,
      dependencies: {},
      edges: chosen,
    };
  };
  let level = Object.entries(requested).map(([name, range]) =>
    registryRange({ name, range, from: undefined })
  );
  while (level.length > 0) {
    const names = [...new Set(level.map(({ name }) => name))];
    // Read ahead, a few at a time.
    for (let at = 0; at < names.length; at += metadataConcurrency) {
      // oxlint-disable-next-line no-await-in-loop -- bounded reads
      await Promise.all(
        names.slice(at, at + metadataConcurrency).map(versionsOf)
      );
    }
    const next: Edge[] = [];
    for (const { name, range, from } of level) {
      const [inGraph] = Object.values(packages)
        .filter(
          (entry) => entry.name === name && satisfies(entry.version, range)
        )
        .toSorted((a, b) => rcompare(a.version, b.version));
      let resolved = inGraph;
      if (resolved === undefined) {
        // oxlint-disable-next-line no-await-in-loop -- read ahead above
        const { edges, ...entry } = newest(await versionsOf(name), name, range);
        packages[packageKey(entry)] = entry;
        if (Object.keys(packages).length > dependencyMaxPackages) {
          throw packageErrors.create("package.quota", {
            limit: dependencyMaxPackages,
          });
        }
        next.push(...edgesOf(edges, entry));
        resolved = entry;
      }
      const { version } = resolved;
      if (from === undefined) {
        direct[name] = version;
      } else {
        from.dependencies[name] = version;
      }
    }
    level = next;
  }
  return {
    lockfileVersion: 2,
    registry: npmRegistryOrigin,
    requested,
    direct,
    entries,
    packages,
  };
};

/**
 * Resolves what an App's or a workflow's source asks for (`input`) into
 * an exact lock, scans it, and proposes it for a builder's approval, for
 * one of its builders or the chat's agent acting for one; never Grasp
 * staff.
 */
export const resolveDependencies = async (
  env: Env,
  by: Acting,
  input: unknown,
  /** Admits the proposal right before it is stored: throws to refuse it. */
  admit?: () => Promise<void>
): Promise<DependencyRequest> => {
  const intent = dependencyErrors.parse(
    "dependency.invalid",
    dependencyIntentSchema,
    input
  );
  const subject = subjectOfRef(intent);
  await builtSubject(env, by, subject, true);
  // A request adds to what is approved, and takes out only what it names:
  // the lock it proposes covers both.
  const approved = await latestApprovedLock(env, subject);
  const removed = [...new Set(intent.remove)].toSorted();
  const kept = (name: string) => !removed.includes(name);
  const asked = Object.fromEntries(
    intent.dependencies.map(({ name, range }) => [name, range])
  );
  const issues = [
    ...removed
      .filter((name) => !Object.hasOwn(approved?.requested ?? {}, name))
      .map((name) => `remove: ${name} isn't an approved package`),
    ...(intent.entries ?? [])
      .filter((entry) => !Object.hasOwn(asked, entryPackage(entry)))
      .map((entry) => `entries: ${entry} isn't a dependency`),
  ];
  if (issues.length > 0) {
    throw dependencyErrors.create("dependency.invalid", { issues });
  }
  const requested = {
    ...Object.fromEntries(
      Object.entries(approved?.requested ?? {}).filter(([name]) => kept(name))
    ),
    ...asked,
  };
  const entries = [
    ...(approved?.entries ?? []).filter((entry) => kept(entryPackage(entry))),
    ...(intent.entries ?? Object.keys(asked)),
  ].toSorted();
  const lock = await resolveGraph(env, requested, [...new Set(entries)]);
  const refs = Object.values(lock.packages);
  // A scan that can't be read fails the resolve: never proposed as one
  // without findings.
  // Nothing left to scan once every package is removed.
  const { malware, advisories } =
    refs.length === 0
      ? { malware: [], advisories: [] }
      : await scanPackages(env, refs);
  const [first, ...rest] = malware;
  if (first !== undefined) {
    await refuseMalware(
      env,
      by.actor ?? actorOf(by),
      subject,
      [first, ...rest],
      "resolve"
    );
  }
  const findings: DependencyFinding[] = [
    ...lookalikeFindings(refs),
    ...advisories.map(({ advisory, package: ref }) => ({
      kind: "security" as const,
      package: ref,
      severity: advisory.severity,
      id: advisory.id,
      summary: advisory.title,
    })),
  ]
    .toSorted((a, b) => findingGravity[b.severity] - findingGravity[a.severity])
    .slice(0, dependencyMaxFindings);
  await admit?.();
  return await propose(
    env,
    by,
    subject,
    intent.purpose,
    lock,
    findings,
    removed
  );
};
