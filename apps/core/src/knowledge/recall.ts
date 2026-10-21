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
// This first policy reads full text only. Semantic routes are reported as
// not enabled, and no model is used, so no source text reaches one here;
// the recheck before model use comes with reranking (GRA-304).

/** The retrieval policy this service follows: full text, version 1. */
export const recallPolicyVersion = "fulltext@1";

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

/** A digest of `text`, for a pack's access revision. */
const digest = async (text: string): Promise<string> =>
  toHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    )
  ).slice(0, 32);

/** Waits `ms`, then resolves with `undefined`. */
const timeout = async (ms: number): Promise<undefined> => {
  await scheduler.wait(ms);
  return undefined;
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
  /** A collection's stub passes its own: the one collection it reads. */
  only?: CollectionId,
  store: BrainStore = d1BrainStore(env)
): Promise<MemoryPack> => {
  try {
    const { query, filters, budget } = brainErrors.parse(
      "brain.invalid",
      recallInputSchema,
      input
    );
    // An App, run or agent recalls only under its `brain` grant, and only
    // from the collections it was granted (the design: a binding can't
    // search the whole company because its name is "Brain").
    await store.requireBrainGrant(reader);
    const limits = clampBudget(budget);
    const named = filters?.collectionIds;
    if (only !== undefined && named?.some((id) => id !== only) === true) {
      throw brainErrors.create("brain.not_found");
    }
    const collectionIds = only === undefined ? named : [only];
    // One more than asked, to tell a full pack from a cut one.
    const limit = Math.min(limits.maxItems + 1, searchMaxLimit);
    const read = await Promise.race([
      store.findEvidence(reader, {
        query,
        limit,
        ...(collectionIds === undefined ? {} : { collectionIds }),
      }),
      timeout(limits.deadlineMs),
    ]);
    const found = read?.sections ?? [];
    const { items, tokenCount } = packed(found, limits);
    const truncated =
      items.length < found.length || read?.sections.length === searchMaxLimit;
    return {
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
      accessRevision: await digest(await store.accessKey(reader)),
      indexGeneration,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    throw asBrainError(error);
  }
};
