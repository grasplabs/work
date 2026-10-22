/**
 * The `vectorize` profile of the vector index (vector-index.ts): Cloudflare
 * Vectorize, through Worker bindings. Vectorize has no EU jurisdiction, so
 * it is used only where the client's model rules allow processing outside
 * the EU (vector-index-profile.ts).
 *
 * One Vectorize index is one generation: Vectorize fixes dimensions and
 * metric per index, and can show nothing else of a generation. A Worker
 * can't create, drop or list indexes, so each generation's index is
 * created with Wrangler (its dimensions and metric, and a string metadata
 * index on `p` before its first vector) and bound to core.
 *
 * A record keeps its read-policy key in metadata field `p`, which every
 * search filters on with `$in`, and its source version in `v`. Namespaces
 * stay unused: a vector has one, so a namespace can't express "any of the
 * caller's keys".
 */
import {
  checkGeneration,
  checkIds,
  checkQuery,
  checkRecords,
  fromProvider,
  mergeNearest,
  reservedPrefix,
  VectorIndexError,
} from "./vector-index.ts";
import type {
  VectorGeneration,
  VectorIdPage,
  VectorIndex,
  VectorIndexProvider,
  VectorIndexStatus,
  VectorRecord,
} from "./vector-index.ts";

/** What the adapter uses of a Vectorize index binding. */
export type VectorizeBinding = Pick<
  Vectorize,
  "describe" | "query" | "upsert" | "deleteByIds" | "getByIds"
>;

/**
 * A page of an index's vector IDs, from the start without a cursor. A
 * binding can't list, so this is Vectorize's REST `list-vectors` route,
 * reached through connect.
 */
export type VectorizeLister = (
  cursor: string | undefined
) => Promise<{ ids: string[]; cursor?: string }>;

export interface VectorizeOptions {
  /** Without it, `ids` (and so `drop`) fails `unsupported`. */
  list?: VectorizeLister;
  /** Defaults to 5 s. */
  queryDeadlineMs?: number;
  /** Defaults to 15 s. */
  writeDeadlineMs?: number;
}

const policyField = "p";
const versionField = "v";
const maxWriteBatch = 1000;
/** IDs read back per `getByIds`: small, so a read stays well within limits. */
const readBatch = 20;
const queryDeadlineMs = 5000;
/**
 * How often `drop` asks whether its deletes have applied: about this many
 * times within the write deadline, within these bounds.
 */
const dropPolls = 20;
const minDropPollMs = 10;
const maxDropPollMs = 1000;
const writeDeadlineMs = 15_000;

/**
 * The sentinel `status` writes and searches for, under a reserved key no
 * caller can hold, find, overwrite, delete or list.
 */
const probeId = `${reservedPrefix}filter-probe`;
const probePolicy = `${reservedPrefix}filter-probe`;

const filterOf = (
  policies: readonly string[]
): VectorizeVectorMetadataFilter => ({
  [policyField]: { $in: [...policies] },
});

const inBatches = <Item>(items: readonly Item[], size: number): Item[][] => {
  const batches: Item[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
};

/** The index, and the provider's way to empty it. */
const vectorizeGeneration = (
  binding: VectorizeBinding,
  generation: VectorGeneration,
  options: VectorizeOptions
): { index: VectorIndex; drop: () => Promise<void> } => {
  checkGeneration(generation);
  const queryDeadline = options.queryDeadlineMs ?? queryDeadlineMs;
  const writeDeadline = options.writeDeadlineMs ?? writeDeadlineMs;

  const write = async (vectors: VectorizeVector[]): Promise<void> => {
    await fromProvider(
      "save vectors",
      writeDeadline,
      async () => await binding.upsert(vectors)
    );
  };

  const erase = async (ids: string[]): Promise<void> => {
    await fromProvider(
      "delete vectors",
      writeDeadline,
      async () => await binding.deleteByIds(ids)
    );
  };

  const upsert = async (records: readonly VectorRecord[]): Promise<void> => {
    // What Vectorize does with one ID twice in a batch is undocumented:
    // the last record of an ID is the only one sent.
    const latest = checkRecords(generation, records);
    for (const batch of inBatches(latest, maxWriteBatch)) {
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time, so a failure leaves the later ones unsent
      await write(
        batch.map((record) => ({
          id: record.id,
          values: [...record.values],
          metadata: {
            [policyField]: record.policy,
            [versionField]: record.sourceVersion,
          },
        }))
      );
    }
  };

  const remove = async (ids: readonly string[]): Promise<void> => {
    for (const batch of inBatches(checkIds(ids), maxWriteBatch)) {
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time, so a failure leaves the later ones unsent
      await erase(batch);
    }
  };

  /** A page of every ID the index holds, the sentinel's included. */
  const listed = async (
    cursor?: string
  ): Promise<{ ids: string[]; cursor?: string }> => {
    const { list } = options;
    if (list === undefined) {
      throw new VectorIndexError(
        "unsupported",
        "A Vectorize binding can't list its vectors: listing needs Vectorize's REST list-vectors route, through connect."
      );
    }
    return await fromProvider(
      "list vectors",
      queryDeadline,
      async () => await list(cursor)
    );
  };

  const ids = async (cursor?: string): Promise<VectorIdPage> => {
    const page = await listed(cursor);
    const callers = page.ids.filter((id) => !id.startsWith(reservedPrefix));
    const read = await Promise.all(
      inBatches(callers, readBatch).map(
        async (batch) =>
          await fromProvider(
            "read vectors",
            queryDeadline,
            async () => await binding.getByIds(batch)
          )
      )
    );
    const versions = new Map(
      read
        .flat()
        .map(({ id, metadata }) => [id, metadata?.[versionField]] as const)
    );
    // A vector deleted since it was listed isn't read back: it is left
    // out. One read back without a string version is damaged: listed, with
    // none.
    const entries = callers.flatMap((id) => {
      if (!versions.has(id)) {
        return [];
      }
      const sourceVersion = versions.get(id);
      return [
        {
          id,
          sourceVersion:
            typeof sourceVersion === "string" ? sourceVersion : null,
        },
      ];
    });
    return page.cursor === undefined
      ? { entries }
      : { entries, cursor: page.cursor };
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
    // Written earlier but not found through the filter: the metadata index
    // on `p` is missing, isn't a string index, or came after the sentinel,
    // and the records written then can't be filtered either.
    if (written.length > 0) {
      return "failing";
    }
    // Vectorize applies writes seconds later: the next status proves it.
    await write([
      {
        id: probeId,
        values: probe,
        metadata: { [policyField]: probePolicy, [versionField]: "probe" },
      },
    ]);
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

  // Whether this index's policy filter is proven, once per adapter: until
  // it is, a search could answer "nothing" for a filter the index can't
  // apply. A failed proof isn't kept, so a later search tries again.
  let proven: Promise<void> | undefined;
  const provenFiltering = async (): Promise<void> => {
    proven ??= (async () => {
      const { filtering } = await status();
      if (filtering !== "working") {
        throw new VectorIndexError(
          "unavailable",
          `The vector index's policy filter is ${filtering === "unproven" ? "not proven yet" : "failing"}, so it isn't searched.`
        );
      }
    })();
    try {
      await proven;
    } catch (error) {
      proven = undefined;
      throw error;
    }
  };

  const query: VectorIndex["query"] = async (vector, search) => {
    const { batches, complete } = checkQuery(generation, vector, search);
    if (batches.length === 0) {
      return { matches: [], complete };
    }
    await provenFiltering();
    const answers = await Promise.all(
      batches.map(
        async (batch) =>
          await fromProvider(
            "search",
            queryDeadline,
            async () =>
              await binding.query([...vector], {
                topK: search.topK,
                filter: filterOf(batch),
                returnValues: false,
                returnMetadata: "none",
              })
          )
      )
    );
    return {
      matches: mergeNearest(
        answers.map(({ matches }) => matches),
        generation.metric,
        search.topK
      ),
      complete,
    };
  };

  /**
   * Deletes every ID the index lists, whatever its records hold, and the
   * sentinel; then waits until Vectorize has applied the deletes and lists
   * nothing, for at most the write deadline, or fails `unavailable`.
   */
  const drop = async (): Promise<void> => {
    let cursor: string | undefined;
    do {
      // oxlint-disable-next-line no-await-in-loop -- page after page, each deleted before the next is listed
      const page = await listed(cursor);
      for (const batch of inBatches(page.ids, maxWriteBatch)) {
        // oxlint-disable-next-line no-await-in-loop -- one batch at a time
        await erase(batch);
      }
      ({ cursor } = page);
    } while (cursor !== undefined);
    await erase([probeId]);
    const endsAt = Date.now() + writeDeadline;
    const interval = Math.min(
      maxDropPollMs,
      Math.max(minDropPollMs, writeDeadline / dropPolls)
    );
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- polls until the deletes apply
      const left = await listed();
      if (left.ids.length === 0) {
        return;
      }
      if (Date.now() + interval > endsAt) {
        throw new VectorIndexError(
          "unavailable",
          `The vector index didn't apply its deletes within ${writeDeadline} ms; drop it again.`
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      await scheduler.wait(interval);
    }
  };

  return {
    index: {
      profile: "vectorize",
      generation,
      query,
      upsert,
      delete: remove,
      ids,
      status,
    },
    drop,
  };
};

/**
 * The index of `generation` behind `binding`, created with its dimensions
 * and metric and with a metadata index on `p` before its first vector.
 */
export const vectorizeIndex = (
  binding: VectorizeBinding,
  generation: VectorGeneration,
  options: VectorizeOptions = {}
): VectorIndex => vectorizeGeneration(binding, generation, options).index;

/** One generation's Vectorize index, as bound to core. */
export interface VectorizeGenerationBinding {
  generation: VectorGeneration;
  binding: VectorizeBinding;
  /** That index's REST `list-vectors` route; see {@link VectorizeLister}. */
  list?: VectorizeLister;
}

const sameGeneration = (a: VectorGeneration, b: VectorGeneration): boolean =>
  a.id === b.id &&
  a.model === b.model &&
  a.revision === b.revision &&
  a.route === b.route &&
  a.dimensions === b.dimensions &&
  a.metric === b.metric;

/**
 * The `vectorize` provider: the generations whose indexes are bound. A
 * Worker can't create or delete an index, so `create` checks the bound
 * index and writes the sentinel that proves its filter, and `drop` empties
 * it; the index stays bound, and in `generations`, until its binding is
 * removed.
 */
export const vectorizeProvider = (
  bound: readonly VectorizeGenerationBinding[],
  options: Pick<VectorizeOptions, "queryDeadlineMs" | "writeDeadlineMs"> = {}
): VectorIndexProvider => {
  const indexes = new Map(
    bound.map(({ generation, binding, list }) => [
      generation.id,
      {
        generation,
        ...vectorizeGeneration(binding, generation, {
          ...options,
          ...(list === undefined ? {} : { list }),
        }),
      },
    ])
  );
  const boundOf = (generation: VectorGeneration) => {
    const found = indexes.get(generation.id);
    if (found === undefined || !sameGeneration(found.generation, generation)) {
      throw new VectorIndexError(
        "invalid",
        `No Vectorize index is bound for generation ${generation.id}: create it with Wrangler, with a metadata index on p, and bind it to core.`
      );
    }
    return found;
  };
  const open = (generation: VectorGeneration): VectorIndex =>
    boundOf(generation).index;
  return {
    profile: "vectorize",
    create: async (generation) => await open(generation).status(),
    open,
    drop: async (generation) => {
      await boundOf(generation).drop();
    },
    // oxlint-disable-next-line require-await -- the contract's promise, for providers that look theirs up
    generations: async () =>
      [...indexes.values()].map(({ generation }) => generation),
  };
};
