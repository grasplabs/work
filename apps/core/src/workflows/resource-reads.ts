import { brainErrors, recallInputSchema } from "@grasp-os/brain/contract";
import { recall } from "@grasp-os/brain/recall";
import { d1BrainStore } from "@grasp-os/brain/recall-store";
import { documents } from "@grasp-os/brain/schema";
import { search } from "@grasp-os/brain/search";
import { read } from "@grasp-os/brain/tools";
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
import { readAsDelegate } from "../knowledge/binding.ts";
import { brainOf } from "../knowledge/ports.ts";
import { pinnedTemplate } from "../resource-templates.ts";
import { runAuthority, runContext } from "./resource-authority.ts";
import type { CallingRun, FrozenCatalogBinding } from "./resource-authority.ts";
import {
  citedVersions,
  evidenceOf,
  isAccessRefusal,
  recordRunEvidence,
} from "./run-evidence.ts";

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
// - A recall wider than the binding, or without the Brain (GRA-1067; the
//   threat model is on the issue). A recall is the Brain's own, the same
//   service as every caller's: over the binding's one collection, under
//   its one permission, as the run, and only while the workflow holds the
//   `brain` permission (the recall port, `brain.denied`); a filter naming
//   another collection is refused as one that isn't there
//   (`brain.not_found`). What it read is recorded with the run.

/** What a search asks: text, as Knowledge takes it, and how many hits. */
const searchSchema = z.strictObject({
  text: z.string().min(1).max(knowledgeSearchMaxLength),
  limit: z.int().min(1).max(20).optional(),
});

/** What a read asks: one document, by its ID. */
const readSchema = z.strictObject({ id: z.string().min(1).max(256) });

/** What a recall asks: the Brain's recall input, over the binding's collection. */
const recallSchema = recallInputSchema;

/** How many hits a search answers when it doesn't say. */
const defaultHits = 20;

const callInvalid = (issue: string) =>
  workflowResourceErrors.create("workflow.call_invalid", { issues: [issue] });

/** A knowledge call, as an action asks it: an operation and its request. */
export interface KnowledgeCall {
  readonly operation: "search" | "read" | "recall";
  readonly arguments: Json;
}

/**
 * The collection a knowledge binding reads through its permission, read
 * now: the workflow's own, active, allowing `read`, or the call is denied.
 */
export const boundCollection = async (
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
    const { results, pins } = await readAsDelegate(
      env,
      runAuthority(run),
      runContext(run),
      bound.permissionId,
      async (reader) => {
        const brain = brainOf(env);
        const found = await search(
          brain,
          reader,
          request.text,
          { limit: request.limit ?? defaultHits },
          bound.collectionId
        );
        return {
          results: found,
          pins: await d1BrainStore(brain).pinsOf(reader, found.hits),
        };
      }
    );
    // Each document version whose excerpt it hands over, pinned to the run
    // as a recall's evidence is, without the Brain (run-evidence.ts).
    await recordRunEvidence(env, run, bound.permissionId, pins, {
      recalled: false,
    });
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
    const { found, pins } = await readAsDelegate(
      env,
      runAuthority(run),
      runContext(run),
      bound.permissionId,
      async (reader) => {
        const brain = brainOf(env);
        const done = await read(brain, reader, request.id);
        return {
          found: done,
          pins: await d1BrainStore(brain).pinsOf(reader, [
            {
              documentId: done.id,
              collectionId: done.collectionId,
              version: done.section?.version ?? done.currentVersion,
            },
          ]),
        };
      }
    );
    // The document version it hands over, pinned to the run
    // (run-evidence.ts).
    await recordRunEvidence(env, run, bound.permissionId, pins, {
      recalled: false,
    });
    return { title: found.title, text: found.text };
  } catch (error) {
    if (knowledgeErrors.codeOf(error) === "knowledge.not_found") {
      throw operationErrors.create("resource.item_not_found");
    }
    throw error;
  }
};

/**
 * The Brain's recall over the bound collection, as the run, under the
 * binding's permission: the same recall as every caller's, as JSON.
 */
const recalled = async (
  env: Env,
  run: CallingRun,
  bound: { permissionId: PermissionId; collectionId: CollectionId },
  request: z.infer<typeof recallSchema>
): Promise<Json> => {
  const { pack, pins } = await readAsDelegate(
    env,
    runAuthority(run),
    runContext(run),
    bound.permissionId,
    async (reader) => {
      const brain = brainOf(env);
      const recalledPack = await recall(brain, reader, request, [
        bound.collectionId,
      ]);
      return {
        pack: recalledPack,
        pins: await d1BrainStore(brain).pinsOf(
          reader,
          citedVersions(recalledPack)
        ),
      };
    }
  );
  // What it cites, pinned to the run under the binding's permission
  // (run-evidence.ts): checked before anything leaves the run from now on.
  // A replayed step answers its record and pins nothing more.
  await recordRunEvidence(env, run, bound.permissionId, pins, {
    recalled: true,
  });
  // A memory pack is plain data: what the contract's schemas parse.
  return z.json().parse(pack);
};

/**
 * What knowledge call `call` asks, checked: a search's text and limit, a
 * read's document ID, or a recall's input (`workflow.call_invalid`
 * otherwise).
 */
export const requireKnowledgeRequest = (
  call: KnowledgeCall
):
  | { operation: "search"; request: z.infer<typeof searchSchema> }
  | { operation: "read"; request: z.infer<typeof readSchema> }
  | { operation: "recall"; request: z.infer<typeof recallSchema> } => {
  if (call.operation === "search") {
    const request = searchSchema.safeParse(call.arguments);
    if (!request.success) {
      throw callInvalid(
        `arguments: Give text of 1 to ${knowledgeSearchMaxLength} characters, and a limit of 1 to 20 if any.`
      );
    }
    return { operation: "search", request: request.data };
  }
  if (call.operation === "recall") {
    const request = recallSchema.safeParse(call.arguments);
    if (!request.success) {
      throw callInvalid(
        `arguments: Give a query of 1 to ${knowledgeSearchMaxLength} characters, and a budget if any.`
      );
    }
    return { operation: "recall", request: request.data };
  }
  const request = readSchema.safeParse(call.arguments);
  if (!request.success) {
    throw callInvalid("arguments: Give a document's ID.");
  }
  return { operation: "read", request: request.data };
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
  const request = requireKnowledgeRequest(call);
  switch (request.operation) {
    case "search": {
      return await searched(env, run, bound, request.request);
    }
    case "recall": {
      return await recalled(env, run, bound, request.request);
    }
    case "read": {
      return await document(env, run, bound, request.request);
    }
    default: {
      throw workflowResourceErrors.create("workflow.call_denied");
    }
  }
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

/**
 * `requireRunEvidenceReadable` for a run of a JSON workflow
 * (resource-host.ts, GRA-299): its recalls are each through a knowledge
 * binding, one collection under one permission of the workflow's, so each
 * binding's documents are checked under that permission, as the run
 * reads now: the permission still the workflow's and active
 * (`boundCollection`), the Brain still admitting the run, each document
 * still in its collection, readable there and unpurged. A test run recalls nothing,
 * so has nothing to check.
 */
export const requireResourceRunEvidenceReadable = async (
  env: Env,
  run: CallingRun
): Promise<void> => {
  const rows = await evidenceOf(env, run.runId);
  if (rows.length === 0) {
    return;
  }
  const store = d1BrainStore(brainOf(env));
  try {
    for (const permissionId of new Set(rows.map((row) => row.permissionId))) {
      // oxlint-disable-next-line no-await-in-loop -- one per binding, few
      const bound = await boundCollection(env, run, permissionId);
      // oxlint-disable-next-line no-await-in-loop -- one per binding, few
      await readAsDelegate(
        env,
        runAuthority(run),
        runContext(run),
        bound.permissionId,
        async (reader) => {
          const pinned = rows.filter(
            (row) => row.permissionId === permissionId
          );
          // A recall's evidence needs the Brain too; a search's or a
          // read's only the collection.
          if (pinned.some((row) => row.recalled)) {
            await store.requireBrainGrant(reader);
          }
          await store.requireDocumentsReadable(reader, pinned);
        }
      );
    }
  } catch (error) {
    if (isAccessRefusal(error)) {
      throw brainErrors.create("brain.revoked");
    }
    throw error;
  }
};
