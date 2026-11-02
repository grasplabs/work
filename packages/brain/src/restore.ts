import { and, asc, count, eq, gt, inArray, sql } from "drizzle-orm";
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
  isPartOf,
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
//   is written: a bundle that doesn't match is refused whole. Each part's
//   files are read in name order, one at a time, twice (checked, then
//   written, checked again as read): never the whole bundle at once.
// - Only into an empty Brain, holding no collection nor memory record:
//   never over another company's.
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
// what. It must also run the restore as a job that goes on across calls,
// as an export does (exports.ts `exportInvocationReads`): this runs in one
// call, and each version it saves takes several subrequests (the save's
// D1 statements, its text's upload, its time), so a company of any size
// passes what one invocation may make.

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

const versionRowSchema = z.object({
  number: z.int().min(1),
  author: z.string(),
  message: z.string().nullable(),
  restoredFrom: z.int().nullable(),
  createdAt: z.iso.datetime(),
  text: z.string().nullable(),
});

const documentRowSchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  path: z.string(),
  createdAt: z.iso.datetime(),
  versions: z.array(versionRowSchema),
  transcript: z
    .object({
      version: z.int(),
      turns: z.string(),
      chapters: z.string(),
    })
    .nullable(),
});

/**
 * A line of a documents file: a document's first, or one that continues
 * it with the versions that follow (exports.ts `documentsFile`).
 */
const documentsLineSchema = z.union([
  z.object({ continues: z.string(), versions: z.array(versionRowSchema) }),
  documentRowSchema,
]);

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

type CollectionRow = z.infer<typeof collectionRowSchema>;
type VersionRow = z.infer<typeof versionRowSchema>;

/** A row of a JSON Lines file, checked by `schema`, or a refused bundle. */
const rowOf = <T>(line: string, schema: z.ZodType<T>): T => {
  const parsed = schema.safeParse(jsonOf(line));
  if (!parsed.success) {
    throw refused();
  }
  return parsed.data;
};

/** The bundle's manifest, signed by this Brain's secret, as written. */
type Manifest = z.infer<typeof manifestSchema>;
type BundleFile = Manifest["files"][number];

/** The manifest of the bundle `read` reads: refused unless signed so. */
const manifestOf = async <C>(
  brain: Brain<C>,
  read: (name: string) => Promise<string | null>
): Promise<Manifest> => {
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
  return manifest.data;
};

/**
 * File `file` of the bundle, as its manifest names it: refused when it is
 * missing or doesn't match its SHA-256. Read again for the writes, it is
 * checked again: a reader that hands over other bytes the second time
 * stops the restore there.
 */
const fileText = async (
  read: (name: string) => Promise<string | null>,
  file: BundleFile
): Promise<string> => {
  const text = await read(file.name);
  if (text === null || (await sha256Hex(text)) !== file.sha256) {
    throw refused();
  }
  return text;
};

/** The parts a restore reads, in the order it reads them. */
const restoredParts = [
  "collections",
  "documents",
  "memories",
  "erasures",
] as const;
type RestoredPart = (typeof restoredParts)[number];

/** The files of part `prefix` the manifest names, in name order. */
const filesOfPart = (manifest: Manifest, prefix: RestoredPart): BundleFile[] =>
  manifest.files
    .filter(({ name }) => isPartOf(prefix, name))
    .toSorted((a, b) => a.name.localeCompare(b.name));

/**
 * Each row of part `prefix`, checked by `schema`, one file at a time, in
 * name order: never more than one file read at once.
 */
const eachRow = async <T>(
  read: (name: string) => Promise<string | null>,
  manifest: Manifest,
  prefix: RestoredPart,
  schema: z.ZodType<T>,
  each: (row: T) => Promise<void> | void
): Promise<void> => {
  for (const file of filesOfPart(manifest, prefix)) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time, to bound memory
    const text = await fileText(read, file);
    for (const line of text.split("\n")) {
      if (line !== "") {
        // oxlint-disable-next-line no-await-in-loop -- one row after another, in order
        await each(rowOf(line, schema));
      }
    }
  }
};

/**
 * A line of a documents file: a document's first, or one that continues
 * it with the versions that follow (exports.ts `documentsFile`).
 */
type DocumentsLine = z.infer<typeof documentsLineSchema>;

/**
 * Checks the documents' lines as they come, a document at a time: each in
 * a collection the bundle holds, in ID order (so none twice), at a place
 * no other has, its lines continuing it alone, its versions numbered 1, 2,
 * 3 and on with none lost or repeated.
 */
const documentsCheck = (known: ReadonlySet<string>) => {
  const places = new Set<string>();
  let current: { id: string; next: number } | undefined;
  const ended = () => {
    // A document with no version at all is no document.
    if (current !== undefined && current.next === 1) {
      throw refused();
    }
  };
  const versionsFrom = (rows: readonly VersionRow[]) => {
    for (const { number } of rows) {
      if (current === undefined || number !== current.next) {
        throw refused();
      }
      current.next += 1;
    }
  };
  return {
    line: (line: DocumentsLine) => {
      if ("continues" in line) {
        if (line.continues !== current?.id) {
          throw refused();
        }
        versionsFrom(line.versions);
        return;
      }
      ended();
      const place = `${line.collectionId}\n${line.path}`;
      if (
        !known.has(line.collectionId) ||
        places.has(place) ||
        (current !== undefined && line.id <= current.id)
      ) {
        throw refused();
      }
      places.add(place);
      current = { id: line.id, next: 1 };
      versionsFrom(line.versions);
    },
    ended,
  };
};

/**
 * Checks the whole bundle before anything is written: every file against
 * its SHA-256, a file at a time, and every row of the parts it restores.
 */
const checkBundle = async (
  read: (name: string) => Promise<string | null>,
  manifest: Manifest
): Promise<void> => {
  const known = new Set<string>();
  await eachRow(read, manifest, "collections", collectionRowSchema, (row) => {
    known.add(row.id);
  });
  const documents = documentsCheck(known);
  await eachRow(read, manifest, "documents", documentsLineSchema, (line) => {
    documents.line(line);
  });
  documents.ended();
  await eachRow(read, manifest, "memories", memoryRowSchema, () => {
    // Checked as read.
  });
  await eachRow(read, manifest, "erasures", erasureRowSchema, () => {
    // Checked as read.
  });
  // The host's files, and any other the manifest names: their checksums.
  const restored = new Set(
    restoredParts.flatMap((prefix) =>
      filesOfPart(manifest, prefix).map(({ name }) => name)
    )
  );
  for (const file of manifest.files) {
    if (!restored.has(file.name)) {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time, to bound memory
      await fileText(read, file);
    }
  }
};

/** Statements one batch of erasure records replays. */
const erasuresPerBatch = 50;

/**
 * Replays the erasure records, a batch at a time: how many people they
 * forgot.
 */
const replayErasures = async <C>(
  brain: Brain<C>,
  read: (name: string) => Promise<string | null>,
  manifest: Manifest,
  now: Date
): Promise<number> => {
  const { db } = brain;
  let forgotten = 0;
  let pending: BatchItem<"sqlite">[] = [];
  const flush = async () => {
    const [first, ...rest] = pending;
    pending = [];
    if (first !== undefined) {
      await db.batch([first, ...rest]);
    }
  };
  await eachRow(read, manifest, "erasures", erasureRowSchema, async (row) => {
    forgotten += row.type === "forgotten_person" ? 1 : 0;
    pending.push(replayed(db, row, now));
    if (pending.length >= erasuresPerBatch) {
      await flush();
    }
  });
  await flush();
  return forgotten;
};

/**
 * Writes `rows`, versions of the document at `path` in `collection`, in
 * order, each with its author and time: the document's ID.
 */
const restoreVersions = async <C>(
  brain: Brain<C>,
  by: Writer,
  collection: CollectionRow,
  path: string,
  rows: readonly VersionRow[]
): Promise<string | undefined> => {
  const { db } = brain;
  const row = { ...collection, createdAt: new Date(collection.createdAt) };
  let id: string | undefined;
  for (const version of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one version after another, in order
    const saved = await writeVersion(
      brain,
      { actor: by.actor, userId: version.author },
      {
        collection: row,
        path,
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
  return id;
};

/**
 * Restores the documents a line at a time, each document's versions in
 * order across the lines and files that hold them, then its transcript:
 * each document's new ID by its old one, and how many versions.
 */
const restoreDocuments = async <C>(
  brain: Brain<C>,
  by: Writer,
  read: (name: string) => Promise<string | null>,
  manifest: Manifest,
  collectionsById: ReadonlyMap<string, CollectionRow>,
  now: Date
): Promise<{ newIds: Map<string, string>; versions: number }> => {
  const { db } = brain;
  const newIds = new Map<string, string>();
  let versionCount = 0;
  // The document being restored: its lines come one after another.
  let current:
    | {
        line: Extract<DocumentsLine, { id: string }>;
        collection: CollectionRow;
        id: string | undefined;
      }
    | undefined;
  const finish = async () => {
    if (current === undefined) {
      return;
    }
    const { line, id } = current;
    if (id !== undefined) {
      newIds.set(line.id, id);
      if (line.transcript !== null) {
        await db.insert(transcripts).values({
          documentId: id,
          version: line.transcript.version,
          turns: line.transcript.turns,
          chapters: line.transcript.chapters,
          createdAt: now,
        });
      }
    }
    current = undefined;
  };
  await eachRow(
    read,
    manifest,
    "documents",
    documentsLineSchema,
    async (line) => {
      if (!("continues" in line)) {
        await finish();
        const collection = collectionsById.get(line.collectionId);
        if (collection === undefined) {
          throw refused();
        }
        current = { line, collection, id: undefined };
      }
      if (current === undefined) {
        throw refused();
      }
      const id = await restoreVersions(
        brain,
        by,
        current.collection,
        current.line.path,
        line.versions
      );
      current.id = id ?? current.id;
      versionCount += line.versions.length;
    }
  );
  await finish();
  return { newIds, versions: versionCount };
};

/** Memory records whose citations one page writes. */
const citesPerPage = 100;

/**
 * Restores the shared memory records, a row at a time, each pointed at
 * the documents restored: then drops, until none is left to drop, those
 * a forgotten person owns and those resting on a record not restored, so
 * a record resting on one left out goes too; then what each rests on.
 * How many it restored and left out. The Brain held no memory record
 * before (`restoreExport`): every one it holds now is restored.
 */
const restoreMemories = async <C>(
  brain: Brain<C>,
  read: (name: string) => Promise<string | null>,
  manifest: Manifest,
  newIds: ReadonlyMap<string, string>
): Promise<{ restored: number; leftOut: number }> => {
  const { db } = brain;
  let seen = 0;
  await eachRow(read, manifest, "memories", memoryRowSchema, async (record) => {
    seen += 1;
    const refs: BrainSourceRef[] = [];
    for (const ref of record.sourceRefs) {
      if (ref.kind === "document") {
        const id = newIds.get(ref.documentId);
        // Resting on a document not restored: left out.
        if (id === undefined) {
          return;
        }
        refs.push({ ...ref, documentId: documentIdSchema.parse(id) });
      } else {
        refs.push(ref);
      }
    }
    const at = new Date(record.recordedAt);
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
  });
  await db
    .delete(brainMemories)
    .where(
      inArray(
        brainMemories.ownerId,
        db
          .select({ id: brainForgottenPeople.userId })
          .from(brainForgottenPeople)
      )
    );
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- until nothing more is left out
    const dropped = await db
      .delete(brainMemories)
      .where(
        sql`EXISTS (SELECT 1 FROM json_each(${brainMemories.sourceRefs}) AS ref WHERE json_extract(ref.value, '$.kind') = 'memory' AND json_extract(ref.value, '$.memoryId') NOT IN (SELECT ${brainMemories.id} FROM ${brainMemories}))`
      )
      .returning({ id: brainMemories.id });
    if (dropped.length === 0) {
      break;
    }
  }
  // What each rests on, once all of them are there, a page at a time.
  let restored = 0;
  let after = "";
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    const page = await db
      .select({ id: brainMemories.id, sourceRefs: brainMemories.sourceRefs })
      .from(brainMemories)
      .where(gt(brainMemories.id, after))
      .orderBy(asc(brainMemories.id))
      .limit(citesPerPage);
    for (const record of page) {
      const refs = z
        .array(brainSourceRefSchema)
        .parse(JSON.parse(record.sourceRefs));
      // oxlint-disable-next-line no-await-in-loop -- one record at a time
      const cited = await citedCollectionsOf(db, refs);
      // oxlint-disable-next-line no-await-in-loop -- one record at a time
      await citesWrite(db, record.id, cited);
    }
    restored += page.length;
    const last = page.at(-1);
    if (last === undefined) {
      break;
    }
    after = last.id;
  }
  return { restored, leftOut: seen - restored };
};

/**
 * Restores the export `read` reads files of into `brain`, empty, as `by`:
 * every file checked against its manifest first, a file at a time, then
 * the erasure records replayed before anything is read, then the rest, a
 * file at a time again (each checked again as it is read).
 */
export const restoreExport = async <C>(
  brain: Brain<C>,
  by: Writer,
  read: (name: string) => Promise<string | null>
): Promise<RestoreResult> => {
  const { db } = brain;
  const manifest = await manifestOf(brain, read);
  await checkBundle(read, manifest);
  const [heldCollections] = await db.select({ n: count() }).from(collections);
  const [heldMemories] = await db.select({ n: count() }).from(brainMemories);
  if ((heldCollections?.n ?? 0) > 0 || (heldMemories?.n ?? 0) > 0) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  const now = brain.ports.clock();
  // The erasure records first: whatever is restored after is held to them.
  const forgottenPeople = await replayErasures(brain, read, manifest, now);
  const collectionsById = new Map<string, CollectionRow>();
  await eachRow(
    read,
    manifest,
    "collections",
    collectionRowSchema,
    async (row) => {
      await ensureCollection(
        brain,
        { ...row, createdAt: new Date(row.createdAt) },
        by.actor
      );
      collectionsById.set(row.id, row);
    }
  );
  // Documents get new IDs: the records citing them are pointed at them.
  const documents = await restoreDocuments(
    brain,
    by,
    read,
    manifest,
    collectionsById,
    now
  );
  const memories = await restoreMemories(
    brain,
    read,
    manifest,
    documents.newIds
  );
  const result: RestoreResult = {
    exportId: manifest.exportId,
    collections: collectionsById.size,
    documents: documents.newIds.size,
    versions: documents.versions,
    memories: memories.restored,
    memoriesLeftOut: memories.leftOut,
    forgottenPeople,
  };
  await auditedBatch(brain.ports, db, [
    outboxed(brain, {
      actor: by.actor,
      action: "knowledge.export.restored",
      target: { type: "export", id: manifest.exportId },
      detail: { ...result },
    }),
  ]);
  return result;
};
