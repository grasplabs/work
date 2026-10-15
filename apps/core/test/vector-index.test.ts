import { describe, expect, it } from "vite-plus/test";

import {
  maxPolicyBatches,
  maxPolicyKeyBytes,
  maxPolicyKeysPerFilter,
  reservedPrefix,
  policyFilters,
  unsupportedVectorIndex,
  vectorIndexOf,
  VectorIndexError,
} from "../src/knowledge/vector-index.ts";
import type {
  VectorIndex,
  VectorizeBinding,
  VectorGeneration,
  VectorRecord,
} from "../src/knowledge/vector-index.ts";

// Brain's vector index. These tests start from the ways it can fail or be
// abused: a search that reaches vectors outside the caller's read policies
// (no filter, a filter the provider truncates, a long key that collides
// with another after the provider's 64-byte prefix); a caller with many
// policies silently searched in part; a provider outage, a hang or a
// half-applied write reported as success; a vector of another generation
// mixed in; and a profile with no vector index answering "nothing found"
// instead of refusing. Vectorize, the outside provider, is replaced by a
// fake binding that filters before picking the nearest vectors and keeps
// only the first 64 bytes of an indexed string, as the provider documents.

const generation: VectorGeneration = {
  id: "test-3-cosine-1",
  model: "@cf/test/embedding",
  revision: "1",
  dimensions: 3,
  metric: "cosine",
};

const indexedPrefixBytes = 64;

const prefixOf = (text: string): string =>
  new TextDecoder().decode(
    new TextEncoder().encode(text).slice(0, indexedPrefixBytes)
  );

const norm = (v: readonly number[]): number => Math.hypot(...v);

const cosine = (a: readonly number[], b: readonly number[]): number => {
  const dot = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
  return dot / (norm(a) * norm(b));
};

interface Stored {
  values: number[];
  metadata: Record<string, VectorizeVectorMetadata>;
  /** The fields a metadata index took when it was written. */
  filterable: ReadonlySet<string>;
}

interface FakeBehaviour {
  failQueries: boolean;
  hang: boolean;
  failUpsertAfterBatches: number;
  afterQuery: () => void;
  /**
   * The metadata index on `p`, as it was when each vector was written: a
   * vector written before a string index on `p` existed never matches a
   * filter on `p`, as Vectorize documents.
   */
  metadataIndex: "string" | "number" | "none";
  /** An index that reports no applied write yet. */
  noAppliedMutation: boolean;
}

/** A Vectorize index in memory, with the failures a test asks for. */
const fakeVectorize = (
  dimensions = generation.dimensions,
  metric: VectorGeneration["metric"] = generation.metric
) => {
  const vectors = new Map<string, Stored>();
  // The adapter's own sentinel, kept apart so a test sees only its records.
  const reserved = new Map<string, Stored>();
  const storeOf = (id: string) =>
    id.startsWith(reservedPrefix) ? reserved : vectors;
  const filters: (VectorizeVectorMetadataFilter | undefined)[] = [];
  const behaviour: FakeBehaviour = {
    failQueries: false,
    hang: false,
    failUpsertAfterBatches: Number.POSITIVE_INFINITY,
    afterQuery: (): void => undefined,
    metadataIndex: "string",
    noAppliedMutation: false,
  };
  let upsertBatches = 0;
  const never = Promise.withResolvers<never>().promise;

  const matchesFilter = (
    stored: Stored,
    filter?: VectorizeVectorMetadataFilter
  ) => {
    if (filter === undefined) {
      return true;
    }
    return Object.entries(filter).every(([field, condition]) => {
      if (!stored.filterable.has(field)) {
        return false;
      }
      const value = stored.metadata[field];
      const indexed = typeof value === "string" ? prefixOf(value) : value;
      if (
        condition !== null &&
        typeof condition === "object" &&
        "$in" in condition
      ) {
        return (condition.$in ?? []).some(
          (wanted) =>
            (typeof wanted === "string" ? prefixOf(wanted) : wanted) === indexed
        );
      }
      return condition === indexed;
    });
  };

  const binding: VectorizeBinding = {
    describe: async () => {
      await Promise.resolve();
      // SAFETY: an index with no applied write answers null here, whatever
      // the binding's type says.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const none = JSON.parse("null") as number;
      return {
        vectorCount: vectors.size + reserved.size,
        dimensions,
        processedUpToDatetime: 0,
        processedUpToMutation: behaviour.noAppliedMutation
          ? none
          : upsertBatches,
      };
    },
    query: async (
      vector: VectorFloatArray | number[],
      options?: VectorizeQueryOptions
    ) => {
      if (behaviour.hang) {
        return await never;
      }
      if (behaviour.failQueries) {
        throw new Error(
          "VECTOR_QUERY_ERROR (code = 40000): upstream unavailable"
        );
      }
      await Promise.resolve();
      if (!JSON.stringify(options?.filter ?? {}).includes(reservedPrefix)) {
        filters.push(options?.filter);
      }
      // The index as this read saw it, before anything changes it.
      const answeredFrom = [...vectors, ...reserved].map(
        ([id, stored]): [string, Stored] => [
          id,
          { ...stored, metadata: { ...stored.metadata } },
        ]
      );
      behaviour.afterQuery();
      const matches = answeredFrom
        .filter(([, stored]) => matchesFilter(stored, options?.filter))
        .map(([id, stored]) => ({
          id,
          score:
            metric === "euclidean"
              ? Math.hypot(
                  ...stored.values.map((value, n) => value - (vector[n] ?? 0))
                )
              : cosine([...vector], stored.values),
        }))
        .toSorted((a, b) =>
          metric === "euclidean" ? a.score - b.score : b.score - a.score
        )
        .slice(0, options?.topK ?? 5);
      return { matches, count: matches.length };
    },
    upsert: async (batch: VectorizeVector[]) => {
      if (behaviour.hang) {
        return await never;
      }
      if (upsertBatches >= behaviour.failUpsertAfterBatches) {
        throw new Error("VECTOR_UPSERT_ERROR: upstream unavailable");
      }
      if (new Set(batch.map(({ id }) => id)).size < batch.length) {
        throw new Error("VECTOR_UPSERT_ERROR: duplicate ids in one batch");
      }
      await Promise.resolve();
      upsertBatches += 1;
      for (const vector of batch) {
        const metadata = vector.metadata ?? {};
        storeOf(vector.id).set(vector.id, {
          values: [...vector.values],
          metadata,
          filterable: new Set(
            behaviour.metadataIndex === "string" &&
              typeof metadata.p === "string"
              ? ["p"]
              : []
          ),
        });
      }
      return { mutationId: crypto.randomUUID() };
    },
    getByIds: async (ids: string[]) => {
      await Promise.resolve();
      return ids.flatMap((id) => {
        const stored = storeOf(id).get(id);
        return stored === undefined
          ? []
          : [{ id, values: stored.values, metadata: stored.metadata }];
      });
    },
    deleteByIds: async (ids: string[]) => {
      await Promise.resolve();
      for (const id of ids) {
        vectors.delete(id);
      }
      return { mutationId: crypto.randomUUID() };
    },
  };

  return { binding, vectors, filters, behaviour };
};

/** An index whose policy filter status has proven, as a deployment's is. */
const provenIndex = async (
  provider: ReturnType<typeof fakeVectorize>,
  of: VectorGeneration = generation
): Promise<VectorIndex> => {
  const index = vectorIndexOf(provider.binding, of);
  await index.status();
  return index;
};

const record = (
  id: string,
  policy: string,
  values: number[] = [1, 0, 0]
): VectorRecord => ({ id, values, policy, sourceVersion: `${id}@1` });

const kindOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VectorIndexError) {
      return error.kind;
    }
    throw error;
  }
  return "answered";
};

describe("a search", () => {
  it("finds only vectors indexed under a policy the caller holds", async () => {
    const provider = fakeVectorize();
    const index = await provenIndex(provider);
    await index.upsert([
      record("finance-plan", "policy:finance"),
      record("sales-plan", "policy:sales"),
      record("board-minutes", "policy:board"),
    ]);

    const found = await index.query([1, 0, 0], {
      policies: ["policy:sales", "policy:finance"],
      topK: 10,
    });

    expect(found.complete).toBeTruthy();
    expect(
      found.matches.map(({ id }) => id).toSorted((a, b) => a.localeCompare(b))
    ).toStrictEqual(["finance-plan", "sales-plan"]);
  });

  it("never reaches the provider without a policy filter", async () => {
    const provider = fakeVectorize();
    const index = vectorIndexOf(provider.binding, generation);
    await index.upsert([record("board-minutes", "policy:board")]);

    const found = await index.query([1, 0, 0], { policies: [], topK: 10 });

    expect(found).toStrictEqual({ matches: [], complete: true });
    expect(provider.filters).toStrictEqual([]);
  });

  it("refuses a policy key the provider would only match by its prefix", async () => {
    const provider = fakeVectorize();
    const index = vectorIndexOf(provider.binding, generation);
    const shared = "k".repeat(maxPolicyKeyBytes);
    // Both longer keys index as `shared`: the board's vector would match
    // the sales filter.
    const board = `${shared}board`;
    const sales = `${shared}sales`;

    await expect(
      kindOf(index.upsert([record("board-minutes", board)]))
    ).resolves.toBe("invalid");
    await expect(
      kindOf(index.query([1, 0, 0], { policies: [sales], topK: 10 }))
    ).resolves.toBe("invalid");
    expect(provider.vectors.size).toBe(0);
    // Exactly 64 bytes, multi-byte characters included, is exact.
    await index.upsert([record("plan", "é".repeat(maxPolicyKeyBytes / 2))]);
    expect(provider.vectors.size).toBe(1);
  });

  it("searches every policy of a large grant set when it fits the bounded batches", async () => {
    const provider = fakeVectorize();
    const index = await provenIndex(provider);
    const policies = Array.from({ length: 150 }, (_, n) => `policy:team-${n}`);
    await index.upsert([
      record("first", policies[0] ?? ""),
      record("last", policies.at(-1) ?? "", [0.9, 0.1, 0]),
      record("hidden", "policy:board", [1, 0, 0]),
    ]);

    const found = await index.query([1, 0, 0], { policies, topK: 10 });

    expect(found.complete).toBeTruthy();
    expect(found.matches.map(({ id }) => id)).toStrictEqual(["first", "last"]);
    expect(provider.filters.length).toBeGreaterThan(1);
    expect(provider.filters.length).toBeLessThanOrEqual(maxPolicyBatches);
    for (const filter of provider.filters) {
      expect(
        new TextEncoder().encode(JSON.stringify(filter)).length
      ).toBeLessThan(2048);
    }
  });

  it("says it is incomplete when the caller holds more policies than a search covers, and searches the first", async () => {
    const provider = fakeVectorize();
    const index = await provenIndex(provider);
    // Most important first: a key that sorts last still comes first.
    const policies = [
      "policy:z-priority",
      ...Array.from(
        { length: 2000 },
        (_, n) => `policy:${String(n).padStart(4, "0")}`
      ),
    ];
    await index.upsert([
      record("priority", "policy:z-priority"),
      record("covered", "policy:0000", [0.9, 0.1, 0]),
      record("left-out", "policy:1999"),
    ]);

    const found = await index.query([1, 0, 0], { policies, topK: 10 });

    expect({
      complete: found.complete,
      batches: provider.filters.length,
      matches: found.matches.map(({ id }) => id),
    }).toStrictEqual({
      complete: false,
      batches: maxPolicyBatches,
      matches: ["priority", "covered"],
    });
  });

  it("refuses input the generation or the provider can't hold exactly", async () => {
    const provider = fakeVectorize();
    const index = vectorIndexOf(provider.binding, generation);
    await index.upsert([record("kept", "policy:sales")]);
    // A hole at 1, as in a sparse array a caller built.
    const sparse: number[] = [];
    sparse[0] = 1;
    sparse[2] = 0;
    const search = { policies: ["policy:sales"], topK: 5 };

    const kinds = await Promise.all([
      kindOf(index.query([1, 0], search)),
      kindOf(index.query(sparse, search)),
      kindOf(index.upsert([record("plan", "policy:sales", [1, 0, 0, 0])])),
      kindOf(
        index.upsert([record("plan", "policy:sales", [1, Number.NaN, 0])])
      ),
      kindOf(
        index.upsert([{ ...record("plan", "policy:sales"), values: sparse }])
      ),
      kindOf(
        index.upsert([
          {
            ...record("plan", "policy:sales"),
            sourceVersion: "v".repeat(4096),
          },
        ])
      ),
      kindOf(index.delete(["kept", "x".repeat(65)])),
    ]);

    expect({ kinds, stored: [...provider.vectors.keys()] }).toStrictEqual({
      kinds: Array.from({ length: 7 }, () => "invalid"),
      stored: ["kept"],
    });
  });

  it("refuses an index of another generation", async () => {
    const index = vectorIndexOf(fakeVectorize(1024).binding, generation);

    await expect(kindOf(index.status())).resolves.toBe("invalid");
    await expect(
      vectorIndexOf(fakeVectorize().binding, generation).status()
    ).resolves.toMatchObject({ generation: generation.id, dimensions: 3 });
  });
});

describe("an index's status", () => {
  it("proves the policy filter works with a sentinel no caller can reach", async () => {
    const provider = fakeVectorize();
    const index = vectorIndexOf(provider.binding, generation);

    const first = await index.status();
    const second = await index.status();
    const reserved = `${reservedPrefix}filter-probe`;
    const kinds = await Promise.all([
      kindOf(index.query([1, 0, 0], { policies: [reserved], topK: 5 })),
      kindOf(index.upsert([record(reserved, "policy:sales")])),
      kindOf(index.upsert([record("plan", reserved)])),
      kindOf(index.delete([reserved])),
    ]);
    await index.upsert([record("plan", "policy:sales")]);
    const found = await index.query([1, 0, 0], {
      policies: ["policy:sales"],
      topK: 10,
    });

    expect({
      filtering: [first.filtering, second.filtering],
      kinds,
      found: found.matches.map(({ id }) => id),
    }).toStrictEqual({
      filtering: ["unproven", "working"],
      kinds: ["invalid", "invalid", "invalid", "invalid"],
      found: ["plan"],
    });
  });

  it("says filtering fails without a string metadata index on the policy", async () => {
    const results = await Promise.all(
      (["none", "number"] as const).map(async (metadataIndex) => {
        const provider = fakeVectorize();
        provider.behaviour.metadataIndex = metadataIndex;
        const index = vectorIndexOf(provider.binding, generation);
        await index.status();
        const { filtering } = await index.status();
        return filtering;
      })
    );

    expect(results).toStrictEqual(["failing", "failing"]);
  });

  it("says filtering fails when the metadata index came after the records", async () => {
    const provider = fakeVectorize();
    provider.behaviour.metadataIndex = "none";
    const index = vectorIndexOf(provider.binding, generation);
    await index.status();
    await index.upsert([record("plan", "policy:sales")]);
    provider.behaviour.metadataIndex = "string";

    const { filtering } = await index.status();

    expect(filtering).toBe("failing");
  });

  it("keeps searches off an index whose filter isn't proven", async () => {
    const unproven = vectorIndexOf(fakeVectorize().binding, generation);
    const broken = fakeVectorize();
    broken.behaviour.metadataIndex = "none";
    const failing = await provenIndex(broken);
    await failing.upsert([record("plan", "policy:sales")]);
    const search = { policies: ["policy:sales"], topK: 5 };

    const kinds = await Promise.all([
      kindOf(unproven.query([1, 0, 0], search)),
      kindOf(failing.query([1, 0, 0], search)),
    ]);
    // Once the sentinel's write has applied, the proof holds.
    const found = await unproven.query([1, 0, 0], search);

    expect({ kinds, found }).toStrictEqual({
      kinds: ["unavailable", "unavailable"],
      found: { matches: [], complete: true },
    });
  });

  it("leaves out the last applied write when the index reports none", async () => {
    const provider = fakeVectorize();
    provider.behaviour.noAppliedMutation = true;

    const status = await vectorIndexOf(provider.binding, generation).status();

    expect(status.appliedUpTo).toBeUndefined();
  });
});

describe("a search while records change", () => {
  it("counts a record moved between two policy batches once", async () => {
    const provider = fakeVectorize();
    const index = await provenIndex(provider);
    const policies = Array.from({ length: 150 }, (_, n) => `policy:team-${n}`);
    // Batches keep the caller's order: these two are in the first and last.
    const [first = "", last = ""] = [policies[0], policies.at(-1)];
    await index.upsert([
      record("moving", first),
      record("other", first, [0.8, 0.2, 0]),
    ]);
    // Re-indexed under the last batch's policy after the first batch was read.
    provider.behaviour.afterQuery = () => {
      const moving = provider.vectors.get("moving");
      if (moving !== undefined) {
        moving.metadata.p = last;
      }
    };

    const found = await index.query([1, 0, 0], { policies, topK: 2 });

    expect(found.matches.map(({ id }) => id)).toStrictEqual([
      "moving",
      "other",
    ]);
  });
});

describe("a euclidean generation", () => {
  it("puts the smallest distance first across batches, a duplicate at its nearest", async () => {
    const euclidean: VectorGeneration = {
      ...generation,
      id: "test-3-euclidean-1",
      metric: "euclidean",
    };
    const provider = fakeVectorize(3, "euclidean");
    const index = await provenIndex(provider, euclidean);
    const policies = Array.from({ length: 150 }, (_, n) => `policy:team-${n}`);
    const [first = "", last = ""] = [policies[0], policies.at(-1)];
    await index.upsert([
      record("far", first, [4, 0, 0]),
      record("near", last, [1.5, 0, 0]),
      record("nearest", first, [1.1, 0, 0]),
      record("moving", first, [3, 0, 0]),
    ]);
    // Re-embedded and re-indexed under the last batch's policy after the
    // first batch was read: both batches find it, at different distances.
    provider.behaviour.afterQuery = () => {
      const moving = provider.vectors.get("moving");
      if (moving !== undefined) {
        moving.metadata.p = last;
        moving.values = [1.2, 0, 0];
      }
    };

    const found = await index.query([1, 0, 0], { policies, topK: 3 });

    expect(
      found.matches.map(({ id, score }) => [id, Number(score.toFixed(3))])
    ).toStrictEqual([
      ["nearest", 0.1],
      ["moving", 0.2],
      ["near", 0.5],
    ]);
  });
});

describe("when the provider fails", () => {
  it("reports an outage as unavailable, not as no matches", async () => {
    const provider = fakeVectorize();
    const index = vectorIndexOf(provider.binding, generation);
    provider.behaviour.failQueries = true;

    await expect(
      kindOf(index.query([1, 0, 0], { policies: ["policy:sales"], topK: 5 }))
    ).resolves.toBe("unavailable");
  });

  it("gives up on a provider that doesn't answer", async () => {
    const provider = fakeVectorize();
    const index = vectorIndexOf(provider.binding, generation, {
      queryDeadlineMs: 20,
      writeDeadlineMs: 20,
    });
    provider.behaviour.hang = true;

    await expect(
      kindOf(index.query([1, 0, 0], { policies: ["policy:sales"], topK: 5 }))
    ).resolves.toBe("unavailable");
    await expect(
      kindOf(index.upsert([record("plan", "policy:sales")]))
    ).resolves.toBe("unavailable");
  });

  it("reports a write applied in part as failed, and completes it when repeated", async () => {
    const provider = fakeVectorize();
    const index = vectorIndexOf(provider.binding, generation);
    const records = Array.from({ length: 2500 }, (_, n) =>
      record(`chunk-${n}`, "policy:sales")
    );
    provider.behaviour.failUpsertAfterBatches = 1;

    await expect(kindOf(index.upsert(records))).resolves.toBe("unavailable");
    expect(provider.vectors.size).toBe(1000);

    provider.behaviour.failUpsertAfterBatches = Number.POSITIVE_INFINITY;
    await index.upsert(records);
    expect(provider.vectors.size).toBe(2500);
  });

  it("saves the last record of an ID given twice in one call", async () => {
    const provider = fakeVectorize();
    const index = vectorIndexOf(provider.binding, generation);

    await index.upsert([
      record("plan", "policy:sales"),
      record("plan", "policy:finance"),
    ]);

    expect(provider.vectors.get("plan")?.metadata.p).toBe("policy:finance");
  });

  it("deletes exactly what it is told, and repeating a delete is no error", async () => {
    const provider = fakeVectorize();
    const index = vectorIndexOf(provider.binding, generation);
    await index.upsert([
      record("keep", "policy:sales"),
      record("erase", "policy:sales"),
    ]);

    await index.delete(["erase", "erase"]);
    await index.delete(["erase"]);

    expect([...provider.vectors.keys()]).toStrictEqual(["keep"]);
  });
});

describe("a profile with no vector index", () => {
  it("refuses every call instead of answering empty", async () => {
    for (const index of [
      unsupportedVectorIndex(),
      vectorIndexOf(undefined, generation),
    ]) {
      expect(index.profile).toBe("unsupported");
      // oxlint-disable-next-line no-await-in-loop -- one call at a time
      const kinds = await Promise.all([
        kindOf(index.query([1, 0, 0], { policies: ["policy:sales"], topK: 5 })),
        kindOf(index.upsert([record("plan", "policy:sales")])),
        kindOf(index.delete(["plan"])),
        kindOf(index.status()),
      ]);
      expect(kinds).toStrictEqual([
        "unsupported",
        "unsupported",
        "unsupported",
        "unsupported",
      ]);
    }
  });
});

describe("policy filters", () => {
  it("stay under the provider's filter size with long keys that grow in JSON", () => {
    // 64 bytes each; every quote and backslash doubles when JSON-encoded.
    const keys = Array.from(
      { length: 60 },
      (_, n) => `${'"\\'.repeat(28)}${String(n).padStart(8, "0")}`
    );

    const { filters, complete } = policyFilters(keys);

    const covered = filters.flatMap((filter) => {
      const condition = filter.p;
      return condition !== null &&
        typeof condition === "object" &&
        "$in" in condition
        ? (condition.$in ?? []).map(String)
        : [];
    });
    expect({
      complete,
      batches: filters.length > 1,
      underLimit: filters.every(
        (filter) =>
          new TextEncoder().encode(JSON.stringify(filter)).length < 2048
      ),
      covered: covered.toSorted((a, b) => a.localeCompare(b)),
    }).toStrictEqual({
      complete: true,
      batches: true,
      underLimit: true,
      covered: keys.toSorted((a, b) => a.localeCompare(b)),
    });
  });

  it("hold at most a bounded number of short keys each", () => {
    const keys = Array.from({ length: 150 }, (_, n) => `p${n}`);

    const { filters, complete } = policyFilters(keys);

    expect(complete).toBeTruthy();
    expect(filters).toHaveLength(2);
    for (const filter of filters) {
      const condition = filter.p;
      const listed =
        condition !== null &&
        typeof condition === "object" &&
        "$in" in condition
          ? (condition.$in ?? [])
          : [];
      expect(listed.length).toBeLessThanOrEqual(maxPolicyKeysPerFilter);
    }
  });

  it("cover each key once, in filters the provider accepts", () => {
    const keys = Array.from({ length: 120 }, (_, n) => `policy:${n}`);

    const { filters, complete } = policyFilters([...keys, ...keys]);

    const covered = filters.flatMap((filter) => {
      const condition = filter.p;
      return condition !== null &&
        typeof condition === "object" &&
        "$in" in condition
        ? (condition.$in ?? [])
        : [];
    });
    expect(complete).toBeTruthy();
    expect(
      covered.map(String).toSorted((a, b) => a.localeCompare(b))
    ).toStrictEqual(keys.toSorted((a, b) => a.localeCompare(b)));
  });
});
