import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { brainExportErrors } from "@grasp-os/shared/brain-exports";
import {
  brainSourceErrors,
  brainUploadErrors,
  brainUploadReadersSchema,
} from "@grasp-os/shared/brain-sources";
import type {
  BrainSharedUploadPage,
  BrainUpload,
  BrainUploadFile,
  BrainUploadReaders,
} from "@grasp-os/shared/brain-sources";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { log } from "@grasp-os/shared/log";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  uploadErrors,
  uploadExtensionOf,
  uploadMaxBytes,
  uploadNameSchema,
  uploadTypes,
} from "@grasp-os/shared/uploads";
import { and, desc, eq, lt, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  auditedBatch,
  outboxed,
  outboxedEvent,
  uuidFromHash,
} from "./audit-outbox.ts";
import { memberOf } from "./auth/identity.ts";
import type { Member } from "./auth/identity.ts";
import { uploadSource } from "./brain-next-origins.ts";
import {
  addSource,
  eraseSource,
  readSourceVersionAs,
  sourceTextProblem,
} from "./brain-next.ts";
import type { SourceReaders, SourceVersionRef } from "./brain-next.ts";
import { brainUploads, teams, users } from "./db/core/schema.ts";
import { ExtractorUnavailableError, localExtractor } from "./files/extract.ts";
import { hasText, signatures } from "./files/upload-checks.ts";

// Files a person uploads straight into the Brain, on Brain › Sources
// (GRA-1824; its threat model is on the issue). The uploader chooses who
// may read it: only them, one of their teams, or everyone. The file is
// checked as every upload is, by what arrived (its size, and that it
// starts as the type its name says), and its text read by the local
// extractor in its sandbox, as a chat's file is (chat-files.ts): never a
// model's conversion, so nothing of it leaves the deployment's Workers.
// Its text, under its file name, goes to the Brain at once as a version of
// the source `upload:<id>` (`uploadSource`), within the request: an upload
// is a person's deliberate act, so no queue stands between.
//
// Core remembers each upload in its own database (`brain_uploads`): who
// uploaded it and for whom, IDs only. Its row is written, with the audit
// event, before the Brain is given anything under its key, so every key
// the Brain holds is named by a row its uploader can delete; an add that
// failed, or whose answer was lost, leaves the row, to upload to again or
// delete. Readers are fixed for its life: a new version keeps them, and
// other readers are a new upload. Deleting erases the key in the Brain
// first and forgets the row only after, so a failure leaves the upload as
// it was; once erased, the Brain refuses any add to the key, also one
// whose file was being read while the delete ran.
//
// Who may do what, from core's records read now, never the page's word:
// readers are only the uploader, a team they are in, or everyone; a new
// version is its uploader's alone; a delete is its uploader's, or an
// admin's when it isn't one person's own. An upload they may not read
// answers as one that doesn't exist, alike.

type UploadRow = typeof brainUploads.$inferSelect;

const uploadFileSchema = z.strictObject({
  name: uploadNameSchema,
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
});

/** An upload's id, as core mints them. */
const uploadIdSchema = z.uuid();

/** The member `person` is now: refused once they are none. */
const memberNow = async (env: Env, person: Identity): Promise<Member> => {
  const member = await memberOf(env.DB, person.userId);
  if (member === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return member;
};

/** Whether `member` may name `readers` for an upload of theirs now. */
const mayGrant = (member: Member, readers: BrainUploadReaders): boolean =>
  readers.kind !== "team" ||
  member.teams.some(({ id }) => id === readers.teamId);

/** `row`'s readers, as the page names them. */
const readersOf = (row: UploadRow): BrainUploadReaders => {
  switch (row.readers) {
    case "team": {
      // The table refuses a team row without its team
      // (`brain_uploads_team_named`): one would be read nowhere.
      if (row.teamId === null) {
        throw new Error(`Upload ${row.id} is for a team, but names none`);
      }
      return { kind: "team", teamId: row.teamId };
    }
    case "everyone": {
      return { kind: "everyone" };
    }
    case "me": {
      return { kind: "me" };
    }
    default: {
      throw new Error(`Upload ${row.id} has unknown readers`);
    }
  }
};

/** `row`'s readers, as core's Brain module names them. */
const sourceReadersOf = (row: UploadRow): SourceReaders => {
  const readers = readersOf(row);
  switch (readers.kind) {
    case "me": {
      return { kind: "owner", personId: row.uploadedBy };
    }
    case "team": {
      return { kind: "team", teamId: readers.teamId };
    }
    case "everyone": {
      return { kind: "everyone" };
    }
    default: {
      throw new Error("Unknown readers");
    }
  }
};

/** Whether `member` may read `row`'s upload now: as the Brain reads it. */
const mayRead = (member: Member, row: UploadRow): boolean => {
  const readers = readersOf(row);
  switch (readers.kind) {
    case "me": {
      return row.uploadedBy === member.userId;
    }
    case "team": {
      return member.teams.some(({ id }) => id === readers.teamId);
    }
    case "everyone": {
      return true;
    }
    default: {
      return false;
    }
  }
};

const mayAddVersion = (member: Member, row: UploadRow): boolean =>
  row.uploadedBy === member.userId;

/**
 * Whether `member` may delete `row`'s upload, which erases it for good:
 * a Brain removal keeps history, and only an admin's hard delete erases
 * (Nick's rule; a removal that keeps history is GRA-1877). So:
 *
 * - its uploader, for one theirs alone: nobody else ever read it, and no
 *   admin may see that it exists, so their delete is the one that erases;
 * - an admin, for one shared with a team or everyone, also one they can't
 *   read (a team they aren't in, or one dissolved), so no shared upload is
 *   left that nobody can erase. Such an admin learns that it exists, by
 *   its team, uploader and when (`sharedUploadsFor`), and by its file's
 *   name only when they may read it; never its text. Its uploader asks an
 *   admin to remove it.
 */
const mayDelete = (member: Member, row: UploadRow): boolean =>
  row.readers === "me"
    ? row.uploadedBy === member.userId
    : isAdmin(member.role);

/** Whether `member` may reach `row`'s upload at all: read it, or delete it. */
const mayReach = (member: Member, row: UploadRow): boolean =>
  mayDelete(member, row) || mayRead(member, row);

/**
 * The upload `uploadId` for `member`, when `may` lets them reach it:
 * `brain.upload_not_found` when there is none or it doesn't, alike.
 */
const reachableUpload = async (
  env: Env,
  member: Member,
  uploadId: unknown,
  may: (member: Member, row: UploadRow) => boolean
): Promise<UploadRow> => {
  const id = uploadIdSchema.safeParse(uploadId);
  if (!id.success) {
    throw brainUploadErrors.create("brain.upload_not_found");
  }
  const [row] = await drizzle(env.DB)
    .select()
    .from(brainUploads)
    .where(eq(brainUploads.id, id.data));
  if (row === undefined || !may(member, row)) {
    throw brainUploadErrors.create("brain.upload_not_found");
  }
  return row;
};

/** The upload `uploadId` for `member`, if they may read it (`reachableUpload`). */
const readableUpload = async (
  env: Env,
  member: Member,
  uploadId: unknown
): Promise<UploadRow> => await reachableUpload(env, member, uploadId, mayRead);

/** The file `input` names, checked by what arrived: its name, size and first bytes. */
const checkedFile = (
  input: unknown
): BrainUploadFile & { type: keyof typeof uploadTypes } => {
  const { name, bytes } = uploadErrors.parse(
    "upload.invalid",
    uploadFileSchema,
    input
  );
  // By the bytes that arrived, never by a size anyone reported.
  if (bytes.byteLength > uploadMaxBytes) {
    throw uploadErrors.create("upload.too_large", {
      bytes: bytes.byteLength,
      maxBytes: uploadMaxBytes,
    });
  }
  const type = uploadExtensionOf(name);
  if (type === undefined || !signatures[type](bytes)) {
    throw uploadErrors.create("upload.unsupported");
  }
  return { name, bytes, type };
};

/**
 * The text of `file`, under its name, as the Brain keeps it: read in the
 * extractor's sandbox, its errors as the person reads them. The name is
 * the text's first line, so it is the source's title, found by search and
 * erased with it.
 */
const textOf = async (
  env: Env,
  file: BrainUploadFile & { type: keyof typeof uploadTypes }
): Promise<string> => {
  let markdown: string;
  try {
    ({ markdown } = await localExtractor(env)({
      name: file.name,
      mediaType: uploadTypes[file.type],
      bytes: file.bytes,
    }));
  } catch (error) {
    if (error instanceof ExtractorUnavailableError) {
      throw brainUploadErrors.create("brain.upload_busy");
    }
    // The extractor (files/extract.ts) still says its text is too long
    // with Knowledge's error code: the file is within its size, its text
    // isn't.
    if (knowledgeErrors.codeOf(error) === "knowledge.too_large") {
      throw brainUploadErrors.create("brain.upload_text_too_long");
    }
    if (isExpectedError(error)) {
      throw error;
    }
    // The error's name only: a parser's message may quote the file.
    log.warn("brain.upload.unreadable", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw uploadErrors.create("upload.unreadable");
  }
  if (!hasText(markdown)) {
    throw uploadErrors.create("upload.no_text");
  }
  // A file's text may hold half a surrogate pair, which the Brain refuses:
  // each becomes U+FFFD, as a decoder would make it. Then the Brain's own
  // rules for a text (`sourceTextProblem`), before anything is written:
  // nothing the Brain would refuse as invalid or too large reaches a row.
  const text = `${file.name}\n\n${markdown}`.toWellFormed();
  const problem = sourceTextProblem(text);
  if (problem === "brain.source_no_text") {
    throw uploadErrors.create("upload.no_text");
  }
  if (problem === "brain.source_too_large") {
    throw brainUploadErrors.create("brain.upload_text_too_long");
  }
  return text;
};

/** What an upload's audit events say of it: IDs, its readers' kind and the file's type and size. */
const detailOf = (
  row: UploadRow,
  file: BrainUploadFile & { type: keyof typeof uploadTypes }
) => ({
  readers: row.readers,
  ...(row.teamId === null ? {} : { teamId: row.teamId }),
  mediaType: uploadTypes[file.type],
  bytes: file.bytes.byteLength,
});

/**
 * Why the Brain refused an add: as a hand-over is refused (`erased`,
 * `invalid`, `too_large`), or, for a retried first upload, that its id
 * was already added with another file (`other_file`).
 */
type RefusalReason =
  | "erased"
  | "invalid"
  | "too_large"
  | "other_file"
  | "restoring";

/**
 * Each of the Brain's refusals of an add, which certainly didn't land:
 * why, whether it frees the row, and what the person is told (`first`
 * when the add was an upload's first version). Only `erased` frees it:
 * the key is closed, so the row names nothing the Brain holds, whoever
 * wrote it. `invalid` and `too_large` are ruled out before any row is
 * written (`textOf`), so they free none, never one whose version another
 * call may have landed. `other_file`: the first version made under this
 * id stands; nothing changed.
 */
const refusals: Readonly<
  Record<
    NonNullable<ReturnType<typeof brainSourceErrors.codeOf>>,
    {
      reason: RefusalReason;
      frees: boolean;
      error: (first: boolean) => Error;
    }
  >
> = {
  "brain.source_erased": {
    reason: "erased",
    frees: true,
    // A first upload's id was used before and deleted: a fresh one is the
    // way on, which the page mints for the next file chosen.
    error: (first) =>
      first
        ? brainUploadErrors.create("brain.upload_retry_refused")
        : brainUploadErrors.create("brain.upload_deleted"),
  },
  // An argument core's own check refused, before the Brain was asked. Not
  // reached through an upload: everything `addSource` checks is core's own
  // (its ids, readers and change key) or checked before the add (its text,
  // `textOf`). Kept so every refusal of the family has its answer.
  "brain.request_invalid": {
    reason: "invalid",
    frees: false,
    error: () => uploadErrors.create("upload.invalid"),
  },
  "brain.source_no_text": {
    reason: "invalid",
    frees: false,
    error: () => uploadErrors.create("upload.no_text"),
  },
  "brain.source_too_large": {
    reason: "too_large",
    frees: false,
    error: () => brainUploadErrors.create("brain.upload_text_too_long"),
  },
  "brain.source_change_taken": {
    reason: "other_file",
    frees: false,
    error: () => brainUploadErrors.create("brain.upload_other_file"),
  },
};

/** How the Brain refused `error`'s add, or undefined when it isn't sure. */
const refusalOf = (error: unknown) => {
  // The Brain restores an export and adds nothing meanwhile: refused, the
  // row kept, and the same id taken again once the restore is done.
  if (brainExportErrors.codeOf(error) === "brain.restoring") {
    return {
      reason: "restoring",
      frees: false,
      error: () => brainExportErrors.create("brain.restoring"),
    } as const;
  }
  const code = brainSourceErrors.codeOf(error);
  return code === undefined ? undefined : refusals[code];
};

/**
 * Adds `text` to the Brain as the next version of `row`'s upload, as the
 * change `change`, with the one event the upload is audited by, its counts
 * with it, written before the person is answered. `first` when it is the
 * upload's first: its change is then the upload's own id, so a retry of
 * it (the page's, after a lost answer) is the same version, never a
 * second one.
 *
 * - `brain.upload.added`, with its version.
 * - `brain.upload.refused`, with why (`refusals`), when the Brain refused
 *   it: it certainly didn't land. The row goes with the event only when
 *   its key is erased (`frees`). The person is told why, in their words.
 * - `brain.upload.failed` for any other failure, whose outcome isn't
 *   known: the add may have landed (an answer lost), so the row always
 *   stays, naming the key: the upload can be deleted, and the same id
 *   tried again, which the Brain answers with the version it made.
 */
const addVersion = async (
  env: Env,
  person: Identity,
  row: UploadRow,
  file: BrainUploadFile & { type: keyof typeof uploadTypes },
  text: string,
  { first, change }: { first: boolean; change: string }
): Promise<SourceVersionRef> => {
  const db = drizzle(env.DB);
  const entry = (action: string, detail: Record<string, unknown>) => ({
    actor: actorOf(person),
    target: { type: "brain_upload", id: row.id },
    action,
    detail: { ...detailOf(row, file), ...detail },
  });
  const event = (action: string, detail: Record<string, unknown>) =>
    outboxed(db, entry(action, detail));
  const forgotten = db.delete(brainUploads).where(eq(brainUploads.id, row.id));
  let added: SourceVersionRef;
  try {
    added = await addSource(env, {
      source: uploadSource(row.id),
      change,
      text,
      readers: sourceReadersOf(row),
    });
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === undefined) {
      await auditedBatch(env, db, [event("brain.upload.failed", {})]);
      throw error;
    }
    const refused = event("brain.upload.refused", { reason: refusal.reason });
    await (refusal.frees
      ? auditedBatch(env, db, [forgotten, refused])
      : auditedBatch(env, db, [refused]));
    throw refusal.error(first);
  }
  // Every answered add records its version, once: the same event each
  // time, its ID the upload's and the version's and its time the
  // version's, so the outbox and the log keep it once (`outboxedEvent`),
  // even one sent again after the first was logged: a duplicate the log
  // drops, never a conflict. Each version is audited exactly once
  // whatever order its adds land in or however often one is retried. Its
  // uploader is the only one who adds (`mayAddVersion`), so its actor is
  // the same too; so is its detail, but for a retry with another file
  // whose text is the same (its type and size; see the PR's Known). The
  // version's time is read as its uploader reads it, whom its readers
  // were checked to include just before the add: should they have left
  // since (or it been erased), the event takes the time now, and only a
  // retry they can no longer make would conflict. The name moves only
  // forward, to an add past the row's version: a retry the Brain answers
  // with an older version (its answer lost) leaves it.
  const kept = await readSourceVersionAs(env, person.userId, added);
  const addedEvent = {
    ...createAuditEvent(
      entry("brain.upload.added", { version: added.version }),
      "core"
    ),
    id: uuidFromHash(
      await sha256Hex(
        JSON.stringify(["brain.upload.added", row.id, added.version])
      )
    ),
    at: (kept?.addedAt ?? new Date()).toISOString(),
  };
  await auditedBatch(env, db, [
    db
      .update(brainUploads)
      .set({
        version: added.version,
        // The name of the file its current version came from, kept here
        // only for an upload shared with others: one for its uploader
        // alone keeps its name in their own store.
        ...(row.readers === "me" ? {} : { name: file.name }),
      })
      .where(
        and(
          eq(brainUploads.id, row.id),
          lt(brainUploads.version, added.version)
        )
      ),
    outboxedEvent(db, addedEvent),
  ]);
  return { source: added.source, version: added.version };
};

/**
 * Uploads `input` into the Brain for `readersInput`, as `person`: a new
 * upload, its first version, under `uploadIdInput`, the id the page mints
 * for the file it was given and sends again when it retries (a UUID).
 * Refused before the file is read when the readers aren't theirs to
 * choose, and again after, right before anything is written, should that
 * have changed meanwhile.
 *
 * A retry is the same upload: an id that is already this person's upload,
 * for the same readers, adds its first version again, which the Brain
 * answers with the version it made. An id anyone else's upload holds, or
 * theirs for other readers, is refused (`brain.upload_retry_refused`,
 * audited), never their upload: the page mints a fresh one for the next
 * file. The same id sent again with another file is refused as
 * `brain.upload_other_file`: the first file stays as it was.
 */
export const uploadToBrain = async (
  env: Env,
  person: Identity,
  input: unknown,
  readersInput: unknown,
  uploadIdInput: unknown
): Promise<SourceVersionRef> => {
  const readers = brainUploadErrors.parse(
    "brain.upload_readers",
    brainUploadReadersSchema,
    readersInput
  );
  const id = uploadIdSchema.safeParse(uploadIdInput);
  if (!id.success) {
    throw uploadErrors.create("upload.invalid");
  }
  if (!mayGrant(await memberNow(env, person), readers)) {
    throw brainUploadErrors.create("brain.upload_readers");
  }
  const file = checkedFile(input);
  const text = await textOf(env, file);
  // Read again: reading the file took time, and they may have left the
  // team, or the organization, meanwhile.
  if (!mayGrant(await memberNow(env, person), readers)) {
    throw brainUploadErrors.create("brain.upload_readers");
  }
  const now = new Date();
  const db = drizzle(env.DB);
  // Before the Brain is given anything under its key, so every key it
  // holds is named here for its deletion; kept as it is when the id is
  // already an upload's, which is then read back whoever made it.
  await db
    .insert(brainUploads)
    .values({
      id: id.data,
      uploadedBy: person.userId,
      // Shared only: an upload for its uploader alone keeps even its name
      // in their own store.
      name: readers.kind === "me" ? null : file.name,
      readers: readers.kind,
      teamId: readers.kind === "team" ? readers.teamId : null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(brainUploads)
    .where(eq(brainUploads.id, id.data));
  const theirs =
    row !== undefined &&
    row.uploadedBy === person.userId &&
    row.readers === readers.kind &&
    row.teamId === (readers.kind === "team" ? readers.teamId : null);
  if (!theirs) {
    // Audited as every refusal is: by the person and the id they sent,
    // with nothing of the upload that holds it.
    await auditedBatch(env, db, [
      outboxed(db, {
        actor: actorOf(person),
        target: { type: "brain_upload", id: id.data },
        action: "brain.upload.refused",
        detail: {
          reason: "id_taken",
          readers: readers.kind,
          mediaType: uploadTypes[file.type],
          bytes: file.bytes.byteLength,
        },
      }),
    ]);
    throw brainUploadErrors.create("brain.upload_retry_refused");
  }
  return await addVersion(env, person, row, file, text, {
    first: true,
    change: row.id,
  });
};

/**
 * Uploads `input` as the next version of `uploadId`, for its readers, as
 * `person`, who must be its uploader, under `versionIdInput`: the id the
 * page mints for the file it was given and sends again when it retries (a
 * UUID). It is the version's change, so a retry after a lost answer is
 * the version it made, even after a later one, and the same id sent with
 * another file is refused (`brain.upload_other_file`). Its readers are
 * read again after the file is, right before the add.
 */
export const uploadVersionToBrain = async (
  env: Env,
  person: Identity,
  uploadId: unknown,
  input: unknown,
  versionIdInput: unknown
): Promise<SourceVersionRef> => {
  const versionId = uploadIdSchema.safeParse(versionIdInput);
  // The upload's own id is its first version's change.
  if (!versionId.success || versionId.data === uploadId) {
    throw uploadErrors.create("upload.invalid");
  }
  const asked = await memberNow(env, person);
  const before = await readableUpload(env, asked, uploadId);
  if (!mayAddVersion(asked, before)) {
    throw brainUploadErrors.create("brain.upload_not_allowed");
  }
  const file = checkedFile(input);
  const text = await textOf(env, file);
  // Read again: it may have been deleted, or they may have left its team,
  // while the file was read.
  const member = await memberNow(env, person);
  const row = await readableUpload(env, member, before.id);
  if (!mayGrant(member, readersOf(row))) {
    throw brainUploadErrors.create("brain.upload_readers");
  }
  await drizzle(env.DB)
    .update(brainUploads)
    .set({ updatedAt: new Date() })
    .where(eq(brainUploads.id, row.id));
  return await addVersion(env, person, row, file, text, {
    first: false,
    change: versionId.data,
  });
};

/**
 * The upload `uploadId`, as `person` may act on it: for anyone who may
 * read or delete it (`mayReach`); null when there is none or they may do
 * neither, alike.
 */
export const brainUploadOf = async (
  env: Env,
  person: Identity,
  uploadId: unknown
): Promise<BrainUpload | null> => {
  const member = await memberNow(env, person);
  let row: UploadRow;
  try {
    row = await reachableUpload(env, member, uploadId, mayReach);
  } catch (error) {
    if (brainUploadErrors.codeOf(error) === "brain.upload_not_found") {
      return null;
    }
    throw error;
  }
  return {
    source: uploadSource(row.id),
    readers: readersOf(row),
    // A new version is for readers its uploader may still choose.
    mayAddVersion:
      mayAddVersion(member, row) && mayGrant(member, readersOf(row)),
    mayDelete: mayDelete(member, row),
  };
};

/**
 * Deletes the upload `uploadId` for good, as `person`, who may
 * (`mayDelete`; anyone else who may read it is refused, audited, as
 * `brain.upload_admin_only`): its key erased in
 * the Brain, every version, then its row forgotten, with
 * `brain.upload.deleted`. An erasure that failed is recorded
 * (`brain.upload.delete_failed`) and leaves the upload as it was, to
 * delete again: the erasure is safe to repeat.
 */
export const deleteBrainUpload = async (
  env: Env,
  person: Identity,
  uploadId: unknown
): Promise<void> => {
  const member = await memberNow(env, person);
  const row = await reachableUpload(env, member, uploadId, mayReach);
  const db = drizzle(env.DB);
  const actor = actorOf(person);
  const target = { type: "brain_upload", id: row.id };
  if (!mayDelete(member, row)) {
    // A shared upload, asked of by one of its readers who isn't an admin:
    // its uploader or anyone else may read it, and only an admin erases.
    await auditedBatch(env, db, [
      outboxed(db, {
        actor,
        target,
        action: "brain.upload.refused",
        detail: { reason: "admin_only", readers: row.readers },
      }),
    ]);
    throw brainUploadErrors.create("brain.upload_admin_only");
  }
  // One event, of how it ended, written before the person is answered.
  try {
    await eraseSource(env, {
      source: uploadSource(row.id),
      readers: sourceReadersOf(row),
      reason: "deleted",
    });
  } catch (error) {
    await auditedBatch(env, db, [
      outboxed(db, {
        actor,
        target,
        action: "brain.upload.delete_failed",
        detail: { readers: row.readers },
      }),
    ]);
    throw error;
  }
  await auditedBatch(env, db, [
    db.delete(brainUploads).where(eq(brainUploads.id, row.id)),
    outboxed(db, {
      actor,
      target,
      action: "brain.upload.deleted",
      detail: { readers: row.readers },
    }),
  ]);
};

/** How many shared uploads one page of an admin's listing holds. */
const sharedPageSize = 50;

const sharedAfterSchema = z.strictObject({
  uploadedAt: z.iso.datetime(),
  id: uploadIdSchema,
});

/**
 * For an admin: a page of the uploads shared with a team or everyone,
 * newest first, after `afterInput` (where the page before ended): each by
 * who may read it, who uploaded it and when, and by its file's name when
 * they may read it, so they can erase one they may not read. Never an upload one person alone may read,
 * and never any text. Refused (`role.forbidden`) for anyone else. Each
 * page asked is audited once, with how many it listed.
 */
export const sharedUploadsFor = async (
  env: Env,
  person: Identity,
  afterInput: unknown
): Promise<BrainSharedUploadPage> => {
  const member = await memberNow(env, person);
  if (!isAdmin(member.role)) {
    throw roleErrors.create("role.forbidden");
  }
  const after =
    afterInput === undefined || afterInput === null
      ? undefined
      : brainUploadErrors.parse(
          "brain.upload_not_found",
          sharedAfterSchema,
          afterInput
        );
  const db = drizzle(env.DB);
  const at = after === undefined ? undefined : new Date(after.uploadedAt);
  const rows = await db
    .select({
      upload: brainUploads,
      teamName: teams.name,
      uploaderName: users.name,
      createdAt: brainUploads.createdAt,
    })
    .from(brainUploads)
    .innerJoin(users, eq(users.id, brainUploads.uploadedBy))
    .leftJoin(teams, eq(teams.id, brainUploads.teamId))
    .where(
      and(
        ne(brainUploads.readers, "me"),
        at === undefined || after === undefined
          ? undefined
          : or(
              lt(brainUploads.createdAt, at),
              and(eq(brainUploads.createdAt, at), lt(brainUploads.id, after.id))
            )
      )
    )
    .orderBy(desc(brainUploads.createdAt), desc(brainUploads.id))
    .limit(sharedPageSize + 1);
  // Shown by name only to an admin who may read it: a team's upload is
  // its members' alone, its name too.
  const page = rows.slice(0, sharedPageSize);
  await auditedBatch(env, db, [
    outboxed(db, {
      actor: actorOf(person),
      target: { type: "brain_uploads", id: "shared" },
      action: "brain.upload.listed",
      detail: { count: page.length },
    }),
  ]);
  const last = page.at(-1)?.upload;
  return {
    uploads: page.map(({ upload, teamName, uploaderName }) => ({
      source: uploadSource(upload.id),
      name: mayRead(member, upload) ? upload.name : null,
      readers: readersOf(upload),
      teamName,
      uploaderName,
      uploadedAt: upload.createdAt.toISOString(),
    })),
    next:
      rows.length > sharedPageSize && last !== undefined
        ? { uploadedAt: last.createdAt.toISOString(), id: last.id }
        : null,
  };
};
