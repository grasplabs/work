import { and, desc, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import { brainErrors } from "./contract.ts";
import type { BrainSourceRef } from "./contract.ts";
import {
  brainAssertions,
  brainLinkJobs,
  brainMemories,
  collections,
  documents,
} from "./db/schema.ts";
import { collectionIdSchema, documentIdSchema, memoryIdSchema } from "./ids.ts";

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

const isoDate = /^\d{4}-\d{2}-\d{2}$/u;

const relationsInputSchema = z.strictObject({
  /** The entity whose relations, as subject or object. */
  entityId: z.string().min(1).max(256),
  /** Only this relation (`owns`), folded as relations are. */
  predicate: z.string().min(1).max(40).optional(),
  /** Those that hold on this date (ISO); every one without it. */
  at: z.string().regex(isoDate).optional(),
  /** What the Brain had read by this moment (ISO); now without it. */
  knownAt: z.iso.datetime({ offset: true }).optional(),
});

/** One end of a relation: its entity, and the name its source gives it. */
export interface RelationEnd {
  entityId: string;
  name: string;
}

/** A relation as a reader sees it, with the passage that states it. */
export interface RelationView {
  subject: RelationEnd;
  predicate: string;
  object: RelationEnd;
  validFrom: string | null;
  validTo: string | null;
  state: "observed";
  /**
   * Another readable source relates the entity asked about the same way to
   * a different entity, for an overlapping time.
   */
  conflicting: boolean;
  /** When the Brain read it, and when a later version replaced it. */
  recordedAt: string;
  supersededAt: string | null;
  evidence: string;
  sourceRef: BrainSourceRef;
}

/** Whether two validity intervals share a day; open ends reach forever. */
const overlaps = (
  a: Pick<RelationView, "validFrom" | "validTo">,
  b: Pick<RelationView, "validFrom" | "validTo">
): boolean =>
  (a.validFrom === null || b.validTo === null || a.validFrom <= b.validTo) &&
  (b.validFrom === null || a.validTo === null || b.validFrom <= a.validTo);

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
): Promise<RelationView[]> => {
  const { entityId, predicate, at, knownAt } = brainErrors.parse(
    "brain.invalid",
    relationsInputSchema,
    input
  );
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
    predicate === undefined
      ? undefined
      : eq(brainAssertions.predicate, predicate),
    at === undefined
      ? undefined
      : sql`(${brainAssertions.validFrom} IS NULL OR ${brainAssertions.validFrom} <= ${at}) AND (${brainAssertions.validTo} IS NULL OR ${brainAssertions.validTo} >= ${at})`,
    // Now: those of each source's current version only, so a change hides
    // what it replaced at once, before its own relations are read.
    known === undefined
      ? sql`${brainAssertions.supersededAt} IS NULL AND EXISTS (SELECT 1 FROM ${brainLinkJobs} WHERE ${brainLinkJobs.source} = ${brainAssertions.source} AND ${brainLinkJobs.version} = ${brainAssertions.version})`
      : sql`${brainAssertions.recordedAt} <= ${known.getTime()} AND (${brainAssertions.supersededAt} IS NULL OR ${brainAssertions.supersededAt} > ${known.getTime()})`
  );
  const [fromDocuments, fromMemories] = await Promise.all([
    db
      .select({ ...columns, collectionId: collections.id })
      .from(brainAssertions)
      .innerJoin(documents, eq(documents.id, brainAssertions.documentId))
      .innerJoin(collections, eq(collections.id, documents.collectionId))
      .where(and(allowed.documents(), eq(collections.sensitive, false), where))
      .orderBy(desc(brainAssertions.recordedAt))
      .limit(readRowsMax),
    owner === undefined
      ? []
      : db
          .select(columns)
          .from(brainAssertions)
          .innerJoin(
            brainMemories,
            eq(brainMemories.id, brainAssertions.memoryId)
          )
          .where(and(eq(brainMemories.ownerId, owner), where))
          .orderBy(desc(brainAssertions.recordedAt))
          .limit(readRowsMax),
  ]);
  // Both kinds of source together, newest first: conflicts are found among
  // all of them, then the answer is the newest `readRowsMax`.
  const rows = [
    ...fromDocuments,
    ...fromMemories.map((row) => ({ ...row, collectionId: null })),
  ].toSorted((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
  const views: RelationView[] = rows.map((row) => ({
    subject: { entityId: row.subjectEntityId, name: row.subjectName },
    predicate: row.predicate,
    object: { entityId: row.objectEntityId, name: row.objectName },
    validFrom: row.validFrom,
    validTo: row.validTo,
    state: row.state,
    conflicting: false,
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
  }));
  // Relative to the entity asked about: two readable sources that relate
  // it the same way, in the same place (who owns it, or what it owns), to
  // different entities over a shared time. The Brain can't tell whether
  // they disagree or add up, so it marks both and picks neither.
  const placed = views.map((view, index) => {
    const asSubject = view.subject.entityId === entityId;
    return {
      view,
      source: rows[index]?.source ?? "",
      asSubject,
      other: asSubject ? view.object.entityId : view.subject.entityId,
    };
  });
  for (const one of placed) {
    one.view.conflicting = placed.some(
      (other) =>
        other.source !== one.source &&
        other.asSubject === one.asSubject &&
        other.view.predicate === one.view.predicate &&
        other.other !== one.other &&
        overlaps(one.view, other.view)
    );
  }
  const answered = views.slice(0, readRowsMax);
  const read = rows.slice(0, readRowsMax);
  const collectionIds = [
    ...new Set(read.flatMap(({ collectionId }) => collectionId ?? [])),
  ];
  await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      documentIds: [
        ...new Set(read.flatMap(({ documentId }) => documentId ?? [])),
      ].slice(0, 20),
      detail: { read: "relations", relations: read.length },
    },
    ...collectionIds.map((id) => ({ id, sensitive: false }))
  );
  return answered;
};
