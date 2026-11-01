import { and, count, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "./audit.ts";
import type { Brain } from "./brain.ts";
import { ensureCollection } from "./collections.ts";
import { brainSourceRefSchema } from "./contract.ts";
import type { BrainSourceRef } from "./contract.ts";
import {
  brainErasedEvidence,
  brainForgottenPeople,
  brainMemories,
  brainPurges,
  collections,
  transcripts,
  versions,
} from "./db/schema.ts";
import { writeVersion } from "./documents.ts";
import type { Writer } from "./documents.ts";
import { sha256Hex } from "./encoding.ts";
import {
  exportFormat,
  exportFormatVersion,
  manifestName,
  manifestSigned,
} from "./exports.ts";
import { documentIdSchema } from "./ids.ts";
import { knowledgeErrors } from "./knowledge.ts";
import { citedCollectionsOf, citesWrite } from "./memories.ts";

// Restoring an export of the company's Brain into an empty one (GRA-1193,
// GRA-335's E2; the threat model is on GRA-335): what a departing company
// takes with it must come back as it was, and nothing it no longer holds
// may come back with it.
//
// - Every file is checked against the manifest's SHA-256 before anything
//   is written: a bundle that doesn't match is refused whole.
// - Only into an empty Brain: never over another company's.
// - The erasure records are replayed before anything is readable: the
//   people a purge forgot are forgotten again (their records go, and
//   captures of them stay out), erased evidence stays erased, and the
//   purges are kept as the history they are.
// - Only what the export holds: a document in a collection it doesn't
//   name, or a Personal or Grasp collection, refuses the bundle; a memory
//   record resting on what isn't restored is left out.
// - What is derived (sections, search, links, entities) is derived again
//   by indexing and linking, from the restored text: the export holds no
//   index, so nothing it left out can return through one.
//
// Documents get new IDs, as any saved document does; the records that
// cite them are pointed at the new ones. Each version keeps its author and
// time; the restore is audited as the restorer's.
//
// What this doesn't prove (the security review): a checksum shows a
// bundle isn't corrupt, not where it came from. The manifest is unsigned,
// and an honest bundle downloaded before a later purge predates that
// purge's record. No host may wire a restore up (GRA-1194) until it checks
// the source's purge ledger after the export's `createdAt` (GRA-333) or
// accepts only a manifest Grasp signed. Its caller must also be an admin,
// never staff, claim the empty target atomically, and audit who restored
// what.

const manifestSchema = z.object({
  signature: z.string(),
  format: z.literal(exportFormat),
  version: z.literal(exportFormatVersion),
  exportId: z.string(),
  createdAt: z.string(),
  files: z.array(
    z.object({
      name: z.string(),
      sha256: z.string(),
      bytes: z.number(),
      rows: z.number(),
    })
  ),
});

const collectionRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  owner: z.string(),
  access: z.enum(["everyone", "teams", "admins"]),
  sensitive: z.boolean(),
  source: z.enum(["here", "upload", "apps"]),
  createdAt: z.iso.datetime(),
});

const documentRowSchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  path: z.string(),
  createdAt: z.iso.datetime(),
  versions: z.array(
    z.object({
      number: z.int().min(1),
      author: z.string(),
      message: z.string().nullable(),
      restoredFrom: z.int().nullable(),
      createdAt: z.iso.datetime(),
      text: z.string().nullable(),
    })
  ),
  transcript: z
    .object({
      version: z.int(),
      turns: z.string(),
      chapters: z.string(),
    })
    .nullable(),
});

const memoryRowSchema = z.object({
  id: z.string(),
  revision: z.int(),
  kind: z.enum(["fact", "experience", "lesson", "preference"]),
  scope: z.enum(["team", "company"]),
  scopeId: z.string().nullable(),
  ownerId: z.string(),
  statement: z.string(),
  sourceRefs: z.array(brainSourceRefSchema),
  recordedAt: z.iso.datetime(),
});

const erasureRowSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("purge"),
    id: z.string(),
    kind: z.enum(["personal", "content"]),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    supersededBy: z.string().nullable(),
  }),
  z.object({
    type: z.literal("forgotten_person"),
    userId: z.string(),
    at: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("erased_evidence"),
    evidenceId: z.string(),
    at: z.iso.datetime(),
  }),
]);

/** What a restore brought back, and what it replayed. */
export interface RestoreResult {
  exportId: string;
  collections: number;
  documents: number;
  versions: number;
  memories: number;
  /** Records left out: resting on what isn't restored, or a forgotten person's. */
  memoriesLeftOut: number;
  forgottenPeople: number;
}

/** A refused bundle: never what it holds. */
const refused = () => knowledgeErrors.create("knowledge.invalid");

/** `text` as JSON, or a refused bundle. */
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw refused();
  }
};

/** The rows of a JSON Lines file, each checked by `schema`. */
const rowsOf = <T>(text: string, schema: z.ZodType<T>): T[] =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const parsed = schema.safeParse(jsonOf(line));
      if (!parsed.success) {
        throw refused();
      }
      return parsed.data;
    });

/** Every file of the bundle, each checked against the manifest's SHA-256. */
const readBundle = async <C>(
  brain: Brain<C>,
  read: (name: string) => Promise<string | null>
): Promise<{ exportId: string; files: Map<string, string> }> => {
  const manifestText = await read(manifestName);
  if (manifestText === null) {
    throw refused();
  }
  const manifest = manifestSchema.safeParse(jsonOf(manifestText));
  if (!manifest.success) {
    throw refused();
  }
  // Signed by a Brain holding the same secret, as written: one edited
  // since is refused (`manifestSigned`).
  const { signature, ...body } = manifest.data;
  if (!(await manifestSigned(brain, body, signature))) {
    throw refused();
  }
  const files = new Map<string, string>();
  for (const file of manifest.data.files) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time, in order
    const text = await read(file.name);
    // oxlint-disable-next-line no-await-in-loop -- each checked as read
    if (text === null || (await sha256Hex(text)) !== file.sha256) {
      throw refused();
    }
    files.set(file.name, text);
  }
  return { exportId: manifest.data.exportId, files };
};

type ErasureRow = z.infer<typeof erasureRowSchema>;

/** The statement that replays one erasure record. */
const replayed = (
  db: DrizzleD1Database,
  row: ErasureRow,
  now: Date
): BatchItem<"sqlite"> => {
  if (row.type === "forgotten_person") {
    return db
      .insert(brainForgottenPeople)
      .values({ userId: row.userId, forgottenAt: new Date(row.at) })
      .onConflictDoNothing();
  }
  if (row.type === "erased_evidence") {
    return db
      .insert(brainErasedEvidence)
      .values({ evidenceId: row.evidenceId, erasedAt: new Date(row.at) })
      .onConflictDoNothing();
  }
  return db
    .insert(brainPurges)
    .values({
      id: row.id,
      kind: row.kind,
      // Restored history: no input to resume it by.
      key: `restored:${row.id}`,
      by: "",
      counts: "{}",
      createdAt: new Date(row.createdAt),
      updatedAt: now,
      completedAt: new Date(row.completedAt ?? row.createdAt),
      supersededBy: row.supersededBy,
    })
    .onConflictDoNothing();
};

type DocumentRow = z.infer<typeof documentRowSchema>;
type CollectionRow = z.infer<typeof collectionRowSchema>;

/**
 * Restores `document`'s versions in order, each with its author and
 * time, and its transcript: its new ID, and how many versions.
 */
const restoreDocument = async <C>(
  brain: Brain<C>,
  by: Writer,
  collection: CollectionRow,
  document: DocumentRow,
  now: Date
): Promise<{ id: string | undefined; versions: number }> => {
  const { db } = brain;
  const row = { ...collection, createdAt: new Date(collection.createdAt) };
  let id: string | undefined;
  for (const version of document.versions) {
    // oxlint-disable-next-line no-await-in-loop -- one version after another, in order
    const saved = await writeVersion(
      brain,
      { actor: by.actor, userId: version.author },
      {
        collection: row,
        path: document.path,
        text: version.text ?? "",
        ifVersion: version.number - 1,
        message: version.message,
        restoredFrom: version.restoredFrom,
        sync: true,
      }
    );
    ({ id } = saved);
    // oxlint-disable-next-line no-await-in-loop -- its time as it was
    await db
      .update(versions)
      .set({ createdAt: new Date(version.createdAt) })
      .where(
        and(
          eq(versions.documentId, saved.id),
          eq(versions.number, version.number)
        )
      );
  }
  if (id !== undefined && document.transcript !== null) {
    await db.insert(transcripts).values({
      documentId: id,
      version: document.transcript.version,
      turns: document.transcript.turns,
      chapters: document.transcript.chapters,
      createdAt: now,
    });
  }
  return { id, versions: document.versions.length };
};

type MemoryRow = z.infer<typeof memoryRowSchema>;

/**
 * `record`'s references pointed at what is restored, or undefined when
 * it rests on anything that isn't, or is a forgotten person's.
 */
const restoredRefs = (
  record: MemoryRow,
  newIds: ReadonlyMap<string, string>,
  restored: ReadonlySet<string>,
  forgotten: ReadonlySet<string>
): BrainSourceRef[] | undefined => {
  if (forgotten.has(record.ownerId)) {
    return undefined;
  }
  const refs: BrainSourceRef[] = [];
  for (const ref of record.sourceRefs) {
    if (ref.kind === "document") {
      const id = newIds.get(ref.documentId);
      if (id === undefined) {
        return undefined;
      }
      refs.push({ ...ref, documentId: documentIdSchema.parse(id) });
    } else if (restored.has(ref.memoryId)) {
      refs.push(ref);
    } else {
      return undefined;
    }
  }
  return refs;
};

/** Of `candidates`, the records whose every reference is still among them. */
const keptAmong = (
  rows: readonly MemoryRow[],
  candidates: ReadonlySet<string>,
  newIds: ReadonlyMap<string, string>,
  forgotten: ReadonlySet<string>
): Set<string> =>
  new Set(
    rows
      .filter(
        (record) =>
          candidates.has(record.id) &&
          restoredRefs(record, newIds, candidates, forgotten) !== undefined
      )
      .map(({ id }) => id)
  );

/**
 * Restores the shared memory records whole, each with what it rests on;
 * how many it restored and left out.
 */
const restoreMemories = async <C>(
  brain: Brain<C>,
  rows: readonly MemoryRow[],
  newIds: ReadonlyMap<string, string>,
  forgotten: ReadonlySet<string>
): Promise<{ restored: number; leftOut: number }> => {
  const { db } = brain;
  // Kept only while everything it rests on is kept: until nothing more is
  // left out, so a record resting on one left out goes too.
  let candidates = new Set(rows.map(({ id }) => id));
  for (;;) {
    const next = keptAmong(rows, candidates, newIds, forgotten);
    if (next.size === candidates.size) {
      break;
    }
    candidates = next;
  }
  const kept: MemoryRow[] = [];
  for (const record of rows) {
    const refs = candidates.has(record.id)
      ? restoredRefs(record, newIds, candidates, forgotten)
      : undefined;
    if (refs !== undefined) {
      const at = new Date(record.recordedAt);
      // oxlint-disable-next-line no-await-in-loop -- one record after another
      await db.insert(brainMemories).values({
        id: record.id,
        revision: record.revision,
        scope: record.scope,
        scopeId: record.scopeId,
        ownerId: record.ownerId,
        kind: record.kind,
        statement: record.statement,
        sourceRefs: JSON.stringify(refs),
        state: "accepted",
        indexingState: "pending",
        recordedAt: at,
        updatedAt: at,
      });
      kept.push({ ...record, sourceRefs: refs });
    }
  }
  // What each rests on, once all of them are there.
  for (const record of kept) {
    // oxlint-disable-next-line no-await-in-loop -- one record at a time
    const cited = await citedCollectionsOf(db, record.sourceRefs);
    // oxlint-disable-next-line no-await-in-loop -- one record at a time
    await citesWrite(db, record.id, cited);
  }
  return { restored: kept.length, leftOut: rows.length - kept.length };
};

/**
 * Restores the export `read` reads files of into `brain`, empty, as `by`:
 * every file checked against its manifest first, the erasure records
 * replayed before anything is read.
 */
export const restoreExport = async <C>(
  brain: Brain<C>,
  by: Writer,
  read: (name: string) => Promise<string | null>
): Promise<RestoreResult> => {
  const { db } = brain;
  const { exportId, files } = await readBundle(brain, read);
  const [held] = await db.select({ n: count() }).from(collections);
  if ((held?.n ?? 0) > 0) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  const restoredCollections = rowsOf(
    files.get("collections.jsonl") ?? "",
    collectionRowSchema
  );
  const known = new Map(restoredCollections.map((row) => [row.id, row]));
  const documentRows = [...files]
    .filter(([name]) => name.startsWith("documents-"))
    .flatMap(([, text]) => rowsOf(text, documentRowSchema));
  if (documentRows.some(({ collectionId }) => !known.has(collectionId))) {
    throw refused();
  }
  // Everything a write could refuse, refused before the first write: a
  // path twice in a collection, or versions not numbered 1, 2, 3 and on.
  const places = new Set<string>();
  for (const document of documentRows) {
    const place = `${document.collectionId}\n${document.path}`;
    const numbered = document.versions.every(
      ({ number }, index) => number === index + 1
    );
    if (places.has(place) || !numbered || document.versions.length === 0) {
      throw refused();
    }
    places.add(place);
  }
  const erasures = rowsOf(files.get("erasures.jsonl") ?? "", erasureRowSchema);
  const forgotten = new Set(
    erasures.flatMap((row) =>
      row.type === "forgotten_person" ? [row.userId] : []
    )
  );
  const now = brain.ports.clock();
  // The erasure records first: whatever is restored after is held to them.
  const [first, ...rest] = erasures.map((row) => replayed(db, row, now));
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
  for (const row of restoredCollections) {
    // oxlint-disable-next-line no-await-in-loop -- one collection at a time
    await ensureCollection(
      brain,
      { ...row, createdAt: new Date(row.createdAt) },
      by.actor
    );
  }
  // Documents get new IDs: the records citing them are pointed at them.
  const newIds = new Map<string, string>();
  let versionCount = 0;
  for (const document of documentRows) {
    const collection = known.get(document.collectionId);
    if (collection !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time
      const done = await restoreDocument(brain, by, collection, document, now);
      if (done.id !== undefined) {
        newIds.set(document.id, done.id);
      }
      versionCount += done.versions;
    }
  }
  const memories = await restoreMemories(
    brain,
    rowsOf(files.get("memories.jsonl") ?? "", memoryRowSchema),
    newIds,
    forgotten
  );
  const result: RestoreResult = {
    exportId,
    collections: restoredCollections.length,
    documents: newIds.size,
    versions: versionCount,
    memories: memories.restored,
    memoriesLeftOut: memories.leftOut,
    forgottenPeople: forgotten.size,
  };
  await auditedBatch(brain.ports, db, [
    outboxed(brain, {
      actor: by.actor,
      action: "knowledge.export.restored",
      target: { type: "export", id: exportId },
      detail: { ...result },
    }),
  ]);
  return result;
};
