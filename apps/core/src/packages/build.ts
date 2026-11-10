import type { PackageTarget } from "@grasp-os/compiler";
import type { AuditActor } from "@grasp-os/shared/audit";
import type { DependencySubject } from "@grasp-os/shared/dependencies";
import { sha512Integrity } from "@grasp-os/shared/encoding";
import {
  packageBuildAnswerSchema,
  packageErrors,
  packageLimits,
} from "@grasp-os/shared/packages";
import type { GraspLock, PackageTarball } from "@grasp-os/shared/packages";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import type { OutboxEnv } from "../audit-outbox.ts";
import { cacheKeyOf, throughCache } from "../build-cache.ts";
import type { CacheEnv } from "../build-cache.ts";
import { PlatformBoundError, platformRunner } from "../platform-sandbox.ts";
import type { PlatformEnv } from "../platform-sandbox.ts";
import { inOrderReader } from "../sandbox-session.ts";
import { SandboxUnavailableError, sessionHost } from "../sandboxed.ts";
import {
  approvedLock,
  auditTargetOf,
  latestApproval,
  refuseMalware,
} from "./approvals.ts";
import { knownMalwareIn } from "./malware.ts";

/** What building an approved graph reads from core's env. */
export type PackageBuildEnv = PlatformEnv &
  CacheEnv &
  OutboxEnv &
  Pick<Env, "DB" | "CONNECT">;

// Building an approved graph: its tarballs fetched through connect and
// checked against the lock's integrity here, then bundled into one module
// per entry by the package builder (packages/compiler/src/packages), in
// an isolate of its own: on Cloudflare a Dynamic Worker whose CPU the
// runtime bounds, with no network or bindings; on-prem the sandbox host,
// whose supervisor bounds it; nowhere else (`sessionHost` refuses). What
// could go wrong, and what stops it:
//
// - Building what nobody approved: the lock comes from the approval alone
//   (`approvedLock`); a graph that is pending, denied or revoked builds
//   nothing.
// - Other bytes than approved: each tarball's SHA-512 must be the lock's
//   integrity, the one the approval's hash covers.
// - A version reported as malware since it was approved: both sources are
//   asked again first, and a report refuses the build (as does a check
//   that can't be made).
// - What the builder answers: its code is Grasp's, but it handled hostile
//   bytes, so its answer is checked like any input.
//
// - A cached build standing in for governance: an App's bundle bytes may
//   come from the build cache (`appPackageModules`), keyed by the graph's
//   hash, which covers every tarball's integrity; the approval, the
//   malware check and the audit run on every build all the same.

/**
 * Most bytes of modules core takes from the sandbox host for one build:
 * held whole in memory twice (its chunks, then joined), so well under an
 * isolate's memory.
 */
const maxModuleBytes = 8 * 1024 * 1024;

/** `chunks`, in order, as one. */
const joined = (chunks: readonly Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  );
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
};

/**
 * What the package builder answers for building `lock` from `tarballs`,
 * for `whose` (`app:<id>`, its sub-owner on the sandbox
 * host): the modules, or why not; checked by its caller.
 */
export const runBuilder = async (
  env: PlatformEnv,
  whose: string,
  lock: GraspLock,
  tarballs: PackageTarball[],
  target: PackageTarget
): Promise<unknown> => {
  const { inCore, run } = platformRunner(env, whose);
  if (inCore) {
    return await run("package-builder", "build", [lock, tarballs, target]);
  }
  // On the sandbox host neither the tarballs nor the modules fit one of a
  // session's messages: they go a chunk at a time, each read once, in order.
  const written = new Map<string, Uint8Array[]>();
  let bytes = 0;
  const write = (entry: unknown, chunk: unknown): void => {
    if (typeof entry !== "string" || !(chunk instanceof Uint8Array)) {
      throw new TypeError("A chunk of a module isn't in its shape.");
    }
    bytes += chunk.byteLength;
    if (bytes > maxModuleBytes) {
      throw new RangeError("The modules are larger than a build holds.");
    }
    written.set(entry, [...(written.get(entry) ?? []), chunk]);
  };
  const answer = await run("package-builder", "buildRead", [
    lock,
    tarballs.map(({ key, tarball }) => ({ key, size: tarball.byteLength })),
    inOrderReader(tarballs.map(({ key, tarball }) => [key, tarball] as const)),
    write,
    target,
  ]);
  const parsed = packageBuildAnswerSchema.safeParse(answer);
  if (!parsed.success || !parsed.data.ok) {
    return answer;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  return {
    ok: true,
    refused: parsed.data.refused,
    modules: Object.fromEntries(
      Object.keys(parsed.data.modules).map((entry) => [
        entry,
        decoder.decode(joined(written.get(entry) ?? [])),
      ])
    ),
  };
};

/** What one build of a graph makes: each entry's module, or why not. */
interface Bundled {
  modules: Record<string, string>;
  refused: Record<string, string[]>;
}

/**
 * Each entry of `lock` built into one ES module for `target`, from
 * tarballs checked against the lock's integrity, in the package builder's
 * isolate for `subject`.
 */
const bundle = async (
  env: PackageBuildEnv,
  subject: DependencySubject,
  lock: GraspLock,
  target: PackageTarget
): Promise<Bundled> => {
  const locked = Object.values(lock.packages);
  const tarballs: PackageTarball[] = [];
  let archived = 0;
  for (const { name, version, integrity } of locked) {
    // One at a time: connect reads each whole.
    // oxlint-disable-next-line no-await-in-loop
    const tarball = await env.CONNECT.npmTarball({ name, version, integrity });
    // oxlint-disable-next-line no-await-in-loop
    if ((await sha512Integrity(tarball)) !== integrity) {
      throw packageErrors.create("package.integrity_mismatch", {
        package: `${name}@${version}`,
      });
    }
    archived += tarball.byteLength;
    if (archived > packageLimits.archiveBytes) {
      throw packageErrors.create("package.quota", {
        limit: packageLimits.archiveBytes,
      });
    }
    tarballs.push({ key: `${name}@${version}`, tarball });
  }
  let answer: unknown;
  try {
    answer = await runBuilder(
      env,
      `${subject.type}:${subject.id}`,
      lock,
      tarballs,
      target
    );
  } catch (error) {
    if (!(error instanceof PlatformBoundError)) {
      throw error;
    }
    // A stop the packages reach whatever the load is theirs; one the load
    // can cause is the sandbox's, to try again.
    if (error.own) {
      throw packageErrors.create("package.refused", {
        refusals: ["Building them takes more than a build may."],
      });
    }
    throw new SandboxUnavailableError(
      `The package builder was stopped before it finished: ${error.message}`,
      { cause: error }
    );
  }
  const built = packageBuildAnswerSchema.safeParse(answer);
  if (!built.success) {
    throw new Error("The package builder answered in another shape.");
  }
  if (!built.data.ok) {
    throw packageErrors.create("package.refused", {
      refusals: built.data.refusals,
    });
  }
  const { modules, refused } = built.data;
  if (
    lock.entries.some(
      (entry) =>
        !Object.hasOwn(modules, entry) && !Object.hasOwn(refused, entry)
    )
  ) {
    throw new Error("The package builder left out an entry.");
  }
  return { modules, refused };
};

/** A cached build's text, read back as it was written. */
const bundledSchema = z.object({
  modules: z.record(z.string(), z.string()),
  refused: z.record(z.string(), z.array(z.string())),
});

/**
 * `bundle`, its bytes kept in the build cache under graph `graphHash`'s
 * hash, which covers every tarball's integrity, and `target`: the same
 * graph makes the same modules, whichever App asked first.
 */
const bundleCached = async (
  env: PackageBuildEnv,
  subject: DependencySubject,
  lock: GraspLock,
  graphHash: string,
  target: PackageTarget
): Promise<Bundled> => {
  const { text } = await throughCache(
    env,
    await cacheKeyOf("package-modules", [graphHash, target]),
    async () => ({
      text: JSON.stringify(await bundle(env, subject, lock, target)),
      cache: true,
    })
  );
  return bundledSchema.parse(JSON.parse(text));
};

/**
 * Each entry of `subject`'s current approved graph `graphHash`, built into
 * one ES module for `target`, by entry, audited as an install by `actor`
 * (`dependency.built`); and the approval it stands on. With `cached`, the
 * bytes may come from, and go to, the build cache under the graph's hash
 * and `target`: the approval and the malware check (failing closed) are
 * made, and the build audited, all the same.
 */
export const buildPackages = async (
  env: PackageBuildEnv,
  actor: AuditActor,
  subject: DependencySubject,
  graphHash: string,
  target: PackageTarget,
  cached = false
): Promise<Bundled & { approval: string }> => {
  // Refused at once where nothing bounds the builder, before any tarball
  // is fetched.
  sessionHost(env);
  const { approval, lock } = await approvedLock(env, subject, graphHash);
  const [first, ...rest] = await knownMalwareIn(
    env,
    Object.values(lock.packages)
  );
  if (first !== undefined) {
    await refuseMalware(env, actor, subject, [first, ...rest], "build");
  }
  const { modules, refused } = cached
    ? await bundleCached(env, subject, lock, graphHash, target)
    : await bundle(env, subject, lock, target);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, {
      actor,
      action: "dependency.built",
      target: auditTargetOf(subject),
      detail: {
        [subject.type]: subject.id,
        graphHash,
        approval,
        target,
        entries: lock.entries.length,
      },
    }),
  ]);
  return { approval, modules, refused };
};

/**
 * What an App's page (`browser`) or server (`worker`) build is handed of
 * its approved packages (the compiler's `packageModulesFile`): its
 * current approval's graph, each entry bundled for `target`, the bytes
 * cached by graph and target; none while it has no approval. Each build
 * checks the approval and the malware sources again, and is audited for
 * the App. A graph revoked since is no approval: the next build refuses
 * what imports it, as not approved.
 */
export const appPackageModules = async (
  env: PackageBuildEnv,
  app: string,
  target: PackageTarget
): Promise<string | undefined> => {
  const subject: DependencySubject = { type: "app", id: app };
  const graphHash = await latestApproval(env, subject);
  if (graphHash === undefined) {
    return undefined;
  }
  const { modules } = await buildPackages(
    env,
    { type: "system" },
    subject,
    graphHash,
    target,
    true
  );
  return JSON.stringify({ graphHash, modules });
};
