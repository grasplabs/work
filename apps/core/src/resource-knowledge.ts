import { sha256Hex } from "@grasp-os/shared/encoding";
import { collectionIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import type { AppId, CollectionId, PermissionId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type { SearchHit, SearchResults } from "@grasp-os/shared/knowledge";
import { operationErrors } from "@grasp-os/shared/operations";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { permissions } from "./db/core/schema.ts";
import { documents } from "./db/knowledge/schema.ts";
import { readAsDelegate } from "./knowledge/binding.ts";
import { search } from "./knowledge/search.ts";
import { read } from "./knowledge/tools.ts";
import type {
  BindingCaller,
  DeclarationOf,
  ResourceAdapter,
  TargetOf,
} from "./resource-adapter.ts";

// A knowledge resource (spec 32.3): bounded search and reads of the
// collections the declaration names, each bound to one of the App's own
// collection permissions. Every request reads as a delegate, through
// Knowledge's own access rules (knowledge/access.ts), under that one
// permission: only while it is active and allows reading, only what the
// person the call acts for may read too. A read from a sensitive
// collection puts the App in restricted mode before anything is returned
// (connect then holds its side effects for the person, and the model
// gateway applies the data rules), and every read's provenance is noted
// in the invocation's sources, which go back to the caller with the
// answer and feed its later model requests. A remote search is a snapshot,
// answered once, never a live query.

/** What every knowledge binding serves. */
const knowledgeContract = {
  contractId: "grasp.knowledge@1",
  search: {
    request: { text: "string, 1 to 1000", limit: "1 to 20, optional" },
    answer: "up to 20 hits of a title and an excerpt, best first",
  },
  read: {
    request: { id: "a document ID, 1 to 256" },
    answer: "a document's title and text",
  },
} as const;

/** The knowledge contract's fingerprint, computed once. */
const knowledgeFingerprint = sha256Hex(canonicalJson(knowledgeContract));

/** What the operation host lets through, per operation (operations.ts). */
const searchSchema = z.strictObject({
  text: z.string(),
  limit: z.int().optional(),
});
const readSchema = z.strictObject({ id: z.string() });

/** How many hits a search answers when it doesn't say. */
const defaultHits = 20;

/** One declared collection, as its binding resolves it now. */
interface BoundCollection {
  readonly permissionId: PermissionId;
  readonly collectionId: CollectionId;
}

/**
 * The collections `target` binds for `declaration` of `app`, if it binds
 * exactly the collections declared, each through one of the App's own
 * active permissions to read a collection; undefined otherwise.
 */
const boundCollections = async (
  env: Env,
  app: AppId,
  declaration: DeclarationOf<"knowledge">,
  target: TargetOf<"knowledge">
): Promise<BoundCollection[] | undefined> => {
  const names = Object.keys(target.collections).toSorted();
  const declared = [...declaration.collections].toSorted();
  if (canonicalJson(names) !== canonicalJson(declared)) {
    return undefined;
  }
  const ids = [...new Set(Object.values(target.collections))];
  const rows = await drizzle(env.DB)
    .select({ id: permissions.id, collectionId: permissions.objectId })
    .from(permissions)
    .where(
      and(
        inArray(permissions.id, ids),
        eq(permissions.subjectType, "app"),
        eq(permissions.subjectId, app),
        eq(permissions.objectType, "collection"),
        eq(permissions.status, "active"),
        isNull(permissions.chatId),
        sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value = 'read')`
      )
    );
  if (rows.length !== ids.length) {
    return undefined;
  }
  const byPermission = new Map(rows.map((row) => [row.id, row.collectionId]));
  // In the declaration's order, each collection once.
  const bound = new Map<string, BoundCollection>();
  for (const name of declaration.collections) {
    const permissionId = target.collections[name];
    const collectionId =
      permissionId === undefined ? undefined : byPermission.get(permissionId);
    if (permissionId === undefined || collectionId === undefined) {
      return undefined;
    }
    bound.set(collectionId, {
      permissionId: permissionIdSchema.parse(permissionId),
      collectionId: collectionIdSchema.parse(collectionId),
    });
  }
  return [...bound.values()];
};

/** The collections bound now, or `resource.unavailable` for a lost grant. */
const requireBound = async (
  env: Env,
  caller: BindingCaller,
  declaration: DeclarationOf<"knowledge">,
  target: TargetOf<"knowledge">
): Promise<BoundCollection[]> => {
  const bound = await boundCollections(env, caller.app, declaration, target);
  if (bound === undefined) {
    throw operationErrors.create("resource.unavailable");
  }
  return bound;
};

/**
 * `lists` merged, best first: each list's first, then each one's second,
 * and so on, so no collection's hits crowd out another's best.
 */
const interleaved = <Item>(lists: readonly (readonly Item[])[]): Item[] => {
  const merged: Item[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let rank = 0; rank < longest; rank += 1) {
    for (const list of lists) {
      const item = list[rank];
      if (item !== undefined) {
        merged.push(item);
      }
    }
  }
  return merged;
};

/**
 * One bound collection's best hits for the person the call acts for; none
 * from a collection they may not read (Knowledge refuses it as one that
 * doesn't exist, `knowledge.not_found`), so a search answers what the
 * person may read of the bound collections, and says nothing of the rest.
 */
const searchOne = async (
  env: Env,
  caller: BindingCaller,
  permissionId: PermissionId,
  {
    text,
    limit,
    collectionId,
  }: {
    text: string;
    limit: number;
    collectionId: CollectionId;
  }
): Promise<SearchResults | undefined> => {
  try {
    return await readAsDelegate(
      env,
      caller.authority,
      caller.context,
      permissionId,
      async (reader) => await search(env, reader, text, { limit }, collectionId)
    );
  } catch (error) {
    if (knowledgeErrors.codeOf(error) === "knowledge.not_found") {
      return undefined;
    }
    throw error;
  }
};

/** The best hits for `text` in every bound collection the person may read. */
const searchBound = async (
  env: Env,
  caller: BindingCaller,
  bound: readonly BoundCollection[],
  request: z.infer<typeof searchSchema>
): Promise<{ title: string; excerpt: string }[]> => {
  const limit = request.limit ?? defaultHits;
  const found: SearchHit[][] = [];
  // One collection after another, each under its own permission: each
  // read notes its provenance (and restricts the App) before it returns.
  for (const { permissionId, collectionId } of bound) {
    // oxlint-disable-next-line no-await-in-loop -- one collection at a time
    const results = await searchOne(env, caller, permissionId, {
      text: request.text,
      limit,
      collectionId,
    });
    if (results !== undefined) {
      caller.sources.note(results.provenance);
      found.push(results.hits);
    }
  }
  return interleaved(found)
    .slice(0, limit)
    .map((hit) => ({ title: hit.title, excerpt: hit.snippet }));
};

/** One document of a bound collection, by its ID. */
const readBound = async (
  env: Env,
  caller: BindingCaller,
  bound: readonly BoundCollection[],
  request: z.infer<typeof readSchema>
): Promise<{ title: string; text: string }> => {
  const located = await drizzle(env.KNOWLEDGE)
    .select({ collectionId: documents.collectionId })
    .from(documents)
    .where(eq(documents.id, request.id))
    .get();
  const binding = bound.find(
    ({ collectionId }) => collectionId === located?.collectionId
  );
  if (binding === undefined) {
    throw operationErrors.create("resource.item_not_found");
  }
  try {
    const document = await readAsDelegate(
      env,
      caller.authority,
      caller.context,
      binding.permissionId,
      async (reader) => await read(env, reader, request.id)
    );
    caller.sources.note(document.provenance);
    return { title: document.title, text: document.text };
  } catch (error) {
    if (knowledgeErrors.codeOf(error) === "knowledge.not_found") {
      throw operationErrors.create("resource.item_not_found");
    }
    throw error;
  }
};

export const knowledgeAdapter: ResourceAdapter<"knowledge"> = {
  served: async (env, app, declaration, target) =>
    (await boundCollections(env, app, declaration, target)) === undefined
      ? undefined
      : {
          contractId: knowledgeContract.contractId,
          fingerprint: await knowledgeFingerprint,
        },
  call: async (env, caller, declaration, target, { method, args }) => {
    const bound = await requireBound(env, caller, declaration, target);
    if (method === "search") {
      return await searchBound(env, caller, bound, searchSchema.parse(args[0]));
    }
    return await readBound(env, caller, bound, readSchema.parse(args[0]));
  },
};
