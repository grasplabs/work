import { fileErrors } from "@grasp-os/shared/app-files";
import { sha256HexOfBytes, toBase64, toHex } from "@grasp-os/shared/encoding";
import type { Json } from "@grasp-os/shared/json";
import {
  runFileErrors,
  runFileIdSchema,
  runFileLimits,
  runFileNameSchema,
  runFileTextTypes,
  runFileTypeOfBytes,
  runFileTypeSchema,
} from "@grasp-os/shared/run-files";
import type { RunFileRef, RunFileType } from "@grasp-os/shared/run-files";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  like,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { workflowRunFileChunks, workflowRunFiles } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";

// A workflow run's own files (GRA-724): what its actions write through a
// `files` binding and read back in later steps of the same run, each call
// one of the run's named calls (resource-calls.ts, `makeCall`), with its
// authority decided again and its receipts kept. Threat model, written
// before code on GRA-724, and how each is closed:
//
// - A file read, listed or deleted by another run, workflow, App or
//   person: every lookup is by the file's ID *and* the calling run's,
//   and anything else answers `file.not_found`, as a file that isn't
//   there does. A file's ID is a random UUID; holding one grants nothing
//   outside its run. Nothing serves a run file outside its run's actions:
//   no route, no RPC, no download.
// - Data leaving through a file: it has no way out but the run's own
//   bindings, each approved and decided again on every call; a restricted
//   run's actions still make no connector call (resource-calls.ts). A
//   file is its run's alone, and a run's restricted mode is fixed at its
//   start, so data a restricted run read and wrote to a file stays there.
// - Two writers of one file, or a write mixed into another task's: only
//   the task whose step opened a file adds to or finishes it
//   (`openedBy`); every other caller is refused (`file.not_writable`).
// - A replay or retry writing twice: the effect key of each call
//   (`<step key>:<ordinal>`) makes opening, adding and finishing again
//   answer what the first did. A chunk reserved but not stored (its put
//   failed, or the attempt died) is stored by the same append again, or
//   swept with its file.
// - A file outliving its run's retention: its run's details going marks
//   it deleted in the same batch (retention.ts), and `sweepRunFiles`
//   deletes its chunks, then its row, retrying what R2 refused on the
//   next cron run. A file never finished is swept a day after it opened.
//   A deleted file's chunks are swept only after `sweepGraceMs`, longer
//   than any attempt, so an append under way finishes its put first; a
//   put that still lands after its chunk went deletes its object again
//   (`store`), so no object outlives every record.
// - A stale attempt writing: every call, and every put, first checks the
//   attempt still holds its lease (`requireHolds`).
// - Bytes that aren't what their type says: finishing checks the type
//   against the bytes (a binary type by its signature, a text type as
//   UTF-8 with no NUL and no signature) and the whole file's SHA-256; a
//   file that fails is deleted. Core parses nothing else of a file, and
//   serves none.
// - Size and cost: each limit (`runFileLimits`) is checked in the same
//   statement that reserves a chunk, before its bytes reach R2, so two
//   calls at once can't both take the last of a limit. One call moves at
//   most `callBytes`, within the step payload and the attempt's 32 calls.
// - The audit log, kept longer than a run's details, holding a file's
//   name: receipts carry the file's ID, type, size and SHA-256, never its
//   name or content. A tiny file's SHA-256 can be guessed from a short
//   list of likely contents, so a receipt's digest says as much of such a
//   file as its content would; the audit log is read by admins only.
// - Typing by signature only: a binary type's bytes are checked by their
//   first bytes alone. Nothing serves a run file yet; before downloads
//   (phase 2) serve one, check this again (a polyglot file passes).

/** What each call of a files use asks for, as the action's use declares it. */
export const filesCallOperations = {
  open: "write",
  append: "write",
  finish: "write",
  read: "read",
  list: "list",
  delete: "delete",
} as const;
export type FilesCallOperation = keyof typeof filesCallOperations;

/** Base64 characters `callBytes` take at most. */
const contentChars = Math.ceil(runFileLimits.callBytes / 3) * 4;

const argumentSchemas = {
  open: z.strictObject({ name: runFileNameSchema, type: runFileTypeSchema }),
  append: z.strictObject({
    file: runFileIdSchema,
    content: z.base64().min(1).max(contentChars),
  }),
  finish: z.strictObject({ file: runFileIdSchema }),
  read: z.strictObject({
    file: runFileIdSchema,
    offset: z.int().min(0),
    length: z.int().min(1).max(runFileLimits.callBytes),
  }),
  list: z.strictObject({}),
  delete: z.strictObject({ file: runFileIdSchema }),
} as const;

/** The run a files call is made for, and the effect it is. */
export interface FilesCaller {
  readonly runId: string;
  readonly workflowId: string;
  /** The call's effect key: `<step key>:<ordinal>` for an action's. */
  readonly effectKey: string;
  /** Throws unless the call's attempt still holds its lease. */
  readonly requireHolds: () => void;
}

/** What a files call answers, and what its receipt says of the file. */
export interface FilesAnswer {
  readonly output: Json;
  readonly detail: Readonly<Record<string, string | number>>;
}

/** The bytes `text`, standard base64 the schema checked, holds. */
const bytesOfBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.codePointAt(at) ?? 0;
  }
  return bytes;
};

/** The step an effect key is of: its key without the call's ordinal. */
const stepOf = (effectKey: string): string =>
  effectKey.slice(0, Math.max(0, effectKey.lastIndexOf(":")));

const notFound = () => fileErrors.create("file.not_found");

type FileRow = typeof workflowRunFiles.$inferSelect;

/** A finished file, as its run's actions hand it on. */
const refOf = (row: FileRow): RunFileRef => ({
  file: row.id,
  name: row.name,
  type: runFileTypeSchema.parse(row.type),
  size: row.size,
  sha256: row.sha256 ?? "",
});

const refJson = (row: FileRow): Json => ({ ...refOf(row) });

/** What a receipt says of `row`: never its name. */
const detailOf = (row: FileRow): Record<string, string | number> => ({
  file: row.id,
  type: row.type,
  size: row.size,
  ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
});

/**
 * File `id` of `caller`'s run, unless deleted (`withDeleted` includes
 * those not yet swept); nothing for any other.
 */
const fileOf = async (
  env: Env,
  caller: FilesCaller,
  id: string,
  withDeleted = false
): Promise<FileRow | undefined> => {
  const row = await drizzle(env.DB)
    .select()
    .from(workflowRunFiles)
    .where(
      and(
        eq(workflowRunFiles.id, id),
        eq(workflowRunFiles.runId, caller.runId),
        withDeleted ? undefined : ne(workflowRunFiles.state, "deleted")
      )
    )
    .get();
  return row ?? undefined;
};

/** Refuses `row` unless `caller`'s task opened it and still writes it. */
const requireWriter = (row: FileRow, caller: FilesCaller): void => {
  if (row.state !== "writing" || row.openedBy !== stepOf(caller.effectKey)) {
    throw runFileErrors.create("file.not_writable");
  }
};

/** Opens a file of the run for the calling task to write. */
const open = async (
  env: Env,
  caller: FilesCaller,
  args: z.infer<typeof argumentSchemas.open>
): Promise<FilesAnswer> => {
  const db = drizzle(env.DB);
  const opened = async () =>
    await db
      .select()
      .from(workflowRunFiles)
      .where(eq(workflowRunFiles.openKey, caller.effectKey))
      .get();
  const id = crypto.randomUUID();
  // The run's limits checked as the row goes in, so two opens at once
  // can't both take the last place; opening again with the same effect
  // key inserts nothing and answers the file it opened.
  const inserted = await env.DB.prepare(
    `INSERT INTO workflow_run_files
      (id, run_id, workflow_resource_id, opened_by, open_key, name, type, size, state, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 'writing', ?8
    WHERE (SELECT count(*) FROM workflow_run_files
        WHERE run_id = ?2 AND state <> 'deleted') < ?9
      AND (SELECT count(*) FROM workflow_run_files
        WHERE run_id = ?2 AND state = 'writing') < ?10
    ON CONFLICT(open_key) DO NOTHING`
  )
    .bind(
      id,
      caller.runId,
      caller.workflowId,
      stepOf(caller.effectKey),
      caller.effectKey,
      args.name,
      args.type,
      Date.now(),
      runFileLimits.runFiles,
      runFileLimits.openWrites
    )
    .run();
  const row = await opened();
  if (row !== undefined && row.runId === caller.runId) {
    // The same open again must ask for the same file.
    if (row.name !== args.name || row.type !== args.type) {
      throw workflowResourceErrors.create("workflow.call_invalid");
    }
    return { output: { file: row.id }, detail: detailOf(row) };
  }
  if (inserted.meta.changes > 0 || row !== undefined) {
    throw notFound();
  }
  const writing = await env.DB.prepare(
    "SELECT count(*) AS count FROM workflow_run_files WHERE run_id = ? AND state = 'writing'"
  )
    .bind(caller.runId)
    .first<{ count: number }>();
  throw (writing?.count ?? 0) >= runFileLimits.openWrites
    ? runFileErrors.create("file.writes_open")
    : runFileErrors.create("file.run_full");
};

/** Why reserving `bytes` more for `row` was refused: the limit it passes. */
const limitPassed = async (
  env: Env,
  caller: FilesCaller,
  row: FileRow,
  bytes: number
): Promise<Error> => {
  if (row.size + bytes > runFileLimits.fileBytes) {
    return runFileErrors.create("file.run_too_large");
  }
  const run = await env.DB.prepare(
    "SELECT coalesce(sum(size), 0) AS bytes FROM workflow_run_files WHERE run_id = ? AND state <> 'deleted'"
  )
    .bind(caller.runId)
    .first<{ bytes: number }>();
  if ((run?.bytes ?? 0) + bytes > runFileLimits.runBytes) {
    return runFileErrors.create("file.run_full");
  }
  return runFileErrors.create("file.workflow_quota");
};

/**
 * Stores a reserved chunk's bytes, once its reservation is kept, while
 * the attempt still holds. A chunk is marked stored only while its file
 * isn't deleted: one deleted while its put was under way (and maybe
 * swept, its object deleted before the put landed) has its object
 * deleted again, so no object outlives its record.
 */
const store = async (
  env: Env,
  caller: FilesCaller,
  key: string,
  bytes: Uint8Array,
  sha256: string
): Promise<void> => {
  caller.requireHolds();
  await env.FILES.put(key, bytes, { sha256 });
  const kept = await drizzle(env.DB)
    .update(workflowRunFileChunks)
    .set({ stored: true })
    .where(
      and(
        eq(workflowRunFileChunks.key, key),
        sql`(SELECT ${workflowRunFiles.state} FROM ${workflowRunFiles}
          WHERE ${workflowRunFiles.id} = ${workflowRunFileChunks.fileId}) <> 'deleted'`
      )
    )
    .run();
  if (kept.meta.changes === 0) {
    await env.FILES.delete(key);
    throw notFound();
  }
};

/**
 * The same append again (its effect key's): stored once, under the chunk
 * it reserved, whatever came of the first; its bytes must be the same.
 */
const appendedAgain = async (
  env: Env,
  caller: FilesCaller,
  row: FileRow,
  chunk: typeof workflowRunFileChunks.$inferSelect,
  bytes: Uint8Array,
  sha256: string
): Promise<FilesAnswer> => {
  if (chunk.fileId !== row.id || chunk.sha256 !== sha256) {
    throw workflowResourceErrors.create("workflow.call_invalid");
  }
  // Deleted since, as the same attempt's later call may have: what the
  // append answered stands, and none of its bytes are stored again.
  if (row.state === "deleted") {
    return {
      output: { size: row.size },
      detail: { ...detailOf(row), size: row.size },
    };
  }
  if (!chunk.stored) {
    await store(env, caller, chunk.key, bytes, sha256);
  }
  const now = await drizzle(env.DB)
    .select({ size: workflowRunFiles.size })
    .from(workflowRunFiles)
    .where(eq(workflowRunFiles.id, row.id))
    .get();
  return {
    output: { size: now?.size ?? row.size },
    detail: { ...detailOf(row), size: now?.size ?? row.size },
  };
};

/** Adds up to `callBytes` to a file the calling task writes. */
const append = async (
  env: Env,
  caller: FilesCaller,
  args: z.infer<typeof argumentSchemas.append>
): Promise<FilesAnswer> => {
  const bytes = bytesOfBase64(args.content);
  if (bytes.length === 0 || bytes.length > runFileLimits.callBytes) {
    throw workflowResourceErrors.create("workflow.call_invalid");
  }
  const db = drizzle(env.DB);
  const earlier = await db
    .select()
    .from(workflowRunFileChunks)
    .where(eq(workflowRunFileChunks.appendKey, caller.effectKey))
    .get();
  // A deleted file is found only by the append that already went in.
  const row = await fileOf(env, caller, args.file, earlier !== undefined);
  if (row === undefined) {
    throw notFound();
  }
  const sha256 = await sha256HexOfBytes(bytes);
  // The same append again answers what the first did, even once its file
  // is finished or deleted: its effect key is its own task's, so no other
  // writes so.
  if (earlier !== undefined) {
    return await appendedAgain(env, caller, row, earlier, bytes, sha256);
  }
  requireWriter(row, caller);
  const key = `run-files/${caller.runId}/${row.id}/${crypto.randomUUID()}`;
  // Reserved against every limit in the statement that adds it, before
  // its bytes reach R2; the file's size follows in the same batch.
  const [reserved] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workflow_run_file_chunks
        (file_id, "index", key, append_key, size, sha256, stored)
      SELECT ?1,
        (SELECT coalesce(max("index") + 1, 0) FROM workflow_run_file_chunks WHERE file_id = ?1),
        ?2, ?3, ?4, ?5, 0
      WHERE (SELECT state FROM workflow_run_files WHERE id = ?1) = 'writing'
        AND (SELECT size FROM workflow_run_files WHERE id = ?1) + ?4 <= ?6
        AND (SELECT coalesce(sum(size), 0) FROM workflow_run_files
          WHERE run_id = ?7 AND state <> 'deleted') + ?4 <= ?8
        AND (SELECT coalesce(sum(size), 0) FROM workflow_run_files
          WHERE workflow_resource_id = ?9) + ?4 <= ?10
      ON CONFLICT(append_key) DO NOTHING`
    ).bind(
      row.id,
      key,
      caller.effectKey,
      bytes.length,
      sha256,
      runFileLimits.fileBytes,
      caller.runId,
      runFileLimits.runBytes,
      caller.workflowId,
      runFileLimits.workflowBytes
    ),
    env.DB.prepare(
      "UPDATE workflow_run_files SET size = size + ?1 WHERE id = ?2 AND changes() > 0"
    ).bind(bytes.length, row.id),
  ]);
  if ((reserved?.meta.changes ?? 0) === 0) {
    const raced = await db
      .select()
      .from(workflowRunFileChunks)
      .where(eq(workflowRunFileChunks.appendKey, caller.effectKey))
      .get();
    if (raced === undefined) {
      throw await limitPassed(env, caller, row, bytes.length);
    }
    // The same append, made at once by another of the attempt's calls:
    // stored once, under the chunk it reserved.
    return await appendedAgain(env, caller, row, raced, bytes, sha256);
  }
  await store(env, caller, key, bytes, sha256);
  return {
    output: { size: row.size + bytes.length },
    detail: { ...detailOf(row), size: row.size + bytes.length },
  };
};

/** The bytes a text file's must be: UTF-8 with no NUL. */
const textOf = (decoder: TextDecoder, bytes: Uint8Array): boolean => {
  try {
    return !decoder.decode(bytes, { stream: true }).includes("\0");
  } catch {
    return false;
  }
};

/**
 * What finishing `row` answers when it needs no finishing: one finished,
 * then perhaps deleted (as the same attempt's later call may have), is
 * answered as finished; one deleted unfinished is gone. Nothing for one
 * still being written.
 */
const finishedBefore = (row: FileRow): FilesAnswer | undefined => {
  if (
    row.state === "done" ||
    (row.state === "deleted" && row.sha256 !== null)
  ) {
    return { output: refJson(row), detail: detailOf(row) };
  }
  if (row.state === "deleted") {
    throw notFound();
  }
  return undefined;
};

/**
 * Finishes a file the calling task wrote: its bytes checked against its
 * type and hashed, all of them, as stored.
 */
const finish = async (
  env: Env,
  caller: FilesCaller,
  args: z.infer<typeof argumentSchemas.finish>
): Promise<FilesAnswer> => {
  const db = drizzle(env.DB);
  const row = await fileOf(env, caller, args.file, true);
  if (row === undefined) {
    throw notFound();
  }
  const before = finishedBefore(row);
  if (before !== undefined) {
    return before;
  }
  requireWriter(row, caller);
  const chunks = await db
    .select()
    .from(workflowRunFileChunks)
    .where(eq(workflowRunFileChunks.fileId, row.id))
    .orderBy(asc(workflowRunFileChunks.index));
  if (chunks.some((chunk, at) => !chunk.stored || chunk.index !== at)) {
    throw fileErrors.create("file.incomplete");
  }
  const type: RunFileType = runFileTypeSchema.parse(row.type);
  const text = runFileTextTypes.has(type);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  const head = new Uint8Array(16);
  let headLength = 0;
  let readable = true;
  let size = 0;
  for (const chunk of chunks) {
    // oxlint-disable-next-line no-await-in-loop -- in order: the hash is of the bytes as they follow
    const object = await env.FILES.get(chunk.key);
    if (object === null) {
      throw fileErrors.create("file.incomplete");
    }
    // oxlint-disable-next-line no-await-in-loop -- in order, as above
    const bytes = new Uint8Array(await object.arrayBuffer());
    // oxlint-disable-next-line no-await-in-loop -- in order, as above
    await writer.write(bytes);
    size += bytes.length;
    if (headLength < head.length) {
      const taken = bytes.subarray(0, head.length - headLength);
      head.set(taken, headLength);
      headLength += taken.length;
    }
    readable &&= !text || textOf(decoder, bytes);
  }
  await writer.close();
  const sha256 = toHex(new Uint8Array(await digest.digest));
  if (text && readable) {
    try {
      decoder.decode();
    } catch {
      readable = false;
    }
  }
  const shown =
    readable &&
    size === row.size &&
    (text || size > 0) &&
    runFileTypeOfBytes(head.subarray(0, headLength), type);
  const now = new Date();
  if (!shown) {
    // Not what it says it is: gone, so it holds no place in the limits.
    await db
      .update(workflowRunFiles)
      .set({ state: "deleted", deletedAt: now })
      .where(
        and(
          eq(workflowRunFiles.id, row.id),
          eq(workflowRunFiles.state, "writing")
        )
      );
    throw fileErrors.create("file.content_mismatch");
  }
  // Only the file as hashed: no append can have grown it since.
  const finished = await db
    .update(workflowRunFiles)
    .set({ state: "done", sha256, finishedAt: now })
    .where(
      and(
        eq(workflowRunFiles.id, row.id),
        eq(workflowRunFiles.state, "writing"),
        eq(workflowRunFiles.size, row.size)
      )
    )
    .run();
  if (finished.meta.changes === 0) {
    const current = await fileOf(env, caller, row.id);
    if (current?.state === "done") {
      return { output: refJson(current), detail: detailOf(current) };
    }
    throw fileErrors.create("file.incomplete");
  }
  const done = { ...row, state: "done" as const, sha256, finishedAt: now };
  return { output: refJson(done), detail: detailOf(done) };
};

/** Up to `length` bytes of a finished file of the run, from `offset`. */
const read = async (
  env: Env,
  caller: FilesCaller,
  args: z.infer<typeof argumentSchemas.read>
): Promise<FilesAnswer> => {
  const row = await fileOf(env, caller, args.file);
  if (row === undefined) {
    throw notFound();
  }
  if (row.state !== "done") {
    throw runFileErrors.create("file.not_finished");
  }
  const end = Math.min(row.size, args.offset + args.length);
  const chunks = await drizzle(env.DB)
    .select()
    .from(workflowRunFileChunks)
    .where(eq(workflowRunFileChunks.fileId, row.id))
    .orderBy(asc(workflowRunFileChunks.index));
  const bytes = new Uint8Array(Math.max(0, end - args.offset));
  let at = 0;
  let start = 0;
  for (const chunk of chunks) {
    const from = Math.max(args.offset, start);
    const to = Math.min(end, start + chunk.size);
    if (from < to) {
      // oxlint-disable-next-line no-await-in-loop -- in order: each part follows the last
      const object = await env.FILES.get(chunk.key, {
        range: { offset: from - start, length: to - from },
      });
      if (object === null) {
        throw fileErrors.create("file.incomplete");
      }
      // oxlint-disable-next-line no-await-in-loop -- in order, as above
      bytes.set(new Uint8Array(await object.arrayBuffer()), at);
      at += to - from;
    }
    start += chunk.size;
  }
  return {
    output: { content: toBase64(bytes), size: row.size },
    detail: detailOf(row),
  };
};

/** The run's finished files, oldest first. */
const list = async (env: Env, caller: FilesCaller): Promise<FilesAnswer> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowRunFiles)
    .where(
      and(
        eq(workflowRunFiles.runId, caller.runId),
        eq(workflowRunFiles.state, "done")
      )
    )
    .orderBy(asc(workflowRunFiles.createdAt), asc(workflowRunFiles.id));
  return { output: rows.map((row) => refJson(row)), detail: {} };
};

/** Deletes a file of the run: its chunks go with the next sweep. */
const remove = async (
  env: Env,
  caller: FilesCaller,
  args: z.infer<typeof argumentSchemas.delete>
): Promise<FilesAnswer> => {
  const row = await fileOf(env, caller, args.file, true);
  if (row === undefined) {
    throw notFound();
  }
  // Deleted already, by this call's first attempt or another: done.
  if (row.state === "deleted") {
    return { output: null, detail: detailOf(row) };
  }
  await drizzle(env.DB)
    .update(workflowRunFiles)
    .set({ state: "deleted", deletedAt: new Date() })
    .where(
      and(
        eq(workflowRunFiles.id, row.id),
        eq(workflowRunFiles.runId, caller.runId)
      )
    );
  return { output: null, detail: detailOf(row) };
};

/** `args` as `schema` has them, or the call refused as invalid. */
const parsed = <Schema extends z.ZodType>(
  schema: Schema,
  args: Json
): z.output<Schema> => {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw workflowResourceErrors.create("workflow.call_invalid");
  }
  return result.data;
};

/**
 * Makes one call of a files use for `caller`'s run: `operation`, with
 * `args` checked here, as the host's own contract has them. The action
 * host has already checked the use declares the operation it needs.
 */
/**
 * Refuses a files call whose arguments a real call would refuse
 * (`workflow.call_invalid`), touching nothing: for a test run, which
 * answers the call from its fixture and keeps no file.
 */
export const requireFilesArguments = (
  operation: FilesCallOperation,
  args: Json
): void => {
  const checked = parsed(argumentSchemas[operation], args);
  if (operation === "append" && "content" in checked) {
    const size = bytesOfBase64(checked.content).length;
    if (size === 0 || size > runFileLimits.callBytes) {
      throw workflowResourceErrors.create("workflow.call_invalid");
    }
  }
};

export const callFiles = async (
  env: Env,
  caller: FilesCaller,
  operation: FilesCallOperation,
  args: Json
): Promise<FilesAnswer> => {
  caller.requireHolds();
  switch (operation) {
    case "open": {
      return await open(env, caller, parsed(argumentSchemas.open, args));
    }
    case "append": {
      return await append(env, caller, parsed(argumentSchemas.append, args));
    }
    case "finish": {
      return await finish(env, caller, parsed(argumentSchemas.finish, args));
    }
    case "read": {
      return await read(env, caller, parsed(argumentSchemas.read, args));
    }
    case "list": {
      parsed(argumentSchemas.list, args);
      return await list(env, caller);
    }
    case "delete": {
      return await remove(env, caller, parsed(argumentSchemas.delete, args));
    }
    default: {
      return operation satisfies never;
    }
  }
};

/** Most chunks one sweep deletes at a time: R2's bound for one delete. */
const chunksPerDelete = 1000;
/** Most deletes one sweep makes, so a cron run stays bounded. */
const deletesPerSweep = 10;
/**
 * How long a deleted file's chunks stay before the sweep takes them:
 * longer than any attempt, so an append that reserved a chunk before the
 * delete has put its bytes by then.
 */
export const sweepGraceMs = 60 * 60_000;

/**
 * A file a start hands its run (GRA-885): an App's file, as its store
 * recorded it, read by its recorded chunks only.
 */
export interface RunFileSource {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  /** Its recorded chunks, in order: each one's R2 key and SHA-256. */
  readonly chunks: readonly { readonly key: string; readonly sha256: string }[];
}

/** Who opened a start's copies into run `runId`: no task's step key. */
const startOpener = (runId: string): string => `start:${runId}`;

/** Why copying `size` bytes more into run `runId` was refused. */
const startLimitPassed = async (
  env: Env,
  runId: string,
  size: number
): Promise<Error> => {
  const run = await env.DB.prepare(
    "SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes FROM workflow_run_files WHERE run_id = ? AND state <> 'deleted'"
  )
    .bind(runId)
    .first<{ files: number; bytes: number }>();
  return (run?.files ?? 0) >= runFileLimits.runFiles ||
    (run?.bytes ?? 0) + size > runFileLimits.runBytes
    ? runFileErrors.create("file.run_full")
    : runFileErrors.create("file.workflow_quota");
};

/**
 * Copies `source` into run `runId`'s files, as file `slot` of its start,
 * before the start is admitted: its bytes read chunk by chunk, each
 * against its recorded SHA-256, written to the run's own objects, then
 * checked as a finish checks a file (its size, its type by its bytes, its
 * SHA-256 over what was copied). Its row stays `writing`, opened by the
 * start, so no action can write to it and nothing reads it, until the
 * admitting batch marks it done (`startFilesAdmitted`); a start never
 * admitted leaves it to be dropped (`startFilesDropped`) or swept. Every
 * limit is checked as its row goes in, its whole size reserved at once.
 * Its ID, once copied.
 */
export const copyIntoRun = async (
  env: Env,
  target: { readonly runId: string; readonly workflowId: string },
  slot: number,
  source: RunFileSource
): Promise<string> => {
  const type = runFileTypeSchema.safeParse(source.type);
  const name = runFileNameSchema.safeParse(source.name);
  if (!type.success) {
    throw runFileErrors.create("file.run_type_unsupported");
  }
  if (!name.success) {
    throw workflowResourceErrors.create("workflow.call_invalid");
  }
  if (source.size > runFileLimits.fileBytes) {
    throw runFileErrors.create("file.run_too_large");
  }
  const id = crypto.randomUUID();
  const reserved = await env.DB.prepare(
    `INSERT INTO workflow_run_files
      (id, run_id, workflow_resource_id, opened_by, open_key, name, type, size, state, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'writing', ?9
    WHERE (SELECT count(*) FROM workflow_run_files
        WHERE run_id = ?2 AND state <> 'deleted') < ?10
      AND (SELECT coalesce(sum(size), 0) FROM workflow_run_files
        WHERE run_id = ?2 AND state <> 'deleted') + ?8 <= ?11
      AND (SELECT coalesce(sum(size), 0) FROM workflow_run_files
        WHERE workflow_resource_id = ?3 AND state <> 'deleted') + ?8 <= ?12`
  )
    .bind(
      id,
      target.runId,
      target.workflowId,
      startOpener(target.runId),
      `${startOpener(target.runId)}:${slot}`,
      name.data,
      type.data,
      source.size,
      Date.now(),
      runFileLimits.runFiles,
      runFileLimits.runBytes,
      runFileLimits.workflowBytes
    )
    .run();
  if (reserved.meta.changes === 0) {
    throw await startLimitPassed(env, target.runId, source.size);
  }
  const db = drizzle(env.DB);
  const gone = async (error: Error): Promise<never> => {
    await db
      .update(workflowRunFiles)
      .set({ state: "deleted", deletedAt: new Date() })
      .where(eq(workflowRunFiles.id, id));
    throw error;
  };
  const text = runFileTextTypes.has(type.data);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  const head = new Uint8Array(16);
  let headLength = 0;
  let readable = true;
  let size = 0;
  for (const [index, chunk] of source.chunks.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- in order: the hash is of the bytes as they follow
    const object = await env.FILES.get(chunk.key);
    // oxlint-disable-next-line no-await-in-loop -- in order, as above
    const bytes = object === null ? null : await object.bytes();
    if (
      bytes === null ||
      // oxlint-disable-next-line no-await-in-loop -- in order, as above
      (await sha256HexOfBytes(bytes)) !== chunk.sha256
    ) {
      // oxlint-disable-next-line no-await-in-loop -- ends the copy
      return await gone(fileErrors.create("file.not_found"));
    }
    const key = `run-files/${target.runId}/${id}/${crypto.randomUUID()}`;
    // Recorded before its object is put, so the sweep finds every object
    // a dropped copy wrote.
    // oxlint-disable-next-line no-await-in-loop -- in order, as above
    await db.insert(workflowRunFileChunks).values({
      fileId: id,
      index,
      key,
      appendKey: `${startOpener(target.runId)}:${slot}:${index}`,
      size: bytes.length,
      sha256: chunk.sha256,
      stored: false,
    });
    // oxlint-disable-next-line no-await-in-loop -- in order, as above
    await env.FILES.put(key, bytes, { sha256: chunk.sha256 });
    // oxlint-disable-next-line no-await-in-loop -- in order, as above
    await db
      .update(workflowRunFileChunks)
      .set({ stored: true })
      .where(eq(workflowRunFileChunks.key, key));
    // oxlint-disable-next-line no-await-in-loop -- in order, as above
    await writer.write(bytes);
    size += bytes.length;
    if (headLength < head.length) {
      const taken = bytes.subarray(0, head.length - headLength);
      head.set(taken, headLength);
      headLength += taken.length;
    }
    readable &&= !text || textOf(decoder, bytes);
  }
  await writer.close();
  const sha256 = toHex(new Uint8Array(await digest.digest));
  if (text && readable) {
    try {
      decoder.decode();
    } catch {
      readable = false;
    }
  }
  const shown =
    readable &&
    size === source.size &&
    (text || size > 0) &&
    runFileTypeOfBytes(head.subarray(0, headLength), type.data);
  if (!shown) {
    return await gone(fileErrors.create("file.content_mismatch"));
  }
  await db
    .update(workflowRunFiles)
    .set({ sha256 })
    .where(eq(workflowRunFiles.id, id));
  return id;
};

/**
 * Marks the files run `runId`'s start copied done, in the batch that
 * admits it, only once `admitted` (its receipt written) holds: until
 * then they are no file of a run.
 */
export const startFilesAdmitted = (
  db: ReturnType<typeof drizzle>,
  runId: string,
  admitted: SQL
) =>
  db
    .update(workflowRunFiles)
    .set({ state: "done", finishedAt: new Date() })
    .where(
      and(
        eq(workflowRunFiles.runId, runId),
        eq(workflowRunFiles.openedBy, startOpener(runId)),
        eq(workflowRunFiles.state, "writing"),
        isNotNull(workflowRunFiles.sha256),
        admitted
      )
    );

/**
 * Drops the files a start copied for run `runId` that it never admitted:
 * deleted, so the sweep takes their chunks.
 */
export const startFilesDropped = async (
  env: Env,
  runId: string
): Promise<void> => {
  await drizzle(env.DB)
    .update(workflowRunFiles)
    .set({ state: "deleted", deletedAt: new Date() })
    .where(
      and(
        eq(workflowRunFiles.runId, runId),
        eq(workflowRunFiles.openedBy, startOpener(runId)),
        eq(workflowRunFiles.state, "writing")
      )
    );
};

/**
 * Marks files of the runs `runIds` deleted: their run's details went
 * (retention.ts), so they go too, in the same batch.
 */
export const runFilesRemoved = (db: ReturnType<typeof drizzle>, runIds: SQL) =>
  db
    .update(workflowRunFiles)
    // Stamped by the clock, never a late cron's scheduled time, so the
    // grace counts from when the file really went.
    .set({ state: "deleted", deletedAt: new Date() })
    .where(
      and(
        inArray(workflowRunFiles.runId, runIds),
        ne(workflowRunFiles.state, "deleted")
      )
    );

/**
 * Sweeps run files: those never finished a day after they opened are
 * deleted, and the chunks of files deleted longer ago than
 * `sweepGraceMs` go from R2, then their rows. What
 * R2 refuses stays, for the next cron run to try again. `now` is the
 * clock as the sweep runs, never the cron's scheduled time, which a late
 * run would make shorten the grace.
 */
export const sweepRunFiles = async (
  env: Env,
  now: Date = new Date()
): Promise<void> => {
  const db = drizzle(env.DB);
  await db
    .update(workflowRunFiles)
    .set({ state: "deleted", deletedAt: now })
    .where(
      and(
        eq(workflowRunFiles.state, "writing"),
        or(
          lt(
            workflowRunFiles.createdAt,
            new Date(now.getTime() - runFileLimits.orphanMs)
          ),
          // A start's copy never admitted: no task will finish it.
          and(
            like(workflowRunFiles.openedBy, "start:%"),
            lt(
              workflowRunFiles.createdAt,
              new Date(now.getTime() - runFileLimits.startOrphanMs)
            )
          )
        )
      )
    );
  const graceEnded = new Date(now.getTime() - sweepGraceMs);
  const due = and(
    eq(workflowRunFiles.state, "deleted"),
    lt(workflowRunFiles.deletedAt, graceEnded)
  );
  for (let round = 0; round < deletesPerSweep; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded delete after another
    const chunks = await db
      .select({ key: workflowRunFileChunks.key })
      .from(workflowRunFileChunks)
      .innerJoin(
        workflowRunFiles,
        eq(workflowRunFiles.id, workflowRunFileChunks.fileId)
      )
      .where(due)
      .limit(chunksPerDelete);
    if (chunks.length === 0) {
      break;
    }
    const keys = chunks.map(({ key }) => key);
    // oxlint-disable-next-line no-await-in-loop -- one bounded delete after another
    await env.FILES.delete(keys);
    // oxlint-disable-next-line no-await-in-loop -- one bounded delete after another
    await db
      .delete(workflowRunFileChunks)
      // As one bound list: D1 binds at most 100 values to a statement.
      .where(inList(workflowRunFileChunks.key, keys));
  }
  await db.delete(workflowRunFiles).where(
    and(
      due,
      sql`NOT EXISTS (SELECT 1 FROM workflow_run_file_chunks AS chunk
          WHERE chunk.file_id = ${workflowRunFiles.id})`
    )
  );
};
