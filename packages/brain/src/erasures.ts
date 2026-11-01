import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { Brain } from "./brain.ts";
import { brainErasedDocuments } from "./db/schema.ts";
import { sha256Hex } from "./encoding.ts";

// Fences against copies made late (GRA-1121; the threat model is on
// GRA-309). A purge forgets the host's copies of what it erases through
// `OnErase` (purge.ts), but a copy made from a source read before the
// purge can land after that forget, holding what was erased: a reading of
// a document the model was still reading, say. The Brain and the host
// keep their data apart, so no transaction holds both. Instead a content
// purge records the documents it names (`brain_erased_documents`) before
// it reaches anything, and a host writer:
//
// 1. notes how far those records reach as it starts reading
//    (`erasureMark`);
// 2. writes its copy, kept from everyone until it is checked;
// 3. asks whether a record since names a place it read (`erasedSince`):
//    if so, it forgets its copy, as the purge would have; if not, the
//    copy is checked and served.
//
// A writer that dies between 2 and 3 leaves its copy unchecked, unserved,
// for the host to check again later from the same mark. Either the
// purge's forget comes after the copy is written, or the copy's check
// comes after the purge's record: none outlives both. A purge still
// running as the writer starts (its records written, its forget and
// rewrites not yet done) counts as after the mark: the mark stops below
// its records, so a copy read from what it hasn't rewritten yet is found
// too. One that stopped without saying it was done counts as running for
// `runningPurgeMs` at most. The mark is the records' own sequence (their
// rowid), not a time: two isolates' clocks may differ, the database's
// order doesn't. Nothing of what was erased is kept: IDs and hashes of
// places alone.

/** Where a document is: what a copy of it was read from. */
export interface DocumentPlace {
  collectionId: string;
  path: string;
}

/** A place as the erasure record keeps it: hashed, so no name is kept. */
const placeHash = async ({
  collectionId,
  path,
}: DocumentPlace): Promise<string> =>
  await sha256Hex(`${collectionId}\n${path}`);

/** Erasure records one insert writes: four bound values each, 100 at most. */
const erasedRowsPerStatement = 25;

/** The statements that record `documents` as erased by purge `purgeId`. */
export const erasedDocumentsWrite = async (
  db: DrizzleD1Database,
  purgeId: string,
  documents: readonly (DocumentPlace & { id: string })[],
  now: Date
): Promise<BatchItem<"sqlite">[]> => {
  if (documents.length === 0) {
    return [];
  }
  const values = await Promise.all(
    documents.map(async (document) => ({
      purgeId,
      documentId: document.id,
      place: await placeHash(document),
      erasedAt: now,
    }))
  );
  // D1 binds at most 100 values a statement: four a row.
  const rows: (typeof values)[] = [];
  for (let at = 0; at < values.length; at += erasedRowsPerStatement) {
    rows.push(values.slice(at, at + erasedRowsPerStatement));
  }
  return rows.map((chunk) =>
    db.insert(brainErasedDocuments).values(chunk).onConflictDoNothing()
  );
};

/**
 * The statement that marks purge `purgeId`'s records done: its forget and
 * rewrites have run, or it stopped trying (`erasureMark`).
 */
export const erasedDocumentsDone = (
  db: DrizzleD1Database,
  purgeId: string,
  now: Date
) =>
  db
    .update(brainErasedDocuments)
    .set({ doneAt: now })
    .where(
      and(
        eq(brainErasedDocuments.purgeId, purgeId),
        isNull(brainErasedDocuments.doneAt)
      )
    );

/**
 * How long a purge whose records were never marked done (its isolate
 * stopped midway) still counts as running: well past any purge's run.
 */
export const runningPurgeMs = 60 * 60 * 1000;

/** The rowid of an erasure record: its place in the order they were written. */
const sequence = sql<number>`${brainErasedDocuments}.rowid`;

/**
 * How far the erasure records reach as a copy starts reading its
 * sources: what `erasedSince` is asked from. Below the first record of a
 * purge still running, so its records count as after the mark.
 */
export const erasureMark = async <C>(brain: Brain<C>): Promise<number> => {
  const since = brain.ports.clock().getTime() - runningPurgeMs;
  const [row] = await brain.db
    .select({
      running: sql<
        number | null
      >`min(CASE WHEN ${brainErasedDocuments.doneAt} IS NULL AND ${brainErasedDocuments.erasedAt} > ${since} THEN ${sequence} END)`,
      last: sql<number | null>`max(${sequence})`,
    })
    .from(brainErasedDocuments);
  if (row?.running !== null && row?.running !== undefined) {
    return row.running - 1;
  }
  return row?.last ?? 0;
};

/**
 * Whether a purge recorded after `mark` named a document at any of
 * `places`: then a copy read from them since must go.
 */
export const erasedSince = async <C>(
  brain: Brain<C>,
  mark: number,
  places: readonly DocumentPlace[]
): Promise<boolean> => {
  if (places.length === 0) {
    return false;
  }
  const hashes = await Promise.all(places.map(placeHash));
  const found = await brain.db
    .select({ id: brainErasedDocuments.documentId })
    .from(brainErasedDocuments)
    .where(and(inArray(brainErasedDocuments.place, hashes), gt(sequence, mark)))
    .limit(1);
  return found.length > 0;
};
