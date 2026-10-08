import {
  compilerVersion,
  platformPeers,
  startPackageBuilder,
} from "@grasp-os/compiler";
import type { BuildRequest } from "@grasp-os/compiler";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import {
  dependencyErrors,
  dependencyGraphHash,
} from "@grasp-os/shared/dependencies";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  graspLockSchema,
  packageArtifactSchema,
  packageBuildAnswerSchema,
  packageBuildRequestSchema,
  packageErrors,
  packageLimitsOf,
  targetConfigHash,
} from "@grasp-os/shared/packages";
import type {
  ArtifactPin,
  GraspLock,
  PackageArtifact,
  PackageBuild,
  PackageLimits,
  PackageTarball,
} from "@grasp-os/shared/packages";
import { and, eq, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";

import { appFor } from "../apps.ts";
import {
  auditedBatch,
  outboxedEventWhere,
  outboxedWhere,
  storedEvent,
} from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import {
  dependencyBuildLeases,
  dependencyLocks,
  dependencyRequests,
  packageCleanups,
} from "../db/core/schema.ts";
import { policyGenerationSql } from "../dependencies/policy.ts";
import { admitDependencies } from "../dependencies/requests.ts";
import { windowedAccessEnd } from "../screen-frame.ts";
import { packageArtifactAddress } from "./address.ts";
import { clearBuildCleanup, recordCleanup } from "./cleanup-records.ts";
import { holdLockFor } from "./locks.ts";
import { graphOfLock } from "./resolve.ts";
import { verifiedTarball } from "./tarballs.ts";

// Building an approved graph for one target (the PackageBuilder path):
// the lock's tarballs, checked against their integrity, bundled with
// esbuild-wasm in the package builder's isolate (no network, no bindings,
// nothing of the packages run), into an artifact core checks byte for
// byte before keeping it. What could go wrong, and what stops it:
//
// - Building what nobody approved, or more of it: every build asks
//   `admitDependencies` first, for this App, graph and target under the
//   policy generation the caller read, and the pin it writes records the
//   approval it relied on. The lock is checked to still hash to the
//   approved graph.
// - Other bytes than approved: each tarball is checked against the lock's
//   integrity in core and again in the builder.
// - An artifact that changes under the same lock: the first build of a
//   target config (its conditions and entries, `targetConfigHash`) by a
//   compiler pins its artifact's hash in the lock, under that config; a
//   later build of it that makes anything else is refused, never swapped
//   in (`package.artifact_mismatch`). A resolve that sets other entries
//   changes the target's config, audited as it does
//   (`dependency.lock_targets_changed`, resolve.ts): the new config gets a
//   pin of its own, recorded as it is written (`dependency.built`), and
//   the old config's pin stays as it was. A kept artifact is handed out by
//   its description, whose hash is checked; its files' bytes are checked
//   each time one is served (serve.ts), and a corrupt one makes the next
//   build make it again, to the pin.
// - A platform that moved on: a lock is the graph it was resolved
//   against, React included, and hashes with the lock's own platform
//   peers. A release with another React builds nothing of it
//   (`package.platform_changed`): resolve again, for a new approval.
// - Releases side by side, each with its own compiler: each pins its own
//   builds, and a lock keeps the pins of the two compilers that pinned
//   last, so neither erases the other's while both serve.
// - What the builder answers: its code is Grasp's, but it handled hostile
//   bytes, so its answer is checked like any input: its shape, every
//   file's SHA-256 against the bytes, and the artifact's size.
//
// Not here yet: taking an approval back, or retiring an artifact. Until
// GRA-359, an approval holds until the policy generation moves on, and a
// pin until it is dropped as one too many (`withPin`).

/** How the runtime says it stopped an isolate over its limits. */
const overLimit = /exceeded (?:its )?(?:CPU|memory)/iu;

const artifactKey = (hash: string): string => `package-builds/${hash}.json`;
const filesPrefix = (hash: string): string => `package-builds/${hash}/`;
const fileKey = (hash: string, path: string): string =>
  `${filesPrefix(hash)}${path}`;

/**
 * Deletes every file of artifact `hash`, its description last, so a
 * description there still means its files are (cleanup.ts).
 */
export const deleteArtifact = async (env: Env, hash: string): Promise<void> => {
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    const listed = await env.FILES.list({
      prefix: filesPrefix(hash),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const keys = listed.objects.map(({ key }) => key);
    if (keys.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await env.FILES.delete(keys);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  await env.FILES.delete(artifactKey(hash));
};

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))
  );

/** The hash that names an artifact: of its canonical description. */
const artifactHash = async (artifact: PackageArtifact): Promise<string> =>
  await sha256Hex(canonicalJson(artifact));

/**
 * A kept artifact's description, if it is there and hashes to `hash`:
 * anything else is as good as missing. Its files are checked one by one
 * (`keptFile`).
 */
export const keptDescription = async (
  env: Env,
  hash: string
): Promise<PackageArtifact | undefined> => {
  const stored = await env.FILES.get(artifactKey(hash));
  if (!stored) {
    return undefined;
  }
  let description: unknown;
  try {
    description = JSON.parse(await stored.text());
  } catch {
    log.warn("packages.artifact_corrupt", { hash, path: "description" });
    return undefined;
  }
  const parsed = packageArtifactSchema.safeParse(description);
  if (!parsed.success || (await artifactHash(parsed.data)) !== hash) {
    return undefined;
  }
  return parsed.data;
};

/**
 * File `path` of the kept artifact `hash`, if its bytes still hash to
 * `expected`, the SHA-256 the artifact's description names: anything else
 * is as good as missing.
 */
export const keptFile = async (
  env: Env,
  hash: string,
  path: string,
  expected: string
): Promise<Uint8Array | undefined> => {
  const file = await env.FILES.get(fileKey(hash, path));
  const bytes = file ? new Uint8Array(await file.arrayBuffer()) : undefined;
  if (bytes === undefined || (await sha256(bytes)) !== expected) {
    log.warn("packages.artifact_corrupt", { hash, path });
    return undefined;
  }
  return bytes;
};

/**
 * Forgets kept artifact `hash`'s description, once one of its files is
 * found not to be the bytes it names: the next build of it makes it
 * again, and must match its pin.
 */
export const forgetArtifact = async (env: Env, hash: string): Promise<void> => {
  await env.FILES.delete(artifactKey(hash));
};

/** Whether two sets of platform peers name the same packages and versions. */
const samePlatform = (
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>
): boolean => canonicalJson({ ...a }) === canonicalJson({ ...b });

/**
 * The lock of an App's graph, checked to still be that graph, and to be
 * for this release's platform: one resolved against another React is
 * `package.platform_changed` (resolve again), logged as a warning, since a
 * release that moves React on does that to every lock.
 */
export const lockOf = async (
  env: Env,
  app: string,
  graphHash: string
): Promise<{ lock: GraspLock; stored: string }> => {
  const row = await drizzle(env.DB)
    .select({ lock: dependencyLocks.lock })
    .from(dependencyLocks)
    .where(
      and(
        eq(dependencyLocks.appId, app),
        eq(dependencyLocks.graphHash, graphHash)
      )
    )
    .get();
  if (!row) {
    throw dependencyErrors.create("dependency.invalid", {
      issues: [
        "graphHash: no lock for this graph: resolve the dependencies first",
      ],
    });
  }
  const lock = graspLockSchema.parse(JSON.parse(row.lock));
  if ((await dependencyGraphHash(graphOfLock(lock))) !== graphHash) {
    log.error("packages.lock_changed", { app, graphHash });
    throw dependencyErrors.create("dependency.approval_required");
  }
  if (!samePlatform(lock.platformPeers, platformPeers)) {
    log.warn("packages.platform_changed", {
      app,
      graphHash,
      locked: canonicalJson({ ...lock.platformPeers }),
      platform: canonicalJson({ ...platformPeers }),
    });
    throw packageErrors.create("package.platform_changed");
  }
  return { lock, stored: row.lock };
};

/** Most configs of one target a compiler's pins keep: the newest. */
const maxTargetConfigs = 4;

/**
 * Most compilers whose pins a lock keeps: the two that pinned last, so two
 * releases running side by side (a rollout, ring by ring) each keep their
 * own pins instead of erasing the other's.
 */
const maxCompilers = 2;

/** When a compiler's pins were last written: its newest pin's time. */
const lastPinned = (pins: Record<string, ArtifactPin>): string => {
  let latest = "";
  for (const { pinnedAt } of Object.values(pins)) {
    if (pinnedAt > latest) {
      latest = pinnedAt;
    }
  }
  return latest;
};

/** Newest first, by when each was pinned. */
const newestFirst = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? 1 : -1;
};

/**
 * A lock's pins once `added` is pinned for `compiler` under `config`, and
 * the hashes of the pins that drops: a config of the same target past the
 * newest {@link maxTargetConfigs} (by when each was last pinned or handed
 * out, `touchPin`), and every pin of a compiler past the
 * {@link maxCompilers} that pinned last. Never the config the lock names
 * for the target now (`inUse`), which a build may have read before a
 * resolve set it back. Nothing else is dropped: a pin of another config,
 * another target or another kept compiler stays.
 */
export const withPin = (
  artifacts: GraspLock["artifacts"],
  compiler: string,
  config: string,
  added: ArtifactPin,
  inUse?: string
): { artifacts: NonNullable<GraspLock["artifacts"]>; dropped: string[] } => {
  const pins: Record<string, ArtifactPin> = {
    ...artifacts?.[compiler],
    [config]: added,
  };
  // Kept whatever their time: the config pinned now, and the one in use.
  const keptAnyway =
    inUse !== undefined && inUse !== config && pins[inUse] !== undefined
      ? 2
      : 1;
  const tooMany = new Set(
    Object.entries(pins)
      .filter(
        ([key, { target }]) =>
          key !== config && key !== inUse && target === added.target
      )
      .toSorted(([, a], [, b]) => newestFirst(a.pinnedAt, b.pinnedAt))
      .slice(maxTargetConfigs - keptAnyway)
      .map(([key]) => key)
  );
  const others = Object.entries(artifacts ?? {})
    .filter(([version]) => version !== compiler)
    .toSorted(([, a], [, b]) => newestFirst(lastPinned(a), lastPinned(b)));
  return {
    artifacts: {
      ...Object.fromEntries(others.slice(0, maxCompilers - 1)),
      [compiler]: Object.fromEntries(
        Object.entries(pins).filter(([key]) => !tooMany.has(key))
      ),
    },
    dropped: [
      ...Object.entries(pins)
        .filter(([key]) => tooMany.has(key))
        .map(([, { hash }]) => hash),
      ...others
        .slice(maxCompilers - 1)
        .flatMap(([, gone]) => Object.values(gone).map(({ hash }) => hash)),
    ],
  };
};

/** What a build was admitted under: re-checked in the write that pins. */
interface Admitted {
  approval: string;
  policyGeneration: number;
}

/**
 * Whether `admitted` still holds as a statement runs: under the same
 * policy generation, and its approval still approved (nothing takes one
 * back until GRA-359, so today the generation is what moves).
 */
const stillAdmitted = ({ approval, policyGeneration }: Admitted): SQL =>
  sql`EXISTS (SELECT 1 FROM ${dependencyRequests} WHERE ${dependencyRequests.id} = ${approval} AND ${dependencyRequests.status} = 'approved') AND ${policyGenerationSql} = ${policyGeneration}`;

/**
 * The audit entry of a pin a build writes: which App, graph, target config
 * and artifact, and the approval it relied on. Only for a pin written: a
 * build that hands out an artifact pinned before records nothing, so
 * asking again and again adds nothing to the trail.
 */
const pinEntry = (
  by: Acting,
  pinned: {
    app: string;
    graphHash: string;
    target: PackageArtifact["target"];
    config: string;
    approval: string;
    hash: string;
  }
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action: "dependency.built",
  target: { type: "app", id: pinned.app },
  detail: pinned,
});

/**
 * The audit entry of a pin that writing another (`pinned`) dropped, one
 * each: a build of a third release drops every pin of the oldest other
 * one, more hashes than one detail value holds.
 */
const droppedEntry = (
  by: Acting,
  dropped: { app: string; graphHash: string; hash: string; pinned: string }
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action: "dependency.pin_dropped",
  target: { type: "app", id: dropped.app },
  detail: dropped,
});

/** How often pinning starts over when another write changed the lock first. */
const pinTries = 3;

/** What a build pins: its artifact, for one target config. */
interface Pinning {
  target: PackageArtifact["target"];
  config: string;
  hash: string;
  exports: Record<string, string>;
}

/**
 * Pins `pinning.hash` as what `compilerVersion` builds the target config
 * to, unless a build pinned that config first; returns the pin that
 * holds, and, if this call wrote it, the pins writing it dropped
 * (`withPin`). One conditional update on the lock as it was read, which
 * lands only while the build's approval holds; after another write, the
 * lock is read again and checked again (`lockOf`), size included.
 */
const pin = async (
  env: Env,
  by: Acting,
  app: string,
  graphHash: string,
  read: { lock: GraspLock; stored: string },
  pinning: Pinning,
  limits: PackageLimits,
  admitted: Admitted,
  admit: () => Promise<unknown>
): Promise<string> => {
  const db = drizzle(env.DB);
  let current = read;
  for (let attempt = 0; attempt < pinTries; attempt += 1) {
    const existing =
      current.lock.artifacts?.[compilerVersion]?.[pinning.config];
    if (existing) {
      return existing.hash;
    }
    const named = current.lock.targets[pinning.target];
    const inUse =
      named === undefined
        ? undefined
        : // oxlint-disable-next-line no-await-in-loop
          await targetConfigHash(pinning.target, named);
    const { artifacts, dropped } = withPin(
      current.lock.artifacts,
      compilerVersion,
      pinning.config,
      {
        target: pinning.target,
        hash: pinning.hash,
        exports: pinning.exports,
        pinnedAt: new Date().toISOString(),
      },
      inUse
    );
    const stored = canonicalJson(
      graspLockSchema.parse({ ...current.lock, artifacts })
    );
    if (new TextEncoder().encode(stored).byteLength > limits.lockBytes) {
      throw packageErrors.create("package.quota", {
        quota: "lockBytes",
        limit: limits.lockBytes,
      });
    }
    const built = createAuditEvent(
      pinEntry(by, {
        app,
        graphHash,
        target: pinning.target,
        config: pinning.config,
        approval: admitted.approval,
        hash: pinning.hash,
      }),
      "core"
    );
    // In turn: each attempt writes on the lock the one before read. The
    // pin, its audit events and the cleanup of the pins it drops land
    // together or not at all: the events only if this update changed the
    // lock, and the cleanup only if the lock is the one this wrote.
    // oxlint-disable-next-line no-await-in-loop
    const [updated] = await auditedBatch(env, db, [
      db
        .update(dependencyLocks)
        .set({ lock: stored })
        .where(
          and(
            eq(dependencyLocks.appId, app),
            eq(dependencyLocks.graphHash, graphHash),
            eq(dependencyLocks.lock, current.stored),
            stillAdmitted(admitted)
          )
        )
        .returning({ lock: dependencyLocks.lock }),
      // Only if this update changed the lock: two builds of the same bytes
      // can write the same text, and only the one that lands records it.
      outboxedEventWhere(db, built, sql`changes() > 0`),
      // Each pin it dropped, only if the pin itself was recorded.
      ...dropped.map((hash) =>
        outboxedWhere(
          db,
          droppedEntry(by, {
            app,
            graphHash,
            hash,
            pinned: pinning.hash,
          }),
          storedEvent(built.id)
        )
      ),
      db
        .insert(packageCleanups)
        .select(
          sql`SELECT value, 'build', ${Date.now()} FROM json_each(${JSON.stringify(dropped)}) WHERE EXISTS (SELECT 1 FROM ${dependencyLocks} WHERE ${dependencyLocks.appId} = ${app} AND ${dependencyLocks.graphHash} = ${graphHash} AND ${dependencyLocks.lock} = ${stored})`
        )
        .onConflictDoUpdate({
          target: packageCleanups.key,
          set: { createdAt: sql`excluded.created_at` },
        }),
    ]);
    if (updated.length > 0) {
      return pinning.hash;
    }
    // The admission no longer holds (this throws), or another write
    // changed the lock first: read it as it is now.
    // oxlint-disable-next-line no-await-in-loop
    await admit();
    // oxlint-disable-next-line no-await-in-loop
    current = await lockOf(env, app, graphHash);
  }
  throw dependencyErrors.create("dependency.stale");
};

/** How long a pin handed out goes before its time is moved on. */
const touchAfterMs = 24 * 60 * 60 * 1000;

/**
 * Moves a pin's time on when it is handed out and its time is a day old,
 * so the pins kept for a target are the ones in use, not the ones pinned
 * first (`withPin`). One conditional write on the lock as it was read; a
 * write that loses to another, or fails, changes nothing and is only
 * logged: handing the artifact out doesn't depend on it.
 */
const touchPin = async (
  env: Env,
  app: string,
  graphHash: string,
  read: { lock: GraspLock; stored: string },
  config: string,
  pinned: ArtifactPin
): Promise<void> => {
  if (Date.now() - Date.parse(pinned.pinnedAt) < touchAfterMs) {
    return;
  }
  const pins = read.lock.artifacts?.[compilerVersion] ?? {};
  const stored = canonicalJson(
    graspLockSchema.parse({
      ...read.lock,
      artifacts: {
        ...read.lock.artifacts,
        [compilerVersion]: {
          ...pins,
          [config]: { ...pinned, pinnedAt: new Date().toISOString() },
        },
      },
    })
  );
  try {
    await drizzle(env.DB)
      .update(dependencyLocks)
      .set({ lock: stored })
      .where(
        and(
          eq(dependencyLocks.appId, app),
          eq(dependencyLocks.graphHash, graphHash),
          eq(dependencyLocks.lock, read.stored)
        )
      );
  } catch (error) {
    log.warn("packages.pin_touch_failed", { app, ...errorFields(error) });
  }
};

/** Every tarball of the lock, checked, counting bytes as they come. */
const lockedTarballs = async (
  env: Env,
  lock: GraspLock,
  limits: PackageLimits
): Promise<PackageTarball[]> => {
  // The count first: nothing is fetched for a lock past the limit.
  if (Object.keys(lock.packages).length > limits.graphPackages) {
    throw packageErrors.create("package.quota", {
      quota: "graphPackages",
      limit: limits.graphPackages,
    });
  }
  const packages: PackageTarball[] = [];
  let archiveBytes = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    const request = {
      name: entry.name,
      version: entry.version,
      integrity: entry.integrity,
    };
    // One at a time, counting bytes as they come.
    // oxlint-disable-next-line no-await-in-loop
    const tarball = await verifiedTarball(env, request);
    archiveBytes += tarball.byteLength;
    if (archiveBytes > limits.graphArchiveBytes) {
      throw packageErrors.create("package.quota", {
        quota: "graphArchiveBytes",
        limit: limits.graphArchiveBytes,
      });
    }
    packages.push({ key, ...request, tarball });
  }
  return packages;
};

/**
 * Has the package builder build `request`, and checks what it answers:
 * its shape, that its files are the ones it describes, byte for byte,
 * and the artifact's size.
 */
const builtArtifact = async (env: Env, request: BuildRequest) => {
  const builder = await startPackageBuilder(env.LOADER, env.ASSETS);
  const started = Date.now();
  let answer: unknown;
  try {
    answer = await builder.build(request);
  } catch (error) {
    if (error instanceof Error && overLimit.test(error.message)) {
      throw packageErrors.create("package.refused", {
        refusals: ["building the packages took more than the builder may"],
      });
    }
    throw error;
  }
  const builtMs = Date.now() - started;
  const built = packageBuildAnswerSchema.parse(answer);
  if (!built.ok) {
    throw packageErrors.create("package.refused", {
      refusals: built.refusals,
    });
  }
  const { artifact, files, stats } = built;
  const described = Object.keys(artifact.files).toSorted();
  if (
    canonicalJson(described) !== canonicalJson(Object.keys(files).toSorted())
  ) {
    throw new Error("The package builder's files aren't the ones it described");
  }
  let artifactBytes = 0;
  for (const [path, bytes] of Object.entries(files)) {
    artifactBytes += bytes.byteLength;
    // oxlint-disable-next-line no-await-in-loop
    const digest = await sha256(bytes);
    if (digest !== artifact.files[path]?.sha256) {
      throw new Error(
        `The package builder's ${path} isn't the file it described`
      );
    }
  }
  if (artifactBytes > request.limits.artifactBytes) {
    throw packageErrors.create("package.quota", {
      quota: "artifactBytes",
      limit: request.limits.artifactBytes,
    });
  }
  return { artifact, files, stats, artifactBytes, builtMs };
};

/**
 * Where a build's files are served: only the browser target's, which
 * runs in a browser; the others never leave core. The lock records how
 * long the address holds first, so it keeps its room until then
 * (`holdLockFor`, locks.ts).
 */
const addressOf = async (
  env: Env,
  {
    app,
    graphHash,
    target,
  }: { app: AppId; graphHash: string; target: PackageArtifact["target"] },
  hash: string
): Promise<string | null> => {
  if (target !== "browser") {
    return null;
  }
  const now = Date.now();
  await holdLockFor(env, { app, graphHash, until: windowedAccessEnd(now) });
  return await packageArtifactAddress(env, { app, graphHash, hash }, now);
};

/** How long a build may hold its lease before another may take it. */
const leaseMs = 5 * 60 * 1000;

/**
 * How long a build waits for another of the same target to end, and how
 * often it looks: a build takes seconds, so a look a second is plenty.
 */
const leaseWaitMs = 60 * 1000;
const leasePollMs = 1000;

/** Which build a lease is for: one target of one App's graph. */
interface Leased {
  app: string;
  graphHash: string;
  target: PackageArtifact["target"];
}

/** That `lease` is the row of `leased`. */
const leaseRow = ({ app, graphHash, target }: Leased): SQL | undefined =>
  and(
    eq(dependencyBuildLeases.appId, app),
    eq(dependencyBuildLeases.graphHash, graphHash),
    eq(dependencyBuildLeases.target, target)
  );

/** Whether another build holds `leased`'s lease now, unexpired: one read. */
const leaseHeld = async (env: Env, leased: Leased): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ expiresAt: dependencyBuildLeases.expiresAt })
    .from(dependencyBuildLeases)
    .where(leaseRow(leased))
    .get();
  return row !== undefined && row.expiresAt.getTime() > Date.now();
};

/**
 * Takes `leased`'s lease for `holder` if no build holds it, or the one
 * that does outlived it; whether it did. One statement: two builds never
 * both take it.
 */
const takeLease = async (
  env: Env,
  leased: Leased,
  holder: string
): Promise<boolean> => {
  const now = Date.now();
  const taken = await drizzle(env.DB)
    .insert(dependencyBuildLeases)
    .values({
      appId: leased.app,
      graphHash: leased.graphHash,
      target: leased.target,
      holder,
      expiresAt: new Date(now + leaseMs),
    })
    .onConflictDoUpdate({
      target: [
        dependencyBuildLeases.appId,
        dependencyBuildLeases.graphHash,
        dependencyBuildLeases.target,
      ],
      set: { holder, expiresAt: new Date(now + leaseMs) },
      setWhere: lt(dependencyBuildLeases.expiresAt, new Date(now)),
    })
    .returning({ holder: dependencyBuildLeases.holder });
  return taken[0]?.holder === holder;
};

/**
 * Gives `leased`'s lease back, if `holder` still holds it. A failure is
 * logged, never thrown: what the build answers stands, and the lease
 * lapses on its own.
 */
const giveLeaseBack = async (
  env: Env,
  leased: Leased,
  holder: string
): Promise<void> => {
  try {
    await drizzle(env.DB)
      .delete(dependencyBuildLeases)
      .where(and(leaseRow(leased), eq(dependencyBuildLeases.holder, holder)));
  } catch (error) {
    log.error("packages.lease_release_failed", {
      app: leased.app,
      ...errorFields(error),
    });
  }
};

/**
 * Waits until `leased`'s lease is `holder`'s: at once if nobody holds it,
 * otherwise once the build that does ends or outlives its lease, looking
 * with a plain read until it's free before trying to take it.
 * `package.build_busy` after {@link leaseWaitMs}.
 */
const leaseFor = async (
  env: Env,
  leased: Leased,
  holder: string
): Promise<void> => {
  const until = Date.now() + leaseWaitMs;
  for (;;) {
    // One look at a time: a plain read, and a write only once it's free.
    // oxlint-disable-next-line no-await-in-loop
    const held = await leaseHeld(env, leased);
    // oxlint-disable-next-line no-await-in-loop
    if (!held && (await takeLease(env, leased, holder))) {
      return;
    }
    if (Date.now() >= until) {
      throw packageErrors.create("package.build_busy");
    }
    // oxlint-disable-next-line no-await-in-loop
    await scheduler.wait(leasePollMs);
  }
};

/** What a build of an approved graph read before it builds. */
interface Asked {
  asked: z.output<typeof packageBuildRequestSchema>;
  admitted: Admitted;
  admit: () => Promise<Admitted>;
}

/**
 * The artifact pinned for the target's config, as the lock is now, if
 * its description is kept: handed out by that alone, with nothing
 * recorded and no file read. Each file's bytes are checked as it is
 * served (serve.ts), every time. Also the lock as read, and the config's
 * hash, for a build to go by when it isn't.
 */
const pinnedNow = async (
  env: Env,
  { asked, admitted }: Asked
): Promise<
  | { kept: PackageBuild }
  | {
      kept: undefined;
      read: { lock: GraspLock; stored: string };
      configHash: string;
      pinned: ArtifactPin | undefined;
    }
> => {
  const read = await lockOf(env, asked.app, asked.graphHash);
  const config = read.lock.targets[asked.target];
  if (config === undefined) {
    throw dependencyErrors.create("dependency.invalid", {
      issues: [`target: the lock has no ${asked.target} target`],
    });
  }
  const configHash = await targetConfigHash(asked.target, config);
  const pinned = read.lock.artifacts?.[compilerVersion]?.[configHash];
  const kept = pinned ? await keptDescription(env, pinned.hash) : undefined;
  if (pinned && kept) {
    await touchPin(env, asked.app, asked.graphHash, read, configHash, pinned);
    return {
      kept: {
        hash: pinned.hash,
        artifact: kept,
        approval: admitted.approval,
        stats: null,
        address: await addressOf(env, asked, pinned.hash),
      },
    };
  }
  return { kept: undefined, read, configHash, pinned };
};

/** Builds and pins the artifact, holding the App's lease. */
const buildUnderLease = async (
  env: Env,
  by: Acting,
  { asked, admitted, admit }: Asked,
  {
    read,
    configHash,
    pinned,
  }: {
    read: { lock: GraspLock; stored: string };
    configHash: string;
    pinned: ArtifactPin | undefined;
  }
): Promise<PackageBuild> => {
  const { lock } = read;
  const { approval } = admitted;
  const limits = packageLimitsOf(env.PACKAGE_LIMITS);
  const packages = await lockedTarballs(env, lock, limits);
  const { artifact, stats, artifactBytes, builtMs, files } =
    await builtArtifact(env, { limits, lock, target: asked.target, packages });
  // The policy may have moved on while the build ran (and, once GRA-359
  // lets an approval be taken back, the approval with it): what decides
  // now wins, and nothing is kept or pinned for a graph no longer
  // admitted. The pin's own write checks it again as it lands.
  await admit();
  const hash = await artifactHash(artifact);
  if (pinned && pinned.hash !== hash) {
    log.error("packages.artifact_mismatch", {
      app: asked.app,
      graphHash: asked.graphHash,
      target: asked.target,
    });
    throw packageErrors.create("package.artifact_mismatch");
  }
  // The files first and the description last: a description there means
  // every file is too. Each keeps its type, the one it is served with.
  //
  // What an artifact's code does at run time is not checked here: no check
  // of text can be complete (a worker or a fetch can be built from any
  // string). The build refuses only what it can decide whole (Node's
  // built-ins, remote imports, imports computed at run time, CSS that
  // fetches from outside, SVGs that aren't only drawing). Run time is
  // bounded where the artifact is served (serve.ts), by this
  // Content-Security-Policy on every one of its files
  // (`packageArtifactPolicy`, security-headers.ts):
  //
  //   default-src 'none'; script-src <the artifact's own origin>;
  //   worker-src 'none'; connect-src 'none';
  //   img-src 'self' data:; font-src 'self' data:; style-src 'self'
  //
  // with `sandbox` (so a file opened as a document, an SVG say, runs
  // nothing) and `X-Content-Type-Options: nosniff` on all, so a file is
  // only ever read as the type stored here.
  //
  // Recorded for cleanup first: if this build fails before its pin holds,
  // the cron deletes what it wrote once no lock names it (cleanup.ts).
  await recordCleanup(env, "build", hash);
  await Promise.all(
    Object.entries(files).map(
      async ([path, bytes]) =>
        await env.FILES.put(fileKey(hash, path), bytes, {
          httpMetadata: { contentType: artifact.files[path]?.type },
        })
    )
  );
  await env.FILES.put(artifactKey(hash), canonicalJson(artifact));
  // Made again under its pin (the kept one was corrupt): the same bytes,
  // and nothing new to record.
  const holds = pinned
    ? pinned.hash
    : await pin(
        env,
        by,
        asked.app,
        asked.graphHash,
        read,
        {
          target: asked.target,
          config: configHash,
          hash,
          exports: Object.fromEntries(
            Object.entries(artifact.entries).map(([entry, { resolved }]) => [
              entry,
              resolved,
            ])
          ),
        },
        limits,
        admitted,
        admit
      );
  if (holds !== hash) {
    throw packageErrors.create("package.artifact_mismatch");
  }
  // Pinned: its files are named by the lock, and need no cleanup, unless
  // the lock gave up its room since (and recorded them again).
  await clearBuildCleanup(env, {
    app: asked.app,
    graphHash: asked.graphHash,
    hash,
  });
  log.info("packages.built", {
    app: asked.app,
    approval,
    target: asked.target,
    hash,
    builtMs,
    buildMs: stats.buildMs,
    initializeMs: stats.initializeMs,
    wasmMemoryBytes: stats.wasmMemoryBytes,
    inputFiles: stats.inputFiles,
    inputBytes: stats.inputBytes,
    artifactBytes,
  });
  return {
    hash,
    artifact,
    approval,
    stats,
    address: await addressOf(env, asked, hash),
  };
};

/**
 * Builds one target of an App's approved graph into an artifact, or
 * returns the one built and pinned before for the target's config. For
 * one of the App's builders, or the chat's agent acting for one; never
 * Grasp staff.
 *
 * One build of each target of an App's graph runs at a time (its lease,
 * spec 19.2): another of the same asked for meanwhile waits for it, then
 * hands out what it pinned when that is what it asks for, without
 * building again. A lease
 * a build outlives (it died) lapses; then two builds could run, and the
 * pin's own conditional write still keeps one artifact per config.
 */
export const buildDependencies = async (
  env: Env,
  by: Acting,
  input: unknown
): Promise<PackageBuild> => {
  const asked = dependencyErrors.parse(
    "dependency.invalid",
    packageBuildRequestSchema,
    input
  );
  if (by.staff) {
    throw dependencyErrors.create("dependency.forbidden");
  }
  await appFor(env, by, asked.app, "builder");
  const admit = async (): Promise<Admitted> =>
    await admitDependencies(env, by.actor ?? actorOf(by), {
      app: asked.app,
      graphHash: asked.graphHash,
      targets: [asked.target],
      policyGeneration: asked.policyGeneration,
    });
  const building: Asked = { asked, admitted: await admit(), admit };
  const before = await pinnedNow(env, building);
  if (before.kept) {
    return before.kept;
  }
  const holder = crypto.randomUUID();
  const leased: Leased = {
    app: asked.app,
    graphHash: asked.graphHash,
    target: asked.target,
  };
  await leaseFor(env, leased, holder);
  try {
    // The wait may have been long: what decides now is what holds, and
    // another build may have pinned it while this one waited.
    const leasedBuild: Asked = { ...building, admitted: await admit() };
    const now = await pinnedNow(env, leasedBuild);
    return now.kept ?? (await buildUnderLease(env, by, leasedBuild, now));
  } finally {
    await giveLeaseBack(env, leased, holder);
  }
};
