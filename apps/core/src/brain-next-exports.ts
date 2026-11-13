import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { brainExportErrors } from "@grasp-os/shared/brain-exports";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { z } from "zod";

import { appendAuditEvent } from "./audit-outbox.ts";
import { organizationId } from "./auth/auth.ts";
import { identifyFull } from "./auth/identity.ts";
import {
  brainExportFile,
  brainExportStatus,
  brainRestoreStatus,
  startBrainExport,
  startBrainRestore,
} from "./brain-next.ts";
import { installShippedSkills } from "./brain-skills.ts";
import { errorResponse } from "./errors.ts";

// Exports of the Brain and their restore, over core's own site (GRA-1755),
// shaped as today's export of Knowledge is (knowledge/brain-export.ts): a
// signed-in person's request from core's own pages, never another site's,
// and every file an attachment never cached.
//
// - `POST /api/brain/exports`: starts an export of the company's Brain,
//   for an admin, never staff. A person's own export is for later.
// - `GET /api/brain/exports?id=`: where it is, with its files once done;
//   `&file=` downloads one. For an admin, never staff.
// - `POST /api/brain/restore` `{ exportId }` and `GET ?id=`: an admin's
//   restore of the company's export into a shared store that holds nothing.
//
// Each start is in the audit log before it applies, with its outcome after;
// each download before its file is answered. Events name the export's
// random id and the kind of file: no content, key or name.

/** Where exports are started, followed and downloaded. */
export const brainExportsPath = "/api/brain/exports";

/** Where an admin restores the company's export. */
export const brainRestorePath = "/api/brain/restore";

/** Requests a page of core's own site sends: never another site. */
const sameSiteFetches = new Set(["same-origin", "none"]);

/** The most bytes a start's body takes. */
const bodyMaxBytes = 1024;

const readSchema = z.strictObject({
  id: z.uuid(),
  // Checked by the Brain's one rule of an export's file names
  // (brain-next.ts `brainExportFile`): a name it doesn't take is not found.
  file: z.string().min(1).max(64).optional(),
});

const restoreSchema = z.strictObject({ exportId: z.uuid() });

const restoreReadSchema = z.strictObject({ id: z.uuid() });

const organization = { type: "organization", id: organizationId } as const;

const notFound = (requestId: string): Response =>
  errorResponse(404, requestErrors.create("request.not_found"), requestId);

const answer = (body: unknown): Response =>
  Response.json(body, { headers: { "cache-control": "no-store" } });

/**
 * The signed-in person behind a request from core's own site, or the
 * response that refuses it.
 */
const personOf = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Identity | Response> => {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && !sameSiteFetches.has(fetchSite)) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  const person = await identifyFull(env, request.headers);
  return (
    person ??
    errorResponse(401, authErrors.create("auth.unauthenticated"), requestId)
  );
};

/** Whether `person` may act for the company: an admin of it, never staff. */
const actsForCompany = (person: Identity): boolean =>
  !person.staff && isAdmin(person.role);

/** A start's JSON body as `schema` reads it, or undefined. */
const bodyOf = async <T>(
  request: Request,
  schema: z.ZodType<T>
): Promise<T | undefined> => {
  const text = await request.text();
  if (text.length > bodyMaxBytes) {
    return undefined;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** The query of `request` as `schema` reads it, or undefined. */
const queryOf = <T>(request: Request, schema: z.ZodType<T>): T | undefined => {
  const parsed = schema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  return parsed.success ? parsed.data : undefined;
};

/** An audit entry of `person`'s, on the organization. */
const entryOf = (
  person: Identity,
  action: string,
  requestId: string,
  detail: Record<string, AuditDetailValue>
) => ({
  actor: { type: "person", userId: person.userId } as const,
  action,
  target: organization,
  requestId,
  detail,
});

/**
 * `run`, asked and answered in the audit log: the ask before it applies
 * (a log that can't take it applies nothing), its outcome after, a failure
 * among them, which goes on as any other error.
 */
const audited = async <T>(
  env: Env,
  entry: (
    action: string,
    outcome?: string,
    value?: T
  ) => ReturnType<typeof entryOf>,
  run: () => Promise<T>
): Promise<T> => {
  await appendAuditEvent(env, entry("asked"));
  let value: T;
  try {
    value = await run();
  } catch (error) {
    await appendAuditEvent(env, entry("answered", "failed"));
    throw error;
  }
  await appendAuditEvent(env, entry("answered", "started", value));
  return value;
};

/** Starts an export of the company's Brain, for an admin. */
const startExport = async (
  env: Env,
  person: Identity,
  requestId: string
): Promise<Response> => {
  let started: Awaited<ReturnType<typeof startBrainExport>>;
  try {
    started = await audited(
      env,
      (step, outcome, answered) =>
        entryOf(person, `brain.export.${step}`, requestId, {
          ...(outcome === undefined ? {} : { outcome }),
          // The new export's random id, once it is started.
          ...(answered === undefined ? {} : { exportId: answered.id }),
        }),
      async () => await startBrainExport(env)
    );
  } catch (error) {
    // Refused for the state the Brain is in: a conflict.
    if (brainExportErrors.codeOf(error) === "brain.export_refused") {
      return errorResponse(
        409,
        brainExportErrors.create("brain.export_refused"),
        requestId
      );
    }
    throw error;
  }
  return answer(started);
};

/** Where an export is, or one of its files. */
const readExport = async (
  request: Request,
  env: Env,
  person: Identity,
  requestId: string
): Promise<Response> => {
  const asked = queryOf(request, readSchema);
  if (asked === undefined) {
    return notFound(requestId);
  }
  if (asked.file === undefined) {
    const status = await brainExportStatus(env, { id: asked.id });
    return status === null ? notFound(requestId) : answer(status);
  }
  const { file } = asked;
  const body = await brainExportFile(env, { id: asked.id, file });
  if (body === null) {
    return notFound(requestId);
  }
  // On record before the file is answered; a log that can't take it
  // answers nothing.
  await appendAuditEvent(
    env,
    entryOf(person, "brain.export.downloaded", requestId, {
      exportId: asked.id,
      file: file === "manifest.json" ? "manifest" : "part",
    })
  );
  return new Response(body, {
    headers: {
      "content-type":
        file === "manifest.json" ? "application/json" : "application/x-ndjson",
      "content-disposition": `attachment; filename="brain-${asked.id}-${file}"`,
      "cache-control": "no-store",
    },
  });
};

/**
 * Exports of the Brain: started with `POST`, followed and downloaded with
 * `GET` (above). Anything else is a path core doesn't serve.
 */
export const brainExportsResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "POST") {
    return notFound(requestId);
  }
  const person = await personOf(request, env, requestId);
  if (person instanceof Response) {
    return person;
  }
  if (!actsForCompany(person)) {
    return errorResponse(403, roleErrors.create("role.forbidden"), requestId);
  }
  return request.method === "POST"
    ? await startExport(env, person, requestId)
    : await readExport(request, env, person, requestId);
};

/**
 * An admin's restore of the company's export: started with `POST`,
 * followed with `GET` (above). Never staff's, never a member's.
 */
export const brainRestoreResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "POST") {
    return notFound(requestId);
  }
  const person = await personOf(request, env, requestId);
  if (person instanceof Response) {
    return person;
  }
  if (!actsForCompany(person)) {
    return errorResponse(403, roleErrors.create("role.forbidden"), requestId);
  }
  if (request.method === "GET") {
    const asked = queryOf(request, restoreReadSchema);
    const status =
      asked === undefined ? null : await brainRestoreStatus(env, asked.id);
    return status === null ? notFound(requestId) : answer(status);
  }
  const asked = await bodyOf(request, restoreSchema);
  if (asked === undefined) {
    return notFound(requestId);
  }
  try {
    const status = await audited(
      env,
      (step, outcome) =>
        entryOf(person, `brain.restore.${step}`, requestId, {
          exportId: asked.exportId,
          ...(outcome === undefined ? {} : { outcome }),
        }),
      // Grasp's own skills first, once the Brain says the restore may
      // start, whatever the release's install recorded: a restore never
      // writes them (no export holds them) and adds nothing while it runs,
      // so what is installed now is there when it is done, also in a store
      // whose storage was lost after the release installed them.
      // An install that didn't write every skill fails the preparation:
      // the restore doesn't start, and the admin is told to try again.
      async () =>
        await startBrainRestore(
          env,
          asked.exportId,
          async () => await installShippedSkills(env)
        )
    );
    return answer(status);
  } catch (error) {
    // Refused for the state the Brain is in, not for the request (the
    // skills' install meeting a restore that began meanwhile among it): a
    // conflict, its answer in the audit log as failed.
    const code = brainExportErrors.codeOf(error);
    if (code === "brain.restore_refused" || code === "brain.restoring") {
      return errorResponse(409, brainExportErrors.create(code), requestId);
    }
    // Grasp's own skills not all installed: nothing started, to try again.
    if (code === "brain.restore_unprepared") {
      return errorResponse(503, brainExportErrors.create(code), requestId);
    }
    throw error;
  }
};
