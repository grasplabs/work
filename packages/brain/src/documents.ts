import { and, asc, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { auditedBatch, outboxed } from "./audit.ts";
import { allowedFor } from "./authorize.ts";
import type { Allowed } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import { readableCollection } from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import { brainErrors } from "./contract.ts";
import { isUniqueViolation } from "./db/d1.ts";
import {
  brainDocumentCites,
  brainPayloads,
  collections,
  documents,
  links,
  versions,
} from "./db/schema.ts";
import { sha256Hex } from "./encoding.ts";
import { documentLinkIntent } from "./entities.ts";
import type { BrainEvent, DetailValue } from "./events.ts";
import {
  FrontmatterError,
  parseBaseFields,
  parseFrontmatter,
} from "./frontmatter.ts";
import type { ParsedDocument } from "./frontmatter.ts";
import { collectionIdSchema, documentIdSchema } from "./ids.ts";
import { publishInline } from "./indexing.ts";
import type { Json } from "./json.ts";
import {
  documentTypeOf,
  historyOptionsSchema,
  knowledgeErrors,
  listDocumentsOptionsSchema,
  versionInputSchema,
} from "./knowledge.ts";
import type {
  Backlink,
  BacklinkPage,
  DocumentPage,
  DocumentRead,
  DocumentSummary,
  DocumentType,
  HistoryPage,
  Version,
  VersionSummary,
} from "./knowledge.ts";
import { extractLinks, splitSections } from "./markdown.ts";
import type { Link, Section } from "./markdown.ts";
import {
  commitPayload,
  committedKey,
  isUncommitted,
  readPayload,
  stagePayload,
} from "./payloads.ts";
import type { StagedPayload } from "./payloads.ts";
import {
  hasTranscript,
  transcriptDetail,
  transcriptSchema,
  isTranscriptMoved,
  transcriptUnmoved,
  transcriptWrites,
} from "./transcripts.ts";
import type { ReadAt, Transcript } from "./transcripts.ts";

// Saving a document: its frontmatter is read and checked (and a memory
// file's size, memory-files.ts), its Markdown split into sections and its
// links found, its text stored as an immutable payload in R2
// (payloads.ts), and then one D1 batch (a transaction) commits the
// payload, adds the next version, replaces the links, updates the document
// (queued for indexing) and stores the audit event; its sections are then
// published to search (indexing.ts). The batch commits whole or not
// at all, and a save from a version that is no longer current writes
// nothing (its payload, unreferenced, is collected later).

/**
 * Largest document text, in bytes of UTF-8: the sections, which hold it
 * all again, are rows in D1, which keeps a row to 2 MB.
 */
const knowledgeTextMaxBytes = 1024 * 1024;

/** Most sections one document has. */
const documentMaxSections = 1000;

/** Most distinct links one document has. */
export const documentMaxLinks = 500;

/** D1 binds at most 100 parameters to one statement. */
const maxBoundParameters = 100;

export type DocumentRow = typeof documents.$inferSelect;

/** What a save writes, read from the text. */
interface Prepared {
  type: DocumentType;
  title: string;
  description: string;
  owner: string | undefined;
  tags: string[];
  reviewDate: string | null;
  sections: Section[];
  links: Link[];
}

const invalid = (issues: string[]) =>
  knowledgeErrors.create("knowledge.invalid", { issues });

const fileTitle = (path: string): string => {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/**
 * A document's title: the frontmatter's, else a skill's name, else its
 * first heading (of `found`, its sections), else its file name.
 */
const titleOf = (
  path: string,
  { type, frontmatter }: ParsedDocument,
  found: readonly Section[]
): string => {
  const name =
    type === "skill" && typeof frontmatter.name === "string"
      ? frontmatter.name
      : undefined;
  const firstHeading = found
    .map(({ headings }) => headings[0] ?? "")
    .find((heading) => heading !== "");
  return frontmatter.title ?? name ?? firstHeading ?? fileTitle(path);
};

/**
 * The values a save of `text` at `path` gives the search index
 * (0001_search.sql), as `prepare` reads them: its title and description,
 * and each section's headings, joined by a space, and text. Undefined when
 * its frontmatter doesn't read. A personal purge works out from these the
 * tokens of every version it deletes (search-erasure.ts).
 */
export const indexedValuesOf = (
  path: string,
  text: string
): string[] | undefined => {
  let parsed: ParsedDocument;
  try {
    parsed = parseBaseFields(path, text);
  } catch {
    return undefined;
  }
  const found = splitSections(parsed.body);
  return [
    titleOf(path, parsed, found),
    parsed.frontmatter.description,
    ...found.flatMap(({ headings, text: sectionText }) => [
      headings.join(" "),
      sectionText,
    ]),
  ];
};

/**
 * How many sections a version's `text` at `path` has, numbered from 0 as
 * its save numbered them, or undefined when its frontmatter doesn't read:
 * for a version whose sections are no longer stored (only the current
 * one's are), such as one a Brain memory cites.
 */
export const sectionCountOf = (
  path: string,
  text: string
): number | undefined => {
  try {
    return splitSections(parseBaseFields(path, text).body).length;
  } catch {
    return undefined;
  }
};

/**
 * Reads the text of the document at `path`, within the limits a save
 * keeps. Its title is the frontmatter's, else a skill's name, else its
 * first heading, else its file name.
 */
const prepare = (path: string, text: string, purge: boolean): Prepared => {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > knowledgeTextMaxBytes) {
    throw knowledgeErrors.create("knowledge.too_large", {
      bytes,
      maxBytes: knowledgeTextMaxBytes,
    });
  }
  let parsed: ParsedDocument;
  try {
    parsed = purge ? parseBaseFields(path, text) : parseFrontmatter(path, text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw invalid(error.issues);
    }
    throw error;
  }
  const { type, frontmatter, body } = parsed;
  const found = splitSections(body);
  if (found.length > documentMaxSections) {
    throw knowledgeErrors.create("knowledge.too_many_sections", {
      sections: found.length,
      maxSections: documentMaxSections,
    });
  }
  const linked = extractLinks(body);
  if (linked.length > documentMaxLinks) {
    throw knowledgeErrors.create("knowledge.too_many_links", {
      links: linked.length,
      maxLinks: documentMaxLinks,
    });
  }
  return {
    type,
    title: titleOf(path, parsed, found),
    description: frontmatter.description,
    owner: frontmatter.owner,
    tags: frontmatter.tags,
    reviewDate: frontmatter.review ?? null,
    sections: found,
    links: linked,
  };
};

export const findByPath = async (
  db: DrizzleD1Database,
  collectionId: string,
  path: string
): Promise<DocumentRow | undefined> =>
  await db
    .select()
    .from(documents)
    .where(
      and(eq(documents.collectionId, collectionId), eq(documents.path, path))
    )
    .get();

/** Splits rows so no insert binds more parameters than D1 allows. */
const inChunks = <Row extends object>(rows: Row[]): Row[][] => {
  const [first] = rows;
  if (!first) {
    return [];
  }
  const size = Math.floor(maxBoundParameters / Object.keys(first).length);
  const chunks: Row[][] = [];
  for (let start = 0; start < rows.length; start += size) {
    chunks.push(rows.slice(start, start + size));
  }
  return chunks;
};

const tagsSchema = z.array(z.string());

export const toSummary = (row: DocumentRow): DocumentSummary => ({
  id: documentIdSchema.parse(row.id),
  collectionId: collectionIdSchema.parse(row.collectionId),
  path: row.path,
  title: row.title,
  type: documentTypeOf(row.type),
  description: row.description,
  owner: row.owner,
  tags: tagsSchema.parse(JSON.parse(row.tags)),
  reviewDate: row.reviewDate,
  currentVersion: row.currentVersion,
  indexedVersion: row.indexedVersion,
  indexing: row.indexState,
  updatedAt: row.updatedAt.toISOString(),
});

const versionColumns = {
  number: versions.number,
  author: versions.author,
  message: versions.message,
  restoredFrom: versions.restoredFrom,
  createdAt: versions.createdAt,
};

/** A version's metadata, its payload's hash joined: never its text. */
const versionSummaryColumns = {
  ...versionColumns,
  sha256: brainPayloads.sha256,
};

const toVersionSummary = (row: {
  number: number;
  author: string;
  message: string | null;
  restoredFrom: number | null;
  createdAt: Date;
  sha256: string;
}): VersionSummary => ({
  number: row.number,
  author: row.author,
  message: row.message,
  restoredFrom: row.restoredFrom,
  sha256: row.sha256,
  createdAt: row.createdAt.toISOString(),
});

/**
 * The text of `document`'s version `number`, read from its payload, or
 * undefined when there's no such version.
 */
export const versionText = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  documentId: string,
  number: number
): Promise<string | undefined> => {
  const ref = await db
    .select({ key: brainPayloads.key, sha256: brainPayloads.sha256 })
    .from(versions)
    .innerJoin(brainPayloads, eq(brainPayloads.key, versions.payloadKey))
    .where(
      and(eq(versions.documentId, documentId), eq(versions.number, number))
    )
    .get();
  return ref === undefined ? undefined : await readPayload(brain, ref);
};

const conflict = (existing: DocumentRow | undefined) =>
  knowledgeErrors.create("knowledge.conflict", {
    documentId: existing?.id ?? null,
    latestVersion: existing?.currentVersion ?? 0,
  });

/**
 * Reads `text` for the document at `path` in `collection`, refused as a
 * save would refuse it: as the host's `onWrite` port refuses it (core's:
 * the Grasp skills by anything but their sync, a memory file over its
 * size limit), over a document's limits, or frontmatter that doesn't fit
 * its type. A purge's text (`purge`) is checked for the fields every type
 * has only (`parseBaseFields`), whatever its type says.
 */
export const checkedText = async <C>(
  brain: Brain<C>,
  collection: CollectionRow,
  path: string,
  text: string,
  sync = false,
  purge = false
): Promise<Prepared> => {
  await brain.ports.onWrite({ collection, path, text, sync });
  return prepare(path, text, purge);
};

/**
 * Who saves a version: the audit log's actor, and the person the version
 * is by (the author, and the owner of a new document without one in its
 * frontmatter): a person saving themselves, or the one an agent or App
 * acts for. `detail` goes into the save's audit event: for an App, the
 * person it acted for, how (interactive or a workflow run) and its
 * version, which its actor doesn't name.
 */
export interface Writer {
  actor: Json;
  userId: string;
  detail?: Record<string, DetailValue>;
}

/** A new version of the document at `path` in `collection`. */
export interface Write {
  collection: CollectionRow;
  path: string;
  text: string;
  ifVersion: number;
  message: string | null;
  restoredFrom: number | null;
  /**
   * More statements for the same batch, such as a purge's rewrite of the
   * current version: they commit with it or not at all.
   */
  also?: BatchItem<"sqlite">[];
  /**
   * Set by the host's own sync of what it alone writes (core's Grasp
   * skills), which its `onWrite` port lets through.
   */
  sync?: true;
  /**
   * Checked last, just before the batch is sent, with nothing awaited in
   * between: throws to refuse the write, such as a delegate's context that
   * became restricted while the save was being prepared.
   */
  lastCheck?: () => Promise<void>;
  /**
   * What the version rests on, when its writer wrote it from what it read
   * (`brain_document_cites`, GRA-1093): set by the host for a save from a
   * pinned chat or run, never for a person's own. At most
   * `documentCitesMax`.
   */
  cites?: readonly DocumentCite[];
  /**
   * Set only by a purge (purge.ts): removing personal data comes first, so
   * its text is checked only for the fields every type has and a
   * document's limits (`parseBaseFields`).
   */
  purge?: true;
  /**
   * The version's transcript (transcripts.ts), as its producer gives it:
   * saved in the same batch, and served while this version is current.
   * Left out, the document has none from this version on.
   */
  transcript?: unknown;
  /**
   * Set only by a purge, in place of `transcript`: the transcript it
   * rewrote, kept with the version it saves. Removing data comes before
   * limits, so it isn't checked against them again.
   */
  purgedTranscript?: Transcript;
  /**
   * With `purgedTranscript`: the transcript as the purge read it. The save
   * fails with `knowledge.conflict` when it is no longer so, as another
   * purge changed it meanwhile (`transcriptUnmoved`).
   */
  transcriptRead?: ReadAt;
}

/**
 * `row`, just saved, once its sections are published (`publishInline`):
 * marked indexed when search holds them, queued otherwise.
 */
const published = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  row: DocumentRow,
  found: readonly Section[],
  purgeBy: Json | undefined
): Promise<DocumentRow> =>
  (await publishInline(brain, db, row.id, row.currentVersion, found, purgeBy))
    ? { ...row, indexedVersion: row.currentVersion, indexState: "indexed" }
    : row;

/**
 * Stores `text` for `collectionId` and sends the save's batch with it. A
 * payload collected between its staging and the batch refuses the batch
 * (`isUncommitted`): the text is stored again, once.
 */
const stagedAndSent = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  collectionId: string,
  text: string,
  send: (staged: StagedPayload) => Promise<void>
): Promise<void> => {
  try {
    await send(await stagePayload(brain, db, collectionId, text));
  } catch (error) {
    if (!isUncommitted(error)) {
      throw error;
    }
    await send(await stagePayload(brain, db, collectionId, text));
  }
};

/**
 * The row a save leaves: `saved`, with what it keeps of the document as it
 * was (`existing`, none for a new one): what search holds of it, whether a
 * purge waits on its indexing, when it was created.
 */
const savedRow = (
  existing: DocumentRow | undefined,
  saved: Omit<DocumentRow, "indexedVersion" | "indexPurgePending" | "createdAt">
): DocumentRow => ({
  indexedVersion: existing?.indexedVersion ?? null,
  indexPurgePending: existing?.indexPurgePending ?? false,
  createdAt: existing?.createdAt ?? saved.updatedAt,
  ...saved,
});

/** What a version rests on: a collection, or a document in it. */
export interface DocumentCite {
  collectionId: string;
  documentId?: string;
  /**
   * With `documentId`: the version it was read at, and its pin
   * (`PinnedVersion.text`, recall-store.ts): the version must still be
   * stored as it was then, or the save is refused, and a purge of it
   * later hides the copy.
   */
  version?: number;
  pin?: string;
}

/**
 * Most cites one version keeps: far above what a chat or run reads, so
 * each read's check of them stays one bounded index range.
 */
export const documentCitesMax = 500;

/**
 * The payload a cited version is stored as, if its pin still says so:
 * '' for a cite of no version. Refuses, as `brain.revoked`, a version
 * gone or no longer stored as it was read (purged since).
 */
const citedPayloadKey = async (
  db: DrizzleD1Database,
  { documentId, version, pin }: DocumentCite
): Promise<string> => {
  if (documentId === undefined || version === undefined || pin === undefined) {
    return "";
  }
  const row = await db
    .select({ key: versions.payloadKey })
    .from(versions)
    .where(
      and(eq(versions.documentId, documentId), eq(versions.number, version))
    )
    .get();
  if (row === undefined || (await sha256Hex(row.key)) !== pin) {
    throw brainErrors.create("brain.revoked");
  }
  return row.key;
};

/**
 * The statements that write what a version of `write` rests on, once its
 * document and number are known: its `cites`, and those of the version it
 * was made from (one it restores, or one a purge rewrites), which a copy
 * of it keeps. Refuses, as `brain.budget_exceeded`, more than
 * `documentCitesMax` cites.
 */
const citesWrites = async (db: DrizzleD1Database, write: Write) => {
  const cites = write.cites ?? [];
  if (cites.length > documentCitesMax) {
    throw brainErrors.create("brain.budget_exceeded");
  }
  const purged = write.purge === true && write.ifVersion > 0;
  const from = write.restoredFrom ?? (purged ? write.ifVersion : null);
  const rows = JSON.stringify(
    await Promise.all(
      cites.map(async (cite) => [
        cite.collectionId,
        cite.documentId ?? "",
        cite.version ?? 0,
        await citedPayloadKey(db, cite),
      ])
    )
  );
  return (documentId: string, number: number): BatchItem<"sqlite">[] => [
    ...(cites.length === 0
      ? []
      : [
          db
            .insert(brainDocumentCites)
            .select(
              sql`SELECT ${documentId}, ${number}, json_extract(cite.value, '$[0]'), json_extract(cite.value, '$[1]'), json_extract(cite.value, '$[2]'), json_extract(cite.value, '$[3]') FROM json_each(${rows}) AS cite WHERE true`
            )
            .onConflictDoNothing(),
        ]),
    ...(from === null
      ? []
      : [
          db
            .insert(brainDocumentCites)
            .select(
              sql`SELECT document_id, ${number}, collection_id, cited_document_id, cited_version, cited_payload_key FROM ${brainDocumentCites} WHERE document_id = ${documentId} AND version = ${from}`
            )
            .onConflictDoNothing(),
        ]),
  ];
};

/**
 * Writes the next version, if the document is still at `ifVersion`
 * (0: it doesn't exist yet). Throws `knowledge.conflict`, with the version
 * it is at, and writes nothing otherwise.
 */
export const writeVersion = async <C>(
  brain: Brain<C>,
  by: Writer,
  write: Write
): Promise<DocumentSummary> => {
  const { collection, path, text, ifVersion, message, restoredFrom } = write;
  const { also = [], sync = false } = write;
  const rests = await citesWrites(brain.db, write);
  const { db } = brain;
  const existing = await findByPath(db, collection.id, path);
  const prepared = await checkedText(
    brain,
    collection,
    path,
    text,
    sync,
    write.purge === true
  );
  const transcript =
    write.transcript === undefined
      ? write.purgedTranscript
      : knowledgeErrors.parse(
          "knowledge.invalid",
          transcriptSchema,
          write.transcript
        );
  if ((existing?.currentVersion ?? 0) !== ifVersion) {
    throw conflict(existing);
  }
  const had =
    existing !== undefined && transcript === undefined
      ? await hasTranscript(db, existing.id)
      : false;
  const now = brain.ports.clock();
  const number = ifVersion + 1;
  const documentId = existing?.id ?? crypto.randomUUID();
  const changes = {
    title: prepared.title,
    type: prepared.type,
    description: prepared.description,
    owner: prepared.owner ?? existing?.owner ?? by.userId,
    tags: JSON.stringify(prepared.tags),
    reviewDate: prepared.reviewDate,
    currentVersion: number,
    // The save is its version's indexing intent (indexing.ts).
    indexState: "queued" as const,
    indexAttempts: 0,
    indexFailure: null,
    indexRun: 0,
    indexFailedAt: null,
    updatedAt: now,
  };
  const row = savedRow(existing, {
    id: documentId,
    collectionId: collection.id,
    path,
    ...changes,
  });
  const entry: BrainEvent = {
    actor: by.actor,
    action:
      restoredFrom === null
        ? "knowledge.document.saved"
        : "knowledge.document.restored",
    target: { type: "document", id: documentId },
    detail: {
      ...by.detail,
      collectionId: collection.id,
      version: number,
      ...(restoredFrom === null ? {} : { restoredFrom }),
      ...(transcript === undefined ? {} : transcriptDetail(transcript)),
    },
  };
  const statements = (staged: StagedPayload): BatchItem<"sqlite">[] => [
    ...commitPayload(db, staged),
    // The version's primary key is the edit check: a save that got here
    // from the same version first has taken this number.
    db.insert(versions).values({
      documentId,
      number,
      payloadKey: committedKey(staged),
      author: by.userId,
      message,
      restoredFrom,
      createdAt: now,
    }),
    ...(write.transcriptRead === undefined
      ? []
      : [transcriptUnmoved(db, documentId, write.transcriptRead)]),
    ...transcriptWrites(
      brain,
      by.actor,
      { documentId, version: number, had },
      transcript,
      now
    ),
    db.delete(links).where(eq(links.fromDocumentId, documentId)),
    ...inChunks(
      prepared.links.map((link) => ({
        fromDocumentId: documentId,
        toCollectionId: collection.id,
        toPath: link.path,
        label: link.label,
      }))
    ).map((chunk) => db.insert(links).values(chunk)),
    // The version's linking intent, and its entity mentions gone with the
    // text they came from (entities.ts).
    ...documentLinkIntent(
      db,
      collection,
      documentId,
      number,
      now,
      write.purge === true
    ),
    // What it rests on, with it: its writer's reads, and those of the
    // version it restores or a purge rewrites (GRA-1093).
    ...rests(documentId, number),
    outboxed(brain, entry),
    ...also,
  ];
  // A new document's row goes first: its version refers to it.
  const document = existing
    ? db
        .update(documents)
        .set(changes)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.currentVersion, ifVersion)
          )
        )
    : db.insert(documents).values(row);
  // A payload collected between its staging and the batch refuses the
  // batch (`isUncommitted`): the text is stored again, once.
  const send = async (staged: StagedPayload): Promise<void> => {
    await write.lastCheck?.();
    try {
      await auditedBatch(brain.ports, db, [document, ...statements(staged)]);
    } catch (error) {
      if (isUniqueViolation(error) || isTranscriptMoved(error)) {
        throw conflict(await findByPath(db, collection.id, path));
      }
      throw error;
    }
  };
  // Checked before the text is stored too: a write it refuses never
  // uploads it.
  await write.lastCheck?.();
  await stagedAndSent(brain, db, collection.id, text, send);
  // Saved: search has it once published, here or by its indexing run.
  return toSummary(
    await published(
      brain,
      db,
      row,
      prepared.sections,
      write.purge === true ? by.actor : undefined
    )
  );
};

/**
 * The document with `documentId` and its collection, if it is one of the
 * `allowed` documents. A malformed ID is one that doesn't exist.
 */
export const readableDocument = async (
  db: DrizzleD1Database,
  allowed: Allowed,
  documentId: unknown
): Promise<{ document: DocumentRow; collection: CollectionRow }> => {
  const id = documentIdSchema.safeParse(documentId);
  const found = id.success
    ? await db
        .select({ document: documents, collection: collections })
        .from(documents)
        .innerJoin(collections, eq(collections.id, documents.collectionId))
        .where(and(eq(documents.id, id.data), allowed.documents()))
        .get()
    : undefined;
  if (!found) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return found;
};

/** A document with its current version, or with `version`. */
export const getDocument = async <C>(
  brain: Brain<C>,
  reader: C,
  documentId: unknown,
  version?: unknown
): Promise<DocumentRead> => {
  const number =
    version === undefined
      ? undefined
      : knowledgeErrors.parse("knowledge.invalid", versionInputSchema, version);
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  const id = documentIdSchema.safeParse(documentId);
  // The version's payload is found in the same query as the access check,
  // so it is never read from a collection that stopped being readable in
  // between: a later revocation doesn't take back a read already allowed.
  const found = id.success
    ? await db
        .select({
          document: documents,
          collection: collections,
          version: versionColumns,
          payload: { key: brainPayloads.key, sha256: brainPayloads.sha256 },
        })
        .from(documents)
        .innerJoin(collections, eq(collections.id, documents.collectionId))
        .leftJoin(
          versions,
          and(
            eq(versions.documentId, documents.id),
            eq(versions.number, number ?? documents.currentVersion)
          )
        )
        .leftJoin(brainPayloads, eq(brainPayloads.key, versions.payloadKey))
        .where(
          and(
            eq(documents.id, id.data),
            allowed.documents(),
            // The version read too, an older one included (GRA-1093).
            allowed.version(
              documents.id,
              number === undefined ? documents.currentVersion : sql`${number}`
            )
          )
        )
        .get()
    : undefined;
  if (!found) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const { document, collection, version: row, payload } = found;
  // Recorded before a missing version is refused: that a version isn't
  // there says something of the document too, so a sensitive one
  // restricts the reader either way.
  const provenance = await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      target: { type: "document", id: document.id },
      detail: { read: "document", version: number ?? document.currentVersion },
    },
    collection
  );
  if (row === null || payload === null) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const text = await readPayload(brain, payload);
  const read: Version = {
    ...toVersionSummary({ ...row, sha256: payload.sha256 }),
    text,
  };
  return { ...toSummary(document), version: read, provenance };
};

/** A page of a collection's documents, in path order. */
export const listDocuments = async <C>(
  brain: Brain<C>,
  reader: C,
  collectionId: unknown,
  options?: unknown
): Promise<DocumentPage> => {
  const { after, limit } = knowledgeErrors.parse(
    "knowledge.invalid",
    listDocumentsOptionsSchema,
    options
  );
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  const collection = await readableCollection(
    db,
    allowed.collections,
    collectionId
  );
  const rows = await db
    .select({ document: documents })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        eq(documents.collectionId, collection.id),
        allowed.documents(),
        after === undefined ? undefined : gt(documents.path, after)
      )
    )
    .orderBy(asc(documents.path))
    .limit(limit);
  const provenance = await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      target: { type: "collection", id: collection.id },
      detail: { read: "documents", count: rows.length },
    },
    collection
  );
  return {
    documents: rows.map(({ document }) => toSummary(document)),
    provenance,
  };
};

/** A page of a document's versions, newest first, without their text. */
export const history = async <C>(
  brain: Brain<C>,
  reader: C,
  documentId: unknown,
  options?: unknown
): Promise<HistoryPage> => {
  const { before, limit } = knowledgeErrors.parse(
    "knowledge.invalid",
    historyOptionsSchema,
    options
  );
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  const { document, collection } = await readableDocument(
    db,
    allowed,
    documentId
  );
  const rows = await db
    .select(versionSummaryColumns)
    .from(versions)
    .innerJoin(brainPayloads, eq(brainPayloads.key, versions.payloadKey))
    .innerJoin(documents, eq(documents.id, versions.documentId))
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        eq(versions.documentId, document.id),
        allowed.documents(),
        // Each version listed rests on nothing the reader may not read.
        allowed.version(versions.documentId, versions.number),
        before === undefined ? undefined : lt(versions.number, before)
      )
    )
    .orderBy(desc(versions.number))
    .limit(limit);
  const provenance = await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      target: { type: "document", id: document.id },
      detail: { read: "history", count: rows.length },
    },
    collection
  );
  return { versions: rows.map(toVersionSummary), provenance };
};

const linking = alias(documents, "linking");

/**
 * The documents that link to `document`, in path order after `after`: only
 * those that are `allowed`. Links name paths in their own
 * collection, so a path is enough to page by, and every backlink is in the
 * document's own collection: the read's provenance.
 */
export const backlinkRows = async (
  db: DrizzleD1Database,
  allowed: Allowed,
  document: DocumentRow,
  { after, limit }: { after?: string; limit: number }
): Promise<Backlink[]> => {
  const rows = await db
    .select({
      documentId: linking.id,
      collectionId: linking.collectionId,
      path: linking.path,
      title: linking.title,
      label: links.label,
    })
    .from(links)
    .innerJoin(linking, eq(linking.id, links.fromDocumentId))
    .innerJoin(collections, eq(collections.id, linking.collectionId))
    .where(
      and(
        eq(links.toCollectionId, document.collectionId),
        eq(links.toPath, document.path),
        ne(linking.id, document.id),
        // What links are made of already keeps them in one collection; this
        // keeps the provenance true however links come to be written.
        eq(linking.collectionId, document.collectionId),
        allowed.documents(linking),
        after === undefined ? undefined : gt(linking.path, after)
      )
    )
    .orderBy(asc(linking.path))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    documentId: documentIdSchema.parse(row.documentId),
    collectionId: collectionIdSchema.parse(row.collectionId),
  }));
};

/** A page of the documents that link to this one (`backlinkRows`). */
export const backlinks = async <C>(
  brain: Brain<C>,
  reader: C,
  documentId: unknown,
  options?: unknown
): Promise<BacklinkPage> => {
  const page = knowledgeErrors.parse(
    "knowledge.invalid",
    listDocumentsOptionsSchema,
    options
  );
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  const { document, collection } = await readableDocument(
    db,
    allowed,
    documentId
  );
  const found = await backlinkRows(db, allowed, document, page);
  const provenance = await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      target: { type: "document", id: document.id },
      detail: { read: "backlinks", count: found.length },
    },
    collection
  );
  return { backlinks: found, provenance };
};
