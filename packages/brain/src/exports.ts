import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
} from "drizzle-orm";

import { auditedBatch, outboxed } from "./audit.ts";
import type { Brain } from "./brain.ts";
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
// purge erased, so its files are deleted, to be asked for again. Its files
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

/** Where file `name` of export `exportId` is kept in the bucket. */
const keyOf = (exportId: string, name: string): string =>
  `exports/${exportId}/${name}`;

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
        excluded.length === 0
          ? undefined
          : notInArray(collections.id, [...excluded])
      )
    )
    .orderBy(asc(collections.id));

/** Whether a purge began or ran again since `since`: what an export holds may be erased. */
const purgedSince = async <C>(
  brain: Brain<C>,
  since: Date
): Promise<boolean> => {
  const found = await brain.db
    .select({ id: brainPurges.id })
    .from(brainPurges)
    .where(
      or(gte(brainPurges.createdAt, since), gte(brainPurges.updatedAt, since))
    )
    .limit(1);
  return found.length > 0;
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
          .where(inArray(documents.collectionId, ids));
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
  token: unknown
): Promise<{ exportId: string }> => {
  await requireExportToken(brain, by, token);
  const exportId = crypto.randomUUID();
  const now = brain.ports.clock();
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

/** The files export `exportId` wrote so far, in order. */
const filesOf = async <C>(brain: Brain<C>, exportId: string) =>
  await brain.db
    .select()
    .from(brainExportFiles)
    .where(eq(brainExportFiles.exportId, exportId))
    .orderBy(asc(brainExportFiles.position));

/** Writes file `name` of the export, and records it, with its checksum. */
const writeFile = async <C>(
  brain: Brain<C>,
  exportId: string,
  position: number,
  name: string,
  body: string,
  rows: number,
  cursor: string | null = null
): Promise<void> => {
  await brain.ports.blobs.put(keyOf(exportId, name), body);
  await brain.db
    .insert(brainExportFiles)
    .values({
      exportId,
      name,
      position,
      sha256: await sha256Hex(body),
      bytes: new TextEncoder().encode(body).byteLength,
      rows,
      cursor,
    })
    .onConflictDoNothing();
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
        inArray(documents.collectionId, [...collectionIds]),
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
 * Writes the next file export `exportId` owes, or its manifest when none
 * is left. Whether more is left to write.
 */
const writeNext = async <C>(
  brain: Brain<C>,
  exportId: string,
  createdAt: Date,
  onExport: OnExport
): Promise<boolean> => {
  const written = await filesOf(brain, exportId);
  const names = new Set(written.map(({ name }) => name));
  const position = written.length;
  const company = await exportedCollections(brain, onExport.excluded);
  const collectionIds = company.map(({ id }) => id);
  if (!names.has("collections.jsonl")) {
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
      exportId,
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
      exportId,
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
      exportId,
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
      exportId,
      position,
      "erasures.jsonl",
      linesOf(rows),
      rows.length
    );
    return true;
  }
  if (!written.some(({ name }) => name.startsWith("host-"))) {
    const files = await onExport.files(collectionIds);
    let at = position;
    for (const file of files) {
      if (!hostNamePattern.test(file.name)) {
        throw knowledgeErrors.create("knowledge.invalid");
      }
      // oxlint-disable-next-line no-await-in-loop -- one file after another, in order
      await writeFile(
        brain,
        exportId,
        at,
        `host-${file.name}.jsonl`,
        linesOf(file.rows),
        file.rows.length
      );
      at += 1;
    }
    // None of its own: noted, so the host isn't asked again.
    if (files.length === 0) {
      await writeFile(brain, exportId, at, "host-none.jsonl", "", 0);
    }
    return true;
  }
  // A purge since it began may have erased what it holds: it goes.
  if (await purgedSince(brain, createdAt)) {
    throw knowledgeErrors.create("knowledge.export_purged");
  }
  const manifest = JSON.stringify({
    format: exportFormat,
    version: exportFormatVersion,
    exportId,
    createdAt: createdAt.toISOString(),
    files: written.map(({ name, sha256, bytes, rows }) => ({
      name,
      sha256,
      bytes,
      rows,
    })),
  });
  await brain.ports.blobs.put(keyOf(exportId, manifestName), manifest);
  const now = brain.ports.clock();
  const [exported] = await brain.db
    .select({ by: brainExports.by })
    .from(brainExports)
    .where(eq(brainExports.id, exportId));
  await auditedBatch(brain.ports, brain.db, [
    brain.db
      .update(brainExports)
      .set({
        state: "complete",
        completedAt: now,
        expiresAt: new Date(now.getTime() + exportLifetimeMs),
        manifestSha256: await sha256Hex(manifest),
        claim: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(eq(brainExports.id, exportId)),
    outboxed(brain, {
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
  return false;
};

/** Deletes every file export `exportId` wrote, its manifest too. */
const deleteFiles = async <C>(
  brain: Brain<C>,
  exportId: string
): Promise<void> => {
  const written = await filesOf(brain, exportId);
  await brain.ports.blobs.delete([
    ...written.map(({ name }) => keyOf(exportId, name)),
    keyOf(exportId, manifestName),
  ]);
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
    .returning({ createdAt: brainExports.createdAt });
  if (held === undefined) {
    return false;
  }
  try {
    while (brain.ports.clock().getTime() < until.getTime()) {
      // oxlint-disable-next-line no-await-in-loop -- one file after another
      const more = await writeNext(brain, exportId, held.createdAt, onExport);
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
    .select({ id: brainExports.id, createdAt: brainExports.createdAt })
    .from(brainExports)
    .where(eq(brainExports.state, "complete"));
  for (const { id, createdAt } of complete) {
    // oxlint-disable-next-line no-await-in-loop -- one export at a time
    if (await purgedSince(brain, createdAt)) {
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
  const written = await filesOf(brain, exportId);
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
  const written = await filesOf(brain, exportId);
  const listed =
    name === manifestName || written.some((file) => file.name === name);
  if (
    row === undefined ||
    row.by !== by.userId ||
    row.state !== "complete" ||
    row.expiresAt === null ||
    row.expiresAt.getTime() <= now.getTime() ||
    !listed
  ) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  // A purge since it began: what it holds may be erased, so it goes.
  if (await purgedSince(brain, row.createdAt)) {
    await failPurged(brain, exportId);
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const object = await brain.ports.blobs.get(keyOf(exportId, name));
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
