import { and, desc, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import { brainErrors, relationsGetInputSchema } from "./contract.ts";
import type { RelationsAnswer, RelationView } from "./contract.ts";
import {
  brainAssertions,
  brainLinkJobs,
  brainMemories,
  collections,
  documents,
} from "./db/schema.ts";
import { kindOf, requireBrainRead } from "./entities.ts";
import { collectionIdSchema, documentIdSchema, memoryIdSchema } from "./ids.ts";
import { citesReadable } from "./memory-cites.ts";

// Typed, source-backed relations (GRA-306; the Brain design's "History and
// authority" and "Graph tables and query behavior"): what the Brain's
// sources say between their entities, and when it holds, answered for a
// date in the world (`at`, a relation's validity) and for a moment of the
// Brain's (`knownAt`, what it had read by then).
//
// The extraction that links a source's entities (entities.ts) also reads
// the relations it states, in the same call, and keeps only those its text
// bears out: a passage it holds whole, both ends entities linked in that
// source, real dates. Each is `observed`: the source says so, never an
// accepted fact, whatever the predicate. The Brain doesn't know what a
// predicate means, so it never picks between two sources: when two of them
// relate the entity asked about the same way to different entities over a
// shared time (two owners of one process), both come back, each marked
// `conflicting`.
//
// A source's new version supersedes its relations before it, kept as what
// was known until then; an erasure deletes every one of them (entities.ts,
// `eraseLinked`), and removing the source removes them with its link job.
//
// Every read starts from what the reader may read now (`allowedFor`, as
// mentions are read): documents in collections that aren't sensitive, and
// their own memory records. Conflicts are found among those rows only, so
// what a hidden source says never changes a visible answer, and history is
// read through today's access.

/** The most relations one read returns, and reads of each kind of source. */
const readRowsMax = 200;

/**
 * The most claims of an entity, of each kind of source, a read weighs for
 * conflicts: past the answer's cap, so an older readable source that
 * disagrees still marks the newer ones it disagrees with.
 */
const claimRowsMax = 5000;

export type { RelationsAnswer, RelationView } from "./contract.ts";

/** Whether two validity intervals share a day; open ends reach forever. */
const overlaps = (
  a: Pick<RelationView, "validFrom" | "validTo">,
  b: Pick<RelationView, "validFrom" | "validTo">
): boolean =>
  (a.validFrom === null || b.validTo === null || a.validFrom <= b.validTo) &&
  (b.validFrom === null || a.validTo === null || b.validFrom <= a.validTo);

/** What a claim weighed for conflicts takes of a row: no passage. */
const claimColumns = {
  source: brainAssertions.source,
  documentId: brainAssertions.documentId,
  subjectEntityId: brainAssertions.subjectEntityId,
  predicate: brainAssertions.predicate,
  objectEntityId: brainAssertions.objectEntityId,
  validFrom: brainAssertions.validFrom,
  validTo: brainAssertions.validTo,
};

/** A relation row's columns, as every read takes them. */
const columns = {
  source: brainAssertions.source,
  documentId: brainAssertions.documentId,
  memoryId: brainAssertions.memoryId,
  version: brainAssertions.version,
  subjectEntityId: brainAssertions.subjectEntityId,
  subjectName: brainAssertions.subjectName,
  predicate: brainAssertions.predicate,
  objectEntityId: brainAssertions.objectEntityId,
  objectName: brainAssertions.objectName,
  validFrom: brainAssertions.validFrom,
  validTo: brainAssertions.validTo,
  evidence: brainAssertions.evidence,
  state: brainAssertions.state,
  recordedAt: brainAssertions.recordedAt,
  supersededAt: brainAssertions.supersededAt,
};

/**
 * The relations a read answers (`relationsFor`), with where every claim
 * it weighed came from (`considered`): the answered relations' sources,
 * and those past the cap that still decided whether one is
 * `conflicting`. A caller that labels what it was handed (a chat) labels
 * it with all of them.
 */
export const relationsRead = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown
): Promise<{
  answer: RelationsAnswer;
  considered: { collectionIds: string[]; documentIds: string[] };
}> => {
  const { entityId, predicate, at, knownAt } = brainErrors.parse(
    "brain.invalid",
    relationsGetInputSchema,
    input
  );
  // Folded as the Brain keeps relations (`kindOf`): `Reports to` asks for
  // `reports_to`.
  const relation = predicate === undefined ? undefined : kindOf(predicate);
  if (relation === "") {
    throw brainErrors.create("brain.invalid");
  }
  await requireBrainRead(brain, reader);
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  let owner: string | undefined;
  try {
    owner = brain.ports.ownerOf(reader);
  } catch (error) {
    if (brainErrors.codeOf(error) !== "brain.denied") {
      throw error;
    }
  }
  const known = knownAt === undefined ? undefined : new Date(knownAt);
  const where: SQL | undefined = and(
    or(
      eq(brainAssertions.subjectEntityId, entityId),
      eq(brainAssertions.objectEntityId, entityId)
    ),
    relation === undefined
      ? undefined
      : eq(brainAssertions.predicate, relation),
    at === undefined
      ? undefined
      : sql`(${brainAssertions.validFrom} IS NULL OR ${brainAssertions.validFrom} <= ${at}) AND (${brainAssertions.validTo} IS NULL OR ${brainAssertions.validTo} >= ${at})`,
    // Now: those of each source's current version only, so a change hides
    // what it replaced at once, before its own relations are read.
    known === undefined
      ? sql`${brainAssertions.supersededAt} IS NULL AND EXISTS (SELECT 1 FROM ${brainLinkJobs} WHERE ${brainLinkJobs.source} = ${brainAssertions.source} AND ${brainLinkJobs.version} = ${brainAssertions.version})`
      : sql`${brainAssertions.recordedAt} <= ${known.getTime()} AND (${brainAssertions.supersededAt} IS NULL OR ${brainAssertions.supersededAt} > ${known.getTime()})`
  );
  const ownerReads =
    owner === undefined
      ? []
      : await brain.ports.memories.readableBy(reader, [owner]);
  // What each kind of source may give: documents in collections that
  // aren't sensitive, and the reader's own memory records resting only on
  // what they may read now (a record follows its sources' restrictions,
  // the owner's own too).
  const fromReadable = and(
    allowed.documents(),
    eq(collections.sensitive, false),
    where
  );
  const fromOwn =
    owner === undefined
      ? undefined
      : and(eq(brainMemories.ownerId, owner), citesReadable(ownerReads), where);
  const newest = desc(brainAssertions.recordedAt);
  // One more than each cap, to tell whether it left any out: the rows the
  // answer is made of, and the lighter claims weighed for conflicts.
  const [docRows, ownRows, docClaims, ownClaims] = await Promise.all([
    db
      .select({ ...columns, collectionId: collections.id })
      .from(brainAssertions)
      .innerJoin(documents, eq(documents.id, brainAssertions.documentId))
      .innerJoin(collections, eq(collections.id, documents.collectionId))
      .where(fromReadable)
      .orderBy(newest)
      .limit(readRowsMax + 1),
    fromOwn === undefined
      ? []
      : db
          .select(columns)
          .from(brainAssertions)
          .innerJoin(
            brainMemories,
            eq(brainMemories.id, brainAssertions.memoryId)
          )
          .where(fromOwn)
          .orderBy(newest)
          .limit(readRowsMax + 1),
    db
      .select({ ...claimColumns, collectionId: collections.id })
      .from(brainAssertions)
      .innerJoin(documents, eq(documents.id, brainAssertions.documentId))
      .innerJoin(collections, eq(collections.id, documents.collectionId))
      .where(fromReadable)
      .orderBy(newest)
      .limit(claimRowsMax + 1),
    fromOwn === undefined
      ? []
      : db
          .select(claimColumns)
          .from(brainAssertions)
          .innerJoin(
            brainMemories,
            eq(brainMemories.id, brainAssertions.memoryId)
          )
          .where(fromOwn)
          .orderBy(newest)
          .limit(claimRowsMax + 1),
  ]);
  const read = {
    documents: docRows,
    memories: ownRows,
    cut: docRows.length > readRowsMax || ownRows.length > readRowsMax,
  };
  const claims = {
    documents: docClaims,
    memories: ownClaims,
    cut: docClaims.length > claimRowsMax || ownClaims.length > claimRowsMax,
  };
  // Both kinds of source together, newest first: the answer is the newest
  // `readRowsMax`.
  const rows = [
    ...read.documents.slice(0, readRowsMax),
    ...read.memories
      .slice(0, readRowsMax)
      .map((row) => ({ ...row, collectionId: null })),
  ]
    .toSorted((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
    .slice(0, readRowsMax);
  const weighed = [
    ...claims.documents.slice(0, claimRowsMax),
    ...claims.memories
      .slice(0, claimRowsMax)
      .map((row) => ({ ...row, collectionId: null })),
  ];
  // Relative to the entity asked about: two readable sources that relate
  // it the same way, in the same place (who owns it, or what it owns), to
  // different entities over a shared time. The Brain can't tell whether
  // they disagree or add up, so it marks both and picks neither. Weighed
  // against every claim read, past the answer's cap too.
  const placed = (row: { subjectEntityId: string; objectEntityId: string }) => {
    const asSubject = row.subjectEntityId === entityId;
    return {
      asSubject,
      other: asSubject ? row.objectEntityId : row.subjectEntityId,
    };
  };
  const others = weighed.map((claim) => ({ claim, ...placed(claim) }));
  const answered: RelationView[] = rows.map((row) => {
    const here = placed(row);
    return {
      subject: { entityId: row.subjectEntityId, name: row.subjectName },
      predicate: row.predicate,
      object: { entityId: row.objectEntityId, name: row.objectName },
      validFrom: row.validFrom,
      validTo: row.validTo,
      state: row.state,
      conflicting: others.some(
        ({ claim, asSubject, other }) =>
          claim.source !== row.source &&
          asSubject === here.asSubject &&
          claim.predicate === row.predicate &&
          other !== here.other &&
          overlaps(row, claim)
      ),
      recordedAt: row.recordedAt.toISOString(),
      supersededAt: row.supersededAt?.toISOString() ?? null,
      evidence: row.evidence,
      sourceRef:
        row.memoryId === null
          ? {
              kind: "document",
              documentId: documentIdSchema.parse(row.documentId),
              collectionId: collectionIdSchema.parse(row.collectionId),
              version: row.version,
            }
          : {
              kind: "memory",
              memoryId: memoryIdSchema.parse(row.memoryId),
              revision: row.version,
            },
    };
  });
  // Every claim weighed is reported, not only those answered: one past the
  // answer's end still decided whether another is `conflicting`.
  const collectionIds = [
    ...new Set(weighed.flatMap(({ collectionId }) => collectionId ?? [])),
  ];
  const documentIds = [
    ...new Set(weighed.flatMap(({ documentId }) => documentId ?? [])),
  ];
  await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      documentIds: documentIds.slice(0, 20),
      detail: {
        read: "relations",
        relations: answered.length,
        considered: weighed.length,
        documents: documentIds.length,
      },
    },
    ...collectionIds.map((id) => ({ id, sensitive: false }))
  );
  return {
    answer: { relations: answered, truncated: read.cut || claims.cut },
    considered: { collectionIds, documentIds },
  };
};

/**
 * The relations of `entityId` that `reader` may read now, that hold on
 * `at` (all, without it) and that the Brain knew at `knownAt` (now,
 * without it), conflicts among them marked: answers to "who owns it now",
 * "who owned it then", and "what did we know then", each with the passage
 * of the source version that says so.
 */
export const relationsFor = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown
): Promise<RelationsAnswer> => {
  const { answer } = await relationsRead(brain, reader, input);
  return answer;
};
