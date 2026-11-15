import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { z } from "zod";

import { auditedBatch, outboxed } from "./audit.ts";
import type { Brain } from "./brain.ts";
import {
  brainEntityMatches,
  collections,
  documents,
  links,
  sections,
  transcripts,
  versions,
} from "./db/schema.ts";
import { indexedValuesOf } from "./documents.ts";
import type { Writer } from "./documents.ts";
import { forgetCollectionEntities } from "./entities.ts";
import type { BrainEvent } from "./events.ts";
import { knowledgeErrors, purgeInputSchema } from "./knowledge.ts";
import type { PurgeReason, PurgeResult } from "./knowledge.ts";
import { log } from "./log.ts";
import { forgetPerson, personCounts } from "./memories.ts";
import { collectPayloads, releasing } from "./payloads.ts";
import {
  attemptHolds,
  attemptHoldsOrIdle,
  finishPurge,
  heldNow,
  openPurge,
  runStep,
  whileHeld,
} from "./purge-ledger.ts";
import type { StepCounts } from "./purge-ledger.ts";
import {
  collectionPlan,
  eraseCollectionFromSearchIndex,
  errorNameOf,
  owedWritesDoneWhile,
  rebuildOwedWhile,
  rebuildOwedIfChanged,
  secureDeleteReady,
} from "./search-erasure.ts";

// Purging a person from Knowledge, for good, when they are erased (GDPR
// erasure): the one purge left (GRA-1911). Core runs it only from a
// person's erasure (its person-erasure.ts), never on anyone's request;
// the purge of terms an admin could run went with decision B of the
// cutover, as nothing reads Knowledge any more and the whole database
// goes with the package.
//
// Every collection only the person reads (`access` "me", theirs: whatever
// made it, a Personal collection they once had among them) is deleted
// with every version, section, link, transcript and search row, and so
// are their Brain memories, command receipts, outcomes and lessons
// (memories.ts). One batch, with its audit event, which counts them.
// Collections they own that others read too are the company's, and stay.
//
// The host forgets the files it keeps as the purged collections' documents
// first (`OnErase` `forgetFiles`; core's: the originals of uploaded files,
// uploads.ts), before anything of a document changes: a file holds the
// data too. Once done, the host forgets the person as the author of the
// copies it keeps (`forgetActor`).
//
// Then nothing of it is left in the search index (search-erasure.ts): the
// purge reads every version of the collections' documents before deleting
// them and checks the tokens they gave the index after, up to caps past
// which it rebuilds the index. The cleanup runs after the data is
// committed, and on every run, also one with nothing left to change, so
// when it fails (`knowledge.purge_index_pending`) running the purge again
// finishes it.
//
// Each purge is recorded in the ledger (purge-ledger.ts) before anything
// changes: run again, it resumes its record and every step runs again.
// The audit log records who, when, why (a reason from a fixed list) and
// how many: never what it erased.

type PurgeInput = z.output<typeof purgeInputSchema>;
type PersonalPurge = Extract<PurgeInput, { type: "personal" }>;

interface Counts {
  documents: number;
  versions: number;
}

/** The files a host keeps as one collection's Knowledge documents. */
export interface ErasedFiles {
  collectionId: string;
}

/**
 * How a purge reaches what the host keeps outside Knowledge, so Knowledge
 * itself names none of it.
 */
export interface OnErase {
  /**
   * Forgets the files of `scope`, as `by`, before the purge writes
   * anything of it. Throws to fail the purge's step: running it again
   * finishes it.
   */
  forgetFiles: (by: Writer, scope: ErasedFiles) => Promise<void>;
  /** Forgets `userId` as the author of any copy the host keeps. */
  forgetActor: (by: Writer, userId: string) => Promise<void>;
}

const cleanSearchIndex = async (
  cleanup: () => Promise<void>
): Promise<void> => {
  try {
    await cleanup();
  } catch (error) {
    // The data is already deleted by now; running the purge again, which
    // always cleans up, finishes it. The error's name only: a cleanup's
    // query may carry the terms, which its error would repeat.
    log.error("knowledge.purge.rebuild_failed", {
      errorName: errorNameOf(error),
    });
    throw knowledgeErrors.create("knowledge.purge_index_pending");
  }
};

/** Most documents one event names as provenance: the host's audit log holds at most 100. */
const purgeMaxProvenance = 100;

/** The audit event of running a purge: never what it erased. */
const purgeEntry = (
  by: Writer,
  action: "knowledge.purged" | "knowledge.purge.resumed",
  input: PersonalPurge,
  scope: { collectionIds: readonly string[]; documentIds: string[] },
  counts: Partial<Counts> & { memories?: number; receipts?: number },
  purgeId: string
): BrainEvent => ({
  actor: by.actor,
  action,
  // It names its person, and how many collections it takes: one event,
  // whatever their number.
  provenance: scope.documentIds.slice(0, purgeMaxProvenance),
  detail: {
    purgeId,
    kind: input.type,
    reason: input.reason,
    userId: input.userId,
    collections: scope.collectionIds.length,
    ...counts,
  },
});

/** The steps of a purge, in the order it runs them. */
const personalSteps = [
  "host_files",
  "records",
  "payloads",
  "search",
  "host_actor",
] as const;

/** Records that `by` ran purge `purgeId` again, to go on from its record. */
const resumed = async <C>(
  brain: Brain<C>,
  by: Writer,
  input: PersonalPurge,
  scope: { collectionIds: readonly string[]; documentIds: string[] },
  purgeId: string
): Promise<void> => {
  await auditedBatch(brain.ports, brain.db, [
    outboxed(
      brain,
      purgeEntry(by, "knowledge.purge.resumed", input, scope, {}, purgeId)
    ),
  ]);
};

// What a purge deletes.

const idsOf = (collectionIds: readonly string[]): string =>
  JSON.stringify(collectionIds);

/** The documents of `collectionIds`, as a subquery. */
const documentsIn = (db: DrizzleD1Database, collectionIds: readonly string[]) =>
  db
    .select({ id: documents.id })
    .from(documents)
    .where(
      sql`${documents.collectionId} IN (SELECT value FROM json_each(${idsOf(collectionIds)}))`
    );

/**
 * What purging `userId` deletes: every collection only they read, that
 * they own (`access` "me"), whatever made it, the Personal collection a
 * person once had among them. Read anew by each run, so one made since
 * the purge was prepared goes too.
 */
const personalScope = async (
  db: DrizzleD1Database,
  { userId }: PersonalPurge
): Promise<{
  collectionIds: string[];
  documentIds: string[];
  counts: Counts;
}> => {
  const owned = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.owner, userId), eq(collections.access, "me")));
  const collectionIds = owned.map(({ id }) => id);
  const found = await documentsIn(db, collectionIds);
  const [versionCount] = await db
    .select({ count: count() })
    .from(versions)
    .where(inArray(versions.documentId, documentsIn(db, collectionIds)));
  return {
    collectionIds,
    documentIds: found.map(({ id }) => id),
    counts: {
      documents: found.length,
      versions: versionCount?.count ?? 0,
    },
  };
};

/**
 * Deletes every collection only `userId` reads (`personalScope`) and
 * everything in them, and their Brain memories and receipts, in one batch: all or nothing. Its audit
 * event comes first, with the rebuild it owes, before anything changes;
 * then the host forgets the files it keeps as its documents (`OnErase`
 * `forgetFiles`: core deletes the uploads' originals); then the batch.
 * The sections go first, row by row, so the triggers take them out of the
 * search index; the rest in the order they refer to one another. Nothing
 * of the collection is left in the search index after (search-erasure.ts):
 * every version of its documents is read before the batch, and the tokens
 * they gave the index checked after, also when nothing was left to
 * delete. The rebuild is owed from the start, so a run again after the
 * check or rebuild fails,
 * with the collection gone, still rebuilds, and another when the
 * collection changed since it was read.
 */
const purgePersonal = async <C>(
  brain: Brain<C>,
  by: Writer,
  input: PersonalPurge,
  onErase: OnErase
): Promise<PurgeResult> => {
  const { db } = brain;
  const { collectionIds, documentIds, counts } = await personalScope(db, input);
  const memoryCounts = await personCounts(db, input.userId);
  const inCollection = documentsIn(db, collectionIds);
  const secure = await secureDeleteReady(db);
  // Recorded before anything changes, the host's files included, so no
  // purge goes unrecorded however far it gets, with the rebuild it owes
  // (as a content purge records them); run again, it goes on from its
  // record (purge-ledger.ts).
  const open = await openPurge(
    brain,
    by,
    input,
    personalSteps,
    { ...counts },
    (purgeId) => [
      outboxed(
        brain,
        purgeEntry(
          by,
          "knowledge.purged",
          input,
          { collectionIds, documentIds },
          { ...counts, ...memoryCounts },
          purgeId
        )
      ),
    ],
    // Each attempt owes its own rebuild.
    (held, at) => [rebuildOwedWhile(db, held.purgeId, attemptHolds(held, at))]
  );
  const { purgeId } = open;
  if (open.resumed) {
    await resumed(brain, by, input, { collectionIds, documentIds }, purgeId);
  }
  // Resumed, what it began with may be gone: the index is rebuilt then.
  const plan =
    secure && !open.resumed
      ? await collectionPlan(brain, db, collectionIds, indexedValuesOf)
      : ({ kind: "unknown" } as const);
  // The versions' payloads, unreferenced once they go, are collected right
  // after: erased from R2 too.
  const releasedWhile = (holds: SQL) =>
    releasing(
      db,
      and(inArray(versions.documentId, inCollection), holds) ?? sql`0`
    );
  // What the records step deleted, over every run of it (purge-ledger.ts).
  let deleted: StepCounts = {};
  try {
    await runStep(brain, open, "host_files", async () => {
      for (const collectionId of collectionIds) {
        // oxlint-disable-next-line no-await-in-loop -- one collection at a time, as each may refuse
        await onErase.forgetFiles(by, { collectionId });
      }
    });
    deleted = await runStep(brain, open, "records", async (save) => {
      // Each delete only while this run holds the purge: one that lost it
      // changes nothing (purge-ledger.ts).
      const holds = heldNow(brain, open);
      const released = releasedWhile(holds);
      const writes: BatchItem<"sqlite">[] = [
        ...(plan.kind === "keys"
          ? [
              rebuildOwedIfChanged(
                db,
                `${purgeId}:changed`,
                collectionIds,
                plan.versions
              ),
            ]
          : []),
        ...released.before,
        // The entities only its documents name, with their keys, before the
        // documents take their mentions with them.
        forgetCollectionEntities(db, collectionIds, holds),
        // The matches its documents were evidence for, as a content purge
        // forgets them (`forgetMatchesOn`): entities named elsewhere stay.
        db
          .delete(brainEntityMatches)
          .where(
            and(
              inArray(brainEntityMatches.evidenceDocumentId, inCollection),
              holds
            )
          ),
        db
          .delete(sections)
          .where(and(inArray(sections.documentId, inCollection), holds)),
        db
          .delete(links)
          .where(and(inArray(links.fromDocumentId, inCollection), holds)),
        db
          .delete(transcripts)
          .where(and(inArray(transcripts.documentId, inCollection), holds)),
        db
          .delete(versions)
          .where(and(inArray(versions.documentId, inCollection), holds)),
        db
          .delete(documents)
          .where(
            and(
              sql`${documents.collectionId} IN (SELECT value FROM json_each(${idsOf(collectionIds)}))`,
              holds
            )
          ),
        db
          .delete(collections)
          .where(
            and(
              sql`${collections.id} IN (SELECT value FROM json_each(${idsOf(collectionIds)}))`,
              holds
            )
          ),
        ...released.after,
        ...forgetPerson(db, input.userId, brain.ports.clock(), holds),
      ];
      await db.batch([save({ ...counts }), ...writes]);
      return { ...counts };
    });
  } finally {
    // A rebuild from now on covers this purge's writes, also when they
    // failed: it writes no more.
    await whileHeld(brain, open, (at) => [
      owedWritesDoneWhile(db, purgeId, attemptHoldsOrIdle(open, at)),
    ]);
  }
  await runStep(brain, open, "payloads", async () => {
    await collectPayloads(brain, db);
  });
  await runStep(brain, open, "search", async () => {
    await cleanSearchIndex(async () => {
      await eraseCollectionFromSearchIndex(db, plan, { secure, id: purgeId });
    });
  });
  // The host's copies keep who wrote them: never the person erased.
  await runStep(brain, open, "host_actor", async () => {
    await onErase.forgetActor(by, input.userId);
  });
  await finishPurge(brain, open);
  return {
    purgeId,
    documents: deleted.documents ?? 0,
    versions: deleted.versions ?? 0,
  };
};

/**
 * Purges the person `userId` from Knowledge, as `by`, for `reason`: what
 * `purgePersonal` deletes, recorded and resumable. Throws when a step
 * fails, which leaves the purge open: running it again finishes it. The
 * counts returned are what it removed.
 */
export const purgePerson = async <C>(
  brain: Brain<C>,
  by: Writer,
  { userId, reason }: { userId: string; reason: PurgeReason },
  onErase: OnErase
): Promise<PurgeResult> => {
  const input = knowledgeErrors.parse("knowledge.invalid", purgeInputSchema, {
    type: "personal",
    userId,
    reason,
  });
  if (input.type !== "personal") {
    throw knowledgeErrors.create("knowledge.invalid");
  }
  return await purgePersonal(brain, by, input, onErase);
};
