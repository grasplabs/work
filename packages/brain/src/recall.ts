import type { Brain, BrainPorts } from "./brain.ts";
import {
  brainContractVersion,
  brainErrors,
  recallDefaults,
  recallInputSchema,
} from "./contract.ts";
import type {
  BrainSourceRef,
  Coverage,
  MemoryItem,
  MemoryPack,
  RecallBudget,
} from "./contract.ts";
import { toHex } from "./encoding.ts";
import type { CollectionId } from "./ids.ts";
import { knowledgeErrors, searchMaxLimit } from "./knowledge.ts";
import type { Provenance } from "./knowledge.ts";
import { searchMemories } from "./memories.ts";
import type { MemoryAudience } from "./memories.ts";
import { d1BrainStore } from "./recall-store.ts";
import type { BrainStore, EvidenceQuery } from "./recall-store.ts";
import type { FoundSection } from "./search.ts";
import { tokensOf } from "./tokens.ts";

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
// BM25 (search.ts): document sections, and memory records (GRA-298) the
// host's memory audience may read, kept or dropped by the host as a chat's
// memory is. A recall narrowed to collections, or bound to some, reads no
// memory record: none is in a collection, so no narrowing widens into
// memory. Semantic routes are reported as
// not enabled, and no model is used, so no source text reaches one here;
// the recheck before model use comes with reranking (GRA-304).

/**
 * The retrieval policy this service follows: full text, version 3, which
 * matches any of a question's words rather than all of them, in document
 * sections and memory records.
 */
export const recallPolicyVersion = "fulltext@3";

/** The search indexes a recall reads: Knowledge's and memory's FTS5 tables. */
const indexGeneration = "knowledge-fts@2";

/** Routes this policy doesn't read yet, and why. */
const omittedRoutes = [{ route: "semantic", reason: "not_enabled" }];

/** What a read of no collection read: nothing. */
const noProvenance: Provenance = {
  collectionIds: [],
  sensitive: false,
  restricted: false,
};

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
const asBrainError = <C>(brain: Brain<C>, error: unknown): unknown => {
  if (brainErrors.codeOf(error) !== undefined) {
    return error;
  }
  if (knowledgeErrors.codeOf(error) === "knowledge.not_found") {
    return brainErrors.create("brain.not_found");
  }
  if (knowledgeErrors.codeOf(error) === "knowledge.invalid") {
    return brainErrors.create("brain.invalid");
  }
  if (brain.ports.recall.isRefusal(error)) {
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

/** A memory record the host kept, as the Brain hands it over. */
type KeptMemory = Awaited<
  ReturnType<BrainPorts<unknown>["memories"]["keep"]>
>[number];

/**
 * One memory record as a pack's item, cited as itself at its revision:
 * where it is, for a person, its scope and who published it.
 */
const memoryItemOf = ({
  id,
  revision,
  kind,
  scope,
  statement,
  state,
  validFrom,
  validTo,
  recordedAt,
  by,
}: KeptMemory): MemoryItem => ({
  id,
  revision,
  kind,
  statement: statement.slice(0, statementMaxLength),
  sourceRefs: [{ kind: "memory", memoryId: id, revision }],
  authorityState: state === "accepted" ? "accepted" : "proposed",
  validFrom,
  validTo,
  recordedAt,
  applicability: "Its words match the question's (full text).",
  citationLocator: [
    `Memory record (${scope})`,
    ...(by === null ? [] : [`by ${by}`]),
  ],
});

/**
 * Sections and memory records, best first in each, taken in turn: their
 * scores come from different indexes, so one is never ranked against the
 * other.
 */
const alternated = (
  sections: readonly FoundSection[],
  memories: readonly KeptMemory[]
): { item: MemoryItem; memory?: KeptMemory }[] => {
  const taken: { item: MemoryItem; memory?: KeptMemory }[] = [];
  for (
    let index = 0;
    index < Math.max(sections.length, memories.length);
    index += 1
  ) {
    const section = sections[index];
    const memory = memories[index];
    if (section !== undefined) {
      taken.push({ item: itemOf(section) });
    }
    if (memory !== undefined) {
      taken.push({ item: memoryItemOf(memory), memory });
    }
  }
  return taken;
};

/**
 * As many of `found`, in order, as the budget holds: no more items than it
 * allows, and no more tokens. With the memory records among them.
 */
const packed = (
  found: readonly { item: MemoryItem; memory?: KeptMemory }[],
  { maxItems, maxTokens }: ClampedBudget
): { items: MemoryItem[]; memories: KeptMemory[]; tokenCount: number } => {
  const items: MemoryItem[] = [];
  const memories: KeptMemory[] = [];
  let tokenCount = 0;
  for (const { item, memory } of found) {
    if (items.length === maxItems) {
      break;
    }
    const tokens = tokensOf(item.statement);
    if (tokenCount + tokens > maxTokens) {
      break;
    }
    items.push(item);
    if (memory !== undefined) {
      memories.push(memory);
    }
    tokenCount += tokens;
  }
  return { items, memories, tokenCount };
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
const digest = async <C>(brain: Brain<C>, text: string): Promise<string> => {
  const key = await brain.ports.keys.hmac("grasp-os brain access revision", [
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
 * The collections a recall reads: those its filter names, or all it is
 * bound `within` (undefined: all the reader may read). A filter naming
 * one outside them is refused as not found.
 */
const scopeOf = (
  named: readonly CollectionId[] | undefined,
  within: readonly CollectionId[] | undefined
): readonly CollectionId[] | undefined => {
  if (within === undefined || named === undefined) {
    return named ?? within;
  }
  if (named.some((id) => !within.includes(id))) {
    throw brainErrors.create("brain.not_found");
  }
  return named;
};

/** Whom a recall's memory serves, as its host answered. */
interface MemoryReaders {
  audience: MemoryAudience;
  people: readonly string[];
}

/**
 * The memory records `readers` may read that match `query`, as the host
 * keeps them now: none for a recall that reads no memory.
 */
const memoriesFound = async <C>(
  brain: Brain<C>,
  reader: C,
  readers: MemoryReaders | undefined,
  query: string,
  limit: number
): Promise<KeptMemory[]> => {
  if (readers === undefined) {
    return [];
  }
  const found = await searchMemories(brain, readers.audience, query, limit);
  return found.length === 0
    ? []
    : await brain.ports.memories.keep(reader, readers.people, found);
};

/**
 * What `store` finds for `query` in `remaining` milliseconds, and the
 * memory records `readers` may read, or undefined once they run out.
 * Bound to no collection it may read, it searches nothing and finds
 * nothing, as a search of them would answer.
 */
const evidenceWithin = async <C>(
  brain: Brain<C>,
  store: BrainStore<C>,
  reader: C,
  readers: MemoryReaders | undefined,
  { remaining, ...query }: EvidenceQuery & { remaining: number }
): Promise<
  | { sections: FoundSection[]; memories: KeptMemory[]; provenance: Provenance }
  | undefined
> => {
  if (query.collectionIds?.length === 0) {
    return { sections: [], memories: [], provenance: noProvenance };
  }
  const read = async () => {
    const [{ sections, provenance }, memories] = await Promise.all([
      store.findEvidence(reader, query),
      memoriesFound(brain, reader, readers, query.query, query.limit),
    ]);
    return { sections, memories, provenance };
  };
  return await Promise.race([read(), timeout(remaining)]);
};

/**
 * Whom a recall's memory serves: none for one narrowed to collections, as
 * no record is in one.
 */
const memoryReadersOf = async <C>(
  brain: Brain<C>,
  reader: C,
  collectionIds: readonly CollectionId[] | undefined
): Promise<MemoryReaders | undefined> =>
  collectionIds === undefined
    ? await brain.ports.memories.audienceOf(reader)
    : undefined;

/**
 * Whether a read stopped at a limit: the section search at its most, or
 * memory at the one more than asked for that tells a full pack from a cut
 * one. A cut there may have left out evidence that applied.
 */
const readFull = (
  read:
    | { sections: readonly unknown[]; memories: readonly unknown[] }
    | undefined,
  limit: number
): boolean =>
  read !== undefined &&
  (read.sections.length === searchMaxLimit || read.memories.length === limit);

/**
 * Before memory records are handed over: a read of them, and of the
 * collections they rest on, a sensitive one restricting the caller first,
 * as a chat's memory is read. None read, nothing noted.
 */
const memoriesRead = async <C>(
  brain: Brain<C>,
  reader: C,
  memories: readonly KeptMemory[]
): Promise<Provenance> => {
  if (memories.length === 0) {
    return noProvenance;
  }
  const cited = new Map(
    memories.flatMap(({ cites }) => cites).map((source) => [source.id, source])
  );
  return await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      detail: { read: "memory", records: memories.length },
    },
    ...cited.values()
  );
};

/**
 * The provenance of what a recall read: its sections' and its memory
 * records', with every collection it was told to read.
 */
const joined = (
  sections: Provenance,
  memories: Provenance,
  told: readonly CollectionId[]
): Provenance => ({
  collectionIds: [
    ...new Set([...sections.collectionIds, ...memories.collectionIds, ...told]),
  ],
  sensitive: sections.sensitive || memories.sensitive,
  restricted: sections.restricted || memories.restricted,
});

/**
 * `recall`, with every collection it read from: those its search reported
 * (a search records the collections it searched, found or not) and every
 * one it was told to read, so a caller that labels what it was handed
 * (a chat) labels a "nothing found in S" answer with S too.
 */
export const recallWithSources = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown,
  /**
   * The only collections it may read, for a caller bound to some: a
   * collection's stub passes its own, an App's knowledge resource those
   * it binds that its person may read (none reads nothing). A filter
   * naming another is refused as not found.
   */
  within?: readonly CollectionId[],
  store: BrainStore<C> = d1BrainStore(brain)
): Promise<{
  pack: MemoryPack;
  sources: CollectionId[];
  /** What the read handed over came from, and how it is classified. */
  provenance: Provenance;
}> => {
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
    const collectionIds = scopeOf(filters?.collectionIds, within);
    if (collectionIds !== undefined) {
      await store.requireReadable(reader, collectionIds);
    }
    // Memory only for a recall narrowed to nothing: no record is in a
    // collection. Whom it serves is part of the access revision, so a
    // pack isn't used again once a team or a chat's audience changes.
    const readers = await memoryReadersOf(brain, reader, collectionIds);
    const accessRevision = await digest(
      brain,
      JSON.stringify([await store.accessKey(reader), readers ?? null])
    );
    const remaining = limits.deadlineMs - (Date.now() - startedAt);
    // One more than asked, to tell a full pack from a cut one.
    const limit = Math.min(limits.maxItems + 1, searchMaxLimit);
    const read =
      remaining <= 0
        ? undefined
        : await evidenceWithin(brain, store, reader, readers, {
            query,
            limit,
            remaining,
            ...(collectionIds === undefined ? {} : { collectionIds }),
          });
    const found = alternated(read?.sections ?? [], read?.memories ?? []);
    const { items, memories, tokenCount } = packed(found, limits);
    const truncated = items.length < found.length || readFull(read, limit);
    const provenance = joined(
      read?.provenance ?? noProvenance,
      await memoriesRead(brain, reader, memories),
      collectionIds ?? []
    );
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
      createdAt: brain.ports.clock().toISOString(),
    };
    return { pack, sources: provenance.collectionIds, provenance };
  } catch (error) {
    throw asBrainError(brain, error);
  }
};

/**
 * The evidence that applies to `input`'s question, for `reader`: a bounded
 * memory pack. A filter only narrows: a collection `reader` can't read
 * refuses the whole recall as `brain.not_found` before anything is read.
 * Refusals are the Brain's stable codes.
 */
export const recall = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown,
  within?: readonly CollectionId[],
  store: BrainStore<C> = d1BrainStore(brain)
): Promise<MemoryPack> => {
  const { pack } = await recallWithSources(brain, reader, input, within, store);
  return pack;
};
