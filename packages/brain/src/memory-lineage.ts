import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import { brainErrors, memoriesLineageInputSchema } from "./contract.ts";
import type {
  BrainSourceRef,
  LineageNode,
  MemoryLineage,
  MemoryRecord,
  ShownMemory,
} from "./contract.ts";
import { inList } from "./db/d1.ts";
import {
  brainMemories,
  collections,
  documents,
  versions,
} from "./db/schema.ts";
import { memoryIdSchema } from "./ids.ts";
import { audienceScope, recordOf, withheldOwn } from "./memories.ts";

// A memory record's lineage, as a person inspects it (GRA-298, slice 4;
// the threat model is on the issue): the record, what it rests on as far
// as they may follow it now, and the correction that superseded it. Who
// may see a record is the host's memory audience (the `memories` port),
// the same one recall reads by; which documents, the host's `authorize`.
// What the reader can't see now leaves no trace: no placeholder, count,
// ID, path or title, and nothing reachable only through it is followed.

/** How far back lineage is followed: as far as publishing checks it. */
const lineageMaxDepth = 8;

/** Most nodes one lineage shows: a crafted chain can't fan out past it. */
const lineageMaxNodes = 100;

/**
 * Most references one lineage looks at, shown or not: the work a read
 * does is bounded by what it reads, not only by what it shows.
 */
const lineageMaxReferences = 200;

/** A record row as a lineage reads it, with whose it is. */
type Owned = MemoryRecord & { ownerId: string };

/**
 * The records `reader`, the person `ownerId`, may inspect: those their
 * memory audience reads now, and every one of their own, retired ones
 * too, as their history.
 */
const inspectable = async <C>(
  brain: Brain<C>,
  reader: C,
  ownerId: string
): Promise<{ where: SQL; people: readonly string[] }> => {
  const { audience, people } = await brain.ports.memories.audienceOf(reader);
  const shared = audienceScope(audience);
  const own = eq(brainMemories.ownerId, ownerId);
  return {
    where: shared === undefined ? own : (or(own, shared) ?? own),
    people,
  };
};

/**
 * Of `records`, those `reader` may see now, shown: their own as they are,
 * another's only if the host keeps it for `people` (whose lineage every
 * one of them may read), with who published it.
 */
const shown = async <C>(
  brain: Brain<C>,
  reader: C,
  ownerId: string,
  people: readonly string[],
  records: readonly Owned[]
): Promise<Map<string, ShownMemory>> => {
  const others = records.filter((record) => record.ownerId !== ownerId);
  const kept =
    others.length === 0
      ? []
      : await brain.ports.memories.keep(reader, people, others);
  const result = new Map<string, ShownMemory>();
  for (const { ownerId: owner, ...record } of records) {
    if (owner === ownerId) {
      result.set(record.id, { ...record, by: null });
    }
  }
  for (const { cites: _cites, ...record } of kept) {
    result.set(record.id, record);
  }
  return result;
};

/** `record`, shown to `reader` if they may see it now. */
const shownOne = async <C>(
  brain: Brain<C>,
  reader: C,
  ownerId: string,
  people: readonly string[],
  record: Owned
): Promise<ShownMemory | undefined> => {
  const found = await shown(brain, reader, ownerId, people, [record]);
  return found.get(record.id);
};

/** The records `ids` names that `where` admits, with whose each is. */
const recordsOf = async <C>(
  { db }: Brain<C>,
  where: SQL,
  ids: readonly string[]
): Promise<Owned[]> => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await db
    .select()
    .from(brainMemories)
    .where(and(where, inList(brainMemories.id, ids)));
  return rows.map((row) => ({ ...recordOf(row), ownerId: row.ownerId }));
};

/**
 * The document versions `refs` cite that `reader` may read now, each with
 * where its document is and its version now, and whether its collection
 * is sensitive. One they can't read isn't answered at all.
 */
const documentsOf = async <C>(
  brain: Brain<C>,
  reader: C,
  refs: readonly (BrainSourceRef & { kind: "document"; citedBy: string })[]
): Promise<(LineageNode & { kind: "document"; sensitive: boolean })[]> => {
  if (refs.length === 0) {
    return [];
  }
  const allowed = await allowedFor(brain.ports, reader);
  // One read for the level: every version cited that the reader may read.
  const rows = await brain.db
    .select({
      documentId: versions.documentId,
      version: versions.number,
      collectionId: documents.collectionId,
      title: documents.title,
      path: documents.path,
      currentVersion: documents.currentVersion,
      sensitive: collections.sensitive,
    })
    .from(versions)
    .innerJoin(documents, eq(documents.id, versions.documentId))
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        inList(versions.documentId, [
          ...new Set(refs.map(({ documentId }) => documentId)),
        ]),
        sql`${versions.number} IN (SELECT value FROM json_each(${JSON.stringify(
          [...new Set(refs.map(({ version }) => version))]
        )}))`,
        allowed.documents()
      )
    );
  const readable = new Map(
    rows.map((row) => [`${row.documentId}@${row.version}`, row])
  );
  return refs.flatMap((ref) => {
    const row = readable.get(`${ref.documentId}@${ref.version}`);
    return row === undefined || row.collectionId !== ref.collectionId
      ? []
      : [
          {
            kind: "document" as const,
            citedBy: memoryIdSchema.parse(ref.citedBy),
            documentId: ref.documentId,
            collectionId: ref.collectionId,
            version: ref.version,
            ...(ref.section === undefined ? {} : { section: ref.section }),
            title: row.title,
            path: row.path,
            currentVersion: row.currentVersion,
            sensitive: row.sensitive,
          },
        ];
  });
};

/**
 * The correction that superseded `record`, if `reader` may see it: the
 * record of the same owner that cites it at its revision. Only a retired
 * record is superseded.
 */
const supersedingOf = async <C>(
  brain: Brain<C>,
  where: SQL,
  record: Owned
): Promise<Owned | undefined> => {
  if (record.state !== "retired") {
    return undefined;
  }
  const row = await brain.db
    .select()
    .from(brainMemories)
    .where(
      and(
        where,
        eq(brainMemories.ownerId, record.ownerId),
        ne(brainMemories.id, record.id),
        sql`EXISTS (
          SELECT 1 FROM json_each(${brainMemories.sourceRefs})
          WHERE json_extract(value, '$.kind') = 'memory'
            AND json_extract(value, '$.memoryId') = ${record.id}
            AND json_extract(value, '$.revision') = ${record.revision}
        )`
      )
    )
    .orderBy(desc(brainMemories.recordedAt), desc(brainMemories.id))
    .get();
  return row === undefined
    ? undefined
    : { ...recordOf(row), ownerId: row.ownerId };
};

/**
 * What `root` rests on that `reader` may see now, followed back a level
 * at a time: each record it cites that they may see, and what that one
 * cites in turn; each document version they may read. A record they may
 * not see is never followed, so nothing reachable only through it shows.
 */
const restsOn = async <C>(
  brain: Brain<C>,
  reader: C,
  ownerId: string,
  { where, people }: { where: SQL; people: readonly string[] },
  root: ShownMemory
): Promise<(LineageNode & { sensitive?: boolean })[]> => {
  const nodes: (LineageNode & { sensitive?: boolean })[] = [];
  const visited = new Set([root.id]);
  let level: ShownMemory[] = [root];
  let references = 0;
  for (
    let depth = 0;
    depth < lineageMaxDepth &&
    level.length > 0 &&
    nodes.length < lineageMaxNodes &&
    references < lineageMaxReferences;
    depth += 1
  ) {
    const cited = level
      .flatMap(({ id, sourceRefs }) =>
        sourceRefs.map((ref) => ({ ...ref, citedBy: id }))
      )
      .slice(0, lineageMaxReferences - references);
    references += cited.length;
    const memoryRefs = cited.filter(
      (ref): ref is typeof ref & { kind: "memory" } =>
        ref.kind === "memory" && !visited.has(ref.memoryId)
    );
    const documentRefs = cited.filter(
      (ref): ref is typeof ref & { kind: "document" } => ref.kind === "document"
    );
    for (const { memoryId } of memoryRefs) {
      visited.add(memoryId);
    }
    // oxlint-disable-next-line no-await-in-loop -- a level rests on the one before
    const [records, docs] = await Promise.all([
      recordsOf(
        brain,
        where,
        memoryRefs.map(({ memoryId }) => memoryId)
      ).then(
        async (found) => await shown(brain, reader, ownerId, people, found)
      ),
      documentsOf(brain, reader, documentRefs),
    ]);
    const next: ShownMemory[] = [];
    for (const ref of memoryRefs) {
      const record = records.get(ref.memoryId);
      if (record !== undefined) {
        nodes.push({
          kind: "memory",
          citedBy: memoryIdSchema.parse(ref.citedBy),
          citedRevision: ref.revision,
          record,
        });
        next.push(record);
      }
    }
    nodes.push(...docs);
    level = next;
  }
  return nodes.slice(0, lineageMaxNodes);
};

/**
 * A shown record with only the references the reader may see in its
 * lineage: a record or document version they can't see, or one past
 * where the lineage was followed, isn't named, not even by its ID.
 */
const visibleOf = (
  root: ShownMemory,
  nodes: readonly LineageNode[],
  superseding: ShownMemory | undefined
) => {
  const records = new Set([
    root.id,
    ...(superseding === undefined ? [] : [superseding.id]),
    ...nodes.flatMap((node) =>
      node.kind === "memory" ? [node.record.id] : []
    ),
  ]);
  const cited = new Set(
    nodes.flatMap((node) =>
      node.kind === "document"
        ? [`${node.citedBy}>${node.documentId}@${node.version}`]
        : []
    )
  );
  return (record: ShownMemory): ShownMemory => ({
    ...record,
    sourceRefs: record.sourceRefs.filter((ref) =>
      ref.kind === "memory"
        ? records.has(ref.memoryId)
        : cited.has(`${record.id}>${ref.documentId}@${ref.version}`)
    ),
  });
};

/**
 * The lineage of the record `input` names, for `reader`, a person: the
 * record, what it rests on as far as they may follow it now, and the
 * correction that superseded it. A record they may not see is
 * `brain.not_found`, alike for one that doesn't exist. The read is noted
 * with the collections of the documents it shows.
 */
export const memoriesLineage = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown
): Promise<MemoryLineage> => {
  const ownerId = brain.ports.ownerOf(reader);
  const { memoryId } = brainErrors.parse(
    "brain.invalid",
    memoriesLineageInputSchema,
    input
  );
  const scope = await inspectable(brain, reader, ownerId);
  const [found] = await recordsOf(brain, scope.where, [memoryId]);
  const record =
    found === undefined
      ? undefined
      : await shownOne(brain, reader, ownerId, scope.people, found);
  if (found === undefined || record === undefined) {
    throw brainErrors.create("brain.not_found");
  }
  // Their own, resting on what they can't read now: shown withheld, with
  // nothing behind it (GRA-1177).
  const [own] =
    found.ownerId === ownerId ? await withheldOwn(brain, reader, [record]) : [];
  if (own?.withheld === true) {
    // Still a read, of nothing it cites.
    await brain.ports.onRead(reader, {
      action: "knowledge.read",
      detail: { read: "memory.lineage", records: 1 },
    });
    return { record: own, restsOn: [], supersededBy: null };
  }
  const superseding = await supersedingOf(brain, scope.where, found);
  const shownSuperseding =
    superseding === undefined
      ? undefined
      : await shownOne(brain, reader, ownerId, scope.people, superseding);
  // A correction of their own is withheld as it is read alone: one citing
  // what they can't read now shows nothing of it here either.
  const [supersededBy] =
    shownSuperseding !== undefined && superseding?.ownerId === ownerId
      ? await withheldOwn(brain, reader, [shownSuperseding])
      : [shownSuperseding];
  const nodes = await restsOn(brain, reader, ownerId, scope, record);
  const sources = new Map<string, { id: string; sensitive: boolean }>();
  for (const node of nodes) {
    if (node.kind === "document") {
      sources.set(node.collectionId, {
        id: node.collectionId,
        sensitive: node.sensitive ?? false,
      });
    }
  }
  await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      detail: { read: "memory.lineage", records: 1 },
    },
    ...sources.values()
  );
  const visible = visibleOf(record, nodes, supersededBy);
  return {
    record: visible(record),
    restsOn: nodes.map((node) => {
      if (node.kind === "memory") {
        return { ...node, record: visible(node.record) };
      }
      const { sensitive: _sensitive, ...shownNode } = node;
      return shownNode;
    }),
    supersededBy: supersededBy === undefined ? null : visible(supersededBy),
  };
};
