import {
  brainContractVersion,
  brainErrors,
  recallDefaults,
  recallInputSchema,
} from "@grasp-os/shared/brain-api";
import type {
  BrainSourceRef,
  Coverage,
  MemoryItem,
  MemoryPack,
  RecallBudget,
} from "@grasp-os/shared/brain-api";
import { toHex } from "@grasp-os/shared/encoding";
import type { CollectionId } from "@grasp-os/shared/ids";
import { knowledgeErrors, searchMaxLimit } from "@grasp-os/shared/knowledge";
import { memoryTokens } from "@grasp-os/shared/memory";
import { permissionErrors } from "@grasp-os/shared/permissions";

import type { Reader } from "./access.ts";
import { portsOf } from "./ports.ts";
import { d1BrainStore } from "./recall-store.ts";
import type { BrainStore } from "./recall-store.ts";
import type { FoundSection } from "./search.ts";

// The Brain's recall (GRA-296; the Brain design's "Brain SDK and API"):
// the one service every caller reaches, a person through Knowledge's RPC,
// an agent or a run through its stubs, an App through its knowledge
// resource. Who reads is the host's `Reader`, never the call's arguments;
// what may be read is Knowledge's one access predicate, inside every read
// (recall-store.ts). It answers evidence, never analysis: a bounded
// memory pack of the sections that match, each cited at its exact
// version, with how far the read got.
//
// This policy reads full text only, any of the question's words ranked by
// BM25 (search.ts). Semantic routes are reported as
// not enabled, and no model is used, so no source text reaches one here;
// the recheck before model use comes with reranking (GRA-304).

/**
 * The retrieval policy this service follows: full text, version 2, which
 * matches any of a question's words rather than all of them.
 */
export const recallPolicyVersion = "fulltext@2";

/** The search index a recall reads: Knowledge's FTS5 tables. */
const indexGeneration = "knowledge-fts@1";

/** Routes this policy doesn't read yet, and why. */
const omittedRoutes = [{ route: "semantic", reason: "not_enabled" }];

/** The longest statement one item quotes, in characters. */
const statementMaxLength = 4000;

/** A recall's budget, as core clamps it: every bound set. */
export type ClampedBudget = Required<RecallBudget>;

/**
 * `budget` with core's defaults for what it leaves out: the schema already
 * held each bound to core's limits.
 */
export const clampBudget = (
  budget: RecallBudget | undefined
): ClampedBudget => ({
  maxItems: budget?.maxItems ?? recallDefaults.maxItems,
  maxTokens: budget?.maxTokens ?? recallDefaults.maxTokens,
  deadlineMs: budget?.deadlineMs ?? recallDefaults.deadlineMs,
});

/** A refusal from a read below, as the Brain's stable code. */
const asBrainError = (error: unknown): unknown => {
  if (brainErrors.codeOf(error) !== undefined) {
    return error;
  }
  if (knowledgeErrors.codeOf(error) === "knowledge.not_found") {
    return brainErrors.create("brain.not_found");
  }
  if (knowledgeErrors.codeOf(error) === "knowledge.invalid") {
    return brainErrors.create("brain.invalid");
  }
  if (permissionErrors.codeOf(error) !== undefined) {
    return brainErrors.create("brain.denied");
  }
  return error;
};

/** One section as a pack's item: its text, cited at its exact version. */
const itemOf = ({
  hit,
  version,
  updatedAt,
  text,
}: FoundSection): MemoryItem => {
  const ref: BrainSourceRef = {
    kind: "document",
    documentId: hit.documentId,
    collectionId: hit.collectionId,
    version,
    section: hit.section,
  };
  return {
    id: `${hit.documentId}@${version}#${hit.section}`,
    revision: version,
    kind: "fact",
    statement: text.slice(0, statementMaxLength),
    sourceRefs: [ref],
    authorityState: "source",
    validFrom: null,
    validTo: null,
    recordedAt: new Date(updatedAt).toISOString(),
    applicability: "Its words match the question's (full text).",
    citationLocator: [hit.title, ...hit.headings].slice(0, 16),
  };
};

/**
 * As many of `found`, in order, as the budget holds: no more items than it
 * allows, and no more tokens.
 */
const packed = (
  found: readonly FoundSection[],
  { maxItems, maxTokens }: ClampedBudget
): { items: MemoryItem[]; tokenCount: number } => {
  const items: MemoryItem[] = [];
  let tokenCount = 0;
  for (const section of found) {
    if (items.length === maxItems) {
      break;
    }
    const item = itemOf(section);
    const tokens = memoryTokens(item.statement);
    if (tokenCount + tokens > maxTokens) {
      break;
    }
    items.push(item);
    tokenCount += tokens;
  }
  return { items, tokenCount };
};

/** Every source version `items` cite, once each. */
const sourcesOf = (items: readonly MemoryItem[]): BrainSourceRef[] => {
  const refs = new Map<string, BrainSourceRef>();
  for (const { sourceRefs } of items) {
    for (const ref of sourceRefs) {
      refs.set(JSON.stringify(ref), ref);
    }
  }
  return [...refs.values()];
};

/**
 * How far the read got: the full-text route timed out (`degraded`, which
 * proves nothing missing), a budget cut it (`bounded`), or it finished its
 * bounded read (`complete`, never exhaustive).
 */
const coverageOf = (timedOut: boolean, truncated: boolean): Coverage => {
  if (timedOut) {
    return {
      state: "degraded",
      queriedRoutes: [],
      omittedRoutes: [
        { route: "fulltext", reason: "deadline" },
        ...omittedRoutes,
      ],
    };
  }
  return {
    state: truncated ? "bounded" : "complete",
    queriedRoutes: ["fulltext"],
    omittedRoutes,
  };
};

/**
 * A pack's access revision: `text` (what the reader may read now) signed
 * with a key of the deployment's own, so it can't be computed, or guessed
 * back, from what a caller knows of its own access.
 */
const digest = async (env: Env, text: string): Promise<string> => {
  const key = await portsOf(env).keys.hmac("grasp-os brain access revision", [
    "sign",
  ]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text)
  );
  return toHex(new Uint8Array(mac)).slice(0, 32);
};

/** Waits `ms`, then resolves with `undefined`. */
const timeout = async (ms: number): Promise<undefined> => {
  await scheduler.wait(ms);
  return undefined;
};

/**
 * `recall`, with every collection it read from: those its search reported
 * (a search records the collections it searched, found or not) and every
 * one it was told to read, so a caller that labels what it was handed
 * (a chat) labels a "nothing found in S" answer with S too.
 */
export const recallWithSources = async (
  env: Env,
  reader: Reader,
  input: unknown,
  /** A collection's stub passes its own: the one collection it reads. */
  only?: CollectionId,
  store: BrainStore = d1BrainStore(env)
): Promise<{ pack: MemoryPack; sources: CollectionId[] }> => {
  try {
    const { query, filters, budget } = brainErrors.parse(
      "brain.invalid",
      recallInputSchema,
      input
    );
    // Every check that can refuse runs before the timed read, so a short
    // deadline never turns a refusal into an empty pack: the `brain` grant
    // (an App, run or agent recalls only under it, and only from the
    // collections it was granted: a binding can't search the whole
    // company because its name is "Brain"), each named collection, and
    // the access revision the pack carries. Their time counts against the
    // deadline: the read gets what is left of it, and none once it is
    // spent.
    const startedAt = Date.now();
    await store.requireBrainGrant(reader);
    const limits = clampBudget(budget);
    const named = filters?.collectionIds;
    if (only !== undefined && named?.some((id) => id !== only) === true) {
      throw brainErrors.create("brain.not_found");
    }
    const collectionIds = only === undefined ? named : [only];
    if (collectionIds !== undefined) {
      await store.requireReadable(reader, collectionIds);
    }
    const accessRevision = await digest(env, await store.accessKey(reader));
    const remaining = limits.deadlineMs - (Date.now() - startedAt);
    // One more than asked, to tell a full pack from a cut one.
    const limit = Math.min(limits.maxItems + 1, searchMaxLimit);
    const read =
      remaining <= 0
        ? undefined
        : await Promise.race([
            store.findEvidence(reader, {
              query,
              limit,
              ...(collectionIds === undefined ? {} : { collectionIds }),
            }),
            timeout(remaining),
          ]);
    const found = read?.sections ?? [];
    const { items, tokenCount } = packed(found, limits);
    const truncated =
      items.length < found.length || read?.sections.length === searchMaxLimit;
    const sources = [
      ...new Set([
        ...(read?.provenance.collectionIds ?? []),
        ...(collectionIds ?? []),
      ]),
    ];
    const pack: MemoryPack = {
      id: crypto.randomUUID(),
      contractVersion: brainContractVersion,
      retrievalPolicyVersion: recallPolicyVersion,
      items,
      sourceVersions: sourcesOf(items),
      conflicts: [],
      // Only a finished read that matched nothing is a gap: one the
      // deadline stopped proves nothing, and one a budget cut matched.
      gaps:
        found.length === 0 && read !== undefined
          ? [{ about: "No evidence the caller may read matched the question." }]
          : [],
      coverage: coverageOf(read === undefined, truncated),
      truncated,
      warnings: [],
      tokenCount,
      accessRevision,
      indexGeneration,
      createdAt: portsOf(env).clock().toISOString(),
    };
    return { pack, sources };
  } catch (error) {
    throw asBrainError(error);
  }
};

/**
 * The evidence that applies to `input`'s question, for `reader`: a bounded
 * memory pack. A filter only narrows: a collection `reader` can't read
 * refuses the whole recall as `brain.not_found` before anything is read.
 * Refusals are the Brain's stable codes.
 */
export const recall = async (
  env: Env,
  reader: Reader,
  input: unknown,
  only?: CollectionId,
  store: BrainStore = d1BrainStore(env)
): Promise<MemoryPack> => {
  const { pack } = await recallWithSources(env, reader, input, only, store);
  return pack;
};
