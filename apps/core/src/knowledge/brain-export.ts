import {
  advanceExport,
  expireExports,
  exportFile,
  runningExports,
} from "@grasp-os/brain/exports";
import type { OnExport } from "@grasp-os/brain/exports";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { onboardingDocumentsCollection } from "@grasp-os/shared/onboarding-documents";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { identifyFull } from "../auth/identity.ts";
import { collectionTeams, permissions } from "../db/core/schema.ts";
import { errorResponse } from "../errors.ts";
import { personWriter } from "./person-writes.ts";
import { brainOf } from "./ports.ts";

// Core's part of an export of the company's Brain (GRA-1192; the Brain's
// exports.ts holds the rest): who reads each exported collection by team,
// and the active grants Apps and agents hold on the Brain and on those
// collections. IDs, kinds and actions alone.

/** A grant's actions, as stored (JSON). */
const actionsOf = (stored: string): string[] => {
  const parsed = z.array(z.string()).safeParse(JSON.parse(stored));
  return parsed.success ? parsed.data : [];
};

/** What core adds to an export (`OnExport`). */
export const coreExport = (env: Env): OnExport => ({
  // What the onboarding's documents are read into is the interviews', not
  // company content (onboarding/documents.ts); interview records are
  // core's own (brain_records), never in the Brain.
  excluded: [onboardingDocumentsCollection],
  files: async (collectionIds) => {
    const db = drizzle(env.DB);
    const ids = [...collectionIds];
    const teams =
      ids.length === 0
        ? []
        : await db
            .select()
            .from(collectionTeams)
            .where(inArray(collectionTeams.collectionId, ids));
    const grants = await db
      .select({
        id: permissions.id,
        subjectType: permissions.subjectType,
        subjectId: permissions.subjectId,
        objectType: permissions.objectType,
        objectId: permissions.objectId,
        actions: permissions.actions,
        binding: permissions.binding,
        grantedBy: permissions.grantedBy,
      })
      .from(permissions)
      .where(
        and(
          eq(permissions.status, "active"),
          or(
            eq(permissions.objectType, "platform"),
            ids.length === 0
              ? undefined
              : and(
                  eq(permissions.objectType, "collection"),
                  inArray(permissions.objectId, ids)
                )
          )
        )
      );
    // On the platform, only the grants to the Brain itself.
    const brainGrants = grants.filter(
      ({ objectType, actions }) =>
        objectType === "collection" || actionsOf(actions).includes("brain")
    );
    return [
      { name: "collection-teams", rows: teams },
      { name: "grants", rows: brainGrants },
    ];
  },
});

/** How long one clock tick writes exports for. */
const exportBudgetMs = 20_000;

/**
 * Goes on with the running exports for a while, and deletes the files of
 * those past their window or failed: core's clock, each minute.
 */
export const advanceExports = async (env: Env, at: Date): Promise<void> => {
  const brain = brainOf(env);
  await expireExports(brain, at);
  const until = new Date(Date.now() + exportBudgetMs);
  for (const exportId of await runningExports(brain)) {
    if (Date.now() >= until.getTime()) {
      return;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one export at a time
      await advanceExport(brain, exportId, coreExport(env), until);
    } catch {
      // Failed and recorded as failed, with why: its admin reads it.
    }
  }
};

/** Where an admin downloads an export's files: `?id=<export>&file=<name>`. */
export const brainExportPath = "/api/brain/export";

/** Requests a page of core's own site sends: never another site. */
const sameSiteFetches = new Set(["same-origin", "none"]);

const exportFileQuery = z.object({
  id: z.uuid(),
  file: z.string().regex(/^[a-z0-9-]{1,60}\.(?:jsonl|json)$/u),
});

/**
 * Serves one file of a complete export to the admin who asked for it,
 * within its window (the Brain's `exportFile`, which audits it): never to
 * staff, another admin or anyone else, never from another site, and never
 * as a public link.
 */
export const brainExportResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (request.method !== "GET") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  if (fetchSite !== null && !sameSiteFetches.has(fetchSite)) {
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
  if (person.staff || !isAdmin(person.role)) {
    return errorResponse(403, roleErrors.create("role.forbidden"), requestId);
  }
  const query = exportFileQuery.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (!query.success) {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  try {
    const body = await exportFile(
      brainOf(env),
      personWriter(person),
      query.data.id,
      query.data.file
    );
    return new Response(body, {
      headers: {
        "content-type": query.data.file.endsWith(".json")
          ? "application/json"
          : "application/x-ndjson",
        "content-disposition": `attachment; filename="brain-${query.data.file}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (knowledgeErrors.codeOf(error) === "knowledge.not_found") {
      return errorResponse(
        404,
        requestErrors.create("request.not_found"),
        requestId
      );
    }
    throw error;
  }
};
