import { fileLimits } from "@grasp-os/shared/app-file-limits";
import { fileErrors } from "@grasp-os/shared/app-files";
import { auditEventSchema } from "@grasp-os/shared/audit";
import { sha256Hex, sha256HexOfBytes } from "@grasp-os/shared/encoding";
import {
  authErrors,
  internalErrors,
  isExpectedError,
  requestErrors,
} from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin } from "@grasp-os/shared/roles";
import {
  runFileDownloadName,
  runFilesPath,
  runFileTypeSchema,
} from "@grasp-os/shared/run-files";
import type { RunFileListing, RunFileType } from "@grasp-os/shared/run-files";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, asc, eq, not } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
  uuidFromHash,
} from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import { identifyFull } from "../auth/identity.ts";
import {
  workflowResourceRuns,
  workflowRunFileChunks,
  workflowRunFiles,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import { errorResponse } from "../errors.ts";
import { requireWorkflowRole } from "../workflow-resources.ts";
import { detailsRemoved } from "./retention.ts";

// Downloading a run's finished files from its run sheet (GRA-1306). A
// run's files can hold what it read for its person, so they go where its
// result goes. What could go wrong, and what stops it:
//
// - Someone else reading them: the run's person, or one of the
//   organization's admins with a role in the workflow, as for what the run
//   returned (`resourceRunFor`); in a restricted run its person alone, so
//   what a restricted run read never leaves but to them. Grasp staff
//   never. Anyone else, and any file not found by its own ID, its run's
//   and its workflow's together, is told the file isn't there
//   (`file.not_found`), as a missing one is.
// - A file half written, deleted, or kept past its run's details: only a
//   finished file, and none once the run's details are gone, as for
//   every reader of a run (`detailsRemoved`), whether or not
//   the sweep has marked them yet.
// - Access lost partway: core streams the file's chunks from R2 itself,
//   on its own origin, and hands out no address of R2's, so no link
//   outlives a revocation. Before each chunk, the session, who may
//   download and the file's state are decided again, so a lost role,
//   removed details or a deleted file end the stream; each chunk's bytes
//   must match the SHA-256 recorded when they were written; and the whole
//   download ends after `fileLimits.downloadMs`. A file is at most 30
//   chunks, so the checks cost at most 30 times a few indexed reads.
// - Another site: only a request the page itself sends, or a link the
//   person opened themselves (`Sec-Fetch-Site` `same-origin` or `none`),
//   and never read by another site (`Cross-Origin-Resource-Policy`, with
//   the rest of the file headers in security-headers.ts).
// - Running as a page: always an attachment, as the type core checked its
//   bytes to be when written (no run file type is one a browser runs),
//   under `nosniff` and a policy that loads and runs nothing.
// - Who read it: each download is audited (`workflow.file.downloaded`),
//   once a day per person and file, as App files are (app-file-route.ts),
//   with the file's type and size and whether the reader was the run's
//   person or an admin, never its name.

/** The run's row with its receipt's details mark; nothing for another workflow's. */
const runRowOf = async (env: Env, workflowId: string, runId: string) =>
  await drizzle(env.DB)
    .select({
      principalId: workflowResourceRuns.principalId,
      restricted: workflowResourceRuns.restricted,
      endedAt: workflowResourceRuns.endedAt,
      detailsRemovedAt: workflowStartReceipts.detailsRemovedAt,
    })
    .from(workflowResourceRuns)
    .innerJoin(
      workflowStartReceipts,
      eq(workflowStartReceipts.id, workflowResourceRuns.id)
    )
    .where(
      and(
        eq(workflowResourceRuns.id, runId),
        eq(workflowResourceRuns.workflowResourceId, workflowId)
      )
    )
    .get();

/** Whether `by` may download run `run`'s files, as decided for a run they may see. */
interface Decided {
  workflow: string;
  run: string;
  may: boolean;
  /** Whether `by` is the run's person, not an admin reading another's. */
  own: boolean;
}

/**
 * Whether `by` may download run `runId`'s files: undefined when they may
 * not see the run at all.
 */
const mayDownload = async (
  env: Env,
  by: Acting,
  workflowId: unknown,
  runId: unknown
): Promise<Decided | undefined> => {
  if (typeof runId !== "string") {
    return undefined;
  }
  let workflow: string;
  let builder: boolean;
  try {
    const found = await requireWorkflowRole(env, by, workflowId, "user");
    workflow = found.id;
    builder = found.role === "builder";
  } catch (error) {
    if (isExpectedError(error)) {
      return undefined;
    }
    throw error;
  }
  const row = await runRowOf(env, workflow, runId);
  if (row === undefined) {
    return undefined;
  }
  const own = row.principalId === by.userId;
  // Someone else's run, only to its workflow's builders, as
  // `listResourceRuns` shows it.
  if (!own && !builder) {
    return undefined;
  }
  const allowed = !by.staff && (own || (isAdmin(by.role) && !row.restricted));
  return {
    workflow,
    run: runId,
    may: allowed && !detailsRemoved(row),
    own,
  };
};

/**
 * Run `runId` of workflow `id`'s finished files, oldest first, for `by`,
 * who may download them; null for one who may see the run but not its
 * files. Refused as `resourceRunFor` refuses a run they may not see.
 */
export const runFilesFor = async (
  env: Env,
  by: Acting,
  id: unknown,
  runId: unknown
): Promise<RunFileListing[] | null> => {
  const decided = await mayDownload(env, by, id, runId);
  if (decided === undefined) {
    // As `resourceRunFor` answers: the workflow, or the run, isn't theirs.
    await requireWorkflowRole(env, by, id, "user");
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  if (!decided.may) {
    return null;
  }
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowRunFiles)
    .where(
      and(
        eq(workflowRunFiles.runId, decided.run),
        eq(workflowRunFiles.state, "done")
      )
    )
    .orderBy(asc(workflowRunFiles.createdAt), asc(workflowRunFiles.id));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: runFileTypeSchema.parse(row.type),
    size: row.size,
    finishedAt: (row.finishedAt ?? row.createdAt).toISOString(),
  }));
};

/**
 * Finished file `fileId` of run `runId` of workflow `workflowId`, if `by`
 * may download it now; nothing otherwise, whatever the reason.
 */
const downloadable = async (
  env: Env,
  by: Acting,
  workflowId: string,
  runId: string,
  fileId: string
): Promise<
  (typeof workflowRunFiles.$inferSelect & { own: boolean }) | undefined
> => {
  const decided = await mayDownload(env, by, workflowId, runId);
  if (decided?.may !== true) {
    return undefined;
  }
  const row = await drizzle(env.DB)
    .select()
    .from(workflowRunFiles)
    .where(
      and(
        eq(workflowRunFiles.id, fileId),
        eq(workflowRunFiles.runId, decided.run),
        eq(workflowRunFiles.workflowResourceId, decided.workflow),
        eq(workflowRunFiles.state, "done")
      )
    )
    .get();
  return row === undefined ? undefined : { ...row, own: decided.own };
};

/**
 * Records that `reader` downloaded `file`: once a day per person and file
 * (the event's ID is derived from them), as App files are.
 */
const auditDownload = async (
  env: Env,
  reader: string,
  file: typeof workflowRunFiles.$inferSelect & { own: boolean }
): Promise<void> => {
  const action = "workflow.file.downloaded";
  const day = new Date().toISOString().slice(0, 10);
  const event = auditEventSchema.parse({
    id: uuidFromHash(await sha256Hex(`${action}:${file.id}:${reader}:${day}`)),
    // The same event however often that day: one sent again after the
    // first was logged is a duplicate the log drops, never a conflict.
    at: `${day}T00:00:00.000Z`,
    source: "core",
    actor: { type: "person", userId: reader },
    action,
    target: { type: "workflow_resource", id: file.workflowResourceId },
    detail: {
      run: file.runId,
      file: file.id,
      type: file.type,
      size: file.size,
      as: file.own ? "person" : "admin",
      day,
    },
  });
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxedEventWhere(db, event, not(storedEvent(event.id))),
  ]);
};

/**
 * What `read` answers, if it answers before `endsAt`; refused as the file
 * not being there once that passes, whatever it still waits for.
 */
const byDeadline = async <T>(
  endsAt: number,
  read: () => Promise<T>
): Promise<T> => {
  const { promise: late, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => {
      reject(fileErrors.create("file.not_found"));
    },
    Math.max(0, endsAt - Date.now())
  );
  try {
    return await Promise.race([read(), late]);
  } finally {
    clearTimeout(timer);
  }
};

const segment = /^[A-Za-z0-9_-]{1,64}$/u;

/** The workflow, run and file a download path names; undefined for another path. */
export const runFileRouteOf = (
  pathname: string
): { workflow: string; run: string; file: string } | undefined => {
  if (!pathname.startsWith(`${runFilesPath}/`)) {
    return undefined;
  }
  const [workflow, run, file, last, ...rest] = pathname
    .slice(runFilesPath.length + 1)
    .split("/");
  if (
    workflow === undefined ||
    run === undefined ||
    file === undefined ||
    last !== "content" ||
    rest.length > 0 ||
    ![workflow, run, file].every((part) => segment.test(part))
  ) {
    return undefined;
  }
  return { workflow, run, file };
};

/** Whether `request` comes from the page itself, or a link the person opened. */
const fromOwnPage = (request: Request): boolean => {
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
};

/** The `Content-Type` a run file of `type` is sent with. */
const contentTypeOf = (type: RunFileType): string =>
  type.startsWith("text/") || type === "application/json"
    ? `${type}; charset=utf-8`
    : type;

/** What RFC 8187's attr-char leaves out and `encodeURIComponent` doesn't. */
const notAttrChar = /['()*]/gu;

/** `Content-Disposition` for `saved`: an attachment, ASCII first and the name in full after. */
const attachmentOf = (saved: string): string => {
  const fallback = saved.replaceAll(/[^\u0020-\u007E]|["\\]/gu, "_");
  const encoded = encodeURIComponent(saved).replaceAll(
    notAttrChar,
    (character) =>
      `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

/**
 * Answers a download of a run's finished file (`runFileRouteOf`): its
 * bytes as an attachment, streamed chunk by chunk, each only while the
 * reader may still download it.
 */
export const runFileResponse = async (
  request: Request,
  env: Env,
  route: { workflow: string; run: string; file: string },
  requestId: string
): Promise<Response> => {
  if (request.method !== "GET" || !fromOwnPage(request)) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  const person = await identifyFull(env, request.headers);
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  try {
    const file = await downloadable(
      env,
      person,
      route.workflow,
      route.run,
      route.file
    );
    if (file === undefined) {
      throw fileErrors.create("file.not_found");
    }
    const type = runFileTypeSchema.parse(file.type);
    const chunks = await drizzle(env.DB)
      .select()
      .from(workflowRunFileChunks)
      .where(eq(workflowRunFileChunks.fileId, file.id))
      .orderBy(asc(workflowRunFileChunks.index));
    await auditDownload(env, person.userId, file);
    const endsAt = Date.now() + fileLimits.downloadMs;
    let next = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          const chunk = chunks[next];
          if (chunk === undefined) {
            controller.close();
            return;
          }
          next += 1;
          // Decided again before each chunk: the session as it is now, its
          // person's role, the run's details and the file's state.
          const now = await identifyFull(env, request.headers);
          const still =
            now?.userId === person.userId
              ? await downloadable(
                  env,
                  now,
                  route.workflow,
                  route.run,
                  route.file
                )
              : undefined;
          if (still === undefined || Date.now() > endsAt) {
            throw fileErrors.create("file.not_found");
          }
          const bytes = await byDeadline(endsAt, async () => {
            const object = await env.FILES.get(chunk.key);
            return object === null
              ? undefined
              : new Uint8Array(await object.bytes());
          });
          // The bytes written, or none: a chunk changed in R2 ends it.
          if (
            bytes === undefined ||
            bytes.byteLength !== chunk.size ||
            (await sha256HexOfBytes(bytes)) !== chunk.sha256 ||
            Date.now() > endsAt
          ) {
            throw fileErrors.create("file.incomplete");
          }
          controller.enqueue(bytes);
        },
      },
      // Nothing read ahead: each chunk is checked when it is asked for.
      { highWaterMark: 0 }
    );
    return new Response(body, {
      headers: {
        "content-type": contentTypeOf(type),
        "content-disposition": attachmentOf(
          runFileDownloadName(file.name, type)
        ),
        "content-length": String(file.size),
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (isExpectedError(error)) {
      return errorResponse(
        error.code === "file.not_found" ? 404 : 403,
        error,
        requestId
      );
    }
    log.error("run_file.download_failed", { requestId, ...errorFields(error) });
    return errorResponse(
      500,
      internalErrors.create("internal.unexpected"),
      requestId
    );
  }
};
