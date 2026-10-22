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
import type { RunFileListing } from "@grasp-os/shared/run-files";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, asc, eq, not } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  attachmentContentType,
  attachmentDisposition,
} from "../attachment-headers.ts";
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

// Downloading a run's finished files from its run page (GRA-888, phase 2
// of GRA-844 decision 2b). The threat note is on GRA-888; how each part
// of it is closed:
//
// - Who: the run's person, or an admin of the organization with a role in
//   the workflow, as for what the run returned (`resourceRunFor`); in a
//   restricted run, its person alone, so data a restricted run read never
//   leaves but to them. Grasp staff never. Anyone else, and any file not
//   found by its own ID, its run's and its workflow's together, is told
//   the file isn't there (`file.not_found`), as a missing one is.
// - What: a finished file only, never one being written or deleted, and
//   none once the run's details are gone, at the deployment's retention
//   as it is now (`detailsRemoved`), whether or not the sweep marked it.
// - Delivery: core streams the file's chunks from R2 itself, on its own
//   origin; no signed or public address of R2's is ever handed out, so no
//   link outlives a revocation. Before each chunk, who may download and
//   the file's state are decided again, so a lost role, a removed run's
//   details or a deleted file ends the stream; each chunk's bytes are
//   checked against the SHA-256 recorded when they were written; and the
//   whole download ends after `fileLimits.downloadMs`.
// - Another site: only a request the page itself sends, or a link the
//   person opened themselves (`Sec-Fetch-Site` `same-origin` or `none`),
//   and never read by another site (`Cross-Origin-Resource-Policy`, set
//   with the rest of the file headers in security-headers.ts).
// - Running as a page: always an attachment, with the type core checked
//   the bytes as (none of the run file types is one a browser runs: no
//   HTML, SVG or script), `nosniff`, and a policy that loads and runs
//   nothing (security-headers.ts). A binary type is checked by its
//   signature alone (`runFileTypeOfBytes`), so a polyglot passes: one
//   whose first bytes are a PNG's and the rest HTML, say. That is why it
//   is never served but as its checked type, as an attachment, under
//   `nosniff` and that policy: no browser renders it as HTML, and one
//   opened anyway has an opaque origin and runs nothing.
// - Who read it: each download is audited (`workflow.file.downloaded`),
//   once a day per person and file, with the file's type and size, never
//   its name.

/** The run's row, its receipt's details mark, and nothing for another. */
const runRowOf = async (env: Env, workflowId: string, runId: string) => {
  const row = await drizzle(env.DB)
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
  return row ?? undefined;
};

/**
 * Whether `by` may download run `runId`'s files: undefined when they may
 * not see the run at all, false when they may see it and not its files.
 */
const mayDownload = async (
  env: Env,
  by: Acting,
  workflowId: unknown,
  runId: unknown
): Promise<{ workflow: string; run: string; may: boolean } | undefined> => {
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
  // `resourceRunFor` decides.
  if (!own && !builder) {
    return undefined;
  }
  // Grasp staff never, whatever they may see of the run.
  const allowed = !by.staff && (own || (isAdmin(by.role) && !row.restricted));
  return {
    workflow,
    run: runId,
    may: allowed && !detailsRemoved(env, row),
  };
};

/** Run `run`'s finished files, oldest first. */
const finishedFiles = async (env: Env, run: string) =>
  await drizzle(env.DB)
    .select()
    .from(workflowRunFiles)
    .where(
      and(eq(workflowRunFiles.runId, run), eq(workflowRunFiles.state, "done"))
    )
    .orderBy(asc(workflowRunFiles.createdAt), asc(workflowRunFiles.id));

/**
 * Run `runId` of workflow `id`'s finished files, for `by`, who may
 * download them; null for one who may see the run but not its files.
 * Refused as `resourceRunFor` refuses a run they may not see.
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
  const rows = await finishedFiles(env, decided.run);
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
): Promise<typeof workflowRunFiles.$inferSelect | undefined> => {
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
  return row ?? undefined;
};

/**
 * Records that `reader` downloaded file `file` of run `run`: once a day
 * per person and file (the event's ID is derived from them), never its
 * name.
 */
const auditDownload = async (
  env: Env,
  reader: string,
  file: { id: string; runId: string; workflowResourceId: string },
  shown: { type: string; size: number }
): Promise<void> => {
  const action = "workflow.file.downloaded";
  const day = new Date().toISOString().slice(0, 10);
  const event = auditEventSchema.parse({
    id: uuidFromHash(await sha256Hex(`${action}:${file.id}:${reader}:${day}`)),
    // The same event however often that day: one sent again after the
    // first was logged is a duplicate the log drops.
    at: `${day}T00:00:00.000Z`,
    source: "core",
    actor: { type: "person", userId: reader },
    action,
    target: { type: "workflow_resource", id: file.workflowResourceId },
    detail: {
      run: file.runId,
      file: file.id,
      type: shown.type,
      size: shown.size,
      day,
    },
  });
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxedEventWhere(db, event, not(storedEvent(event.id))),
  ]);
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

/** Whether `request` may come from where it did (see the header). */
const fromOwnPage = (request: Request): boolean => {
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
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
    await auditDownload(env, person.userId, file, {
      type: file.type,
      size: file.size,
    });
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
          const object = await env.FILES.get(chunk.key);
          const bytes =
            object === null ? undefined : new Uint8Array(await object.bytes());
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
        "content-type": attachmentContentType(type),
        "content-disposition": attachmentDisposition(
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
