import { actorOf } from "@grasp-os/shared/audit";
import type { DependencySubject } from "@grasp-os/shared/dependencies";
import { sha512Integrity } from "@grasp-os/shared/encoding";
import {
  packageBuildAnswerSchema,
  packageErrors,
  packageLimits,
} from "@grasp-os/shared/packages";
import type { GraspLock, PackageTarball } from "@grasp-os/shared/packages";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import { PlatformBoundError, platformRunner } from "../platform-sandbox.ts";
import type { PlatformEnv } from "../platform-sandbox.ts";
import { inOrderReader } from "../sandbox-session.ts";
import { SandboxUnavailableError, sessionHost } from "../sandboxed.ts";
import { knownMalwareIn } from "./malware.ts";
import { approvedLock, refuseMalware } from "./requests.ts";
import { auditTargetOf } from "./subjects.ts";

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
// Nothing is kept here: the modules go into the build of what uses them
// (a workflow version's, workflows/sealed-packages.ts), whose artifacts
// are content-addressed and collected as releases' are.

/**
 * Most bytes of modules core takes from the sandbox host: what a workflow
 * version seals at most, at UTF-8's four bytes a character.
 */
const maxModuleBytes = packageLimits.workflowPackageChars * 4;

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
 * for `whose` (`app:<id>` or `workflow:<id>`, its sub-owner on the sandbox
 * host): the modules, or why not; checked by its caller.
 */
export const runBuilder = async (
  env: PlatformEnv,
  whose: string,
  lock: GraspLock,
  tarballs: PackageTarball[]
): Promise<unknown> => {
  const { inCore, run } = platformRunner(env, whose);
  if (inCore) {
    return await run("package-builder", "build", [lock, tarballs]);
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
  ]);
  const parsed = packageBuildAnswerSchema.safeParse(answer);
  if (!parsed.success || !parsed.data.ok) {
    return answer;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  return {
    ok: true,
    modules: Object.fromEntries(
      Object.keys(parsed.data.modules).map((entry) => [
        entry,
        decoder.decode(joined(written.get(entry) ?? [])),
      ])
    ),
  };
};

/**
 * Each entry of `subject`'s approved graph `graphHash`, built into one ES
 * module, by entry, for `by` (one of its builders), audited as an install
 * (`dependency.built`); and the approval it stands on.
 */
export const buildPackages = async (
  env: Env,
  by: Acting,
  subject: DependencySubject,
  graphHash: string
): Promise<{ approval: string; modules: Record<string, string> }> => {
  // Refused at once where nothing bounds the builder, before any tarball
  // is fetched.
  sessionHost(env);
  const { approval, lock } = await approvedLock(env, subject, graphHash);
  const actor = by.actor ?? actorOf(by);
  const locked = Object.values(lock.packages);
  const [first, ...rest] = await knownMalwareIn(env, locked);
  if (first !== undefined) {
    await refuseMalware(env, actor, subject, [first, ...rest], "build");
  }
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
      tarballs
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
  const { modules } = built.data;
  if (lock.entries.some((entry) => !Object.hasOwn(modules, entry))) {
    throw new Error("The package builder left out an entry.");
  }
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
        entries: lock.entries.length,
      },
    }),
  ]);
  return { approval, modules };
};
