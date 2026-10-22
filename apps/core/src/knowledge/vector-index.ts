/**
 * Brain's single-vector index: the portable contract semantic recall goes
 * through, which every deployment profile implements, so the service
 * behind it can be swapped per profile.
 *
 * - `vectorize`: Cloudflare Vectorize, through Worker bindings
 *   (vectorize-index.ts). Only where the client's model rules allow
 *   processing outside the EU (vector-index-profile.ts).
 * - `sqlite`: SQLite Durable Objects, in `jurisdiction("eu")` on Cloudflare
 *   and on plain workerd on-prem.
 * - `external`: a vector store in the client's network, reached through
 *   connect.
 * - `unsupported`: no vector index here. Every call fails with
 *   {@link VectorIndexError} `unsupported` instead of answering as if
 *   nothing matched. A caller that falls back to full-text search must say
 *   its coverage is reduced; an empty answer would claim the information
 *   isn't there.
 *
 * The index is a rebuildable projection, never an authority. It holds
 * vectors, their ID, the opaque read-policy key each was indexed under and
 * its source version. No source text. One index is one generation (see
 * {@link VectorGeneration}), so a model change is a new generation, filled
 * and checked before anything reads from it (vector-rebuild.ts).
 *
 * Every search is filtered by the read-policy keys the caller holds now,
 * before the nearest vectors are picked. There is no unfiltered search: no
 * keys, no query. A matched ID is a candidate only: a provider may apply
 * writes and deletes later, so the caller rechecks current grants and the
 * source's state before using one.
 *
 * Every implementation keeps to the strictest provider's limits, below, and
 * the same policy batching ({@link policyBatches}), so the application
 * behaves the same on every profile. The shared behaviour suite every
 * implementation passes is test/vector-index-conformance.ts.
 */
import { deadline, whenAborted } from "@grasp-os/shared/deadline";

export type VectorIndexProfile =
  | "vectorize"
  | "sqlite"
  | "external"
  | "unsupported";

/** The distance metrics a generation can use. */
export type VectorMetric = "cosine" | "euclidean" | "dot-product";

/** What every vector of one generation was made with, and where. */
export interface VectorGenerationSpec {
  /** The embedding model, e.g. `@cf/baai/bge-m3`. */
  model: string;
  revision: string;
  /**
   * The route that served the model, e.g. `workers-ai` or a local server:
   * the same weights served two ways (quantised, another context length)
   * can give other vectors, so each route is its own generation.
   */
  route: string;
  dimensions: number;
  metric: VectorMetric;
}

/**
 * One index generation. Its ID names everything in the spec, so vectors of
 * two generations are never compared: see {@link vectorGeneration}.
 */
export interface VectorGeneration extends VectorGenerationSpec {
  id: string;
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

/** A record as listed: what reconciling an index needs of it. */
export interface VectorIdEntry {
  id: string;
  /**
   * `null` for a damaged record, whose source version the index doesn't
   * hold: it is listed all the same, so an audit or a reconciliation sees
   * it, and a drop removes it.
   */
  sourceVersion: string | null;
}

export interface VectorIdPage {
  entries: VectorIdEntry[];
  /** Where the next page starts; absent on the last page. */
  cursor?: string;
}

export interface VectorIndexStatus {
  generation: string;
  dimensions: number;
  vectors: number;
  /** The last write the provider has applied, if it says. */
  appliedUpTo?: string;
  /**
   * Whether the policy filter is proven to work on this index. `working`:
   * proven. `unproven`: not yet, as on the first status of a new index
   * whose provider applies writes later; ask again. `failing`: the index
   * can't filter the records it holds and needs to be rebuilt. Only
   * `working` is searched.
   */
  filtering: "working" | "unproven" | "failing";
}

export interface VectorIndex {
  readonly profile: VectorIndexProfile;
  readonly generation: VectorGeneration;
  /** Fails `unavailable` while the policy filter isn't proven working. */
  query: (
    vector: readonly number[],
    query: VectorQuery
  ) => Promise<VectorSearch>;
  /**
   * Replaces each record whole; of one ID given twice, the last counts.
   * Safe to repeat. A failed write may have applied in part: repeat it
   * whole.
   */
  upsert: (records: readonly VectorRecord[]) => Promise<void>;
  /** Safe to repeat; an ID that isn't there is no error. */
  delete: (ids: readonly string[]) => Promise<void>;
  /**
   * Every record of the index, a page at a time, from the start without a
   * cursor: for exact export, deletion audits and reconciling the index
   * with its canonical sources. Fails `unsupported` where the provider
   * can't list.
   */
  ids: (cursor?: string) => Promise<VectorIdPage>;
  /** Fails `invalid` when the index doesn't hold this generation. */
  status: () => Promise<VectorIndexStatus>;
}

/** Creates, opens and drops a profile's index generations. */
export interface VectorIndexProvider {
  readonly profile: VectorIndexProfile;
  /**
   * Makes the generation's index ready for its first record, and says how
   * it is. Safe to repeat.
   */
  create: (generation: VectorGeneration) => Promise<VectorIndexStatus>;
  /** Fails `invalid` for a generation the provider doesn't have. */
  open: (generation: VectorGeneration) => VectorIndex;
  /**
   * Removes every record of the generation: once done, none can be found
   * or listed. Safe to repeat.
   */
  drop: (generation: VectorGeneration) => Promise<void>;
  /** The generations the provider has. */
  generations: () => Promise<VectorGeneration[]>;
}

/**
 * Why a vector index call failed. `unsupported`: this profile has no vector
 * index, or can't do what was asked. `eu_only`: the client's rules keep
 * this data in the EU and this provider can't. `invalid`: the input
 * doesn't fit the generation or the portable limits, or the index holds
 * another generation; repeating it won't help. `unavailable`: anything the
 * provider did instead of answering, in time or at all: a caller retries a
 * bounded number of times, then degrades and reports it. A write may have
 * been applied in part, so it is repeated whole.
 */
export class VectorIndexError extends Error {
  readonly kind: "unsupported" | "eu_only" | "unavailable" | "invalid";

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

// The portable limits: the strictest provider's, Vectorize's
// (developers.cloudflare.com/vectorize/platform/limits,
// .../reference/metadata-filtering). Every implementation checks them, so
// a request that breaks one fails before it reaches a provider, the same
// on every profile, and the policy filter never relies on a limit a
// provider applies silently.
export const maxDimensions = 1536;
export const maxIdBytes = 64;
/**
 * A Vectorize metadata index keeps only the first 64 bytes of a string.
 * Two longer keys with the same first 64 bytes would match each other's
 * filter, so a longer key is refused rather than truncated.
 */
export const maxPolicyKeyBytes = 64;
/** Keeps a vector's metadata far below Vectorize's 10 KiB. */
export const maxSourceVersionBytes = 256;
/** Without values or metadata returned. */
export const maxTopK = 100;
/** A Vectorize filter's compact JSON must be shorter than this. */
export const maxFilterBytes = 2048;
/**
 * Vectorize documents no limit on an `$in` list's length, only on the
 * filter's size. Staying at 100 keeps an undocumented one from turning a
 * grant set into a refused search.
 */
export const maxPolicyKeysPerFilter = 100;
/**
 * Policy-key batches one search may run before it reports itself
 * incomplete. The keys it leaves out are the caller's last ones, so a
 * caller orders its keys by importance.
 */
export const maxPolicyBatches = 4;

/**
 * Policy keys and IDs starting with this are an implementation's own,
 * never a caller's: no caller can hold, find, overwrite, delete or list
 * them.
 */
export const reservedPrefix = "!";

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The ID {@link vectorGeneration} gives a spec: its fields as a JSON array,
 * readable, and unambiguous whatever characters a model or route name
 * holds, where joining them with a separator would let two specs share an
 * ID.
 */
const generationIdOf = ({
  route,
  model,
  revision,
  dimensions,
  metric,
}: VectorGenerationSpec): string =>
  JSON.stringify([route, model, revision, dimensions, metric]);

/** A generation, named by everything that makes its vectors comparable. */
export const vectorGeneration = (
  spec: VectorGenerationSpec
): VectorGeneration => ({ ...spec, id: generationIdOf(spec) });

/** Refuses a generation whose ID doesn't name its spec, or out of limits. */
export const checkGeneration = (generation: VectorGeneration): void => {
  const { dimensions, model, revision, route } = generation;
  if (
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > maxDimensions
  ) {
    throw new VectorIndexError(
      "invalid",
      `A vector generation has 1 to ${maxDimensions} dimensions.`
    );
  }
  if (
    [model, revision, route].some((part) => part.length === 0) ||
    generation.id !== generationIdOf(generation)
  ) {
    throw new VectorIndexError(
      "invalid",
      `Generation ${generation.id} must name its model, revision, route, dimensions and metric.`
    );
  }
};

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

// A Vectorize filter on the keys of one batch is `{"p":{"$in":[…]}}`: its
// size is that fixed part plus each key as JSON, with commas between them.
const emptyFilterBytes = bytesOf(JSON.stringify({ p: { $in: [] } }));

/**
 * The caller's policy keys, deduplicated in their order, split into the
 * batches one search covers, at most {@link maxPolicyBatches}, the first
 * keys first; each batch fits one Vectorize filter. Every implementation
 * searches exactly these keys, so `complete` means the same everywhere.
 */
export const policyBatches = (
  policies: readonly string[]
): { batches: string[][]; complete: boolean } => {
  const keys = [...new Set(policies)];
  for (const key of keys) {
    checkPolicyKey(key);
  }
  const batches: string[][] = [];
  let batch: string[] = [];
  let batchBytes = emptyFilterBytes;
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
    batches.push(batch);
    if (batches.length === maxPolicyBatches) {
      return { batches, complete: false };
    }
    batch = [key];
    batchBytes = emptyFilterBytes + keyBytes - 1;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return { batches, complete: true };
};

/** Nearest first: the highest score, or for euclidean the lowest distance. */
export const nearestFirst =
  (metric: VectorMetric) =>
  (a: VectorMatch, b: VectorMatch): number =>
    metric === "euclidean" ? a.score - b.score : b.score - a.score;

/**
 * The `topK` nearest of several batches' answers. A record whose policy
 * changed between two batches' reads can be in both: it counts once, at
 * its nearest.
 */
export const mergeNearest = (
  answers: readonly (readonly VectorMatch[])[],
  metric: VectorMetric,
  topK: number
): VectorMatch[] => {
  const nearest = new Map<string, VectorMatch>();
  for (const { id, score } of answers.flat().toSorted(nearestFirst(metric))) {
    if (!nearest.has(id)) {
      nearest.set(id, { id, score });
    }
  }
  return [...nearest.values()].slice(0, topK);
};

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

/**
 * Checks a search against the portable limits, and returns the policy
 * batches it runs.
 */
export const checkQuery = (
  generation: VectorGeneration,
  vector: readonly number[],
  { policies, topK }: VectorQuery
): { batches: string[][]; complete: boolean } => {
  if (!Number.isInteger(topK) || topK < 1 || topK > maxTopK) {
    throw new VectorIndexError("invalid", `topK is 1 to ${maxTopK}.`);
  }
  checkVector(generation, vector);
  return policyBatches(policies);
};

/**
 * Checks records against the portable limits, and returns them with the
 * last of each ID only, in order, as a later call would leave them.
 */
export const checkRecords = (
  generation: VectorGeneration,
  records: readonly VectorRecord[]
): VectorRecord[] => {
  for (const record of records) {
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
  }
  return [...new Map(records.map((record) => [record.id, record])).values()];
};

/** Checks IDs against the portable limits, and returns each once. */
export const checkIds = (ids: readonly string[]): string[] => {
  for (const id of ids) {
    checkId(id);
  }
  return [...new Set(ids)];
};

/**
 * `call`'s answer, or {@link VectorIndexError} `unavailable` when it fails
 * or takes longer than `deadlineMs`. A {@link VectorIndexError} `call`
 * throws itself passes as it is.
 */
export const fromProvider = async <Result>(
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
    // The implementation's own answer, such as a generation it refused.
    if (error instanceof VectorIndexError) {
      throw error;
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

/**
 * A provider that refuses every call with `error`: the `unsupported`
 * profile, and a provider the client's rules don't allow here.
 */
export const refusingProvider = (
  profile: VectorIndexProfile,
  error: () => VectorIndexError
): VectorIndexProvider => {
  // oxlint-disable-next-line require-await -- refuses as a rejected promise, like the calls it stands in for
  const refuse = async (): Promise<never> => {
    throw error();
  };
  return {
    profile,
    create: refuse,
    open: (generation) => ({
      profile,
      generation,
      query: refuse,
      upsert: refuse,
      delete: refuse,
      ids: refuse,
      status: refuse,
    }),
    drop: refuse,
    generations: refuse,
  };
};

/**
 * The `unsupported` profile: refuses every call, saying why. Used wherever
 * no vector index is bound, so semantic search is never silently replaced.
 */
export const unsupportedVectorIndexProvider = (): VectorIndexProvider =>
  refusingProvider(
    "unsupported",
    () =>
      new VectorIndexError(
        "unsupported",
        "This deployment has no vector index, so semantic search is unsupported here. A full-text fallback must report reduced coverage."
      )
  );
