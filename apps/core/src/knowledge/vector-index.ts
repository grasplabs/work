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
  /** At most {@link maxSourceVersionBytes} bytes. */
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
  /**
   * The read-policy keys the caller holds now, most important first: when
   * there are more than one search covers, the last ones are left out.
   */
  policies: readonly string[];
  /** At most {@link maxTopK}. */
  topK: number;
}

export interface VectorIndexStatus {
  /** The generation this adapter was given; only its dimensions are checked. */
  generation: string;
  dimensions: number;
  vectors: number;
  /** The last write the provider has applied, if it says. */
  appliedUpTo?: string;
  /**
   * Whether the policy filter is proven to work on this index, by a
   * sentinel written under a reserved key and found through that key's
   * filter. `working`: found. `unproven`: just written, as on the first
   * status of a new index; writes apply seconds later, so ask again.
   * `failing`: written earlier but not found through the filter, so the
   * metadata index on `p` is missing, isn't a string index, or was created
   * after the sentinel, and the records written then are as unfilterable
   * (or the sentinel's write is still being applied). Only `working` may
   * be searched; `failing` needs the index rebuilt.
   */
  filtering: "working" | "unproven" | "failing";
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
  /**
   * Fails `invalid` when the index's dimensions aren't the generation's.
   * The provider can show nothing else of a generation (its model,
   * revision or metric), so provisioning pins each index to one: an index
   * per generation, created with its dimensions and metric. Called first
   * when the index is created, before any record, so its sentinel proves
   * the metadata index was there before them.
   */
  status: () => Promise<VectorIndexStatus>;
}

/**
 * Why a vector index call failed. `unsupported`: this profile has no vector
 * adapter. `invalid`: the input doesn't fit the generation or the
 * provider's documented limits, or `status` found an index of other
 * dimensions; repeating it won't help. `unavailable`: anything the
 * provider did instead of answering, in time or at all. Its errors carry
 * no documented classes, so an outage and a misprovisioned index both land
 * here: a caller retries a bounded number of times, then degrades and
 * reports it, and `status` tells an operator which it is. A write may have
 * been applied in part, so it is repeated whole.
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
/**
 * Keeps a vector's metadata (the policy key, this and their field names)
 * far below Vectorize's 10 KiB.
 */
export const maxSourceVersionBytes = 256;
/** Without values or metadata returned. */
export const maxTopK = 100;
/** A filter's compact JSON must be shorter than this. */
const maxFilterBytes = 2048;
/**
 * Vectorize documents no limit on an `$in` list's length, only on the
 * filter's size. Staying at 100 keeps an undocumented one from turning a
 * grant set into a refused search; few more short keys fit in a filter.
 */
export const maxPolicyKeysPerFilter = 100;
const maxWriteBatch = 1000;

/**
 * Policy-key batches one search may run before it reports itself
 * incomplete. The keys it leaves out are the caller's last ones, so a
 * caller orders its keys by importance.
 */
export const maxPolicyBatches = 4;

const queryDeadlineMs = 5000;
const writeDeadlineMs = 15_000;

/**
 * Policy keys and IDs starting with this are the adapter's own, never a
 * caller's: the sentinel {@link VectorIndex.status} writes and searches
 * for, which no caller can hold, find, overwrite or delete.
 */
export const reservedPrefix = "!";
const probeId = `${reservedPrefix}filter-probe`;
const probePolicy = `${reservedPrefix}filter-probe`;

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
  if (key.startsWith(reservedPrefix)) {
    throw new VectorIndexError(
      "invalid",
      `A read-policy key can't start with ${reservedPrefix}.`
    );
  }
};

/**
 * The caller's policy keys, deduplicated in their order, split into
 * filters Vectorize accepts, at most {@link maxPolicyBatches} of them, the
 * first keys first. Each key must be one the index can match exactly.
 */
export const policyFilters = (
  policies: readonly string[]
): { filters: VectorizeVectorMetadataFilter[]; complete: boolean } => {
  const keys = [...new Set(policies)];
  for (const key of keys) {
    checkPolicyKey(key);
  }
  // A filter's size is its fixed part plus each key as JSON, with commas
  // between them, so it grows by key without serialising it again.
  const emptyBytes = bytesOf(JSON.stringify(filterOf([])));
  const filters: VectorizeVectorMetadataFilter[] = [];
  let batch: string[] = [];
  let batchBytes = emptyBytes;
  for (const key of keys) {
    const keyBytes = bytesOf(JSON.stringify(key)) + (batch.length > 0 ? 1 : 0);
    if (
      batch.length < maxPolicyKeysPerFilter &&
      batchBytes + keyBytes < maxFilterBytes
    ) {
      batch.push(key);
      batchBytes += keyBytes;
      continue;
    }
    filters.push(filterOf(batch));
    if (filters.length === maxPolicyBatches) {
      return { filters, complete: false };
    }
    batch = [key];
    batchBytes = emptyBytes + keyBytes - 1;
  }
  if (batch.length > 0) {
    filters.push(filterOf(batch));
  }
  return { filters, complete: true };
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
    // A hole in a sparse array is no value: `every` would skip it.
    ![...values].every((value) => Number.isFinite(value))
  ) {
    throw new VectorIndexError(
      "invalid",
      `A vector of generation ${generation.id} has ${generation.dimensions} finite values.`
    );
  }
};

const checkId = (id: string): void => {
  const idBytes = bytesOf(id);
  if (idBytes === 0 || idBytes > maxIdBytes) {
    throw new VectorIndexError(
      "invalid",
      `A vector ID must be 1 to ${maxIdBytes} bytes.`
    );
  }
  if (id.startsWith(reservedPrefix)) {
    throw new VectorIndexError(
      "invalid",
      `A vector ID can't start with ${reservedPrefix}.`
    );
  }
};

const checkRecord = (
  generation: VectorGeneration,
  record: VectorRecord
): void => {
  checkId(record.id);
  checkPolicyKey(record.policy);
  const versionBytes = bytesOf(record.sourceVersion);
  if (versionBytes === 0 || versionBytes > maxSourceVersionBytes) {
    throw new VectorIndexError(
      "invalid",
      `A source version must be 1 to ${maxSourceVersionBytes} bytes.`
    );
  }
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
  "describe" | "query" | "upsert" | "deleteByIds" | "getByIds"
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
    // A record whose policy changed between two batches' reads can be in
    // both answers: it counts once, at its nearest.
    const nearest = new Map<string, VectorMatch>();
    for (const { id, score } of answers
      .flatMap(({ matches: found }) => found)
      .toSorted(nearestFirst(generation.metric))) {
      if (!nearest.has(id)) {
        nearest.set(id, { id, score });
      }
    }
    const matches = [...nearest.values()].slice(0, topK);
    return { matches, complete };
  };

  const upsert = async (records: readonly VectorRecord[]): Promise<void> => {
    for (const record of records) {
      checkRecord(generation, record);
    }
    // The last record of an ID replaces the earlier ones, as a later call
    // would; what Vectorize does with one ID twice in a batch is undocumented.
    const latest = [
      ...new Map(records.map((record) => [record.id, record])).values(),
    ];
    for (const batch of inBatches(latest)) {
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
    for (const id of ids) {
      checkId(id);
    }
    for (const batch of inBatches([...new Set(ids)])) {
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time, so a failure leaves the later ones unsent
      await fromProvider(
        "delete vectors",
        writeDeadline,
        async () => await binding.deleteByIds(batch)
      );
    }
  };

  /** Whether the sentinel comes back through its own key's filter. */
  const probeFiltering = async (): Promise<VectorIndexStatus["filtering"]> => {
    const probe = Array.from({ length: generation.dimensions }, (_, n) =>
      n === 0 ? 1 : 0
    );
    const found = await fromProvider(
      "search",
      queryDeadline,
      async () =>
        await binding.query(probe, {
          topK: 1,
          filter: filterOf([probePolicy]),
          returnValues: false,
          returnMetadata: "none",
        })
    );
    if (found.matches.some(({ id }) => id === probeId)) {
      return "working";
    }
    const written = await fromProvider(
      "read vectors",
      queryDeadline,
      async () => await binding.getByIds([probeId])
    );
    if (written.length > 0) {
      return "failing";
    }
    await fromProvider(
      "save vectors",
      writeDeadline,
      async () =>
        await binding.upsert([
          {
            id: probeId,
            values: probe,
            metadata: { [policyField]: probePolicy, [versionField]: "probe" },
          },
        ])
    );
    return "unproven";
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
    // Typed as a number, but an index with no writes yet may report none.
    const applied: number | null | undefined = info.processedUpToMutation;
    return {
      generation: generation.id,
      dimensions: info.dimensions,
      vectors: info.vectorCount,
      ...(typeof applied === "number" ? { appliedUpTo: String(applied) } : {}),
      filtering: await probeFiltering(),
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
