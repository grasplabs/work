import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { inList } from "../db/d1.ts";
import {
  brainPayloadReleases,
  brainPayloads,
  versions,
} from "../db/knowledge/schema.ts";

// The texts of Knowledge's versions: each an immutable object in the
// deployment's private `BRAIN_OBJECTS` bucket (EU jurisdiction, set when
// the bucket is created), written once under a key of its own and never
// replaced, with a row in `brain_payloads` (db/knowledge/schema.ts). A
// version names its payload's key; listings and history read the rows
// only, never an object. The key is core's own: it never leaves core, and
// nothing outside it reads the bucket. On-prem, the R2 binding is the
// adapter: workerd's R2 client, served by src/on-prem/r2.ts.
//
// Saving a text (`stagePayload`, then the statements below in the save's
// own batch):
//
// 1. A committed payload with the same SHA-256 is taken as it is: the same
//    text is stored once, whichever documents and versions hold it.
// 2. Otherwise a `pending` row is written first, then the object, which R2
//    checks against the hash as it takes it.
// 3. The save's batch marks the row `committed` (unless another save of
//    the same text committed first) and writes the version with
//    `committedKey`: the key of the committed payload of that hash, read
//    in the batch itself. With none (the row was collected meanwhile, or
//    lost the race), the version's key is NULL and its NOT NULL refuses
//    the whole batch: a version never names an object that's missing,
//    being deleted, or not checked in. `isUncommitted` tells that refusal,
//    which a save stages again for.
//
// Collecting (conservative): only a row no version refers to, or a
// `pending` one older than `pendingGraceMs`, is marked `collecting`, in
// D1, before its object is deleted; a save never takes a `collecting` row,
// and a crash between the two leaves it `collecting` for the next
// `collectPayloads`. Deleting or repointing versions notes their payloads
// first and marks those left unreferenced at the end of the same batch
// (`releasing`), so nothing scans for orphans.

/** How long a staged payload may wait for its save's batch. */
export const pendingGraceMs = 15 * 60 * 1000;

/** Rows collected at once: R2 deletes up to 1,000 keys in one call. */
const collectBatch = 100;

/** Whether no version refers to the payload row at hand. */
const unreferenced = sql`NOT EXISTS (SELECT 1 FROM ${versions} WHERE ${versions.payloadKey} = ${brainPayloads.key})`;

/** A text, stored and ready for a save's batch to commit. */
export interface StagedPayload {
  readonly key: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Whether this save put the object, and its batch commits the row. */
  readonly fresh: boolean;
}

/** A version's payload, as its row names it. */
export interface PayloadRef {
  readonly key: string;
  readonly sha256: string;
}

const encoder = new TextEncoder();
// A byte order mark is part of the text as saved: kept.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The key of a new object for a text of `sha256`: unique to the upload. */
const objectKey = (sha256: string): string =>
  `payloads/${sha256}/${crypto.randomUUID()}`;

/**
 * Stores `text`, or finds it stored: a committed payload of the same hash,
 * or a new `pending` one whose object is in R2. Throws when the upload
 * fails, leaving the row for `collectPayloads`.
 */
export const stagePayload = async (
  env: Env,
  db: DrizzleD1Database,
  text: string
): Promise<StagedPayload> => {
  const body = encoder.encode(text);
  const sha256 = await sha256HexOfBytes(body);
  const committed = await db
    .select({ key: brainPayloads.key })
    .from(brainPayloads)
    .where(
      and(
        eq(brainPayloads.sha256, sha256),
        eq(brainPayloads.state, "committed")
      )
    )
    .get();
  if (committed) {
    return { key: committed.key, sha256, bytes: body.byteLength, fresh: false };
  }
  const key = objectKey(sha256);
  // The row first: an object is never in R2 without one to collect it by.
  await db.insert(brainPayloads).values({
    key,
    sha256,
    bytes: body.byteLength,
    state: "pending",
    createdAt: new Date(),
  });
  await env.BRAIN_OBJECTS.put(key, body, { sha256 });
  return { key, sha256, bytes: body.byteLength, fresh: true };
};

/**
 * What a save's batch commits `staged` with, before the statement that
 * names it (`committedKey`): a fresh row becomes the committed payload of
 * its hash, unless another is already.
 */
export const commitPayload = (
  db: DrizzleD1Database,
  staged: StagedPayload
): BatchItem<"sqlite">[] =>
  staged.fresh
    ? [
        db
          .update(brainPayloads)
          .set({ state: "committed" })
          .where(
            and(
              eq(brainPayloads.key, staged.key),
              eq(brainPayloads.state, "pending"),
              sql`NOT EXISTS (SELECT 1 FROM ${brainPayloads} AS other WHERE other.sha256 = ${staged.sha256} AND other.state = 'committed')`
            )
          ),
      ]
    : [];

/**
 * The key of the committed payload of a hash (`staged`'s), read in the batch
 * that writes a version with it: NULL, which a version's key refuses,
 * when there is none.
 */
export const committedKey = ({ sha256 }: { sha256: string }): SQL =>
  sql`(SELECT ${brainPayloads.key} FROM ${brainPayloads} WHERE ${brainPayloads.sha256} = ${sha256} AND ${brainPayloads.state} = 'committed')`;

/**
 * Whether `error` is a batch refused because the payload it named wasn't
 * committed (`committedKey`): stage again and retry.
 */
export const isUncommitted = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("NOT NULL constraint failed: versions.payload_key") ||
    isUncommitted(error.cause));

/**
 * Statements around those of a batch that delete or repoint the versions
 * `where` selects: `before` notes their payloads, `after` marks those no
 * version refers to any more `collecting`, for `collectPayloads`.
 */
export const releasing = (
  db: DrizzleD1Database,
  where: SQL
): { before: BatchItem<"sqlite">[]; after: BatchItem<"sqlite">[] } => ({
  before: [
    db
      .insert(brainPayloadReleases)
      .select(
        db
          .selectDistinct({ key: versions.payloadKey })
          .from(versions)
          .where(where)
      )
      .onConflictDoNothing(),
  ],
  after: [
    db
      .update(brainPayloads)
      .set({ state: "collecting" })
      .where(
        and(
          sql`${brainPayloads.key} IN (SELECT key FROM ${brainPayloadReleases})`,
          eq(brainPayloads.state, "committed"),
          unreferenced
        )
      ),
    db.delete(brainPayloadReleases),
  ],
});

/** Refuses a version whose text can't be read as stored. */
const unavailable = (ref: PayloadRef, why: string) => {
  log.error("knowledge.payload_unavailable", { key: ref.key, why });
  return knowledgeErrors.create("knowledge.unavailable");
};

/**
 * The text of a version's payload, checked against its hash: refused with
 * `knowledge.unavailable` when its object is missing or isn't that text.
 */
export const readPayload = async (
  env: Env,
  ref: PayloadRef
): Promise<string> => {
  const object = await env.BRAIN_OBJECTS.get(ref.key);
  if (object === null) {
    throw unavailable(ref, "missing");
  }
  const body = await object.arrayBuffer();
  if ((await sha256HexOfBytes(body)) !== ref.sha256) {
    throw unavailable(ref, "hash_mismatch");
  }
  try {
    return decoder.decode(body);
  } catch {
    throw unavailable(ref, "not_utf8");
  }
};

/**
 * Marks `pending` rows past their grace `collecting`, then deletes the
 * objects of `collecting` rows and the rows, a page at a time. Resolves how
 * many it deleted. The cron trigger runs it; a purge runs it right after
 * its batch, so what it erased leaves R2 too.
 */
export const collectPayloads = async (
  env: Env,
  db: DrizzleD1Database,
  now = Date.now()
): Promise<number> => {
  await db
    .update(brainPayloads)
    .set({ state: "collecting" })
    .where(
      and(
        eq(brainPayloads.state, "pending"),
        lt(brainPayloads.createdAt, new Date(now - pendingGraceMs))
      )
    );
  let deleted = 0;
  for (;;) {
    // A version referring to one never loses its object, whatever marked
    // it.
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const page = await db
      .select({ key: brainPayloads.key })
      .from(brainPayloads)
      .where(and(eq(brainPayloads.state, "collecting"), unreferenced))
      .limit(collectBatch);
    if (page.length === 0) {
      return deleted;
    }
    const keys = page.map(({ key }) => key);
    try {
      // oxlint-disable-next-line no-await-in-loop -- a page at a time
      await env.BRAIN_OBJECTS.delete(keys);
    } catch (error) {
      log.warn("knowledge.payload_collect_failed", errorFields(error));
      return deleted;
    }
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    await db
      .delete(brainPayloads)
      .where(
        and(
          inList(brainPayloads.key, keys),
          eq(brainPayloads.state, "collecting"),
          unreferenced
        )
      );
    deleted += keys.length;
    if (page.length < collectBatch) {
      return deleted;
    }
  }
};

/** The cron trigger's `collectPayloads`, every minute. */
export const sweepPayloads = async (env: Env, now: Date): Promise<void> => {
  await collectPayloads(env, drizzle(env.KNOWLEDGE), now.getTime());
};
