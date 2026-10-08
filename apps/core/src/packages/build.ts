import { compilerVersion, startPackageBuilder } from "@grasp-os/compiler";
import type { BuildRequest } from "@grasp-os/compiler";
import { actorOf } from "@grasp-os/shared/audit";
import {
  dependencyErrors,
  dependencyGraphHash,
} from "@grasp-os/shared/dependencies";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import {
  graspLockSchema,
  packageArtifactSchema,
  packageBuildAnswerSchema,
  packageBuildRequestSchema,
  packageErrors,
  packageLimitsOf,
} from "@grasp-os/shared/packages";
import type {
  GraspLock,
  PackageArtifact,
  PackageBuild,
  PackageLimits,
  PackageTarball,
} from "@grasp-os/shared/packages";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appFor } from "../apps.ts";
import { auditedBatch, outboxed } from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import { dependencyLocks, dependencyRequests } from "../db/core/schema.ts";
import { policyGenerationSql } from "../dependencies/policy.ts";
import { admitDependencies } from "../dependencies/requests.ts";
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
//   policy generation the caller read, and records the approval it relied
//   on. The lock is checked to still hash to the approved graph.
// - Other bytes than approved: each tarball is checked against the lock's
//   integrity in core and again in the builder.
// - An artifact that changes under the same lock: the first build of a
//   target by a compiler pins its artifact's hash in the lock; a later
//   build that makes anything else is refused, never swapped in
//   (`package.artifact_mismatch`). A kept artifact is read only after
//   every file's hash is checked again; a corrupt one is built again and
//   must match the pin.
// - What the builder answers: its code is Grasp's, but it handled hostile
//   bytes, so its answer is checked like any input: its shape, every
//   file's SHA-256 against the bytes, and the artifact's size.

/** How the runtime says it stopped an isolate over its limits. */
const overLimit = /exceeded (?:its )?(?:CPU|memory)/iu;

const artifactKey = (hash: string): string => `package-builds/${hash}.json`;
const fileKey = (hash: string, path: string): string =>
  `package-builds/${hash}/${path}`;

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))
  );

/** The hash that names an artifact: of its canonical description. */
const artifactHash = async (artifact: PackageArtifact): Promise<string> =>
  await sha256Hex(canonicalJson(artifact));

/**
 * A kept artifact, if it is there whole: its description hashing to
 * `hash`, and every file's bytes to the hash it names. Anything else is
 * as good as missing.
 */
const keptArtifact = async (
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
  for (const [path, { sha256: expected }] of Object.entries(
    parsed.data.files
  )) {
    // Each file in turn: one that doesn't match ends the check.
    // oxlint-disable-next-line no-await-in-loop
    const file = await env.FILES.get(fileKey(hash, path));
    // oxlint-disable-next-line no-await-in-loop
    const bytes = file ? new Uint8Array(await file.arrayBuffer()) : undefined;
    // oxlint-disable-next-line no-await-in-loop
    if (bytes === undefined || (await sha256(bytes)) !== expected) {
      log.warn("packages.artifact_corrupt", { hash, path });
      return undefined;
    }
  }
  return parsed.data;
};

/** The lock of an App's graph, checked to still be that graph. */
const lockOf = async (
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
  return { lock, stored: row.lock };
};

/** What a target is built for: its conditions and entries, as one text. */
const targetOf = (lock: GraspLock, target: PackageArtifact["target"]): string =>
  JSON.stringify(lock.targets[target] ?? null);

/**
 * Stops a build that returns an existing pin's artifact unless the pin
 * still holds as it returns: the lock read again has the target's entries
 * and conditions as they were read, and the same pin. A resolve may have
 * changed the target (and its pin) while the artifact was read or built;
 * then the artifact is for a target that no longer exists, and the build
 * is stale (`dependency.stale`), never returned.
 */
const checkPinHolds = async (
  env: Env,
  app: string,
  graphHash: string,
  read: GraspLock,
  target: PackageArtifact["target"],
  hash: string
): Promise<void> => {
  const now = await lockOf(env, app, graphHash);
  if (
    targetOf(now.lock, target) !== targetOf(read, target) ||
    now.lock.artifacts?.[compilerVersion]?.[target]?.hash !== hash
  ) {
    throw dependencyErrors.create("dependency.stale");
  }
};

/** What a build was admitted under: re-checked in the write that pins. */
interface Admitted {
  approval: string;
  policyGeneration: number;
}

/**
 * Whether `admitted` still holds as a statement runs: its approval still
 * approved, under the same policy generation.
 */
const stillAdmitted = ({ approval, policyGeneration }: Admitted): SQL =>
  sql`EXISTS (SELECT 1 FROM ${dependencyRequests} WHERE ${dependencyRequests.id} = ${approval} AND ${dependencyRequests.status} = 'approved') AND ${policyGenerationSql} = ${policyGeneration}`;

/**
 * Pins `hash` as what `compilerVersion` builds `target` of the lock to,
 * unless a build pinned something first; returns the pin that holds. One
 * conditional update on the lock as it was read, which lands only while
 * the build's approval holds. A retry after another write re-reads the
 * lock and stops if the target is no longer the one built (a resolve set
 * other entries or conditions): that build is stale, never pinned.
 */
const pin = async (
  env: Env,
  app: string,
  graphHash: string,
  read: { lock: GraspLock; stored: string },
  built: { target: PackageArtifact["target"]; for: string },
  pinned: { hash: string; exports: Record<string, string> },
  limits: PackageLimits,
  admitted: Admitted,
  admit: () => Promise<unknown>
): Promise<string> => {
  const { target } = built;
  if (targetOf(read.lock, target) !== built.for) {
    throw dependencyErrors.create("dependency.stale");
  }
  // Only this compiler's pins are kept: another compiler's artifacts are
  // another release's, which builds its own.
  const next: GraspLock = {
    ...read.lock,
    artifacts: {
      [compilerVersion]: {
        ...read.lock.artifacts?.[compilerVersion],
        [target]: pinned,
      },
    },
  };
  const stored = canonicalJson(next);
  if (new TextEncoder().encode(stored).byteLength > limits.lockBytes) {
    throw packageErrors.create("package.quota", {
      quota: "lockBytes",
      limit: limits.lockBytes,
    });
  }
  const db = drizzle(env.DB);
  const updated = await db
    .update(dependencyLocks)
    .set({ lock: stored })
    .where(
      and(
        eq(dependencyLocks.appId, app),
        eq(dependencyLocks.graphHash, graphHash),
        eq(dependencyLocks.lock, read.stored),
        stillAdmitted(admitted)
      )
    )
    .returning({ lock: dependencyLocks.lock });
  if (updated.length > 0) {
    return pinned.hash;
  }
  // The approval no longer holds (this throws, audited), or another write
  // changed the lock first.
  await admit();
  const now = await lockOf(env, app, graphHash);
  if (targetOf(now.lock, target) !== built.for) {
    throw dependencyErrors.create("dependency.stale");
  }
  return (
    now.lock.artifacts?.[compilerVersion]?.[target]?.hash ??
    (await pin(
      env,
      app,
      graphHash,
      now,
      built,
      pinned,
      limits,
      admitted,
      admit
    ))
  );
};

/**
 * Records in the audit trail that a build used an approval: which App,
 * graph, target and artifact, and whether it was built now or kept from
 * before. Each use, so what relied on which approval can be found.
 */
const recordUse = async (
  env: Env,
  by: Acting,
  used: {
    app: string;
    graphHash: string;
    target: PackageArtifact["target"];
    approval: string;
    hash: string;
    kept: boolean;
  }
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, {
      actor: by.actor ?? actorOf(by),
      action: "dependency.built",
      target: { type: "app", id: used.app },
      detail: { ...used },
    }),
  ]);
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
 * Builds one target of an App's approved graph into an artifact, or
 * returns the one built before. For one of the App's builders, or the
 * chat's agent acting for one; never Grasp staff.
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
  const admit = async () =>
    await admitDependencies(env, by.actor ?? actorOf(by), {
      app: asked.app,
      graphHash: asked.graphHash,
      targets: [asked.target],
      policyGeneration: asked.policyGeneration,
    });
  const admitted = await admit();
  const { approval } = admitted;
  const read = await lockOf(env, asked.app, asked.graphHash);
  const { lock } = read;
  if (lock.targets[asked.target] === undefined) {
    throw dependencyErrors.create("dependency.invalid", {
      issues: [`target: the lock has no ${asked.target} target`],
    });
  }
  const pinned = lock.artifacts?.[compilerVersion]?.[asked.target];
  if (pinned) {
    const kept = await keptArtifact(env, pinned.hash);
    if (kept) {
      // Reading it took time: what decides now wins, and the pin must
      // still be the target's.
      await admit();
      await checkPinHolds(
        env,
        asked.app,
        asked.graphHash,
        lock,
        asked.target,
        pinned.hash
      );
      await recordUse(env, by, {
        app: asked.app,
        graphHash: asked.graphHash,
        target: asked.target,
        approval,
        hash: pinned.hash,
        kept: true,
      });
      return { hash: pinned.hash, artifact: kept, approval, stats: null };
    }
  }
  const limits = packageLimitsOf(env.PACKAGE_LIMITS);
  const packages = await lockedTarballs(env, lock, limits);
  const { artifact, stats, artifactBytes, builtMs, files } =
    await builtArtifact(env, { limits, lock, target: asked.target, packages });
  // The approval may have gone while the build ran: what decides now
  // wins, and nothing is kept or pinned for a graph no longer approved.
  // The pin's own write checks it again as it lands.
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
  // bounded where the artifact is served, by this Content-Security-Policy
  // on every one of its files:
  //
  //   default-src 'none'; script-src <the artifact's own origin>;
  //   worker-src 'none'; connect-src <the host's origin>;
  //   img-src 'self' data:; font-src 'self' data:; style-src 'self'
  //
  // with `sandbox` on SVGs (so one opened as a document runs nothing) and
  // `X-Content-Type-Options: nosniff` on all, so a file is only ever read
  // as the type stored here.
  await Promise.all(
    Object.entries(files).map(
      async ([path, bytes]) =>
        await env.FILES.put(fileKey(hash, path), bytes, {
          httpMetadata: { contentType: artifact.files[path]?.type },
        })
    )
  );
  await env.FILES.put(artifactKey(hash), canonicalJson(artifact));
  if (pinned) {
    // Built again under an existing pin: returned only while the pin
    // still holds for the target as it was read.
    await checkPinHolds(
      env,
      asked.app,
      asked.graphHash,
      lock,
      asked.target,
      pinned.hash
    );
  }
  const holds = pinned
    ? pinned.hash
    : await pin(
        env,
        asked.app,
        asked.graphHash,
        read,
        { target: asked.target, for: targetOf(lock, asked.target) },
        {
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
  await recordUse(env, by, {
    app: asked.app,
    graphHash: asked.graphHash,
    target: asked.target,
    approval,
    hash,
    kept: false,
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
  return { hash, artifact, approval, stats };
};
