import { actorOf } from "@grasp-os/shared/audit";
import {
  brainSourceErrors,
  brainUploadErrors,
} from "@grasp-os/shared/brain-sources";
import type {
  BrainUpload,
  BrainUploadFile,
  BrainUploadReaders,
} from "@grasp-os/shared/brain-sources";
import { isExpectedError } from "@grasp-os/shared/errors";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { log } from "@grasp-os/shared/log";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  uploadErrors,
  uploadExtensionOf,
  uploadMaxBytes,
  uploadNameSchema,
  uploadTypes,
} from "@grasp-os/shared/uploads";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { memberOf } from "./auth/identity.ts";
import type { Member } from "./auth/identity.ts";
import { uploadSource } from "./brain-next-origins.ts";
import { addSource, eraseSource } from "./brain-next.ts";
import type { SourceReaders, SourceVersionRef } from "./brain-next.ts";
import { brainUploads } from "./db/core/schema.ts";
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

const readersSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("me") }),
  z.strictObject({ kind: z.literal("team"), teamId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("everyone") }),
]);

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
  if (row.readers === "team" && row.teamId !== null) {
    return { kind: "team", teamId: row.teamId };
  }
  if (row.readers === "everyone") {
    return { kind: "everyone" };
  }
  return { kind: "me" };
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

const mayDelete = (member: Member, row: UploadRow): boolean =>
  row.uploadedBy === member.userId ||
  (isAdmin(member.role) && row.readers !== "me");

/**
 * The upload `uploadId` for `member`: `brain.upload_not_found` when there
 * is none or they may not read it, alike.
 */
const readableUpload = async (
  env: Env,
  member: Member,
  uploadId: unknown
): Promise<UploadRow> => {
  const id = uploadIdSchema.safeParse(uploadId);
  if (!id.success) {
    throw brainUploadErrors.create("brain.upload_not_found");
  }
  const [row] = await drizzle(env.DB)
    .select()
    .from(brainUploads)
    .where(eq(brainUploads.id, id.data));
  if (row === undefined || !mayRead(member, row)) {
    throw brainUploadErrors.create("brain.upload_not_found");
  }
  return row;
};

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
    // The extractor (files/extract.ts) still says text too large with
    // Knowledge's error code; it is the upload's too large here.
    if (knowledgeErrors.codeOf(error) === "knowledge.too_large") {
      throw uploadErrors.create("upload.too_large", {
        bytes: file.bytes.byteLength,
        maxBytes: uploadMaxBytes,
      });
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
  // each becomes U+FFFD, as a decoder would make it. Its size is the
  // Brain's rule to check (`addSource`), as given and as indexed.
  return `${file.name}\n\n${markdown}`.toWellFormed();
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

/** A hand-over's reason for a refusal, as the contract names it. */
type RefusalReason = "erased" | "invalid" | "too_large";

/**
 * Each of the Brain's refusals of an add, which certainly didn't land:
 * why, as a hand-over is refused, and what the person is told.
 */
const refusals: Readonly<
  Record<
    NonNullable<ReturnType<typeof brainSourceErrors.codeOf>>,
    { reason: RefusalReason; error: () => Error }
  >
> = {
  "brain.source_erased": {
    reason: "erased",
    error: () => brainUploadErrors.create("brain.upload_deleted"),
  },
  "brain.source_no_text": {
    reason: "invalid",
    error: () => uploadErrors.create("upload.no_text"),
  },
  "brain.source_too_large": {
    reason: "too_large",
    error: () =>
      uploadErrors.create("upload.too_large", { maxBytes: uploadMaxBytes }),
  },
};

/** How the Brain refused `error`'s add, or undefined when it isn't sure. */
const refusalOf = (error: unknown) => {
  const code = brainSourceErrors.codeOf(error);
  return code === undefined ? undefined : refusals[code];
};

/**
 * Adds `text` to the Brain as the next version of `row`'s upload, `first`
 * when it is the upload's first, with the one event the upload is audited
 * by, its counts with it, written before the person is answered:
 *
 * - `brain.upload.added`, with its version.
 * - `brain.upload.refused`, with why, as a hand-over is refused
 *   (`erased`, `invalid`, `too_large`), when the Brain refused it: it
 *   certainly didn't land. The row goes with the event when it names
 *   nothing the Brain holds: always for `erased` (the key is closed), and
 *   for a first upload. The person is told why, in their words.
 * - `brain.upload.failed` for any other failure: a call that threw or
 *   whose answer was lost may still have added it, so the row stays,
 *   naming the key for its deletion. A first upload that failed so may
 *   then hold no version: the person can't see it on the page, and it
 *   holds nothing anyone reads; its row names only IDs.
 */
const addVersion = async (
  env: Env,
  person: Identity,
  row: UploadRow,
  file: BrainUploadFile & { type: keyof typeof uploadTypes },
  text: string,
  first: boolean
): Promise<SourceVersionRef> => {
  const db = drizzle(env.DB);
  const event = (action: string, detail: Record<string, unknown>) =>
    outboxed(db, {
      actor: actorOf(person),
      target: { type: "brain_upload", id: row.id },
      action,
      detail: { ...detailOf(row, file), ...detail },
    });
  let added: SourceVersionRef;
  try {
    added = await addSource(env, {
      source: uploadSource(row.id),
      // One change per upload request, minted before its one try.
      change: crypto.randomUUID(),
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
    await (first || refusal.reason === "erased"
      ? auditedBatch(env, db, [
          db.delete(brainUploads).where(eq(brainUploads.id, row.id)),
          refused,
        ])
      : auditedBatch(env, db, [refused]));
    throw refusal.error();
  }
  await auditedBatch(env, db, [
    event("brain.upload.added", { version: added.version }),
  ]);
  return added;
};

/**
 * Uploads `input` into the Brain for `readersInput`, as `person`: a new
 * upload, its first version. Refused before the file is read when the
 * readers aren't theirs to choose, and again after, right before anything
 * is written, should that have changed meanwhile.
 */
export const uploadToBrain = async (
  env: Env,
  person: Identity,
  input: unknown,
  readersInput: unknown
): Promise<SourceVersionRef> => {
  const readers = brainUploadErrors.parse(
    "brain.upload_readers",
    readersSchema,
    readersInput
  );
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
  const row: UploadRow = {
    id: crypto.randomUUID(),
    uploadedBy: person.userId,
    readers: readers.kind,
    teamId: readers.kind === "team" ? readers.teamId : null,
    createdAt: now,
    updatedAt: now,
  };
  // Before the Brain is given anything under its key, so every key it
  // holds is named here for its deletion.
  await drizzle(env.DB).insert(brainUploads).values(row);
  return await addVersion(env, person, row, file, text, true);
};

/**
 * Uploads `input` as the next version of `uploadId`, for its readers, as
 * `person`, who must be its uploader. Its readers are read again after the
 * file is, right before the add.
 */
export const uploadVersionToBrain = async (
  env: Env,
  person: Identity,
  uploadId: unknown,
  input: unknown
): Promise<SourceVersionRef> => {
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
  return await addVersion(env, person, row, file, text, false);
};

/** The upload `uploadId`, as `person` may act on it: null when there is none or they may not read it, alike. */
export const brainUploadOf = async (
  env: Env,
  person: Identity,
  uploadId: unknown
): Promise<BrainUpload | null> => {
  const member = await memberNow(env, person);
  let row: UploadRow;
  try {
    row = await readableUpload(env, member, uploadId);
  } catch (error) {
    if (brainUploadErrors.codeOf(error) === "brain.upload_not_found") {
      return null;
    }
    throw error;
  }
  return {
    source: uploadSource(row.id),
    readers: readersOf(row),
    mayAddVersion: mayAddVersion(member, row),
    mayDelete: mayDelete(member, row),
  };
};

/**
 * Deletes the upload `uploadId` for good, as `person`: its key erased in
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
  const row = await readableUpload(env, member, uploadId);
  if (!mayDelete(member, row)) {
    throw brainUploadErrors.create("brain.upload_not_allowed");
  }
  const db = drizzle(env.DB);
  const actor = actorOf(person);
  const target = { type: "brain_upload", id: row.id };
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
