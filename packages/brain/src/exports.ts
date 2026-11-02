import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import {
  auditedBatch,
  outboxed,
  outboxedIfChanged,
  outboxedWhere,
} from "./audit.ts";
import type { Brain } from "./brain.ts";
import { inList, notInList } from "./db/d1.ts";
import {
  auditOutbox,
  brainErasedEvidence,
  brainExportFiles,
  brainExports,
  brainForgottenPeople,
  brainMemories,
  brainPurges,
  collections,
  documents,
  transcripts,
  versions,
} from "./db/schema.ts";
import type { Writer } from "./documents.ts";
import { versionText } from "./documents.ts";
import { fromBase64Url, sha256Hex, toBase64Url } from "./encoding.ts";
import { canonicalJson } from "./json.ts";
import type { Json } from "./json.ts";
import { knowledgeErrors } from "./knowledge.ts";
import type { ExportStatus } from "./knowledge.ts";
import { recordOf } from "./memories.ts";
import { citesReadable } from "./memory-cites.ts";

// The company's Brain as one portable export (GRA-335's E1, GRA-1192; the
// threat model is on GRA-335): a departing company takes what it admitted
// with it. An export is a set of JSON Lines files written to the Brain's
// bucket under its own prefix, one after another, each recorded with its
// SHA-256 as it is written (`brain_export_files`), so a run cut short goes
// on from the next; the manifest, which names every file and its checksum,
// is written last, so an export without one is incomplete however far it
// got. What it holds is the company's, never one person's:
//
// - the collections everyone, teams or admins read, with every version of
//   every document in them and their transcripts: never a Personal
//   collection (`me`), nor Grasp's own skills (the release's text);
// - the accepted team and company memory records, with what they cite,
//   that rest on nothing outside those collections: never a person's own
//   or a chat's;
// - the erasure records (which purges ran, who was forgotten, which
//   evidence was erased), so a restore replays them before anything is
//   read again: IDs and times alone, never what was erased;
// - what the host adds of its own (`OnExport`: core's grants and who
//   reads which collection).
//
// Each part is written in files of its own, in this order, a page of rows
// at a time: `collections-0001.jsonl` and on, `documents-…`,
// `memories-…`, `erasures-…`, then each of the host's, `host-<name>-…`. A
// file closes once the next row would take it past `exportFileBytes`,
// recording where the next goes on (`brain_export_files.cursor`): no step
// holds more than one file, however much the company holds, and a run cut
// short goes on from the next file. A restore reads each part's files in
// name order.
//
// A purge that runs while it is written, or before its files are
// downloaded, fails it (`knowledge.export_purged`): it may hold what the
// purge erased, so its files are deleted, to be asked for again. One
// still unfinished as it would begin refuses it
// (`knowledge.export_purge_open`). What it holds is decided once, as it
// begins: its collections, frozen with it, so every file reads the same.
//
// One run writes at a time, under a claim with a lease; every write a run
// makes is fenced on its claim, so a run that lost it (past its lease)
// changes nothing of what the run that took over writes. Each file's
// object is a key of its own, recorded before it is uploaded and marked
// stored after: an upload cut short is written again, and whatever a lost
// run uploaded anyway is swept with the rest of the export's prefix. Its files
// are downloaded by the admin who asked for it, for a day
// (`exportLifetimeMs`), and then deleted. It holds the company's sensitive
// collections too: the admin who exports takes the company's data whole.
// The host names collections that are no company content of its own
// (`OnExport.excluded`: core's onboarding documents, an interview's).

/** How long a complete export's files may be downloaded. */
export const exportLifetimeMs = 24 * 60 * 60 * 1000;

/** How long a run holds an export before another may take it over. */
export const exportLeaseMs = 10 * 60 * 1000;

/** Documents begun in one file of the export, at most. */
export const documentsPerFile = 25;

/**
 * What one file of the export holds before it is closed, of any part:
 * a run past it goes on in the next file, so no file, and no step that
 * writes one, holds more than this and one row (a document's version
 * holds 1 MiB at most). Every file is paged so (`pagedFile`,
 * `documentsFile`); only the manifest isn't, one short line per file.
 */
export const exportFileBytes = 8 * 1024 * 1024;

/** Rows one page of a part reads at a time. */
const pageRows = 100;

/** The export's format, as its manifest names it. */
export const exportFormat = "grasp-brain-export";

/** The version of the format this writes. */
export const exportFormatVersion = 1;

/** The manifest's name: written last. */
export const manifestName = "manifest.json";

/**
 * A row of a part, with the key the next page goes on after: the rows
 * come in the order of their keys.
 */
export interface KeyedRow {
  row: Json;
  key: string;
}

/**
 * A page of a part's rows after `after` (null: from the first), a
 * hundred or so at most: none once all are read.
 */
export type ExportPage = (after: string | null) => Promise<KeyedRow[]>;

/** One part the host adds, read a page at a time (`ExportPage`). */
export interface HostExportFile {
  /**
   * Lower-case letters, digits and dashes: its files are
   * `host-<name>-0001.jsonl` and on.
   */
  name: string;
  page: (
    collectionIds: readonly string[],
    after: string | null
  ) => Promise<KeyedRow[]>;
}

/** What the host adds to an export of its own (core: grants, teams). */
export interface OnExport {
  /** Collections never exported: no company content (core: interviews'). */
  excluded: readonly string[];
  /** Its parts, each in files of its own, in this order. */
  files: readonly HostExportFile[];
}

const hostNamePattern = /^[a-z][a-z0-9-]{0,40}$/u;

/**
 * The key a manifest is signed with: derived by the host from a secret it
 * already holds (core: HKDF from its auth secret), under a purpose of its
 * own and a version, so a bundle edited after it was written is refused
 * on restore. Only a Brain holding the same secret verifies it.
 */
const manifestKey = async <C>(
  brain: Brain<C>,
  usages: ("sign" | "verify")[]
): Promise<CryptoKey> =>
  await brain.ports.keys.hmac("grasp-os brain export manifest v1", usages);

/** What a manifest's signature signs: everything in it but the signature. */
const manifestData = (body: Json): Uint8Array =>
  new TextEncoder().encode(canonicalJson(body));

/** The signature of manifest `body`, base64url. */
const manifestSignature = async <C>(
  brain: Brain<C>,
  body: Json
): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await manifestKey(brain, ["sign"]),
        manifestData(body)
      )
    )
  );

/** Whether `signature` is this Brain's signature of manifest `body`. */
export const manifestSigned = async <C>(
  brain: Brain<C>,
  body: Json,
  signature: string
): Promise<boolean> => {
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await manifestKey(brain, ["verify"]),
      fromBase64Url(signature),
      manifestData(body)
    );
  } catch {
    return false;
  }
};

/** Everything export `exportId` keeps in the bucket is under this. */
const prefixOf = (exportId: string): string => `exports/${exportId}/`;

/** A new object for file `name` of export `exportId`: never reused. */
const objectFor = (exportId: string, name: string): string =>
  `${prefixOf(exportId)}${crypto.randomUUID()}-${name}`;

/** File `index` (from 1) of the part named `prefix`. */
const partName = (prefix: string, index: number): string =>
  `${prefix}-${String(index).padStart(4, "0")}.jsonl`;

/** Whether `name` is a file of the part named `prefix`. */
const isPartOf = (prefix: string, name: string): boolean =>
  name.startsWith(`${prefix}-`) &&
  /^\d{4,}\.jsonl$/u.test(name.slice(prefix.length + 1));

/** Rows as JSON Lines. */
const linesOf = (rows: readonly unknown[]): string =>
  rows.map((row) => `${JSON.stringify(row)}\n`).join("");

/**
 * The collections an export holds: the company's, never a person's own,
 * Grasp's skills or one the host excludes.
 */
const exportedCollections = async <C>(
  brain: Brain<C>,
  excluded: readonly string[]
) =>
  await brain.db
    .select()
    .from(collections)
    .where(
      and(
        ne(collections.access, "me"),
        ne(collections.source, "grasp"),
        excluded.length === 0 ? undefined : notInList(collections.id, excluded)
      )
    )
    .orderBy(asc(collections.id));

/**
 * How many purge records there are now: what `purgedSince` is asked
 * from. Purge records are never deleted (purge-ledger.ts: a finished one
 * run again records a new one), so the count only grows, one for each
 * purge begun; a count, not a rowid, as VACUUM may renumber those.
 */
const purgeMarkOf = async <C>(brain: Brain<C>): Promise<number> => {
  const [row] = await brain.db.select({ n: count() }).from(brainPurges);
  return row?.n ?? 0;
};

/** A purge still unfinished: neither complete nor superseded. */
const purgeOpen = and(
  isNull(brainPurges.completedAt),
  isNull(brainPurges.supersededBy)
);

/**
 * That no purge may have erased what an export begun at `mark` holds, as
 * a condition (`purgedSince`): for a statement written only while so.
 */
const unpurgedSince = (mark: number): SQL =>
  sql`((SELECT count(*) FROM ${brainPurges}) <= ${mark} AND NOT EXISTS (SELECT 1 FROM ${brainPurges} WHERE ${purgeOpen}))`;

/**
 * Whether a purge may have erased what an export begun at `mark` holds:
 * one recorded since (begun, or a finished one run again, which records
 * a new one: purge-ledger.ts), or one still unfinished, whose steps may
 * run again at any time.
 */
const purgedSince = async <C>(
  brain: Brain<C>,
  mark: number
): Promise<boolean> => {
  const [row] = await brain.db
    .select({
      records: count(),
      open: sql<number>`coalesce(sum(CASE WHEN ${purgeOpen} THEN 1 ELSE 0 END), 0)`,
    })
    .from(brainPurges);
  return (row?.records ?? 0) > mark || (row?.open ?? 0) > 0;
};

/** How long a prepared export's confirmation holds. */
export const exportTokenLifetimeMs = 10 * 60 * 1000;

const exportTokenKey = async <C>(brain: Brain<C>): Promise<CryptoKey> =>
  await brain.ports.keys.hmac("grasp-os knowledge export token", [
    "sign",
    "verify",
  ]);

const exportTokenData = (by: Writer, expiresAt: number) =>
  new TextEncoder().encode(JSON.stringify([by.userId, "export", expiresAt]));

const exportTokenPattern = /^(?<expiresAt>\d{1,15})\.(?<mac>[\w-]{1,128})$/u;

/**
 * What an export would hold, for `by`, an admin the host checked, to
 * confirm with the token returned: the explicit step a departing company
 * takes before the whole of it is copied. Audited.
 */
export const prepareExport = async <C>(
  brain: Brain<C>,
  by: Writer,
  onExport: Pick<OnExport, "excluded">
): Promise<{
  collections: number;
  documents: number;
  token: string;
  expiresAt: string;
}> => {
  const company = await exportedCollections(brain, onExport.excluded);
  const ids = company.map(({ id }) => id);
  const [counted] =
    ids.length === 0
      ? [{ documents: 0 }]
      : await brain.db
          .select({ documents: count() })
          .from(documents)
          .where(inList(documents.collectionId, ids));
  const expiresAt = brain.ports.clock().getTime() + exportTokenLifetimeMs;
  const mac = await crypto.subtle.sign(
    "HMAC",
    await exportTokenKey(brain),
    exportTokenData(by, expiresAt)
  );
  await auditedBatch(brain.ports, brain.db, [
    outboxed(brain, {
      actor: by.actor,
      action: "knowledge.export.prepared",
      detail: { collections: ids.length, documents: counted?.documents ?? 0 },
    }),
  ]);
  return {
    collections: ids.length,
    documents: counted?.documents ?? 0,
    token: `${expiresAt}.${toBase64Url(new Uint8Array(mac))}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
};

/** Refuses with `knowledge.purge_expired` unless `token` is `by`'s, unexpired. */
const requireExportToken = async <C>(
  brain: Brain<C>,
  by: Writer,
  token: unknown
): Promise<void> => {
  const groups =
    typeof token === "string"
      ? exportTokenPattern.exec(token)?.groups
      : undefined;
  const expiresAt = Number(groups?.expiresAt);
  let valid = false;
  if (groups?.mac !== undefined && expiresAt > brain.ports.clock().getTime()) {
    try {
      valid = await crypto.subtle.verify(
        "HMAC",
        await exportTokenKey(brain),
        fromBase64Url(groups.mac),
        exportTokenData(by, expiresAt)
      );
    } catch {
      // Not base64url: not a token.
    }
  }
  if (!valid) {
    throw knowledgeErrors.create("knowledge.purge_expired");
  }
};

/**
 * Begins an export of the company's Brain for `by`, an admin the host
 * checked, with the token `prepareExport` gave them: recorded and audited
 * before anything is written. Runs as `advanceExport` goes on with it.
 */
export const startExport = async <C>(
  brain: Brain<C>,
  by: Writer,
  token: unknown,
  onExport: Pick<OnExport, "excluded">
): Promise<{ exportId: string }> => {
  await requireExportToken(brain, by, token);
  const exportId = crypto.randomUUID();
  const now = brain.ports.clock();
  // The mark first: a purge recorded after it is one `purgedSince` sees.
  const purgeMark = await purgeMarkOf(brain);
  const [open] = await brain.db
    .select({ id: brainPurges.id })
    .from(brainPurges)
    .where(purgeOpen)
    .limit(1);
  if (open !== undefined) {
    throw knowledgeErrors.create("knowledge.export_purge_open");
  }
  // What it holds, frozen now (`OnExport.excluded`, the host's as it is):
  // what the admin confirmed, as company content then. A collection's
  // access, or the host's exclusions, changing while it runs don't change
  // it, so its files never disagree; one made personal meanwhile is in it
  // as it was confirmed.
  const company = await exportedCollections(brain, onExport.excluded);
  // One being written at a time (`brain_exports_running_idx`).
  const [running] = await brain.db
    .select({ id: brainExports.id })
    .from(brainExports)
    .where(eq(brainExports.state, "running"))
    .limit(1);
  if (running !== undefined) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  try {
    await auditedBatch(brain.ports, brain.db, [
      brain.db.insert(brainExports).values({
        id: exportId,
        by: by.userId,
        collectionIds: JSON.stringify(company.map(({ id }) => id)),
        purgeMark,
        createdAt: now,
        updatedAt: now,
      }),
      outboxed(brain, {
        actor: by.actor,
        action: "knowledge.export.started",
        target: { type: "export", id: exportId },
      }),
    ]);
  } catch (error) {
    // Another begun at the same time: one at a time.
    if (String(error).includes("UNIQUE")) {
      throw knowledgeErrors.create("knowledge.conflict");
    }
    throw error;
  }
  return { exportId };
};

/** The files export `exportId` recorded so far, in order. */
const filesOf = async <C>(brain: Brain<C>, exportId: string) =>
  await brain.db
    .select()
    .from(brainExportFiles)
    .where(eq(brainExportFiles.exportId, exportId))
    .orderBy(asc(brainExportFiles.position));

/** The files export `exportId` stored, in order: what its manifest names. */
const storedOf = async <C>(brain: Brain<C>, exportId: string) => {
  const files = await filesOf(brain, exportId);
  return files.filter(({ stored }) => stored);
};

/** A run writing an export, as it holds it. */
interface ExportRun {
  exportId: string;
  /** Its claim on the export: every write it makes is fenced on it. */
  claim: string;
  createdAt: Date;
  /** The collections it holds, frozen as it began. */
  collectionIds: readonly string[];
  /** The newest purge record as it began. */
  purgeMark: number;
}

/** An export's frozen collections, as its row keeps them. */
const collectionIdsOf = (text: string): string[] => {
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed)
    ? parsed.filter((id): id is string => typeof id === "string")
    : [];
};

/** A run that lost its claim: it stops, writing nothing more. */
class ClaimLostError extends Error {
  override name = "ClaimLostError";
}

/** That `run` still holds its export's claim, as a condition of a write. */
const holding = (run: ExportRun) =>
  sql`EXISTS (SELECT 1 FROM ${brainExports} WHERE ${brainExports.id} = ${run.exportId} AND ${brainExports.claim} = ${run.claim} AND ${brainExports.state} = 'running')`;

/** Deletes `objects` from the bucket, a thousand at a time. */
const deleteObjects = async <C>(
  brain: Brain<C>,
  objects: readonly string[]
): Promise<void> => {
  for (let at = 0; at < objects.length; at += 1000) {
    // oxlint-disable-next-line no-await-in-loop -- one batch after another
    await brain.ports.blobs.delete(objects.slice(at, at + 1000));
  }
};

/**
 * Removes `files` of `run`'s export, records and objects: an upload cut
 * short, or the host's files of a run that stopped among them.
 */
const removeFiles = async <C>(
  brain: Brain<C>,
  run: ExportRun,
  files: readonly { name: string; object: string }[]
): Promise<void> => {
  if (files.length === 0) {
    return;
  }
  const removed = await brain.db
    .delete(brainExportFiles)
    .where(
      and(
        eq(brainExportFiles.exportId, run.exportId),
        inList(
          brainExportFiles.name,
          files.map(({ name }) => name)
        ),
        holding(run)
      )
    )
    .returning({ object: brainExportFiles.object });
  if (removed.length === 0) {
    throw new ClaimLostError();
  }
  await deleteObjects(
    brain,
    removed.map(({ object }) => object)
  );
};

/**
 * Writes file `name` of `run`'s export: recorded first, with its checksum
 * and an object of its own, then uploaded, then marked stored, each step
 * only while the run holds its claim.
 */
const writeFile = async <C>(
  brain: Brain<C>,
  run: ExportRun,
  position: number,
  name: string,
  body: string,
  rows: number,
  cursor: string | null = null
): Promise<void> => {
  const object = objectFor(run.exportId, name);
  const sha256 = await sha256Hex(body);
  const bytes = new TextEncoder().encode(body).byteLength;
  const recorded = await brain.db
    .insert(brainExportFiles)
    .select(
      sql`SELECT ${run.exportId}, ${name}, ${position}, ${sha256}, ${bytes}, ${rows}, ${cursor}, ${object}, 0 WHERE ${holding(run)}`
    )
    // No conflict handling: a file recorded twice is a fault that fails
    // the export, never mistaken for a lost claim.
    .returning({ name: brainExportFiles.name });
  if (recorded.length === 0) {
    throw new ClaimLostError();
  }
  await brain.ports.blobs.put(object, body);
  const stored = await brain.db
    .update(brainExportFiles)
    .set({ stored: true })
    .where(
      and(
        eq(brainExportFiles.exportId, run.exportId),
        eq(brainExportFiles.name, name),
        eq(brainExportFiles.object, object),
        holding(run)
      )
    )
    .returning({ name: brainExportFiles.name });
  if (stored.length === 0) {
    throw new ClaimLostError();
  }
};

// A documents file is JSON Lines, a document at a time in ID order. A
// document's first line holds the document, its transcript and its first
// versions, in order:
//
//   {"id", "collectionId", "path", …, "currentVersion", "versions": [...],
//    "transcript"}
//
// A document whose versions don't fit in what is left of the file
// (`exportFileBytes`) goes on in lines of their own, in this file or
// the next, each with the versions that follow, in order:
//
//   {"continues": "<document ID>", "versions": [...]}
//
// A restore appends each line's versions to the document it continues.
// Where a file stops is its cursor (`brain_export_files.cursor`): after a
// document, or within one, after a version.

/** Where the next file of documents goes on from. */
type DocumentsCursor =
  | { after: string }
  | {
      /** Within this document, after version `afterVersion`. */
      document: string;
      afterVersion: number;
      /** Its current version as its first line was read: the last one. */
      upTo: number;
    };

const documentsCursorSchema = z.union([
  z.object({ after: z.string() }),
  z.object({
    document: z.string(),
    afterVersion: z.int(),
    upTo: z.int(),
  }),
]);

/** A version as a documents file holds it, with its text. */
const versionEntry = async <C>(
  brain: Brain<C>,
  version: typeof versions.$inferSelect
): Promise<Json> => {
  const text = await versionText(
    brain,
    brain.db,
    version.documentId,
    version.number
  );
  return {
    number: version.number,
    author: version.author,
    message: version.message,
    restoredFrom: version.restoredFrom,
    createdAt: version.createdAt.toISOString(),
    text: text ?? null,
  };
};

/** The bytes `value` takes as JSON. */
const jsonBytes = (value: Json): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * Versions of `kept`, in order, while they fit in `room` bytes (one at
 * least when `atLeastOne`): with the bytes they take.
 */
const versionsFitting = async <C>(
  brain: Brain<C>,
  kept: readonly (typeof versions.$inferSelect)[],
  room: number,
  atLeastOne: boolean
): Promise<{ entries: Json[]; bytes: number; last: number | null }> => {
  const entries: Json[] = [];
  let bytes = 0;
  let last: number | null = null;
  for (const version of kept) {
    // oxlint-disable-next-line no-await-in-loop -- one version's text at a time, to bound memory
    const entry = await versionEntry(brain, version);
    const size = jsonBytes(entry);
    const first = entries.length === 0 && atLeastOne;
    if (!first && bytes + size > room) {
      break;
    }
    entries.push(entry);
    bytes += size;
    last = version.number;
  }
  return { entries, bytes, last };
};

/**
 * A piece of a document: its line, if any versions fit (or it is the
 * document's first line), the bytes it takes, and where the file goes on.
 * `full`: the file is closed after it.
 */
interface Piece {
  row: Json | null;
  bytes: number;
  next: DocumentsCursor;
  full: boolean;
}

/**
 * The next piece of a document a file stopped within (`cursor`): its
 * versions after the last one written, up to its current version as its
 * first line read it. Versions change only by a purge, which fails the
 * export.
 */
const continuedPiece = async <C>(
  brain: Brain<C>,
  cursor: Extract<DocumentsCursor, { document: string }>,
  room: number,
  atLeastOne: boolean
): Promise<Piece> => {
  const { document, afterVersion, upTo } = cursor;
  const kept = await brain.db
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.documentId, document),
        gt(versions.number, afterVersion),
        lte(versions.number, upTo)
      )
    )
    .orderBy(asc(versions.number));
  const piece = await versionsFitting(brain, kept, room, atLeastOne);
  const full = piece.entries.length < kept.length;
  return {
    row:
      piece.entries.length === 0
        ? null
        : { continues: document, versions: piece.entries },
    bytes: piece.bytes,
    next: full
      ? { document, afterVersion: piece.last ?? afterVersion, upTo }
      : { after: document },
    full,
  };
};

/**
 * The first piece of document `id`: the document, its versions and its
 * transcript read in one batch, so as one (a save between the reads would
 * leave a transcript without the version it belongs to), with as many of
 * its versions as fit. Null when it was deleted since it was listed, or
 * when not even its first version fits in a file already begun.
 */
const firstPiece = async <C>(
  brain: Brain<C>,
  id: string,
  room: number,
  atLeastOne: boolean
): Promise<Piece | null> => {
  const { db } = brain;
  const [[document], kept, [transcript]] = await db.batch([
    db.select().from(documents).where(eq(documents.id, id)),
    db
      .select()
      .from(versions)
      .where(eq(versions.documentId, id))
      .orderBy(asc(versions.number)),
    db.select().from(transcripts).where(eq(transcripts.documentId, id)),
  ]);
  if (document === undefined) {
    return { row: null, bytes: 0, next: { after: id }, full: false };
  }
  const head = {
    id: document.id,
    collectionId: document.collectionId,
    path: document.path,
    title: document.title,
    type: document.type,
    description: document.description,
    owner: document.owner,
    tags: document.tags,
    reviewDate: document.reviewDate,
    currentVersion: document.currentVersion,
    createdAt: document.createdAt.toISOString(),
    transcript:
      transcript === undefined
        ? null
        : {
            version: transcript.version,
            turns: transcript.turns,
            chapters: transcript.chapters,
          },
  };
  const headBytes = jsonBytes(head);
  const piece = await versionsFitting(
    brain,
    kept,
    room - headBytes,
    atLeastOne
  );
  if (piece.entries.length === 0 && kept.length > 0) {
    return null;
  }
  const full = piece.entries.length < kept.length;
  return {
    row: { ...head, versions: piece.entries },
    bytes: headBytes + piece.bytes,
    next: full
      ? {
          document: document.id,
          afterVersion: piece.last ?? 0,
          upTo: kept.at(-1)?.number ?? 0,
        }
      : { after: document.id },
    full,
  };
};

/** The ID of the first exported document after `after` (null: the first). */
const nextDocument = async <C>(
  brain: Brain<C>,
  collectionIds: readonly string[],
  after: string | null
): Promise<string | undefined> => {
  const [next] = await brain.db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        inList(documents.collectionId, collectionIds),
        after === null ? undefined : gt(documents.id, after)
      )
    )
    .orderBy(asc(documents.id))
    .limit(1);
  return next?.id;
};

/**
 * The next file of documents from `from` (null: the first), each version
 * with its text, closed at `exportFileBytes` or `documentsPerFile`
 * documents begun: its lines, and where the next goes on (null: none).
 */
const documentsFile = async <C>(
  brain: Brain<C>,
  collectionIds: readonly string[],
  from: string | null
): Promise<{ rows: Json[]; last: string | null }> => {
  const rows: Json[] = [];
  let bytes = 0;
  let begun = 0;
  let cursor: DocumentsCursor | null =
    from === null ? null : documentsCursorSchema.parse(JSON.parse(from));
  for (;;) {
    const within = cursor !== null && "document" in cursor;
    if (!within && (begun >= documentsPerFile || bytes >= exportFileBytes)) {
      return { rows, last: JSON.stringify(cursor) };
    }
    const id =
      cursor !== null && "document" in cursor
        ? undefined
        : // oxlint-disable-next-line no-await-in-loop -- one document at a time
          await nextDocument(brain, collectionIds, cursor?.after ?? null);
    if (!within && id === undefined) {
      return { rows, last: null };
    }
    const piece =
      cursor !== null && "document" in cursor
        ? // oxlint-disable-next-line no-await-in-loop -- one piece at a time, to bound memory
          await continuedPiece(
            brain,
            cursor,
            exportFileBytes - bytes,
            rows.length === 0
          )
        : // oxlint-disable-next-line no-await-in-loop -- one piece at a time, to bound memory
          await firstPiece(
            brain,
            id ?? "",
            exportFileBytes - bytes,
            rows.length === 0
          );
    // Not even its first version fits: it begins the next file.
    if (piece === null) {
      return { rows, last: JSON.stringify(cursor) };
    }
    if (piece.row !== null) {
      rows.push(piece.row);
      bytes += piece.bytes;
      begun += within ? 0 : 1;
    }
    cursor = piece.next;
    if (piece.full) {
      return { rows, last: JSON.stringify(cursor) };
    }
  }
};

/**
 * The rows `page` reads from `from` (null: the first), as one file of a
 * part: closed once the next row would take it past `exportFileBytes`,
 * with the key it goes on after (null: none left).
 */
const pagedFile = async (
  page: ExportPage,
  from: string | null
): Promise<{ rows: Json[]; last: string | null }> => {
  const rows: Json[] = [];
  let bytes = 0;
  let after = from;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time, to bound memory
    const keyed = await page(after);
    if (keyed.length === 0) {
      return { rows, last: null };
    }
    for (const { row, key } of keyed) {
      const size = jsonBytes(row) + 1;
      if (rows.length > 0 && bytes + size > exportFileBytes) {
        return { rows, last: after };
      }
      rows.push(row);
      bytes += size;
      after = key;
    }
  }
};

/** The collections an export holds, a page at a time, by ID. */
const collectionsPage =
  <C>(brain: Brain<C>, collectionIds: readonly string[]): ExportPage =>
  async (after) => {
    if (collectionIds.length === 0) {
      return [];
    }
    const page = await brain.db
      .select()
      .from(collections)
      .where(
        and(
          inList(collections.id, collectionIds),
          after === null ? undefined : gt(collections.id, after)
        )
      )
      .orderBy(asc(collections.id))
      .limit(pageRows);
    return page.map((collection) => ({
      key: collection.id,
      row: {
        id: collection.id,
        name: collection.name,
        description: collection.description,
        owner: collection.owner,
        access: collection.access,
        sensitive: collection.sensitive,
        source: collection.source,
        createdAt: collection.createdAt.toISOString(),
      },
    }));
  };

/**
 * The accepted team and company memory records resting on nothing
 * outside the export's collections, a page at a time, by ID.
 */
const memoriesPage =
  <C>(brain: Brain<C>, collectionIds: readonly string[]): ExportPage =>
  async (after) => {
    const page = await brain.db
      .select()
      .from(brainMemories)
      .where(
        and(
          inArray(brainMemories.scope, ["team", "company"]),
          eq(brainMemories.state, "accepted"),
          citesReadable(collectionIds),
          after === null ? undefined : gt(brainMemories.id, after)
        )
      )
      .orderBy(asc(brainMemories.id))
      .limit(pageRows);
    return page.map((row) => ({
      key: row.id,
      row: { ...recordOf(row), scopeId: row.scopeId, ownerId: row.ownerId },
    }));
  };

/** The erasure records, by kind and, within one, by ID. */
const erasureKinds = ["purge", "forgotten_person", "erased_evidence"] as const;
type ErasureKind = (typeof erasureKinds)[number];

const erasureKeySchema = z.object({
  type: z.enum(erasureKinds),
  after: z.string(),
});

/** A page of erasure records of `type` after `after`. */
const erasuresOf = async <C>(
  brain: Brain<C>,
  type: ErasureKind,
  after: string | null
): Promise<KeyedRow[]> => {
  const { db } = brain;
  const keyed = (id: string, row: Json): KeyedRow => ({
    key: JSON.stringify({ type, after: id }),
    row,
  });
  if (type === "purge") {
    const page = await db
      .select()
      .from(brainPurges)
      .where(after === null ? undefined : gt(brainPurges.id, after))
      .orderBy(asc(brainPurges.id))
      .limit(pageRows);
    return page.map((purge) =>
      keyed(purge.id, {
        type,
        id: purge.id,
        kind: purge.kind,
        createdAt: purge.createdAt.toISOString(),
        completedAt: purge.completedAt?.toISOString() ?? null,
        supersededBy: purge.supersededBy,
      })
    );
  }
  if (type === "forgotten_person") {
    const page = await db
      .select()
      .from(brainForgottenPeople)
      .where(
        after === null ? undefined : gt(brainForgottenPeople.userId, after)
      )
      .orderBy(asc(brainForgottenPeople.userId))
      .limit(pageRows);
    return page.map((person) =>
      keyed(person.userId, {
        type,
        userId: person.userId,
        at: person.forgottenAt.toISOString(),
      })
    );
  }
  const page = await db
    .select()
    .from(brainErasedEvidence)
    .where(
      after === null ? undefined : gt(brainErasedEvidence.evidenceId, after)
    )
    .orderBy(asc(brainErasedEvidence.evidenceId))
    .limit(pageRows);
  return page.map((each) =>
    keyed(each.evidenceId, {
      type,
      evidenceId: each.evidenceId,
      at: each.erasedAt.toISOString(),
    })
  );
};

/**
 * The erasure records (which purges ran, who was forgotten, which
 * evidence was erased), a page at a time: IDs and times alone.
 */
const erasuresPage =
  <C>(brain: Brain<C>): ExportPage =>
  async (after) => {
    const at =
      after === null ? null : erasureKeySchema.parse(JSON.parse(after));
    const first = at === null ? 0 : erasureKinds.indexOf(at.type);
    for (const type of erasureKinds.slice(first)) {
      // oxlint-disable-next-line no-await-in-loop -- one kind after another
      const page = await erasuresOf(
        brain,
        type,
        type === at?.type ? at.after : null
      );
      if (page.length > 0) {
        return page;
      }
    }
    return [];
  };

/** A part of the export: its files are `<prefix>-0001.jsonl` and on. */
interface ExportPart {
  prefix: string;
  /** Its next file from `from` (null: its first), and where it goes on. */
  file: (from: string | null) => Promise<{ rows: Json[]; last: string | null }>;
}

/** The export's parts, in the order they are written. */
const exportParts = <C>(
  brain: Brain<C>,
  collectionIds: readonly string[],
  onExport: OnExport
): ExportPart[] => [
  {
    prefix: "collections",
    file: async (from) =>
      await pagedFile(collectionsPage(brain, collectionIds), from),
  },
  {
    prefix: "documents",
    file: async (from) => await documentsFile(brain, collectionIds, from),
  },
  {
    prefix: "memories",
    file: async (from) =>
      await pagedFile(memoriesPage(brain, collectionIds), from),
  },
  {
    prefix: "erasures",
    file: async (from) => await pagedFile(erasuresPage(brain), from),
  },
  ...onExport.files.map((host): ExportPart => ({
    prefix: `host-${host.name}`,
    file: async (from) =>
      await pagedFile(
        async (after) => await host.page(collectionIds, after),
        from
      ),
  })),
];

/**
 * Writes the next file `run`'s export owes, or its manifest when none is
 * left. Whether more is left to write.
 */
const writeNext = async <C>(
  brain: Brain<C>,
  run: ExportRun,
  onExport: OnExport
): Promise<boolean> => {
  const { exportId, collectionIds } = run;
  const hostNames = onExport.files.map(({ name }) => name);
  if (
    hostNames.some((name) => !hostNamePattern.test(name)) ||
    new Set(hostNames).size !== hostNames.length
  ) {
    throw knowledgeErrors.create("knowledge.invalid");
  }
  // A purge since it began may have erased what it holds: it goes.
  if (await purgedSince(brain, run.purgeMark)) {
    throw knowledgeErrors.create("knowledge.export_purged");
  }
  // An upload cut short: written again.
  const recorded = await filesOf(brain, exportId);
  await removeFiles(
    brain,
    run,
    recorded.filter(({ stored }) => !stored)
  );
  const written = recorded.filter(({ stored }) => stored);
  const position = written.length;
  // Each part in files of its own, in order: the next file owed is that
  // of the first part whose last file says where it goes on (or that has
  // none yet).
  for (const part of exportParts(brain, collectionIds, onExport)) {
    const files = written.filter(({ name }) => isPartOf(part.prefix, name));
    const last = files.at(-1);
    if (last === undefined || last.cursor !== null) {
      // oxlint-disable-next-line no-await-in-loop -- one file per step
      const { rows, last: next } = await part.file(last?.cursor ?? null);
      // oxlint-disable-next-line no-await-in-loop -- one file per step
      await writeFile(
        brain,
        run,
        position,
        partName(part.prefix, files.length + 1),
        linesOf(rows),
        rows.length,
        next
      );
      return true;
    }
  }
  const body = {
    format: exportFormat,
    version: exportFormatVersion,
    exportId,
    createdAt: run.createdAt.toISOString(),
    files: written.map(({ name, sha256, bytes, rows }) => ({
      name,
      sha256,
      bytes,
      rows,
    })),
  };
  const manifest = JSON.stringify({
    ...body,
    signature: await manifestSignature(brain, body),
  });
  const manifestObject = objectFor(exportId, manifestName);
  await brain.ports.blobs.put(manifestObject, manifest);
  const now = brain.ports.clock();
  const [exported] = await brain.db
    .select({ by: brainExports.by })
    .from(brainExports)
    .where(eq(brainExports.id, exportId));
  const [completed] = await auditedBatch(brain.ports, brain.db, [
    brain.db
      .update(brainExports)
      .set({
        state: "complete",
        completedAt: now,
        expiresAt: new Date(now.getTime() + exportLifetimeMs),
        manifestSha256: await sha256Hex(manifest),
        manifestObject,
        claim: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(brainExports.id, exportId),
          eq(brainExports.claim, run.claim),
          eq(brainExports.state, "running")
        )
      )
      .returning({ id: brainExports.id }),
    outboxedIfChanged(brain, {
      actor: { type: "system" },
      action: "knowledge.export.completed",
      target: { type: "export", id: exportId },
      detail: {
        by: exported?.by ?? "",
        files: written.length,
        rows: written.reduce((sum, { rows }) => sum + rows, 0),
      },
    }),
  ]);
  if (completed === undefined || completed.length === 0) {
    throw new ClaimLostError();
  }
  return false;
};

/**
 * Deletes everything export `exportId` keeps in the bucket: every object
 * under its prefix, what a run that lost its claim uploaded too.
 */
const deleteFiles = async <C>(
  brain: Brain<C>,
  exportId: string
): Promise<void> => {
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const listed = await brain.ports.blobs.list({
      prefix: prefixOf(exportId),
      ...(cursor === undefined ? {} : { cursor }),
    });
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    await deleteObjects(
      brain,
      listed.objects.map(({ key }) => key)
    );
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
};

/**
 * Goes on with the running export `exportId` until it is complete or
 * `until` passes: one run at a time, under a claim with a lease. A
 * failure fails it with a stable code and deletes what it wrote.
 * Whether it is complete.
 */
export const advanceExport = async <C>(
  brain: Brain<C>,
  exportId: string,
  onExport: OnExport,
  until: Date
): Promise<boolean> => {
  const now = brain.ports.clock();
  const claim = crypto.randomUUID();
  const [held] = await brain.db
    .update(brainExports)
    .set({ claim, claimedAt: now, updatedAt: now })
    .where(
      and(
        eq(brainExports.id, exportId),
        eq(brainExports.state, "running"),
        or(
          isNull(brainExports.claim),
          lt(brainExports.claimedAt, new Date(now.getTime() - exportLeaseMs))
        )
      )
    )
    .returning({
      createdAt: brainExports.createdAt,
      collectionIds: brainExports.collectionIds,
      purgeMark: brainExports.purgeMark,
    });
  if (held === undefined) {
    return false;
  }
  const run: ExportRun = {
    exportId,
    claim,
    createdAt: held.createdAt,
    collectionIds: collectionIdsOf(held.collectionIds),
    purgeMark: held.purgeMark,
  };
  try {
    while (brain.ports.clock().getTime() < until.getTime()) {
      // oxlint-disable-next-line no-await-in-loop -- one file after another
      const more = await writeNext(brain, run, onExport);
      if (!more) {
        return true;
      }
    }
    await brain.db
      .update(brainExports)
      .set({ claim: null, claimedAt: null, updatedAt: brain.ports.clock() })
      .where(and(eq(brainExports.id, exportId), eq(brainExports.claim, claim)));
    return false;
  } catch (error) {
    // Taken over past its lease: the run that took it goes on.
    if (error instanceof ClaimLostError) {
      return false;
    }
    // Only while it is still this run's: one that took over past its
    // lease says how it ended.
    const failed = await brain.db
      .update(brainExports)
      .set({
        state: "failed",
        reason:
          knowledgeErrors.codeOf(error) ??
          (error instanceof Error ? error.name : "unknown"),
        claim: null,
        claimedAt: null,
        updatedAt: brain.ports.clock(),
      })
      .where(and(eq(brainExports.id, exportId), eq(brainExports.claim, claim)))
      .returning({ id: brainExports.id });
    if (failed.length > 0) {
      await deleteFiles(brain, exportId);
    }
    throw error;
  }
};

/** The running exports, oldest first: what the host's clock goes on with. */
export const runningExports = async <C>(brain: Brain<C>): Promise<string[]> => {
  const rows = await brain.db
    .select({ id: brainExports.id })
    .from(brainExports)
    .where(eq(brainExports.state, "running"))
    .orderBy(asc(brainExports.createdAt));
  return rows.map(({ id }) => id);
};

/** Fails export `exportId` as one a purge ran after, and deletes its files. */
const failPurged = async <C>(
  brain: Brain<C>,
  exportId: string
): Promise<void> => {
  await brain.db
    .update(brainExports)
    .set({
      state: "failed",
      reason: "knowledge.export_purged",
      updatedAt: brain.ports.clock(),
    })
    .where(eq(brainExports.id, exportId));
  await deleteFiles(brain, exportId);
};

/**
 * Deletes the files of every complete export past its download window,
 * and of every failed one, noting the complete ones expired.
 */
export const expireExports = async <C>(
  brain: Brain<C>,
  now: Date
): Promise<void> => {
  // A complete one a purge ran after: it may hold what was erased.
  const complete = await brain.db
    .select({ id: brainExports.id, purgeMark: brainExports.purgeMark })
    .from(brainExports)
    .where(eq(brainExports.state, "complete"));
  for (const { id, purgeMark } of complete) {
    // oxlint-disable-next-line no-await-in-loop -- one export at a time
    if (await purgedSince(brain, purgeMark)) {
      // oxlint-disable-next-line no-await-in-loop -- one export at a time
      await failPurged(brain, id);
    }
  }
  const due = await brain.db
    .select({ id: brainExports.id, state: brainExports.state })
    .from(brainExports)
    .where(
      or(
        and(
          eq(brainExports.state, "complete"),
          lt(brainExports.expiresAt, now)
        ),
        eq(brainExports.state, "failed")
      )
    );
  for (const { id, state } of due) {
    // oxlint-disable-next-line no-await-in-loop -- one export at a time
    await deleteFiles(brain, id);
    if (state === "complete") {
      // oxlint-disable-next-line no-await-in-loop -- one export at a time
      await brain.db
        .update(brainExports)
        .set({ state: "expired", updatedAt: now })
        .where(eq(brainExports.id, id));
    }
  }
};

/**
 * Where export `exportId` stands, for `by`, the admin who asked for it;
 * `knowledge.not_found` for none, or another's.
 */
export const exportStatus = async <C>(
  brain: Brain<C>,
  by: Writer,
  exportId: string
): Promise<ExportStatus> => {
  const [row] = await brain.db
    .select()
    .from(brainExports)
    .where(eq(brainExports.id, exportId));
  if (row === undefined || row.by !== by.userId) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const written = await storedOf(brain, exportId);
  return {
    exportId,
    state: row.state,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    manifestSha256: row.manifestSha256,
    files:
      row.state === "complete"
        ? written.map(({ name, sha256, bytes, rows }) => ({
            name,
            sha256,
            bytes,
            rows,
          }))
        : [],
  };
};

/**
 * File `name` of the complete export `exportId`, for `by` to download
 * (the admin who asked for it, the host checked), within its window;
 * `knowledge.not_found` otherwise, alike for one that isn't there and
 * one that isn't theirs. Audited.
 */
export const exportFile = async <C>(
  brain: Brain<C>,
  by: Writer,
  exportId: string,
  name: string
): Promise<ReadableStream> => {
  const now = brain.ports.clock();
  const [row] = await brain.db
    .select()
    .from(brainExports)
    .where(eq(brainExports.id, exportId));
  const written = await storedOf(brain, exportId);
  const objectKey =
    name === manifestName
      ? row?.manifestObject
      : written.find((file) => file.name === name)?.object;
  if (
    row === undefined ||
    row.by !== by.userId ||
    row.state !== "complete" ||
    row.expiresAt === null ||
    row.expiresAt.getTime() <= now.getTime() ||
    objectKey === undefined ||
    objectKey === null
  ) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  // A purge since it began: what it holds may be erased, so it goes.
  if (await purgedSince(brain, row.purgeMark)) {
    await failPurged(brain, exportId);
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const object = await brain.ports.blobs.get(objectKey);
  if (object === null) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  // The download is recorded only while still no purge has begun, which
  // a purge begun as the bucket was read fails: then the file is never
  // handed over, nor its download recorded, and the export goes. Nothing
  // is awaited between the record and the hand-over.
  const [recorded] = await auditedBatch(brain.ports, brain.db, [
    outboxedWhere(
      brain,
      {
        actor: by.actor,
        action: "knowledge.export.downloaded",
        target: { type: "export", id: exportId },
        detail: { file: name },
      },
      unpurgedSince(row.purgeMark)
    ).returning({ id: auditOutbox.id }),
  ]);
  if (recorded.length === 0) {
    await object.body.cancel();
    await failPurged(brain, exportId);
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return object.body;
};
