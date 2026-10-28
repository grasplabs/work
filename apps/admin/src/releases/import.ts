/**
 * Imports the releases CI publishes to R2 (scripts/release/upload-release.ts)
 * into the admin's database, on the admin's cron.
 *
 * CI writes a release's blobs first and its manifest,
 * `releases/<id>/manifest.json`, last, so a release is listed only once its
 * manifest exists. Each new one has every blob checked against its manifest
 * (`verifyReleaseBlobs`, the check CI ran before publishing) and is then
 * recorded with its audit event. This protects against partial or
 * corrupted uploads, not against whoever can write to the bucket: a
 * release that's consistent with its own manifest imports.
 *
 * A release with more blobs than one run reads is checked a batch at a
 * time, over as many runs as it takes: each run records how many of its
 * blobs, in its manifest's order, are checked, for that manifest's sha256
 * (`releaseImportProgress`), and the next run goes on from there. It is
 * imported once the last batch checks out.
 *
 * A release that doesn't verify is recorded as failed, audited, and tried
 * again after a wait that doubles with each attempt, so a broken release
 * costs a few reads a day and never holds up the releases after or before
 * it.
 *
 * A release that records platform limits has its limit evidence file
 * next to the manifest (`limitEvidenceKey`, written at publish), read once:
 * its SHA-256 checked against the one R2 checked on write, then the file
 * against the manifest (its release, its commit, and evidence for each
 * limit it raises over the release before it, `verifyLimitEvidence`), and
 * that release against the admin's own record of it when it holds one, all
 * before anything is stored. Its bytes and sha256 are recorded with the
 * release; each deploy then holds the release to the client's profile
 * (src/releases/limits.ts). A signature over both (GRA-891's pattern) is
 * what would stop a bucket writer forging evidence too: it would be
 * checked here, before any of this is read.
 *
 * Idempotent: an imported release is skipped, and one imported by a run
 * that overlapped this one is recorded, and audited, once.
 */

import { toHex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  blobCount,
  limitEvidenceFileSchema,
  limitEvidenceKey,
  limitRaises,
  manifestKey,
  platformLimitsSchema,
  releaseIdSchema,
  releaseManifestSchema,
  sha256OfBytes,
  verifyLimitEvidence,
  verifyReleaseBlobs,
} from "@grasp-os/shared/release";
import type {
  Bytes,
  LimitEvidenceFile,
  PlatformLimits,
  ReleaseManifest,
} from "@grasp-os/shared/release";
import { eq, sql } from "drizzle-orm";

import { actIfChanged } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  auditEvents,
  releaseImportFailures,
  releaseImportProgress,
  releases,
} from "../db/schema.ts";
import { startsMajor } from "./version.ts";

/**
 * The releases bucket, as the import uses it: reading only, so the import
 * can't write to it. CI is the only writer; a release never changes once
 * published.
 */
export type ReleaseStore = Pick<R2Bucket, "get" | "list">;

const RELEASES_PREFIX = "releases/";

/**
 * Most releases one run imports. Every merge is a release, so a run
 * normally finds one or none; this bounds the first run, or one after an
 * outage, and the rest follow on the next runs.
 */
export const MAX_IMPORTS_PER_RUN = 5;

/**
 * Most R2 reads a run makes, which count towards the Worker's subrequest
 * limit. A release costs its manifest plus one read per blob (about 700
 * today); what doesn't fit in what the run has left is checked on the
 * next runs.
 */
export const MAX_READS_PER_RUN = 500;

/**
 * Most blobs a release may name: about three times today's, read over a
 * few runs. A bound on a broken manifest, not on the runs: the batches
 * keep each run within its reads whatever the count.
 */
export const MAX_BLOBS_PER_RELEASE = 2000;

/**
 * Blobs read at once. A release's largest module is about 10 MB today:
 * two at a time, with their hashing, stays well inside the Worker's memory.
 */
const READ_CONCURRENCY = 2;

/** Largest manifest the import reads; today's is about 35 KB. */
export const MAX_MANIFEST_BYTES = 1_000_000;

/** Largest limit evidence file the import reads: a few entries a release. */
export const MAX_LIMIT_EVIDENCE_BYTES = 100_000;

/** The wait after a release's first failed attempt: the next run. */
const FIRST_RETRY_MS = 5 * 60 * 1000;
/** The longest wait between attempts. */
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;

/** What one run did, by release id. */
export interface ImportResult {
  imported: string[];
  /** Published, but didn't verify: tried again after a wait. */
  failed: string[];
}

/** The id of every release with a manifest in `store`. */
const publishedIds = async (store: ReleaseStore): Promise<string[]> => {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const page = await store.list({
      prefix: RELEASES_PREFIX,
      delimiter: "/",
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const prefix of page.delimitedPrefixes) {
      const id = prefix.slice(RELEASES_PREFIX.length, -1);
      if (releaseIdSchema.safeParse(id).success) {
        ids.push(id);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return ids;
};

const ciRelease = /^r(?<run>\d+)-(?<sha>[0-9a-f]{7})$/u;

/** A CI release's run number; -1 for a local build (`dev-`). */
const runOf = (id: string): number =>
  Number(ciRelease.exec(id)?.groups?.run ?? -1);

/** CI releases by run number, newest first, then local builds. */
const newestFirst = (a: string, b: string): number =>
  runOf(b) - runOf(a) || b.localeCompare(a);

/** Reads from `store`, counting the reads. */
class Reader {
  reads = 0;
  readonly #store: ReleaseStore;

  constructor(store: ReleaseStore) {
    this.#store = store;
  }

  /**
   * The object at `key`, or undefined when there's none. Refuses one whose
   * size fails `sizeOk` before reading its body.
   */
  async read(
    key: string,
    sizeOk: (size: number) => boolean,
    expected: string
  ): Promise<Bytes | undefined> {
    this.reads += 1;
    const object = await this.#store.get(key);
    if (object === null) {
      return undefined;
    }
    if (!sizeOk(object.size)) {
      await object.body.cancel();
      throw new Error(`${key} is ${object.size} bytes; expected ${expected}`);
    }
    return new Uint8Array(await object.arrayBuffer());
  }

  /**
   * As `read`, with the SHA-256 R2 checked when it was written (hex), or
   * undefined when it was written without one.
   */
  async readChecked(
    key: string,
    maxBytes: number
  ): Promise<{ bytes: Bytes; storedSha256: string | undefined } | undefined> {
    this.reads += 1;
    const object = await this.#store.get(key);
    if (object === null) {
      return undefined;
    }
    if (object.size > maxBytes) {
      await object.body.cancel();
      throw new Error(`${key} is ${object.size} bytes; at most ${maxBytes}`);
    }
    // The checksum R2 verified on write (`x-amz-checksum-sha256`), or, as
    // CI also sends it, the same value in the object's metadata.
    const stored = object.checksums.sha256;
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      storedSha256:
        stored === undefined
          ? object.customMetadata?.sha256
          : toHex(new Uint8Array(stored)),
    };
  }
}

/**
 * The manifest at `id`'s key, checked to be release `id`'s, and its text:
 * strict UTF-8, a byte-order mark kept (and refused by the JSON parser).
 */
const parseManifest = (
  id: string,
  bytes: Bytes
): { manifest: ReleaseManifest; text: string } => {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const manifest = releaseManifestSchema.parse(JSON.parse(text));
  if (manifest.releaseId !== id) {
    throw new Error(
      `The manifest at ${manifestKey(id)} names release ${manifest.releaseId}`
    );
  }
  const sha = ciRelease.exec(id)?.groups?.sha;
  if (sha !== undefined && !manifest.commit.startsWith(sha)) {
    throw new Error(
      `Release ${id} names commit ${manifest.commit}, not one starting ${sha}`
    );
  }
  return { manifest, text };
};

/** Whether two releases' limits are the same, name for name. */
const sameLimits = (a: PlatformLimits, b: PlatformLimits): boolean => {
  const names = Object.keys(a);
  return (
    names.length === Object.keys(b).length &&
    names.every((name) => Object.hasOwn(b, name) && a[name] === b[name])
  );
};

/**
 * Throws when the release `evidence` says came before `manifest`'s is one
 * the admin holds and isn't what it says: built later, or with other
 * limits than the file raises over. One the admin doesn't hold (yet) is
 * taken at its word here; what a client runs never is
 * (src/releases/limits.ts).
 */
const checkPreviousRelease = async (
  db: AdminDatabase,
  manifest: ReleaseManifest,
  evidence: LimitEvidenceFile
): Promise<void> => {
  const previous = evidence.previousRelease;
  if (previous === null) {
    return;
  }
  const [row] = await db
    .select({
      builtAt: releases.builtAt,
      limits: sql<
        string | null
      >`json_extract(${releases.manifest}, '$.platformLimits')`,
    })
    .from(releases)
    .where(eq(releases.id, previous.releaseId));
  if (row === undefined) {
    return;
  }
  if (row.builtAt >= new Date(manifest.createdAt)) {
    throw new Error(
      `Release ${manifest.releaseId} names ${previous.releaseId}, built after it, as previous`
    );
  }
  const limits =
    row.limits === null
      ? undefined
      : platformLimitsSchema.safeParse(JSON.parse(row.limits)).data;
  if (limits === undefined) {
    throw new Error(
      `Release ${manifest.releaseId} names ${previous.releaseId} as previous, which records no limits`
    );
  }
  if (!sameLimits(limits, previous.platformLimits)) {
    throw new Error(
      `Release ${manifest.releaseId} raises its limits over other values than ${previous.releaseId} has`
    );
  }
};

/**
 * The limit evidence file of `manifest`'s release, read once and checked
 * before anything is stored: its SHA-256 the one R2 checked on write, the
 * release's own, covering each raise (`verifyLimitEvidence`), over a
 * previous release the admin's records agree with. Undefined for a
 * release that records no limits.
 */
const readLimitEvidence = async (
  reader: Reader,
  db: AdminDatabase,
  manifest: ReleaseManifest
): Promise<
  { evidence: LimitEvidenceFile; text: string; sha256: string } | undefined
> => {
  if (manifest.platformLimits === undefined) {
    return undefined;
  }
  const key = limitEvidenceKey(manifest.releaseId);
  const read = await reader.readChecked(key, MAX_LIMIT_EVIDENCE_BYTES);
  if (read === undefined) {
    throw new Error(
      `Release ${manifest.releaseId} records platform limits but has no ${key}`
    );
  }
  const sha256 = await sha256OfBytes(read.bytes);
  if (read.storedSha256 !== sha256) {
    throw new Error(
      `${key} is ${sha256}, not the ${read.storedSha256 ?? "unrecorded"} SHA-256 R2 checked on write`
    );
  }
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(read.bytes);
  const evidence = limitEvidenceFileSchema.parse(JSON.parse(text));
  if (
    evidence.releaseId !== manifest.releaseId ||
    evidence.commit !== manifest.commit
  ) {
    throw new Error(
      `${key} is for ${evidence.releaseId} at ${evidence.commit}, not ${manifest.releaseId} at ${manifest.commit}`
    );
  }
  if (evidence.previousRelease?.releaseId === manifest.releaseId) {
    throw new Error(`Release ${manifest.releaseId} names itself as previous`);
  }
  verifyLimitEvidence({
    ...evidence,
    platformLimits: manifest.platformLimits,
  });
  await checkPreviousRelease(db, manifest, evidence);
  return { evidence, text, sha256 };
};

/** What `manifest`'s release raises, on which profiles, for the audit trail. */
const raisedOf = (
  manifest: ReleaseManifest,
  evidence: LimitEvidenceFile | undefined
): string => {
  const limits = manifest.platformLimits;
  if (limits === undefined || evidence === undefined) {
    return "";
  }
  return limitRaises(evidence.previousRelease?.platformLimits ?? limits, limits)
    .map(({ limit, raisedTo }) => {
      const profiles = evidence.limitEvidence
        .filter((entry) => entry.limit === limit)
        .map((entry) => entry.profile);
      return `${limit} to ${raisedTo ?? "unbounded"} on ${profiles.join("+")}`;
    })
    .join("; ");
};

/**
 * Verifies release `id` and records it: `absent` when it has no manifest
 * (yet), `deferred` when the run's reads ran out before its last blob,
 * the blobs checked so far recorded for the next run. Throws when it
 * doesn't verify.
 */
const importRelease = async (
  reader: Reader,
  db: AdminDatabase,
  id: string
): Promise<"imported" | "absent" | "deferred"> => {
  const manifestBytes = await reader.read(
    manifestKey(id),
    (size) => size <= MAX_MANIFEST_BYTES,
    `at most ${MAX_MANIFEST_BYTES}`
  );
  if (manifestBytes === undefined) {
    return "absent";
  }
  const { manifest, text } = parseManifest(id, manifestBytes);
  const blobs = blobCount(manifest);
  if (blobs > MAX_BLOBS_PER_RELEASE) {
    throw new Error(
      `Release ${id} names ${blobs} blobs; at most ${MAX_BLOBS_PER_RELEASE} are read`
    );
  }
  const manifestSha256 = await sha256OfBytes(manifestBytes);
  // Where an earlier run got to, for this very manifest: another (a broken
  // upload put right) is checked from its start.
  const [progress] = await db
    .select()
    .from(releaseImportProgress)
    .where(eq(releaseImportProgress.releaseId, id));
  const from =
    progress?.manifestSha256 === manifestSha256
      ? Math.min(progress.verifiedBlobs, blobs)
      : 0;
  // What this run may still read, less one for the evidence file of a
  // release that records limits, which its last batch reads.
  const budget = MAX_READS_PER_RUN - reader.reads - 1;
  const to = Math.min(blobs, from + Math.max(budget, 0));
  if (budget < 0 || (to <= from && from < blobs)) {
    return "deferred";
  }
  await verifyReleaseBlobs(
    manifest,
    async (key, size) =>
      await reader.read(key, (actual) => actual === size, String(size)),
    { concurrency: READ_CONCURRENCY, from, to }
  );
  if (to < blobs) {
    const updatedAt = new Date();
    await db
      .insert(releaseImportProgress)
      .values({ releaseId: id, manifestSha256, verifiedBlobs: to, updatedAt })
      .onConflictDoUpdate({
        target: releaseImportProgress.releaseId,
        set: { manifestSha256, verifiedBlobs: to, updatedAt },
      });
    return "deferred";
  }
  const limitEvidence = await readLimitEvidence(reader, db, manifest);
  // What it raises, on which profiles: in the audit trail with the import,
  // as `<limit> to <value> on <profile>+<profile>`, one per limit.
  const raised = raisedOf(manifest, limitEvidence?.evidence);
  await actIfChanged(
    db,
    "system",
    db
      .insert(releases)
      .values({
        id,
        commitSha: manifest.commit,
        manifest: text,
        manifestSha256,
        limitEvidence: limitEvidence?.text ?? null,
        limitEvidenceSha256: limitEvidence?.sha256 ?? null,
        builtAt: new Date(manifest.createdAt),
        importedAt: new Date(),
        feature: startsMajor(manifest.notes),
      })
      .onConflictDoNothing(),
    {
      action: "release.import",
      target: id,
      detail: {
        commit: manifest.commit,
        manifestSha256,
        ...(limitEvidence === undefined
          ? {}
          : { limitEvidenceSha256: limitEvidence.sha256 }),
        ...(raised === "" ? {} : { raised }),
      },
    }
  );
  // Bookkeeping only: the import itself is what's audited.
  await db.batch([
    db
      .delete(releaseImportFailures)
      .where(eq(releaseImportFailures.releaseId, id)),
    db
      .delete(releaseImportProgress)
      .where(eq(releaseImportProgress.releaseId, id)),
  ]);
  return "imported";
};

/** Past this many doublings the wait is at its longest anyway. */
const MAX_DOUBLINGS = 20;

/**
 * Records a failed attempt at `id` and when to try again, and audits it,
 * in one batch. The count goes up in SQL, and the audit event reads it
 * back from the row, so runs that fail the same release at once each count.
 */
const recordFailure = async (
  db: AdminDatabase,
  id: string,
  now: Date
): Promise<void> => {
  const at = now.getTime();
  const { attempts } = releaseImportFailures;
  // The wait after the nth attempt is FIRST_RETRY_MS * 2^(n - 1): in the
  // update, `attempts` is still the count before this one.
  const record = db
    .insert(releaseImportFailures)
    .values({
      releaseId: id,
      attempts: 1,
      failedAt: now,
      nextAttemptAt: new Date(at + FIRST_RETRY_MS),
    })
    .onConflictDoUpdate({
      target: releaseImportFailures.releaseId,
      set: {
        attempts: sql`${attempts} + 1`,
        failedAt: now,
        nextAttemptAt: sql`${at} + min(${FIRST_RETRY_MS} * (1 << min(${attempts}, ${MAX_DOUBLINGS})), ${MAX_RETRY_MS})`,
      },
    });
  const audit = db
    .insert(auditEvents)
    .select(
      sql`SELECT ${crypto.randomUUID()}, ${at}, 'system', 'release.import_failed', NULL, ${id}, json_object('attempts', ${attempts}) FROM ${releaseImportFailures} WHERE ${releaseImportFailures.releaseId} = ${id}`
    );
  // A failed attempt starts the next from the release's first blob.
  const restart = db
    .delete(releaseImportProgress)
    .where(eq(releaseImportProgress.releaseId, id));
  await db.batch([record, audit, restart]);
};

/**
 * Imports the releases published to `store` that `db` doesn't hold yet,
 * newest first: until {@link MAX_IMPORTS_PER_RUN} are imported or
 * {@link MAX_READS_PER_RUN} are spent, a release the reads ran out in
 * going on from there next run. A release that failed is
 * passed over until its next attempt is due.
 */
export const importReleases = async (
  store: ReleaseStore,
  db: AdminDatabase,
  { now = new Date() }: { now?: Date } = {}
): Promise<ImportResult> => {
  const imported = await db.select({ id: releases.id }).from(releases);
  const known = new Set(imported.map((row) => row.id));
  const failed = await db.select().from(releaseImportFailures);
  const due = new Map(
    failed.map((row) => [row.releaseId, row.nextAttemptAt.getTime()])
  );
  const published = await publishedIds(store);
  const pending = published
    .filter((id) => !known.has(id))
    .filter((id) => (due.get(id) ?? 0) <= now.getTime())
    .toSorted(newestFirst);

  const reader = new Reader(store);
  const result: ImportResult = { imported: [], failed: [] };
  // One release at a time, to bound the blobs read at once.
  for (const id of pending) {
    if (
      result.imported.length >= MAX_IMPORTS_PER_RUN ||
      reader.reads >= MAX_READS_PER_RUN
    ) {
      break;
    }
    let outcome: Awaited<ReturnType<typeof importRelease>>;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one release at a time
      outcome = await importRelease(reader, db, id);
    } catch (error) {
      result.failed.push(id);
      log.error("release.import_failed", {
        releaseId: id,
        ...errorFields(error),
      });
      // oxlint-disable-next-line no-await-in-loop -- one release at a time
      await recordFailure(db, id, now);
      continue;
    }
    if (outcome === "deferred") {
      // The reads ran out in its blobs: the next run goes on from there.
      break;
    }
    if (outcome === "imported") {
      result.imported.push(id);
    }
  }
  return result;
};
