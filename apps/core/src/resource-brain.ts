import {
  brainContractVersion,
  brainErrors,
  skillsReadInputSchema,
  skillsSelectInputSchema,
} from "@grasp-os/brain/contract";
import type {
  MemoryPack,
  SkillRead,
  SkillSelection,
} from "@grasp-os/brain/contract";
import { recallWithSources } from "@grasp-os/brain/recall";
import { d1BrainStore } from "@grasp-os/brain/recall-store";
import { documents } from "@grasp-os/brain/schema";
import { search } from "@grasp-os/brain/search";
import {
  readSkillWithSources,
  selectSkillWithSources,
} from "@grasp-os/brain/skills";
import { read } from "@grasp-os/brain/tools";
import {
  collectionErrors,
  resourceRecallInputSchema,
  searchQueryMaxLength,
} from "@grasp-os/shared/brain-documents";
import type {
  SearchHit,
  SearchResults,
} from "@grasp-os/shared/brain-documents";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { collectionIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import type { AppId, CollectionId, PermissionId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { brainSearchMaxLength } from "@grasp-os/shared/operation-limits";
import { operationErrors } from "@grasp-os/shared/operations";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { readAsDelegate } from "./brain/binding.ts";
import { brainOf } from "./brain/ports.ts";
import { permissions } from "./db/core/schema.ts";
import type {
  BindingCaller,
  DeclarationOf,
  ResourceAdapter,
  TargetOf,
} from "./resource-adapter.ts";

// A brain resource (spec 32.3): bounded search and reads of the
// collections the declaration names, each bound to one of the App's own
// collection permissions. Every request reads as a delegate, through
// The Brain's own access rules (brain/access.ts), under that one
// permission: only while it is active and allows reading, only what the
// person the call acts for may read too. A read from a sensitive
// collection puts the App in restricted mode before anything is returned
// (connect then holds its side effects for the person, and the model
// gateway applies the data rules), and every read's provenance is noted
// in the invocation's sources, which go back to the caller with the
// answer and feed its later model requests. A remote search is a snapshot,
// answered once, never a live query.

/**
 * What a brain binding serves: search, read and recall for every one,
 * and the skill operations (GRA-310) for one that declares them.
 */
const brainContract = {
  contractId: "grasp.brain@1",
  search: {
    request: {
      text: `string, 1 to ${brainSearchMaxLength}`,
      limit: "1 to 20, optional",
    },
    answer: "up to 20 hits of a title and an excerpt, best first",
  },
  read: {
    request: { id: "a document ID, 1 to 256" },
    answer: "a document's title and text",
  },
  recall: {
    request: {
      query: `string, 1 to ${searchQueryMaxLength}`,
      collections: "declared collection names, each once, optional",
      budget: "maxItems, maxTokens and deadlineMs, each optional",
    },
    answer: `a Brain memory pack (${brainContractVersion})`,
    needs: "the App's brain permission",
  },
  skillsSelect: {
    request: { task: "a type, and traits, each a token" },
    answer: `the applicable skill of the declared collections, pinned, or none (${brainContractVersion})`,
    needs: "the App's brain permission",
  },
  skillsRead: {
    request: {
      documentId: "a skill a selection pinned",
      version: "its version",
    },
    answer: `that skill at exactly that version (${brainContractVersion})`,
    needs: "the App's brain permission",
  },
} as const;

/** The operations every brain binding's fingerprint covers, declared or not. */
const baseOperations = ["search", "read", "recall"] as const;

/**
 * The fingerprint of the brain contract a declaration of `operations`
 * is bound to: search, read and recall, as every binding's has been, and
 * a skill operation only once it is declared. So adding an operation to
 * the contract changes no fingerprint but those of the Apps that use it,
 * and every other App's approval still matches.
 */
export const brainFingerprintOf = async (
  operations: readonly string[]
): Promise<string> => {
  const { contractId } = brainContract;
  const covered = Object.entries(brainContract).filter(
    ([name]) =>
      baseOperations.some((base) => base === name) || operations.includes(name)
  );
  return await sha256Hex(
    canonicalJson({ contractId, ...Object.fromEntries(covered) })
  );
};

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
  /** The declaration's names for it: one, or more bound to the same. */
  readonly names: readonly string[];
}

/**
 * The collections `target` binds for `declaration` of `app`, if it binds
 * exactly the collections declared, each through one of the App's own
 * active permissions to read a collection; undefined otherwise.
 */
const boundCollections = async (
  env: Env,
  app: AppId,
  declaration: DeclarationOf<"brain">,
  target: TargetOf<"brain">
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
      names: [...(bound.get(collectionId)?.names ?? []), name],
    });
  }
  return [...bound.values()];
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
 * from a collection they may not read (Brain refuses it as one that
 * doesn't exist, `brain.document_not_found`), so a search answers what the
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
      async (reader) =>
        await search(brainOf(env), reader, text, { limit }, collectionId)
    );
  } catch (error) {
    if (collectionErrors.codeOf(error) === "brain.document_not_found") {
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
  const located = await drizzle(env.BRAIN_DB)
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
      async (reader) => await read(brainOf(env), reader, request.id)
    );
    caller.sources.note(document.provenance);
    return { title: document.title, text: document.text };
  } catch (error) {
    if (collectionErrors.codeOf(error) === "brain.document_not_found") {
      throw operationErrors.create("resource.item_not_found");
    }
    throw error;
  }
};

/**
 * Whether the person the call acts for may read `collectionId` under the
 * binding's `permissionId`, now: refused alike when it is hidden or gone.
 */
const readableNow = async (
  env: Env,
  caller: BindingCaller,
  { permissionId, collectionId }: BoundCollection
): Promise<boolean> => {
  try {
    await readAsDelegate(
      env,
      caller.authority,
      caller.context,
      permissionId,
      async (reader) => {
        await d1BrainStore(brainOf(env)).requireReadable(reader, [
          collectionId,
        ]);
      }
    );
    return true;
  } catch (error) {
    if (collectionErrors.codeOf(error) === "brain.document_not_found") {
      return false;
    }
    throw error;
  }
};

/** Those of `bound` the person the call acts for may read now, each under its own permission. */
const readableOf = async (
  env: Env,
  caller: BindingCaller,
  bound: readonly BoundCollection[]
): Promise<CollectionId[]> => {
  const readable: CollectionId[] = [];
  // One collection after another, each under its own permission.
  for (const binding of bound) {
    // oxlint-disable-next-line no-await-in-loop -- one collection at a time
    if (await readableNow(env, caller, binding)) {
      readable.push(binding.collectionId);
    }
  }
  return readable;
};

/** A Brain refusal, as the operation host answers an App. */
const asOperationError = (error: unknown): unknown => {
  const code = brainErrors.codeOf(error);
  if (code === "brain.denied") {
    return operationErrors.create("resource.unavailable");
  }
  if (code === "brain.invalid" || code === "brain.not_found") {
    return operationErrors.create("resource.invalid_args");
  }
  return error;
};

/**
 * The Brain's recall (@grasp-os/brain/recall) over the bound collections, or
 * the ones `request` names of them, as far as the person the call acts
 * for may read each: the same service, checks and audit as every other
 * caller's. The App recalls only under its own `brain` permission, read
 * on every call, and never from a collection the declaration doesn't
 * bind; one its person can't read is left out, as a search leaves it.
 */
const recallBound = async (
  env: Env,
  caller: BindingCaller,
  bound: readonly BoundCollection[],
  { query, collections, budget }: z.output<typeof resourceRecallInputSchema>
): Promise<MemoryPack> => {
  // The operation host refused names the declaration doesn't have; a
  // name that isn't bound still never widens what is read.
  const asked =
    collections === undefined
      ? bound
      : bound.filter(({ names }) =>
          names.some((name) => collections.includes(name))
        );
  const readable = await readableOf(env, caller, asked);
  try {
    // Under every collection permission the App holds, and only within
    // those this binding names that the person may read now.
    const { pack, provenance } = await readAsDelegate(
      env,
      caller.authority,
      caller.context,
      undefined,
      async (reader) =>
        await recallWithSources(
          brainOf(env),
          reader,
          { query, ...(budget === undefined ? {} : { budget }) },
          readable
        )
    );
    caller.sources.note(provenance);
    return pack;
  } catch (error) {
    throw asOperationError(error);
  }
};

/**
 * The skill of the bound collections the person may read now that applies
 * to `request`'s task, pinned, or none (GRA-310): the Brain's selection,
 * as every caller's, weighing only those collections, as the App's recall
 * reads only them, under its `brain` permission and with what it weighed
 * noted, as a recall's sources are.
 */
const selectBound = async (
  env: Env,
  caller: BindingCaller,
  bound: readonly BoundCollection[],
  request: z.output<typeof skillsSelectInputSchema>
): Promise<SkillSelection> => {
  const readable = await readableOf(env, caller, bound);
  try {
    const { selection, provenance } = await readAsDelegate(
      env,
      caller.authority,
      caller.context,
      undefined,
      async (reader) =>
        await selectSkillWithSources(brainOf(env), reader, request, readable)
    );
    caller.sources.note(provenance);
    return selection;
  } catch (error) {
    throw asOperationError(error);
  }
};

/**
 * A pinned skill at exactly its version, from the bound collections the
 * person may read now: one anywhere else isn't found, as one they can't
 * see. Under the App's `brain` permission, its read noted.
 */
const readSkillBound = async (
  env: Env,
  caller: BindingCaller,
  bound: readonly BoundCollection[],
  request: z.output<typeof skillsReadInputSchema>
): Promise<SkillRead> => {
  const readable = await readableOf(env, caller, bound);
  try {
    const { read: skill, provenance } = await readAsDelegate(
      env,
      caller.authority,
      caller.context,
      undefined,
      async (reader) =>
        await readSkillWithSources(brainOf(env), reader, request, readable)
    );
    caller.sources.note(provenance);
    return skill;
  } catch (error) {
    if (brainErrors.codeOf(error) === "brain.not_found") {
      throw operationErrors.create("resource.item_not_found");
    }
    throw asOperationError(error);
  }
};

export const brainAdapter: ResourceAdapter<"brain"> = {
  bind: async (env, app, declaration, target) => {
    const bound = await boundCollections(env, app, declaration, target);
    const fingerprint = await brainFingerprintOf(declaration.operations);
    return bound === undefined
      ? undefined
      : {
          contractId: brainContract.contractId,
          fingerprint,
          call: async (caller, { method, args }) => {
            if (method === "search") {
              return await searchBound(
                env,
                caller,
                bound,
                searchSchema.parse(args[0])
              );
            }
            if (method === "recall") {
              return await recallBound(
                env,
                caller,
                bound,
                resourceRecallInputSchema.parse(args[0])
              );
            }
            if (method === "skillsSelect") {
              return await selectBound(
                env,
                caller,
                bound,
                skillsSelectInputSchema.parse(args[0])
              );
            }
            if (method === "skillsRead") {
              return await readSkillBound(
                env,
                caller,
                bound,
                skillsReadInputSchema.parse(args[0])
              );
            }
            return await readBound(
              env,
              caller,
              bound,
              readSchema.parse(args[0])
            );
          },
        };
  },
};
