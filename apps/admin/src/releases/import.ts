/**
 * Imports the releases CI publishes to R2 (scripts/release/upload-release.ts)
 * into the admin's database: as soon as R2 tells the admin a manifest was
 * written (its event notification, through the admin's queue), and on the
 * admin's cron every minute, which catches whatever the queue doesn't
 * bring (src/server.ts). Each run is the same import, and reads what the
 * bucket holds, never what told it to run. One runs at a time: the admin
 * holds the `releases` lease around it (src/db/lease.ts).
 *
 * CI writes a release's blobs first and its manifest,
 * `releases/<id>/manifest.json`, last, so a release is listed only once its
 * manifest exists. A new one is checked against its manifest, then
 * recorded with its audit event:
 *
 * - its manifest: signed by a key Grasp trusts, at the signature file
 *   CI stored before it (@grasp-os/shared/release-signature); its id the
 *   one its key names, every blob at its content address, every static
 *   file it indexes one a Worker serves (`blobsOf`);
 * - each blob the newest imported release whose bundle is kept checked
 *   the same way (the same key, size and, for a static file, extension:
 *   `checksOf`), most of a release, as a merge changes a few files: not
 *   read again. Blobs are content-addressed, that release's import read
 *   and hashed it (or found it so checked by the release before it), and
 *   retention never deletes a blob a kept release names. Its head says
 *   it's still there, at its size, and, for a module or migration, with
 *   the SHA-256 R2 checked as CI stored it (`storedBlobProblem`);
 * - each other blob: read whole and hashed, as CI hashed it (`checkBlob`);
 * - its model files, about 100 MB and never read whole here: by their
 *   heads, there, at their size, with the SHA-256 R2 computed when CI
 *   stored them.
 *
 * So a release imports only with every blob there at its size, every blob
 * new to it hashed, and every module and migration at its SHA-256 where R2
 * kept one. What the import doesn't see is a blob an earlier import
 * checked that has since been rewritten with other bytes of the same size
 * and, for a module or migration, without a SHA-256. The deploy stops
 * that before it serves: it hashes every module, migration and static
 * file as it reads them from the bucket (src/deploy/release.ts), and each
 * model file as it streams (src/deploy/model-files.ts), against the
 * manifest this import saved. The signature is what protects against
 * whoever can write to the bucket: a manifest they write or change has
 * none that verifies, and is refused, alerted as a failed import; the
 * blobs it names are then checked against it as above. Once `releases/`
 * is locked in the bucket (set by hand, once), a published manifest can't
 * be rewritten either.
 *
 * A request R2 fails is tried again, after a short wait, a few times. A run
 * makes at most {@link MAX_REQUESTS_PER_RUN} requests and tries at most
 * {@link MAX_RELEASES_PER_RUN} releases. How many of a release's blobs, in
 * its manifest's order, are checked is recorded a batch at a time, for
 * that manifest's sha256 (`releaseImportProgress`), so a release a run
 * doesn't finish, fails, or dies in goes on from there.
 *
 * Each attempt at a release is counted as it starts, and the next waits
 * for a time that doubles with each one, so a release that doesn't verify,
 * or that a run dies in, costs a few reads a day and never holds up the
 * releases after or before it. One that doesn't verify is audited.
 *
 * Idempotent: an imported release is skipped, and one imported by a run
 * that overlapped this one is recorded, and audited, once, with nothing
 * of the other run's attempt left behind.
 */

import "@tanstack/react-start/server-only";
import { toHex } from "@grasp-os/shared/encoding";
import { errorFields, errorName, log } from "@grasp-os/shared/log";
import {
  blobSize,
  blobsOf,
  checkBlob,
  checksOf,
  manifestKey,
  mapConcurrently,
  releaseManifestSchema,
  sha256OfBytes,
  storedBlobProblem,
  storedModelFileProblem,
} from "@grasp-os/shared/release";
import type {
  Bytes,
  ReleaseBlob,
  ReleaseManifest,
} from "@grasp-os/shared/release";
import {
  compareReleaseIds,
  releaseIdSchema,
} from "@grasp-os/shared/release-id";
import {
  MAX_SIGNATURE_BYTES,
  releaseSignatureProblem,
  signatureKey,
} from "@grasp-os/shared/release-signature";
import { releaseSigningKeys } from "@grasp-os/shared/release-signing-keys";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { alert } from "../alerts/alert.ts";
import { actIfChanged } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  auditEvents,
  releaseImportFailures,
  releaseImportProgress,
  releases,
} from "../db/schema.ts";
import { toEdge } from "../rollout/channels.ts";
import { recordBlobs } from "./blobs.ts";

/**
 * The releases bucket, as the import uses it: reading only, so the import
 * can't write to it. CI is the only writer; a release never changes once
 * published.
 */
export type ReleaseStore = Pick<R2Bucket, "get" | "list">;

/** The releases bucket as the import reads it: its objects' heads too. */
export type ImportStore = ReleaseStore & Pick<R2Bucket, "head">;

const RELEASES_PREFIX = "releases/";

/**
 * Most releases one run tries, imported, failed or deferred alike. Every
 * merge is a release, so a run normally finds one or none; this bounds the
 * first run, or one after an outage, and however many broken releases are
 * due at once: each costs at most about 15 D1 statements (its attempt, its
 * blobs on record, its progress a batch at a time, its record or its
 * failure), so a run makes at most about 150 besides its R2 requests.
 * The rest follow on the next runs.
 */
export const MAX_RELEASES_PER_RUN = 10;

/**
 * Most requests to R2 a run makes, heads, reads and their retries alike.
 * Every call to R2 or D1 is a subrequest, and the Workers Paid plan allows
 * 10,000 an invocation by default, which the admin keeps (no `limits` of
 * subrequests in its wrangler.jsonc; "Subrequests" at
 * developers.cloudflare.com/workers/platform/limits/, read 27 Nov 2026).
 * The import takes half: the rest is for its D1 statements (bounded by
 * {@link MAX_RELEASES_PER_RUN}), its listing (a page per 1,000 releases),
 * and, on the cron, the retention, reconciling and provisioning that
 * share the invocation. A release built from main today
 * (1,163 blobs and 3 model files) costs 1,168 with its manifest and
 * signature, so a run imports four; a release it doesn't finish goes on
 * next run from where it got.
 */
export const MAX_REQUESTS_PER_RUN = 5000;

/**
 * Most blobs a release may name: about 1.7 times today's. A bound on a
 * broken manifest, well inside a run's requests, so any release a run
 * starts with all of them left fits in it.
 */
export const MAX_BLOBS_PER_RELEASE = 2000;

/**
 * Requests in flight at once. A Worker has at most six waiting for their
 * response headers, and the rest only queue ("Simultaneous open
 * connections" on the limits page above).
 */
const REQUESTS_AT_ONCE = 6;

/**
 * Largest blob a release may name: Cloudflare's limit on a static file,
 * 25 MiB ("Static Assets" at developers.cloudflare.com/workers/platform/
 * limits/); today's largest is about 14 MB (the compiler's WebAssembly).
 * A release naming a larger one fails before anything is read.
 */
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;

/**
 * Bytes of blobs read whole at once, a blob larger than this read alone:
 * hashing a static file holds its base64 too (a third more), so what's
 * read stays well inside the Worker's 128 MB.
 */
const READ_BYTES_AT_ONCE = MAX_BLOB_BYTES;

/**
 * Blobs checked a batch at a time, in the manifest's order: each batch's
 * progress is recorded as it checks out, so a run that dies goes on from
 * the last batch.
 */
const BATCH = 250;

/**
 * The waits before each retry of a request R2 failed (threw at): about
 * three seconds in all, then the release fails, and goes on from there at
 * its next attempt.
 */
const RETRY_DELAYS_MS = [250, 1000, 2000] as const;

/** Largest manifest the import reads; today's is about 350 KB. */
export const MAX_MANIFEST_BYTES = 1_000_000;

/**
 * The wait after a release's first attempt that didn't import it: the
 * next cron run, a minute later, a little under so that a run starting a
 * moment early still tries.
 */
const FIRST_RETRY_MS = 50 * 1000;
/** The longest wait between attempts. */
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;

/** What one run did, by release id. */
export interface ImportResult {
  imported: string[];
  /** Published, but didn't verify: tried again after a wait. */
  failed: string[];
  /**
   * Whether it read every release published and not yet imported (those
   * waiting after a failure were read before): each one's blobs are on
   * record (src/releases/blobs.ts), so retention may run.
   */
  caughtUp: boolean;
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

/** Newest first, by id (`compareReleaseIds`): local builds last. */
const newestFirst = (a: string, b: string): number => compareReleaseIds(b, a);

/** The run's requests are spent: what it was checking goes on next run. */
class RequestsSpentError extends Error {
  constructor() {
    super("The run's requests to R2 are spent");
    this.name = "RequestsSpentError";
  }
}

/** What R2 reports of an object: its size and the SHA-256 (hex) it kept, if any. */
interface StoredObject {
  size: number;
  sha256?: string;
}

/**
 * Reads from `store` within the run's requests ({@link MAX_REQUESTS_PER_RUN}),
 * each request R2 fails tried again after a wait (`RETRY_DELAYS_MS`).
 */
const readerOf = (store: ImportStore) => {
  let left = MAX_REQUESTS_PER_RUN;
  const request = async <T>(
    send: () => Promise<T>,
    key: string
  ): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      if (left <= 0) {
        throw new RequestsSpentError();
      }
      left -= 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- tries in turn
        return await send();
      } catch (error) {
        const wait = RETRY_DELAYS_MS[attempt];
        if (wait === undefined) {
          throw error;
        }
        log.warn("release.import_retry", { key, ...errorFields(error) });
        // oxlint-disable-next-line no-await-in-loop -- waits between tries
        await scheduler.wait(wait);
      }
    }
  };
  return {
    /** Whether the run has requests left. */
    spent: (): boolean => left <= 0,

    /** What R2 reports of the object at `key`, or null when there's none. */
    head: async (key: string): Promise<StoredObject | null> => {
      const head = await request(async () => await store.head(key), key);
      if (head === null) {
        return null;
      }
      const { sha256 } = head.checksums;
      return {
        size: head.size,
        ...(sha256 === undefined
          ? {}
          : { sha256: toHex(new Uint8Array(sha256)) }),
      };
    },

    /**
     * The object at `key`, or undefined when there's none. Refuses one
     * whose size fails `sizeOk` before reading its body.
     */
    read: async (
      key: string,
      sizeOk: (size: number) => boolean,
      expected: string
    ): Promise<Bytes | undefined> => {
      // Only what R2 fails is tried again, never a size that's wrong.
      const read = await request(async () => {
        const object = await store.get(key);
        if (object === null) {
          return null;
        }
        if (!sizeOk(object.size)) {
          await object.body.cancel();
          return { size: object.size };
        }
        return { bytes: new Uint8Array(await object.arrayBuffer()) };
      }, key);
      if (read === null) {
        return undefined;
      }
      if (!("bytes" in read)) {
        throw new Error(`${key} is ${read.size} bytes; expected ${expected}`);
      }
      return read.bytes;
    },
  };
};

type Reader = ReturnType<typeof readerOf>;

/** `error` as an Error, whatever was thrown. */
const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * Runs the tasks it's given while those running weigh at most `capacity`
 * together, the others in the order they came as weight frees up; a task
 * heavier than that alone.
 */
const gate = (capacity: number) => {
  let free = capacity;
  const waiting: { weight: number; wake: () => void }[] = [];
  return async <T>(bytes: number, task: () => Promise<T>): Promise<T> => {
    const weight = Math.min(bytes, capacity);
    if (waiting.length === 0 && weight <= free) {
      free -= weight;
    } else {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      waiting.push({
        weight,
        wake: () => {
          resolve(true);
        },
      });
      await promise;
    }
    try {
      return await task();
    } finally {
      free += weight;
      // The tasks waiting go in turn, as long as the next one fits.
      let [next] = waiting;
      while (next !== undefined && next.weight <= free) {
        waiting.shift();
        free -= next.weight;
        next.wake();
        [next] = waiting;
      }
    }
  };
};

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
  return { manifest, text };
};

/**
 * What the newest imported release whose bundle is kept checked of each
 * of its blobs (`checksOf`), by key: a release shares most of its blobs
 * with the one before it. Its import read and hashed each, or found it
 * checked the same way by the release before it, and so on back; and
 * retention never deletes a blob a kept release names. Nothing when no
 * release is imported, or its manifest no longer parses as this admin's
 * (another manifest version): then every blob is read.
 */
const checkedBefore = async (
  db: AdminDatabase
): Promise<Map<string, ReadonlySet<string>>> => {
  const [newest] = await db
    .select({ manifest: releases.manifest })
    .from(releases)
    .where(isNull(releases.bundleDeletedAt))
    .orderBy(desc(releases.importedAt))
    .limit(1);
  const parsed =
    newest === undefined
      ? undefined
      : releaseManifestSchema.safeParse(JSON.parse(newest.manifest));
  if (parsed?.success !== true) {
    return new Map();
  }
  return new Map(
    blobsOf(parsed.data).map((blob) => [blob.key, new Set(checksOf(blob))])
  );
};

/**
 * Checks `blobs` against the manifest, in its order: one whose checks are
 * all among those `before` holds of its key by its head, any other read
 * whole. Returns, once every check it started has settled, how many of
 * them, from the first, checked out, and, when one didn't, why.
 */
const checkBlobs = async (
  reader: Reader,
  blobs: readonly ReleaseBlob[],
  before: ReadonlyMap<string, ReadonlySet<string>>
): Promise<{ checked: number; error?: Error }> => {
  const done = blobs.map(() => false);
  const started: Promise<void>[] = [];
  // Set once one fails: a read still waiting for its turn isn't made.
  let stopped = false;
  const whole = gate(READ_BYTES_AT_ONCE);
  const checkOne = async ([index, blob]: [number, ReleaseBlob]) => {
    const checked = before.get(blob.key);
    if (checksOf(blob).every((check) => checked?.has(check) === true)) {
      const problem = storedBlobProblem(blob, await reader.head(blob.key));
      if (problem !== undefined) {
        throw new Error(`${blob.key} ${problem}`);
      }
    } else {
      const size = blobSize(blob);
      await whole(size, async () => {
        if (stopped) {
          throw new Error(`${blob.key} wasn't read: another blob failed`);
        }
        await checkBlob(
          blob,
          await reader.read(blob.key, (actual) => actual === size, String(size))
        );
      });
    }
    done[index] = true;
  };
  try {
    await mapConcurrently(
      [...blobs.entries()],
      REQUESTS_AT_ONCE,
      async (entry) => {
        const check = checkOne(entry);
        started.push(check);
        await check;
      }
    );
    return { checked: blobs.length };
  } catch (error) {
    stopped = true;
    // The run goes on only once nothing of this release is still read.
    await Promise.allSettled(started);
    return { checked: done.indexOf(false), error: asError(error) };
  }
};

/**
 * Throws unless the bucket holds each model file `manifest` names at its
 * size, stored with its SHA-256: R2 computes and checks that when CI
 * stores it (scripts/release/upload-release.ts), so its head says what
 * the bytes are without this reading them. One stored without it is
 * refused, not read.
 */
const checkModelFiles = async (
  reader: Reader,
  manifest: ReleaseManifest
): Promise<void> => {
  for (const file of manifest.modelFiles) {
    // oxlint-disable-next-line no-await-in-loop -- a few files
    const problem = storedModelFileProblem(file, await reader.head(file.r2Key));
    if (problem !== undefined) {
      throw new Error(`${file.r2Key} (${file.name}) ${problem}`);
    }
  }
};

/**
 * Throws unless release `id`'s manifest, `manifestBytes`, verifies with
 * the signature file stored for it (`signatureKey`), against the keys
 * Grasp trusts. Every release it imports is signed: one published before
 * signing began was imported then, and is never checked again. Its
 * error's name, `UnverifiedReleaseError`, is the code its alert carries.
 */
const checkSignature = async (
  reader: Reader,
  id: string,
  manifestBytes: Bytes,
  manifestSha256: string
): Promise<void> => {
  const signature = await reader.read(
    signatureKey(manifestSha256),
    (size) => size <= MAX_SIGNATURE_BYTES,
    `at most ${MAX_SIGNATURE_BYTES}`
  );
  const problem = await releaseSignatureProblem(
    manifestBytes,
    signature,
    releaseSigningKeys,
    id
  );
  if (problem !== undefined) {
    const error = new Error(`Release ${id} ${problem}`);
    error.name = "UnverifiedReleaseError";
    throw error;
  }
};

/** How many of release `id`'s blobs an earlier attempt checked, for this very manifest. */
const resumeAt = async (
  db: AdminDatabase,
  id: string,
  manifestSha256: string
): Promise<number> => {
  const [progress] = await db
    .select()
    .from(releaseImportProgress)
    .where(eq(releaseImportProgress.releaseId, id));
  // Another manifest (a broken upload put right) is checked from its start.
  return progress?.manifestSha256 === manifestSha256
    ? progress.verifiedBlobs
    : 0;
};

/** SQL: release `id` isn't imported, so nothing of its import is left once it is. */
const notImported = (id: string) =>
  sql`NOT EXISTS (SELECT 1 FROM ${releases} WHERE ${releases.id} = ${id})`;

/**
 * Records that the first `verifiedBlobs` of release `id`'s blobs checked
 * out, unless it's imported (by a run that overlapped this one).
 */
const recordChecked = async (
  db: AdminDatabase,
  id: string,
  manifestSha256: string,
  verifiedBlobs: number
): Promise<void> => {
  const updatedAt = new Date();
  await db
    .insert(releaseImportProgress)
    .select(
      sql`SELECT ${id}, ${manifestSha256}, ${verifiedBlobs}, ${updatedAt.getTime()} WHERE ${notImported(id)}`
    )
    .onConflictDoUpdate({
      target: releaseImportProgress.releaseId,
      set: { manifestSha256, verifiedBlobs, updatedAt },
    });
};

/**
 * Verifies release `id` and records it: `absent` when it has no manifest
 * (yet), `deferred` when the run's requests ran out first, the blobs
 * checked so far recorded for the next run. Throws when it doesn't verify,
 * the blobs checked before the one that didn't recorded for its next
 * attempt.
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
  const manifestSha256 = await sha256OfBytes(manifestBytes);
  // Before anything of it is recorded or read.
  await checkSignature(reader, id, manifestBytes, manifestSha256);
  const blobs = blobsOf(manifest);
  if (blobs.length > MAX_BLOBS_PER_RELEASE) {
    throw new Error(
      `Release ${id} names ${blobs.length} blobs; at most ${MAX_BLOBS_PER_RELEASE} are read`
    );
  }
  const oversized = blobs.find((blob) => blobSize(blob) > MAX_BLOB_BYTES);
  if (oversized !== undefined) {
    throw new Error(
      `${oversized.key} is ${blobSize(oversized)} bytes; at most ${MAX_BLOB_BYTES} are read`
    );
  }
  // Before anything is checked: retention keeps the blobs of a release
  // that's still being imported, over however many runs it takes, as the
  // manifest it has now names them.
  await recordBlobs(db, id, manifest);
  const before = await checkedBefore(db);
  let failure: Error | undefined;
  for (
    let at = Math.min(await resumeAt(db, id, manifestSha256), blobs.length);
    at < blobs.length && failure === undefined;
    at += BATCH
  ) {
    // oxlint-disable-next-line no-await-in-loop -- a batch at a time
    const { checked, error } = await checkBlobs(
      reader,
      blobs.slice(at, at + BATCH),
      before
    );
    if (checked > 0) {
      // oxlint-disable-next-line no-await-in-loop -- a batch at a time
      await recordChecked(db, id, manifestSha256, at + checked);
    }
    failure = error;
  }
  if (failure === undefined) {
    try {
      await checkModelFiles(reader, manifest);
    } catch (modelError) {
      failure = asError(modelError);
    }
  }
  if (failure instanceof RequestsSpentError) {
    return "deferred";
  }
  if (failure !== undefined) {
    throw failure;
  }
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
        builtAt: new Date(manifest.createdAt),
        importedAt: new Date(),
      })
      .onConflictDoNothing(),
    {
      action: "release.import",
      target: id,
      detail: {
        commit: manifest.commit,
        manifestSha256,
      },
    },
    // Edge takes it in the same batch: a run that dies after saving it
    // never leaves it saved, and so skipped from then on, but off Edge.
    toEdge(db, id)
  );
  // Told only if its import was told as failing (src/alerts/alert.ts):
  // right as it's saved, before the bookkeeping, which may fail.
  await alert(db, { kind: "imported", releaseId: id });
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
 * Counts an attempt at release `id` and when the next is due, and returns
 * its number; undefined when it's imported. Before the attempt's heavy
 * work, so one a run dies in counts too. Gone once it's imported. The
 * count goes up in SQL, so runs that try the same release at once each
 * count.
 */
const recordAttempt = async (
  db: AdminDatabase,
  id: string,
  now: Date
): Promise<number | undefined> => {
  const at = now.getTime();
  const { attempts } = releaseImportFailures;
  // The wait after the nth attempt is FIRST_RETRY_MS * 2^(n - 1): in the
  // update, `attempts` is still the count before this one.
  const [attempt] = await db
    .insert(releaseImportFailures)
    .select(
      sql`SELECT ${id}, 1, ${at}, ${at + FIRST_RETRY_MS} WHERE ${notImported(id)}`
    )
    .onConflictDoUpdate({
      target: releaseImportFailures.releaseId,
      set: {
        attempts: sql`${attempts} + 1`,
        failedAt: now,
        nextAttemptAt: sql`${at} + min(${FIRST_RETRY_MS} * (1 << min(${attempts}, ${MAX_DOUBLINGS})), ${MAX_RETRY_MS})`,
      },
    })
    .returning({ attempts });
  return attempt?.attempts;
};

/**
 * Takes back the attempt at release `id` a run's requests ran out in, as
 * it didn't fail: due again at once, and no wait added.
 */
const takeBackAttempt = async (
  db: AdminDatabase,
  id: string,
  now: Date
): Promise<void> => {
  const { attempts, releaseId } = releaseImportFailures;
  await db.batch([
    db
      .update(releaseImportFailures)
      .set({ attempts: sql`${attempts} - 1`, nextAttemptAt: now })
      .where(eq(releaseId, id)),
    db
      .delete(releaseImportFailures)
      .where(and(eq(releaseId, id), eq(attempts, 0))),
  ]);
};

/** Audits attempt `attempt` at release `id` as failed, unless it's imported: whether it did. */
const recordFailure = async (
  db: AdminDatabase,
  id: string,
  attempt: number,
  now: Date
): Promise<boolean> => {
  const audited = await db
    .insert(auditEvents)
    .select(
      sql`SELECT ${crypto.randomUUID()}, ${now.getTime()}, 'system', 'release.import_failed', NULL, ${id}, json_object('attempts', CAST(${attempt} AS INTEGER)) WHERE ${notImported(id)}`
    )
    .returning({ id: auditEvents.id });
  return audited.length > 0;
};

/**
 * Imports the releases published to `store` that `db` doesn't hold yet,
 * newest first: until {@link MAX_RELEASES_PER_RUN} are tried or
 * {@link MAX_REQUESTS_PER_RUN} are spent, a release the requests ran out in
 * going on from there next run. A release tried before is passed over
 * until its next attempt is due. One run at a time (src/server.ts holds
 * the `releases` lease), though overlapping runs still record and audit a
 * release once.
 */
export const importReleases = async (
  store: ImportStore,
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

  const reader = readerOf(store);
  const result: ImportResult = { imported: [], failed: [], caughtUp: false };
  let read = 0;
  // One release at a time, to bound the blobs read at once.
  for (const id of pending) {
    if (read >= MAX_RELEASES_PER_RUN || reader.spent()) {
      break;
    }
    read += 1;
    // Counted before anything heavy, so a run that dies in it still makes
    // the next attempt wait.
    // oxlint-disable-next-line no-await-in-loop -- one release at a time
    const attempt = await recordAttempt(db, id, now);
    if (attempt === undefined) {
      // Imported since this run listed it.
      continue;
    }
    let outcome: Awaited<ReturnType<typeof importRelease>>;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one release at a time
      outcome = await importRelease(reader, db, id);
    } catch (error) {
      if (error instanceof RequestsSpentError) {
        // Spent at its manifest: nothing of it checked yet.
        read -= 1;
        // oxlint-disable-next-line no-await-in-loop -- once, as the run stops
        await takeBackAttempt(db, id, now);
        break;
      }
      result.failed.push(id);
      log.error("release.import_failed", {
        releaseId: id,
        ...errorFields(error),
      });
      // oxlint-disable-next-line no-await-in-loop -- one release at a time
      const audited = await recordFailure(db, id, attempt, now);
      // Told once, at its first failed attempt (src/alerts/alert.ts), and
      // only as the failure is audited: never for one imported meanwhile.
      if (audited) {
        // oxlint-disable-next-line no-await-in-loop -- one release at a time
        await alert(db, {
          kind: "import_failed",
          releaseId: id,
          code: errorName(error),
          attempt,
        });
      }
      continue;
    }
    if (outcome === "deferred") {
      // The requests ran out in its blobs: the next run goes on from there.
      // oxlint-disable-next-line no-await-in-loop -- once, as the run stops
      await takeBackAttempt(db, id, now);
      break;
    }
    if (outcome === "imported") {
      result.imported.push(id);
    }
  }
  result.caughtUp = read === pending.length;
  return result;
};
