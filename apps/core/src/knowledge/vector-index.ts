/**
 * Brain's single-vector index: the adapter interface semantic recall goes
 * through, so the platform service behind it can be swapped per deployment
 * profile, and the two profiles there are today.
 *
 * - `vectorize`: Cloudflare Vectorize, through a Worker binding.
 * - `unsupported`: every other profile, plain workerd and on-prem included.
 *   No vector adapter has been qualified there, so every call fails with
 *   {@link VectorIndexError} `unsupported` instead of answering as if
 *   nothing matched. A caller that falls back to full-text search must say
 *   its coverage is reduced; an empty answer would claim the information
 *   isn't there.
 *
 * The index is a rebuildable projection, never an authority. It holds
 * vectors, their ID and two small metadata fields: the opaque read-policy
 * key the record was indexed under (`p`, filtered on) and its source
 * version (`v`). No source text. One index is one generation: a model,
 * revision, dimension count and metric (Vectorize fixes dimensions and
 * metric per index), so a model change is a new index, filled and checked
 * before anything reads from it.
 *
 * Every search is filtered by the read-policy keys the caller holds now,
 * applied by the provider before it picks the nearest vectors. There is no
 * unfiltered search: no keys, no query. A matched ID is a candidate only:
 * provider writes and deletes are applied seconds later, so the caller
 * rechecks current grants and the source's state before using one.
 */
import { deadline, whenAborted } from "@grasp-os/shared/deadline";

/** The distance metrics a generation can use. */
export type VectorMetric = "cosine" | "euclidean" | "dot-product";

/** What every vector of one index generation was made with. */
export interface VectorGeneration {
  /** Names the generation, e.g. `bge-m3-1024-cosine-1`. */
  id: string;
  model: string;
  revision: string;
  dimensions: number;
  metric: VectorMetric;
}

/** A vector to index, under the read policy that decides who may find it. */
export interface VectorRecord {
  /** At most {@link maxIdBytes} bytes. */
  id: string;
  values: readonly number[];
  /** The opaque read-policy key; at most {@link maxPolicyKeyBytes} bytes. */
  policy: string;
  sourceVersion: string;
}

export interface VectorMatch {
  id: string;
  score: number;
}

export interface VectorSearch {
  /** Nearest first. */
  matches: VectorMatch[];
  /**
   * False when the caller holds more policy keys than one bounded search
   * covers: then the matches come from part of what they may read, and
   * the absence of a match proves nothing.
   */
  complete: boolean;
}

export interface VectorQuery {
  /** The read-policy keys the caller holds now. */
  policies: readonly string[];
  /** At most {@link maxTopK}. */
  topK: number;
}

export interface VectorIndexStatus {
  generation: string;
  dimensions: number;
  vectors: number;
  /** The last write the provider has applied, if it says. */
  appliedUpTo?: string;
}

export interface VectorIndex {
  readonly profile: "vectorize" | "unsupported";
  query: (
    vector: readonly number[],
    query: VectorQuery
  ) => Promise<VectorSearch>;
  /** Replaces each record whole. Safe to repeat with the same records. */
  upsert: (records: readonly VectorRecord[]) => Promise<void>;
  /** Safe to repeat; an ID that isn't there is no error. */
  delete: (ids: readonly string[]) => Promise<void>;
  /** Fails `invalid` when the index isn't of this generation. */
  status: () => Promise<VectorIndexStatus>;
}

/**
 * Why a vector index call failed. `unsupported`: this profile has no vector
 * adapter. `unavailable`: the provider failed or didn't answer in time; a
 * write may have been applied in part, so it is repeated whole. `invalid`:
 * the input or the index doesn't fit the generation or the provider's
 * limits; repeating it won't help.
 */
export class VectorIndexError extends Error {
  readonly kind: "unsupported" | "unavailable" | "invalid";

  constructor(
    kind: VectorIndexError["kind"],
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "VectorIndexError";
    this.kind = kind;
  }
}

// Vectorize's limits (developers.cloudflare.com/vectorize/platform/limits,
// .../reference/metadata-filtering), checked here so a request that breaks
// one fails before it reaches the provider, and so the policy filter never
// relies on a limit the provider applies silently.
export const maxDimensions = 1536;
export const maxIdBytes = 64;
/**
 * A metadata index keeps only the first 64 bytes of a string. Two longer
 * keys with the same first 64 bytes would match each other's filter, so a
 * longer key is refused rather than truncated.
 */
export const maxPolicyKeyBytes = 64;
/** Without values or metadata returned. */
export const maxTopK = 100;
/** A filter's compact JSON must be shorter than this. */
const maxFilterBytes = 2048;
const maxWriteBatch = 1000;

/** Policy-key batches one search may run before it reports itself incomplete. */
export const maxPolicyBatches = 4;

const queryDeadlineMs = 5000;
const writeDeadlineMs = 15_000;

const policyField = "p";
const versionField = "v";

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

const filterOf = (
  policies: readonly string[]
): VectorizeVectorMetadataFilter => ({
  [policyField]: { $in: [...policies] },
});

const checkPolicyKey = (key: string): void => {
  const bytes = bytesOf(key);
  if (bytes === 0 || bytes > maxPolicyKeyBytes) {
    throw new VectorIndexError(
      "invalid",
      `A read-policy key must be 1 to ${maxPolicyKeyBytes} bytes.`
    );
  }
};

/**
 * The caller's policy keys, deduplicated and sorted, split into filters
 * Vectorize accepts, at most {@link maxPolicyBatches} of them. Each key must
 * be one the index can match exactly.
 */
export const policyFilters = (
  policies: readonly string[]
): { filters: VectorizeVectorMetadataFilter[]; complete: boolean } => {
  const keys = [...new Set(policies)].toSorted();
  for (const key of keys) {
    checkPolicyKey(key);
  }
  const filters: VectorizeVectorMetadataFilter[] = [];
  let batch: string[] = [];
  for (const key of keys) {
    const grown = [...batch, key];
    if (bytesOf(JSON.stringify(filterOf(grown))) < maxFilterBytes) {
      batch = grown;
      continue;
    }
    filters.push(filterOf(batch));
    batch = [key];
  }
  if (batch.length > 0) {
    filters.push(filterOf(batch));
  }
  return {
    filters: filters.slice(0, maxPolicyBatches),
    complete: filters.length <= maxPolicyBatches,
  };
};

/** Nearest first: the highest score, or for euclidean the lowest distance. */
export const nearestFirst =
  (metric: VectorMetric) =>
  (a: VectorMatch, b: VectorMatch): number =>
    metric === "euclidean" ? a.score - b.score : b.score - a.score;

const checkVector = (
  generation: VectorGeneration,
  values: readonly number[]
): void => {
  if (
    values.length !== generation.dimensions ||
    !values.every((value) => Number.isFinite(value))
  ) {
    throw new VectorIndexError(
      "invalid",
      `A vector of generation ${generation.id} has ${generation.dimensions} finite values.`
    );
  }
};

const checkRecord = (
  generation: VectorGeneration,
  record: VectorRecord
): void => {
  const idBytes = bytesOf(record.id);
  if (idBytes === 0 || idBytes > maxIdBytes) {
    throw new VectorIndexError(
      "invalid",
      `A vector ID must be 1 to ${maxIdBytes} bytes.`
    );
  }
  checkPolicyKey(record.policy);
  checkVector(generation, record.values);
};

const inBatches = <Item>(items: readonly Item[]): Item[][] => {
  const batches: Item[][] = [];
  for (let start = 0; start < items.length; start += maxWriteBatch) {
    batches.push(items.slice(start, start + maxWriteBatch));
  }
  return batches;
};

/**
 * `call`'s answer, or {@link VectorIndexError} `unavailable` when it fails
 * or takes longer than `deadlineMs`.
 */
const fromProvider = async <Result>(
  what: string,
  deadlineMs: number,
  call: () => Promise<Result>
): Promise<Result> => {
  const limit = deadline(deadlineMs);
  try {
    return await Promise.race([call(), whenAborted(limit.signal)]);
  } catch (error) {
    if (limit.stopped() === "timeout") {
      throw new VectorIndexError(
        "unavailable",
        `The vector index didn't ${what} within ${deadlineMs} ms.`
      );
    }
    throw new VectorIndexError(
      "unavailable",
      `The vector index couldn't ${what}.`,
      { cause: error }
    );
  } finally {
    limit.clear();
  }
};

/** What the adapter uses of a Vectorize index binding. */
export type VectorizeBinding = Pick<
  Vectorize,
  "describe" | "query" | "upsert" | "deleteByIds"
>;

export interface VectorizeOptions {
  /** Defaults to 5 s. */
  queryDeadlineMs?: number;
  /** Defaults to 15 s. */
  writeDeadlineMs?: number;
}

/**
 * The `vectorize` profile: `binding` is the Vectorize index of
 * `generation`, created with its dimensions and metric and with a metadata
 * index on `p` before its first vector.
 */
export const vectorizeIndex = (
  binding: VectorizeBinding,
  generation: VectorGeneration,
  options: VectorizeOptions = {}
): VectorIndex => {
  if (
    !Number.isInteger(generation.dimensions) ||
    generation.dimensions < 1 ||
    generation.dimensions > maxDimensions
  ) {
    throw new VectorIndexError(
      "invalid",
      `A Vectorize generation has 1 to ${maxDimensions} dimensions.`
    );
  }
  const queryDeadline = options.queryDeadlineMs ?? queryDeadlineMs;
  const writeDeadline = options.writeDeadlineMs ?? writeDeadlineMs;

  const query = async (
    vector: readonly number[],
    { policies, topK }: VectorQuery
  ): Promise<VectorSearch> => {
    if (!Number.isInteger(topK) || topK < 1 || topK > maxTopK) {
      throw new VectorIndexError("invalid", `topK is 1 to ${maxTopK}.`);
    }
    checkVector(generation, vector);
    const { filters, complete } = policyFilters(policies);
    const answers = await Promise.all(
      filters.map(
        async (filter) =>
          await fromProvider(
            "search",
            queryDeadline,
            async () =>
              await binding.query([...vector], {
                topK,
                filter,
                returnValues: false,
                returnMetadata: "none",
              })
          )
      )
    );
    const matches = answers
      .flatMap(({ matches: found }) =>
        found.map(({ id, score }) => ({ id, score }))
      )
      .toSorted(nearestFirst(generation.metric))
      .slice(0, topK);
    return { matches, complete };
  };

  const upsert = async (records: readonly VectorRecord[]): Promise<void> => {
    for (const record of records) {
      checkRecord(generation, record);
    }
    for (const batch of inBatches(records)) {
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time, so a failure leaves the later ones unsent
      await fromProvider(
        "save vectors",
        writeDeadline,
        async () =>
          await binding.upsert(
            batch.map((record) => ({
              id: record.id,
              values: [...record.values],
              metadata: {
                [policyField]: record.policy,
                [versionField]: record.sourceVersion,
              },
            }))
          )
      );
    }
  };

  const remove = async (ids: readonly string[]): Promise<void> => {
    for (const batch of inBatches([...new Set(ids)])) {
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time, so a failure leaves the later ones unsent
      await fromProvider(
        "delete vectors",
        writeDeadline,
        async () => await binding.deleteByIds(batch)
      );
    }
  };

  const status = async (): Promise<VectorIndexStatus> => {
    const info = await fromProvider(
      "describe itself",
      queryDeadline,
      async () => await binding.describe()
    );
    if (info.dimensions !== generation.dimensions) {
      throw new VectorIndexError(
        "invalid",
        `The vector index has ${info.dimensions} dimensions, not the ${generation.dimensions} of generation ${generation.id}.`
      );
    }
    return {
      generation: generation.id,
      dimensions: info.dimensions,
      vectors: info.vectorCount,
      appliedUpTo: String(info.processedUpToMutation),
    };
  };

  return { profile: "vectorize", query, upsert, delete: remove, status };
};

/**
 * The `unsupported` profile: refuses every call, saying why. Used wherever
 * no qualified vector adapter is bound, so semantic search is never
 * silently replaced.
 */
export const unsupportedVectorIndex = (): VectorIndex => {
  // oxlint-disable-next-line require-await -- refuses as a rejected promise, like the calls it stands in for
  const refuse = async (): Promise<never> => {
    throw new VectorIndexError(
      "unsupported",
      "This deployment profile has no qualified vector index, so semantic search is unsupported here. A full-text fallback must report reduced coverage."
    );
  };
  return {
    profile: "unsupported",
    query: refuse,
    upsert: refuse,
    delete: refuse,
    status: refuse,
  };
};

/**
 * The vector index of this deployment: Vectorize where its binding is
 * there, the `unsupported` profile anywhere else.
 */
export const vectorIndexOf = (
  binding: VectorizeBinding | undefined,
  generation: VectorGeneration,
  options?: VectorizeOptions
): VectorIndex =>
  binding === undefined
    ? unsupportedVectorIndex()
    : vectorizeIndex(binding, generation, options);
