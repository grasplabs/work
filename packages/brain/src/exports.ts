import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit.ts";
import type { Brain } from "./brain.ts";
import { inList, notInList } from "./db/d1.ts";
import {
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

/** Documents in one file of the export: each with every version's text. */
export const documentsPerFile = 25;

/** The export's format, as its manifest names it. */
export const exportFormat = "grasp-brain-export";

/** The version of the format this writes. */
export const exportFormatVersion = 1;

/** The manifest's name: written last. */
export const manifestName = "manifest.json";

/** One file the host adds, as rows of JSON. */
export interface HostExportFile {
  /** Lower-case letters, digits and dashes: it becomes `host-<name>.jsonl`. */
  name: string;
  rows: Json[];
}

/** What the host adds to an export of its own (core: grants, teams). */
export interface OnExport {
  /** Collections never exported: no company content (core: interviews'). */
  excluded: readonly string[];
  files: (collectionIds: readonly string[]) => Promise<HostExportFile[]>;
}

const hostNamePattern = /^[a-z][a-z0-9-]{0,40}$/u;

/** Everything export `exportId` keeps in the bucket is under this. */
const prefixOf = (exportId: string): string => `exports/${exportId}/`;

/** A new object for file `name` of export `exportId`: never reused. */
const objectFor = (exportId: string, name: string): string =>
  `${prefixOf(exportId)}${crypto.randomUUID()}-${name}`;

/** The marker that the host's files are all written, naming them. */
const hostedName = "hosted.jsonl";

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

/** The next file of documents after `after`, with each version's text. */
const documentsFile = async <C>(
  brain: Brain<C>,
  collectionIds: readonly string[],
  after: string | null
): Promise<{ rows: Json[]; last: string | null }> => {
  const { db } = brain;
  const page = await db
    .select()
    .from(documents)
    .where(
      and(
        inList(documents.collectionId, collectionIds),
        after === null ? undefined : gt(documents.id, after)
      )
    )
    .orderBy(asc(documents.id))
    .limit(documentsPerFile);
  const rows: Json[] = [];
  for (const document of page) {
    // oxlint-disable-next-line no-await-in-loop -- one document's versions at a time, to bound memory
    const kept = await db
      .select()
      .from(versions)
      .where(eq(versions.documentId, document.id))
      .orderBy(asc(versions.number));
    const texts: Json[] = [];
    for (const version of kept) {
      // oxlint-disable-next-line no-await-in-loop -- one version's text at a time
      const text = await versionText(brain, db, document.id, version.number);
      texts.push({
        number: version.number,
        author: version.author,
        message: version.message,
        restoredFrom: version.restoredFrom,
        createdAt: version.createdAt.toISOString(),
        text: text ?? null,
      });
    }
    // oxlint-disable-next-line no-await-in-loop -- one document at a time
    const [transcript] = await db
      .select()
      .from(transcripts)
      .where(eq(transcripts.documentId, document.id));
    rows.push({
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
      versions: texts,
      transcript:
        transcript === undefined
          ? null
          : {
              version: transcript.version,
              turns: transcript.turns,
              chapters: transcript.chapters,
            },
    });
  }
  return {
    rows,
    last: page.length < documentsPerFile ? null : (page.at(-1)?.id ?? null),
  };
};

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
  const names = new Set(written.map(({ name }) => name));
  const position = written.length;
  if (!names.has("collections.jsonl")) {
    const company =
      collectionIds.length === 0
        ? []
        : await brain.db
            .select()
            .from(collections)
            .where(inList(collections.id, collectionIds))
            .orderBy(asc(collections.id));
    const rows = company.map((collection) => ({
      id: collection.id,
      name: collection.name,
      description: collection.description,
      owner: collection.owner,
      access: collection.access,
      sensitive: collection.sensitive,
      source: collection.source,
      createdAt: collection.createdAt.toISOString(),
    }));
    await writeFile(
      brain,
      run,
      position,
      "collections.jsonl",
      linesOf(rows),
      rows.length
    );
    return true;
  }
  const parts = written.filter(({ name }) => name.startsWith("documents-"));
  const lastPart = parts.at(-1);
  if (lastPart === undefined || lastPart.cursor !== null) {
    const { rows, last } = await documentsFile(
      brain,
      collectionIds,
      lastPart?.cursor ?? null
    );
    const name = `documents-${String(parts.length + 1).padStart(4, "0")}.jsonl`;
    await writeFile(
      brain,
      run,
      position,
      name,
      linesOf(rows),
      rows.length,
      last
    );
    return true;
  }
  if (!names.has("memories.jsonl")) {
    const rows = await brain.db
      .select()
      .from(brainMemories)
      .where(
        and(
          inArray(brainMemories.scope, ["team", "company"]),
          eq(brainMemories.state, "accepted"),
          citesReadable(collectionIds)
        )
      )
      .orderBy(asc(brainMemories.id));
    const shown = rows.map((row) => ({
      ...recordOf(row),
      scopeId: row.scopeId,
      ownerId: row.ownerId,
    }));
    await writeFile(
      brain,
      run,
      position,
      "memories.jsonl",
      linesOf(shown),
      shown.length
    );
    return true;
  }
  if (!names.has("erasures.jsonl")) {
    const [purges, people, evidence] = await Promise.all([
      brain.db.select().from(brainPurges).orderBy(asc(brainPurges.createdAt)),
      brain.db.select().from(brainForgottenPeople),
      brain.db.select().from(brainErasedEvidence),
    ]);
    const rows: Json[] = [
      ...purges.map((purge) => ({
        type: "purge",
        id: purge.id,
        kind: purge.kind,
        createdAt: purge.createdAt.toISOString(),
        completedAt: purge.completedAt?.toISOString() ?? null,
        supersededBy: purge.supersededBy,
      })),
      ...people.map((person) => ({
        type: "forgotten_person",
        userId: person.userId,
        at: person.forgottenAt.toISOString(),
      })),
      ...evidence.map((each) => ({
        type: "erased_evidence",
        evidenceId: each.evidenceId,
        at: each.erasedAt.toISOString(),
      })),
    ];
    await writeFile(
      brain,
      run,
      position,
      "erasures.jsonl",
      linesOf(rows),
      rows.length
    );
    return true;
  }
  if (!names.has(hostedName)) {
    // The host's files are written all from one ask: any a run stopped
    // among are written again with the rest, never mixed with another's.
    const stale = written.filter(({ name }) => name.startsWith("host-"));
    await removeFiles(brain, run, stale);
    const files = await onExport.files(collectionIds);
    const hostNames = files.map(({ name }) => name);
    if (
      hostNames.some((name) => !hostNamePattern.test(name)) ||
      new Set(hostNames).size !== hostNames.length
    ) {
      throw knowledgeErrors.create("knowledge.invalid");
    }
    let at = position - stale.length;
    for (const file of files) {
      // oxlint-disable-next-line no-await-in-loop -- one file after another, in order
      await writeFile(
        brain,
        run,
        at,
        `host-${file.name}.jsonl`,
        linesOf(file.rows),
        file.rows.length
      );
      at += 1;
    }
    // Then that they all are, naming them: a run stopped before this
    // writes them again.
    const hosted = hostNames.map((name) => ({ name: `host-${name}.jsonl` }));
    await writeFile(brain, run, at, hostedName, linesOf(hosted), hosted.length);
    return true;
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
  const manifest = JSON.stringify(body);
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
  await auditedBatch(brain.ports, brain.db, [
    outboxed(brain, {
      actor: by.actor,
      action: "knowledge.export.downloaded",
      target: { type: "export", id: exportId },
      detail: { file: name },
    }),
  ]);
  return object.body;
};
