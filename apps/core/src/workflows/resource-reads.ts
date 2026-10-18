import { collectionIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId, PermissionId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { knowledgeSearchMaxLength } from "@grasp-os/shared/operation-limits";
import { operationErrors } from "@grasp-os/shared/operations";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { permissions } from "../db/core/schema.ts";
import { documents } from "../db/knowledge/schema.ts";
import { readAsDelegate } from "../knowledge/binding.ts";
import { search } from "../knowledge/search.ts";
import { read } from "../knowledge/tools.ts";
import { pinnedTemplate } from "../resource-templates.ts";
import { runAuthority, runContext } from "./resource-authority.ts";
import type { CallingRun, FrozenCatalogBinding } from "./resource-authority.ts";

// A run's reads of Knowledge and of published templates, for its
// workflow's own actions (GRA-700; the threat model is on the issue). Each
// is one of the run's named calls (resource-calls.ts, `makeCall`): its
// binding frozen at the start, its authority decided again first, its
// receipts kept. What each closes:
//
// - A collection the workflow wasn't granted, or the person can't read.
//   A knowledge binding is one collection, through one permission the
//   workflow holds; every read goes through Knowledge's own access rules
//   as a delegate (`readAsDelegate`), as the run (the workflow, on behalf
//   of the run's person), under that one permission: what both the grant
//   and the person allow, nothing else. A document outside the collection,
//   or one the person may not read, is refused alike, as one that isn't
//   there (`resource.item_not_found`).
// - Restricted data reaching an unrestricted run. Knowledge restricts the
//   reading context before it returns a sensitive collection's data
//   (knowledge/access.ts), and an independent run never enters restricted
//   mode after its start (restricted.ts): such a read is refused
//   (`permission.restricted`) before anything is returned, a search that
//   finds nothing too, as that says something of what the collection
//   holds (knowledge/search.ts). A run started restricted reads it.
// - A template other than the one approved. A binding pins one version by
//   its content's hash; content that no longer hashes to it serves
//   nothing (`resource.unavailable`).

/** What a search asks: text, as Knowledge takes it, and how many hits. */
const searchSchema = z.strictObject({
  text: z.string().min(1).max(knowledgeSearchMaxLength),
  limit: z.int().min(1).max(20).optional(),
});

/** What a read asks: one document, by its ID. */
const readSchema = z.strictObject({ id: z.string().min(1).max(256) });

/** How many hits a search answers when it doesn't say. */
const defaultHits = 20;

const callInvalid = (issue: string) =>
  workflowResourceErrors.create("workflow.call_invalid", { issues: [issue] });

/** A knowledge call, as an action asks it: an operation and its request. */
export interface KnowledgeCall {
  readonly operation: "search" | "read";
  readonly arguments: Json;
}

/**
 * The collection a knowledge binding reads through its permission, read
 * now: the workflow's own, active, allowing `read`, or the call is denied.
 */
const boundCollection = async (
  env: Env,
  run: CallingRun,
  permissionId: string
): Promise<{ permissionId: PermissionId; collectionId: CollectionId }> => {
  const row = await drizzle(env.DB)
    .select({ collectionId: permissions.objectId })
    .from(permissions)
    .where(
      and(
        eq(permissions.id, permissionId),
        eq(permissions.subjectType, "workflow"),
        eq(permissions.subjectId, run.workflowId),
        eq(permissions.objectType, "collection"),
        eq(permissions.status, "active")
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  return {
    permissionId: permissionIdSchema.parse(permissionId),
    collectionId: collectionIdSchema.parse(row.collectionId),
  };
};

/** The best hits for `text` in the bound collection the person may read. */
const searched = async (
  env: Env,
  run: CallingRun,
  bound: { permissionId: PermissionId; collectionId: CollectionId },
  request: z.infer<typeof searchSchema>
): Promise<Json> => {
  try {
    const results = await readAsDelegate(
      env,
      runAuthority(run),
      runContext(run),
      bound.permissionId,
      async (reader) =>
        await search(
          env,
          reader,
          request.text,
          { limit: request.limit ?? defaultHits },
          bound.collectionId
        )
    );
    return results.hits.map((hit) => ({
      id: hit.documentId,
      title: hit.title,
      excerpt: hit.snippet,
    }));
  } catch (error) {
    // A collection the person may not read answers nothing, as one with
    // no match: a search says nothing of what they can't read.
    if (knowledgeErrors.codeOf(error) === "knowledge.not_found") {
      return [];
    }
    throw error;
  }
};

/** One document of the bound collection, by its ID. */
const document = async (
  env: Env,
  run: CallingRun,
  bound: { permissionId: PermissionId; collectionId: CollectionId },
  request: z.infer<typeof readSchema>
): Promise<Json> => {
  const located = await drizzle(env.KNOWLEDGE)
    .select({ collectionId: documents.collectionId })
    .from(documents)
    .where(eq(documents.id, request.id))
    .get();
  if (located?.collectionId !== bound.collectionId) {
    throw operationErrors.create("resource.item_not_found");
  }
  try {
    const found = await readAsDelegate(
      env,
      runAuthority(run),
      runContext(run),
      bound.permissionId,
      async (reader) => await read(env, reader, request.id)
    );
    return { title: found.title, text: found.text };
  } catch (error) {
    if (knowledgeErrors.codeOf(error) === "knowledge.not_found") {
      throw operationErrors.create("resource.item_not_found");
    }
    throw error;
  }
};

/**
 * Makes knowledge call `call` of `run` through `binding`, its authority
 * already decided again (`makeCall`): a search's hits, or a document.
 */
export const callKnowledge = async (
  env: Env,
  run: CallingRun,
  binding: FrozenCatalogBinding,
  call: KnowledgeCall
): Promise<Json> => {
  const { target } = binding;
  if (target.kind !== "knowledge") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const bound = await boundCollection(env, run, target.permissionId);
  if (call.operation === "search") {
    const request = searchSchema.safeParse(call.arguments);
    if (!request.success) {
      throw callInvalid(
        `arguments: Give text of 1 to ${knowledgeSearchMaxLength} characters, and a limit of 1 to 20 if any.`
      );
    }
    return await searched(env, run, bound, request.data);
  }
  const request = readSchema.safeParse(call.arguments);
  if (!request.success) {
    throw callInvalid("arguments: Give a document's ID.");
  }
  return await document(env, run, bound, request.data);
};

/**
 * Reads the template version `binding` pins, as its approval pinned it:
 * its content, or `resource.unavailable` for content that no longer
 * hashes to the pin.
 */
export const callTemplate = async (
  env: Env,
  binding: FrozenCatalogBinding
): Promise<Json> => {
  const { target } = binding;
  if (target.kind !== "template") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const pinned = await pinnedTemplate(
    env,
    target.templateId,
    target.version,
    target.contentHash
  );
  if (pinned === undefined) {
    throw operationErrors.create("resource.unavailable");
  }
  return {
    contract: pinned.contract,
    version: pinned.version,
    content: pinned.content,
  };
};
