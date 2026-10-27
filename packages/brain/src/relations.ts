import { and, desc, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import {
  brainErrors,
  explainPathsMax,
  relationsExplainInputSchema,
  relationsGetInputSchema,
} from "./contract.ts";
import type { RelationsExplanation, RelationView } from "./contract.ts";
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
export const readRowsMax = 200;

/** The most entities an explanation goes on from, at each hop. */
const explainFanOut = 20;

/** An explanation's paths and time, unless its budget says less. */
const explainPathsDefault = 20;
const explainDeadlineMsDefault = 2000;

export type { RelationsExplanation, RelationView } from "./contract.ts";

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

/** What one read of relations asks: an entity and its filters. */
export interface RelationsQuery {
  entityId: string;
  predicate?: string | undefined;
  at?: string | undefined;
  knownAt?: string | undefined;
}

/** What a reader may read through: their documents, and whose memories. */
export interface ReadScope {
  allowed: Awaited<ReturnType<typeof allowedFor>>;
  owner: string | undefined;
  /** What the owner may read now: their own records rest on only that. */
  ownerReads: readonly string[];
}

/** A relation as read, with the source and collection it came from. */
export interface ReadRelation {
  view: RelationView;
  source: string;
  documentId: string | null;
  collectionId: string | null;
}

/** What `reader` reads relations through, past the Brain's gate. */
export const scopeOf = async <C>(
  brain: Brain<C>,
  reader: C
): Promise<ReadScope> => {
  await requireBrainRead(brain, reader);
  const allowed = await allowedFor(brain.ports, reader);
  let owner: string | undefined;
  try {
    owner = brain.ports.ownerOf(reader);
  } catch (error) {
    if (brainErrors.codeOf(error) !== "brain.denied") {
      throw error;
    }
  }
  const ownerReads =
    owner === undefined
      ? []
      : await brain.ports.memories.readableBy(reader, [owner]);
  return { allowed, owner, ownerReads };
};

/** Where a row read came from: its document and collection, if any. */
export interface ReadSource {
  documentId: string | null;
  collectionId: string | null;
}

/** Reports `read` to the host, as every read of the Brain's does. */
const reportRead = async <C>(
  brain: Brain<C>,
  reader: C,
  read: readonly ReadSource[],
  detail: Record<string, string | number>
): Promise<void> => {
  const collectionIds = [
    ...new Set(read.flatMap(({ collectionId }) => collectionId ?? [])),
  ];
  const documentIds = [
    ...new Set(read.flatMap(({ documentId }) => documentId ?? [])),
  ];
  await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      documentIds: documentIds.slice(0, 20),
      // The count of every document read, past the 20 named.
      detail: { ...detail, documents: documentIds.length },
    },
    ...collectionIds.map((id) => ({ id, sensitive: false }))
  );
};

/**
 * The relations of `entityId` readable through `scope`, newest first, at
 * most `readRowsMax`, conflicts among them marked, and whether that cap
 * left any out (`cut`): what every read of relations answers from.
 */
export const readable = async <C>(
  brain: Brain<C>,
  { allowed, owner, ownerReads }: ReadScope,
  { entityId, predicate, at, knownAt }: RelationsQuery
): Promise<{
  relations: ReadRelation[];
  cut: boolean;
  /**
   * Every row read, the answered and those past the cap alike: each still
   * decided whether another is `conflicting`, so each is reported.
   */
  considered: ReadSource[];
}> => {
  const { db } = brain;
  const known = knownAt === undefined ? undefined : new Date(knownAt);
  // Folded as the Brain keeps relations (`kindOf`): `Reports to` asks for
  // `reports_to`.
  const relation = predicate === undefined ? undefined : kindOf(predicate);
  if (relation === "") {
    throw brainErrors.create("brain.invalid");
  }
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
  const [fromDocuments, fromMemories] = await Promise.all([
    db
      .select({ ...columns, collectionId: collections.id })
      .from(brainAssertions)
      .innerJoin(documents, eq(documents.id, brainAssertions.documentId))
      .innerJoin(collections, eq(collections.id, documents.collectionId))
      .where(and(allowed.documents(), eq(collections.sensitive, false), where))
      .orderBy(desc(brainAssertions.recordedAt))
      .limit(readRowsMax + 1),
    owner === undefined
      ? []
      : db
          .select(columns)
          .from(brainAssertions)
          .innerJoin(
            brainMemories,
            eq(brainMemories.id, brainAssertions.memoryId)
          )
          .where(
            and(
              eq(brainMemories.ownerId, owner),
              // A record follows its sources' restrictions, the owner's
              // own too: only those resting on what they may read now.
              citesReadable(ownerReads),
              where
            )
          )
          .orderBy(desc(brainAssertions.recordedAt))
          .limit(readRowsMax + 1),
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
  return {
    relations: views.slice(0, readRowsMax).map((view, index) => ({
      view,
      source: rows[index]?.source ?? "",
      documentId: rows[index]?.documentId ?? null,
      collectionId: rows[index]?.collectionId ?? null,
    })),
    // One more than the cap was read of each kind, to tell.
    cut: rows.length > readRowsMax,
    considered: rows.map(({ documentId, collectionId }) => ({
      documentId,
      collectionId,
    })),
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
): Promise<RelationView[]> => {
  const query = brainErrors.parse(
    "brain.invalid",
    relationsGetInputSchema,
    input
  );
  const { relations: read, considered } = await readable(
    brain,
    await scopeOf(brain, reader),
    query
  );
  await reportRead(brain, reader, considered, {
    read: "relations",
    relations: read.length,
    considered: considered.length,
  });
  return read.map(({ view }) => view);
};

/** The entity at a relation's other end from `entityId`. */
const otherEnd = (view: RelationView, entityId: string) =>
  view.subject.entityId === entityId ? view.object : view.subject;

/**
 * Each of `relations` read from `from`, with the entity at its other end:
 * never back to `start`, where the path began.
 */
const stepsFrom = (
  relations: readonly ReadRelation[],
  from: string,
  start: string
): { view: RelationView; to: RelationView["subject"] }[] =>
  relations.flatMap(({ view }) => {
    const to = otherEnd(view, from);
    return to.entityId === start || to.entityId === from ? [] : [{ view, to }];
  });

/**
 * The paths out from `entityId` that `reader` may read (the Brain design's
 * bounded `relations.explain`): each of its relations, then, two hops
 * deep, each relation of the entities those reach, to an entity not yet on
 * the path. Every hop reads as `relations.get` does, from what the reader
 * may read now, so a relation they can't read neither shows nor decides
 * where a path goes; nothing is scored. Bounded by paths, by
 * `explainFanOut` entities gone on from, and by a deadline: what any of
 * them cut is `truncated`.
 */
export const relationsExplain = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown
): Promise<RelationsExplanation> => {
  const {
    entityId,
    hops = 2,
    budget = {},
    ...filters
  } = brainErrors.parse("brain.invalid", relationsExplainInputSchema, input);
  const maxPaths = Math.min(
    budget.maxPaths ?? explainPathsDefault,
    explainPathsMax
  );
  const deadline =
    brain.ports.clock().getTime() +
    (budget.deadlineMs ?? explainDeadlineMsDefault);
  const scope = await scopeOf(brain, reader);
  const read: ReadRelation[] = [];
  const considered: ReadSource[] = [];
  const paths: RelationsExplanation["paths"] = [];
  const first = await readable(brain, scope, { entityId, ...filters });
  read.push(...first.relations);
  considered.push(...first.considered);
  // Cut by a cap on what was read, on entities gone on from, or the
  // deadline; or by the paths' budget, which ends it.
  let truncated = first.cut;
  /** Adds `found` as far as the budget goes: whether it took them all. */
  const add = (found: RelationsExplanation["paths"]): boolean => {
    const space = maxPaths - paths.length;
    paths.push(...found.slice(0, space));
    return found.length <= space;
  };
  // One path per relation, to the entity at its other end; the entities
  // reached, in the order first reached, are the next hop's starts.
  const firstPaths = stepsFrom(first.relations, entityId, entityId);
  let room = add(firstPaths.map(({ view, to }) => ({ relations: [view], to })));
  const reached = new Map<string, RelationView>();
  for (const { view, to } of firstPaths.slice(0, paths.length)) {
    if (!reached.has(to.entityId)) {
      reached.set(to.entityId, view);
    }
  }
  const starts = hops === 2 && room ? [...reached.entries()] : [];
  truncated ||= starts.length > explainFanOut;
  for (const [via, step] of starts.slice(0, explainFanOut)) {
    if (!room || brain.ports.clock().getTime() >= deadline) {
      truncated ||= room;
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- one hop at a time, within the deadline
    const next = await readable(brain, scope, { entityId: via, ...filters });
    read.push(...next.relations);
    considered.push(...next.considered);
    truncated ||= next.cut;
    room = add(
      stepsFrom(next.relations, via, entityId).map(({ view, to }) => ({
        relations: [step, view],
        to,
      }))
    );
  }
  truncated ||= !room;
  await reportRead(brain, reader, considered, {
    read: "relations.explain",
    relations: read.length,
    considered: considered.length,
  });
  return { paths, truncated };
};
