import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { vectorIndexProviderOf } from "../src/knowledge/vector-index-profile.ts";
import {
  maxFilterBytes,
  maxPolicyBatches,
  maxPolicyKeysPerFilter,
  policyBatches,
  reservedPrefix,
  unsupportedVectorIndexProvider,
  vectorGeneration,
  VectorIndexError,
} from "../src/knowledge/vector-index.ts";
import type {
  VectorGeneration,
  VectorIndex,
  VectorRecord,
} from "../src/knowledge/vector-index.ts";
import { reconcileGeneration } from "../src/knowledge/vector-rebuild.ts";
import {
  vectorizeIndex,
  vectorizeProvider,
} from "../src/knowledge/vectorize-index.ts";
import type {
  VectorizeBinding,
  VectorizeGenerationBinding,
  VectorizeLister,
} from "../src/knowledge/vectorize-index.ts";
import type { ModelsEnv } from "../src/models.ts";
import {
  conformanceGenerations,
  vectorIndexConformance,
} from "./vector-index-conformance.ts";
import type { VectorIndexFaults } from "./vector-index-conformance.ts";

// The `vectorize` profile. It passes the behaviour suite every vector index
// implementation passes (vector-index-conformance.ts), and these tests add
// what is Vectorize's own: its filters' size, the sentinel that proves an
// index's metadata index filters, records moving between two batches'
// reads, and the EU rules that keep it from serving a deployment at all.
// Vectorize, the outside provider, is replaced by a fake index that
// filters before picking the nearest vectors and keeps only the first 64
// bytes of an indexed string, as the provider documents, with a fake of
// its REST list-vectors route beside it.

const [generation] = conformanceGenerations;

const indexedPrefixBytes = 64;
const listPage = 1000;

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
  outage: boolean;
  hang: boolean;
  failUpsertAfterBatches: number;
  afterQuery: () => void;
  /**
   * The metadata index on `p`, as it was when each vector was written: a
   * vector written before a string index on `p` existed never matches a
   * filter on `p`, as Vectorize documents.
   */
  metadataIndex: "string" | "number" | "none";
  /** How long after `deleteByIds` its deletes apply. */
  deleteDelayMs: number;
  /** An index that reports no applied write yet. */
  noAppliedMutation: boolean;
}

/** A Vectorize index in memory, with the failures a test asks for. */
const fakeVectorize = (
  dimensions = generation.dimensions,
  metric: VectorGeneration["metric"] = generation.metric
) => {
  const vectors = new Map<string, Stored>();
  const filters: (VectorizeVectorMetadataFilter | undefined)[] = [];
  const behaviour: FakeBehaviour = {
    outage: false,
    hang: false,
    failUpsertAfterBatches: Number.POSITIVE_INFINITY,
    afterQuery: (): void => undefined,
    metadataIndex: "string",
    noAppliedMutation: false,
    deleteDelayMs: 0,
  };
  /** Deletes accepted but not applied yet, and when they apply. */
  const pendingDeletes: { ids: string[]; at: number }[] = [];
  const applyDueDeletes = (): void => {
    for (const pending of pendingDeletes.filter(({ at }) => at <= Date.now())) {
      for (const id of pending.ids) {
        vectors.delete(id);
      }
      pendingDeletes.splice(pendingDeletes.indexOf(pending), 1);
    }
  };
  let upsertBatches = 0;
  const never = Promise.withResolvers<never>().promise;

  /** Fails or hangs as the test asks, before the provider does anything. */
  const reach = async (): Promise<void> => {
    if (behaviour.hang) {
      await never;
    }
    if (behaviour.outage) {
      throw new Error("VECTOR_ERROR (code = 40000): upstream unavailable");
    }
    await Promise.resolve();
    applyDueDeletes();
  };

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
      await reach();
      // SAFETY: an index with no applied write answers null here, whatever
      // the binding's type says.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const none = JSON.parse("null") as number;
      return {
        vectorCount: vectors.size,
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
      await reach();
      const probing = JSON.stringify(options?.filter ?? {}).includes(
        reservedPrefix
      );
      if (!probing) {
        filters.push(options?.filter);
      }
      // The index as this read saw it, before anything changes it.
      const answeredFrom = [...vectors].map(
        ([id, stored]): [string, Stored] => [
          id,
          { ...stored, metadata: { ...stored.metadata } },
        ]
      );
      // The sentinel's check isn't one of the search's batches.
      if (!probing) {
        behaviour.afterQuery();
      }
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
      await reach();
      if (upsertBatches >= behaviour.failUpsertAfterBatches) {
        throw new Error("VECTOR_UPSERT_ERROR: upstream unavailable");
      }
      if (new Set(batch.map(({ id }) => id)).size < batch.length) {
        throw new Error("VECTOR_UPSERT_ERROR: duplicate ids in one batch");
      }
      upsertBatches += 1;
      for (const vector of batch) {
        const metadata = vector.metadata ?? {};
        vectors.set(vector.id, {
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
      await reach();
      return ids.flatMap((id) => {
        const stored = vectors.get(id);
        return stored === undefined
          ? []
          : [{ id, values: stored.values, metadata: stored.metadata }];
      });
    },
    deleteByIds: async (ids: string[]) => {
      await reach();
      pendingDeletes.push({ ids, at: Date.now() + behaviour.deleteDelayMs });
      applyDueDeletes();
      return { mutationId: crypto.randomUUID() };
    },
  };

  /** The REST list-vectors route: every ID, sentinel included, in pages. */
  const list: VectorizeLister = async (cursor) => {
    await reach();
    const ids = [...vectors.keys()]
      .toSorted()
      .filter((id) => cursor === undefined || id > cursor)
      .slice(0, listPage + 1);
    const page = ids.slice(0, listPage);
    return ids.length > listPage
      ? { ids: page, cursor: page.at(-1) }
      : { ids: page };
  };

  const faults: VectorIndexFaults = {
    outage: () => {
      behaviour.outage = true;
    },
    hang: () => {
      behaviour.hang = true;
    },
    partialWrite: () => {
      behaviour.failUpsertAfterBatches = upsertBatches + 1;
    },
    delayDeletes: (ms) => {
      behaviour.deleteDelayMs = ms;
    },
    heal: () => {
      behaviour.deleteDelayMs = 0;
      behaviour.outage = false;
      behaviour.hang = false;
      behaviour.failUpsertAfterBatches = Number.POSITIVE_INFINITY;
    },
  };

  return { binding, list, vectors, filters, behaviour, faults };
};

vectorIndexConformance("vectorize", ({ generations, deadlineMs }) => {
  const fakes = generations.map((of) => ({
    of,
    fake: fakeVectorize(of.dimensions, of.metric),
  }));
  const deadlines =
    deadlineMs === undefined
      ? {}
      : { queryDeadlineMs: deadlineMs, writeDeadlineMs: deadlineMs };
  const faultOf =
    (fault: Exclude<keyof VectorIndexFaults, "delayDeletes">) => (): void => {
      for (const { fake } of fakes) {
        fake.faults[fault]();
      }
    };
  return {
    provider: vectorizeProvider(
      fakes.map(({ of, fake }) => ({
        generation: of,
        binding: fake.binding,
        list: fake.list,
      })),
      deadlines
    ),
    faults: {
      outage: faultOf("outage"),
      hang: faultOf("hang"),
      partialWrite: faultOf("partialWrite"),
      delayDeletes: (ms) => {
        for (const { fake } of fakes) {
          fake.faults.delayDeletes?.(ms);
        }
      },
      heal: faultOf("heal"),
    },
  };
});

/** An index whose policy filter status has proven, as a deployment's is. */
const provenIndex = async (
  provider: ReturnType<typeof fakeVectorize>,
  of: VectorGeneration = generation
): Promise<VectorIndex> => {
  const index = vectorizeIndex(provider.binding, of, { list: provider.list });
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

describe("a Vectorize search", () => {
  it("never reaches the provider without a policy filter", async () => {
    const provider = fakeVectorize();
    const index = vectorizeIndex(provider.binding, generation);
    await index.upsert([record("board-minutes", "policy:board")]);

    await index.query([1, 0, 0], { policies: [], topK: 10 });

    expect(provider.filters).toStrictEqual([]);
  });

  it("splits a large grant set into bounded filters the provider accepts", async () => {
    const provider = fakeVectorize();
    const index = await provenIndex(provider);
    const policies = Array.from({ length: 150 }, (_, n) => `policy:team-${n}`);

    await index.query([1, 0, 0], { policies, topK: 10 });

    expect(provider.filters.length).toBeGreaterThan(1);
    expect(provider.filters.length).toBeLessThanOrEqual(maxPolicyBatches);
    for (const filter of provider.filters) {
      expect(
        new TextEncoder().encode(JSON.stringify(filter)).length
      ).toBeLessThan(maxFilterBytes);
    }
  });

  it("refuses an index of another dimension count", async () => {
    const index = vectorizeIndex(fakeVectorize(1024).binding, generation);

    await expect(kindOf(index.status())).resolves.toBe("invalid");
  });

  it("lists a damaged record, reconciles it away and drops it", async () => {
    const provider = fakeVectorize();
    const index = await provenIndex(provider);
    await index.upsert([record("plan", "policy:sales")]);
    // Written around the adapter: no source version, or not a string.
    for (const [id, v] of [
      ["orphan", undefined],
      ["plan-2", 2],
    ] as const) {
      provider.vectors.set(id, {
        values: [1, 0, 0],
        metadata:
          v === undefined ? { p: "policy:sales" } : { p: "policy:sales", v },
        filterable: new Set(["p"]),
      });
    }

    const listed = await index.ids();
    const reconciled = await reconcileGeneration(
      index,
      new Map([
        ["plan", "plan@1"],
        ["plan-2", "plan-2@1"],
      ])
    );
    await vectorizeProvider([
      { generation, binding: provider.binding, list: provider.list },
    ]).drop(generation);

    expect({
      listed: listed.entries,
      reconciled,
      left: [...provider.vectors.keys()],
    }).toStrictEqual({
      listed: [
        { id: "orphan", sourceVersion: null },
        { id: "plan", sourceVersion: "plan@1" },
        { id: "plan-2", sourceVersion: null },
      ],
      reconciled: { missing: [], stale: ["plan-2"], extra: ["orphan"] },
      left: [],
    });
  });

  it("can't list without the REST route, and says why", async () => {
    const index = vectorizeIndex(fakeVectorize().binding, generation);

    await expect(kindOf(index.ids())).resolves.toBe("unsupported");
  });

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

  it("puts the smallest euclidean distance first across batches, a duplicate at its nearest", async () => {
    const euclidean = vectorGeneration({ ...generation, metric: "euclidean" });
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

    const found = await index.query([1, 0, 0], { policies, topK: 4 });

    expect(
      found.matches.map(({ id, score }) => [id, Number(score.toFixed(3))])
    ).toStrictEqual([
      ["nearest", 0.1],
      ["moving", 0.2],
      ["near", 0.5],
      ["far", 3],
    ]);
  });
});

describe("a Vectorize index's status", () => {
  it("proves the policy filter works once the sentinel's write applies", async () => {
    const provider = fakeVectorize();
    const index = vectorizeIndex(provider.binding, generation, {
      list: provider.list,
    });

    const first = await index.status();
    const second = await index.status();

    const listed = await index.ids();

    expect({
      filtering: [first.filtering, second.filtering],
      listed: listed.entries,
    }).toStrictEqual({ filtering: ["unproven", "working"], listed: [] });
  });

  it("says filtering fails without a string metadata index on the policy", async () => {
    const results = await Promise.all(
      (["none", "number"] as const).map(async (metadataIndex) => {
        const provider = fakeVectorize();
        provider.behaviour.metadataIndex = metadataIndex;
        const index = vectorizeIndex(provider.binding, generation);
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
    const index = vectorizeIndex(provider.binding, generation);
    await index.status();
    await index.upsert([record("plan", "policy:sales")]);
    provider.behaviour.metadataIndex = "string";

    const { filtering } = await index.status();

    expect(filtering).toBe("failing");
  });

  it("keeps searches off an index whose filter isn't proven", async () => {
    const unproven = vectorizeIndex(fakeVectorize().binding, generation);
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

    const status = await vectorizeIndex(provider.binding, generation).status();

    expect(status.appliedUpTo).toBeUndefined();
  });
});

describe("the deployment's vector index provider", () => {
  const euModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const bound = (): VectorizeGenerationBinding[] => {
    const fake = fakeVectorize();
    return [{ generation, binding: fake.binding, list: fake.list }];
  };
  const withRules = (rules: Record<string, unknown>): ModelsEnv => ({
    ...env,
    MODEL_GATEWAY: { gateway: "grasp-os-test", models: [euModel], ...rules },
  });

  it("refuses Vectorize under every EU rule, saying which", async () => {
    const rules = [
      "deployment",
      "connection",
      "workflow",
      "unreadable",
    ] as const;
    const configs: Record<(typeof rules)[number], Record<string, unknown>> = {
      deployment: { eu: { models: [euModel], deployment: true } },
      connection: { eu: { models: [euModel], connections: ["conn_eu"] } },
      workflow: {
        eu: {
          models: [euModel],
          workflows: [{ app: "app_1", workflow: "invoices" }],
        },
      },
      unreadable: { eu: { models: [] } },
    };
    const saying: Record<keyof typeof configs, string> = {
      deployment: "whole deployment in the EU",
      connection: "connections' data in the EU",
      workflow: "workflows' AI steps in the EU",
      unreadable: "can't be read",
    };

    const refusals = await Promise.all(
      rules.map(async (rule) => {
        const provider = vectorIndexProviderOf(
          withRules(configs[rule]),
          bound()
        );
        const calls = await Promise.all([
          provider.create(generation).catch((error: unknown) => error),
          provider
            .open(generation)
            .query([1, 0, 0], { policies: ["policy:sales"], topK: 5 })
            .catch((error: unknown) => error),
          provider
            .open(generation)
            .upsert([record("plan", "policy:sales")])
            .catch((error: unknown) => error),
        ]);
        return {
          rule,
          profile: provider.profile,
          kinds: calls.map((error) =>
            error instanceof VectorIndexError ? error.kind : "answered"
          ),
          saysWhy: calls.every(
            (error) =>
              error instanceof VectorIndexError &&
              error.message.includes(saying[rule])
          ),
        };
      })
    );

    expect(refusals).toStrictEqual(
      rules.map((rule) => ({
        rule,
        profile: "vectorize",
        kinds: ["eu_only", "eu_only", "eu_only"],
        saysWhy: true,
      }))
    );
  });

  it("uses Vectorize where the rules keep nothing in the EU", async () => {
    const provider = vectorIndexProviderOf(
      withRules({ eu: { models: [euModel] } }),
      bound()
    );
    await provider.create(generation);
    await provider.open(generation).upsert([record("plan", "policy:sales")]);

    const found = await provider
      .open(generation)
      .query([1, 0, 0], { policies: ["policy:sales"], topK: 5 });

    expect({
      profile: provider.profile,
      found: found.matches.map(({ id }) => id),
    }).toStrictEqual({ profile: "vectorize", found: ["plan"] });
  });

  it("refuses every call on the unsupported profile, instead of answering empty", async () => {
    const provider = unsupportedVectorIndexProvider();
    const index = provider.open(generation);

    const kinds = await Promise.all([
      kindOf(index.query([1, 0, 0], { policies: ["policy:sales"], topK: 5 })),
      kindOf(index.upsert([record("plan", "policy:sales")])),
      kindOf(index.delete(["plan"])),
      kindOf(index.ids()),
      kindOf(index.status()),
      kindOf(provider.create(generation)),
      kindOf(provider.drop(generation)),
      kindOf(provider.generations()),
    ]);

    expect({ profile: provider.profile, kinds }).toStrictEqual({
      profile: "unsupported",
      kinds: Array.from({ length: 8 }, () => "unsupported"),
    });
  });
});

const filterBytes = (keys: readonly string[]): number =>
  new TextEncoder().encode(JSON.stringify({ p: { $in: keys } })).length;

describe("generation IDs", () => {
  it("differ whenever what the vectors were made with differs", () => {
    const base = {
      model: "org/model",
      revision: "a@b",
      route: "local|tei",
      dimensions: 3,
      metric: "cosine",
    } as const;
    // Each pair would share an ID if its fields were joined by a separator.
    const specs = [
      base,
      { ...base, model: "org/model@a", revision: "b" },
      { ...base, route: "local", model: "tei|org/model" },
      { ...base, revision: "a", model: "org/model", route: "local|tei" },
    ];

    const ids = specs.map((spec) => vectorGeneration(spec).id);

    expect(new Set(ids).size).toBe(specs.length);
  });
});

describe("policy batches", () => {
  it("fit the provider's filter size with long keys that grow in JSON", () => {
    // 64 bytes each; every quote and backslash doubles when JSON-encoded.
    const keys = Array.from(
      { length: 60 },
      (_, n) => `${'"\\'.repeat(28)}${String(n).padStart(8, "0")}`
    );

    const { batches, complete } = policyBatches(keys);

    expect({
      complete,
      several: batches.length > 1,
      underLimit: batches.every((batch) => filterBytes(batch) < maxFilterBytes),
      covered: batches.flat(),
    }).toStrictEqual({
      complete: true,
      several: true,
      underLimit: true,
      covered: keys,
    });
  });

  it("hold at most a bounded number of short keys each, each key once", () => {
    const keys = Array.from({ length: 150 }, (_, n) => `p${n}`);

    const { batches, complete } = policyBatches([...keys, ...keys]);

    expect({
      complete,
      sizes: batches.map((batch) => batch.length),
      covered: batches.flat(),
    }).toStrictEqual({
      complete: true,
      sizes: [maxPolicyKeysPerFilter, 50],
      covered: keys,
    });
  });
});
