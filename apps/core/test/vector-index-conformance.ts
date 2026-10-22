import { describe, expect, it } from "vite-plus/test";

import {
  maxPolicyKeyBytes,
  policyBatches,
  reservedPrefix,
  vectorGeneration,
  VectorIndexError,
} from "../src/knowledge/vector-index.ts";
import type {
  VectorGeneration,
  VectorIdEntry,
  VectorIndex,
  VectorIndexProvider,
  VectorRecord,
} from "../src/knowledge/vector-index.ts";
import { reconcileGeneration } from "../src/knowledge/vector-rebuild.ts";

// The behaviour every vector index implementation must have, whatever its
// provider: run by each implementation's tests with a harness of its own.
// It starts from the ways an index can fail or be abused: a search that
// reaches records outside the caller's read policies (no keys, a key the
// caller doesn't hold, a long key that collides with another, a reserved
// key); a caller with many policies silently searched in part; a deleted
// record still found or listed; a repeated write that duplicates a record;
// two generations mixed; and an outage, a hang or a half-applied write
// reported as success. The suite reads back right after each write: a
// harness whose provider applies writes later makes them visible first.

/** The faults a harness makes its provider show, until `heal`. */
export interface VectorIndexFaults {
  /** Every call to the provider fails. */
  outage: () => void;
  /** No call to the provider answers. */
  hang: () => void;
  /** The next write applies part of its records, then fails. */
  partialWrite: () => void;
  heal: () => void;
}

export interface VectorIndexHarness {
  provider: VectorIndexProvider;
  faults: VectorIndexFaults;
}

export interface HarnessOptions {
  /** The generations the provider can create. */
  generations: readonly VectorGeneration[];
  /** How long a provider call may take; the implementation's default without one. */
  deadlineMs?: number;
}

export type VectorIndexHarnessFactory = (
  options: HarnessOptions
) => Promise<VectorIndexHarness> | VectorIndexHarness;

const spec = {
  model: "@cf/test/embedding",
  revision: "1",
  route: "test",
  dimensions: 3,
  metric: "cosine",
} as const;

export const conformanceGenerations: readonly [
  VectorGeneration,
  VectorGeneration,
] = [vectorGeneration(spec), vectorGeneration({ ...spec, revision: "2" })];

const [generation, nextGeneration] = conformanceGenerations;

const record = (
  id: string,
  policy: string,
  values: number[] = [1, 0, 0],
  sourceVersion = `${id}@1`
): VectorRecord => ({ id, values, policy, sourceVersion });

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

/** Every record the index lists, page after page. */
const listAll = async (index: VectorIndex): Promise<VectorIdEntry[]> => {
  const entries: VectorIdEntry[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page names where the next starts
    const page = await index.ids(cursor);
    entries.push(...page.entries);
    ({ cursor } = page);
  } while (cursor !== undefined);
  return entries.toSorted((a, b) => a.id.localeCompare(b.id));
};

const idsOf = (entries: readonly { id: string }[]): string[] =>
  entries.map(({ id }) => id).toSorted((a, b) => a.localeCompare(b));

/**
 * The behaviour suite, run against the provider of `name` that `harness`
 * makes.
 */
export const vectorIndexConformance = (
  name: string,
  harness: VectorIndexHarnessFactory
): void => {
  /** A created, empty index of `of`, ready to search. */
  const ready = async (
    options: Partial<HarnessOptions> = {},
    of: VectorGeneration = generation
  ): Promise<{ index: VectorIndex } & VectorIndexHarness> => {
    const made = await harness({
      generations: conformanceGenerations,
      ...options,
    });
    await made.provider.create(of);
    return { ...made, index: made.provider.open(of) };
  };

  describe(`${name}: a search`, () => {
    it("finds only records indexed under a policy the caller holds", async () => {
      const { index } = await ready();
      await index.upsert([
        record("finance-plan", "policy:finance"),
        record("sales-plan", "policy:sales"),
        record("board-minutes", "policy:board"),
      ]);

      const found = await index.query([1, 0, 0], {
        policies: ["policy:sales", "policy:finance", "policy:unknown"],
        topK: 10,
      });

      expect({
        complete: found.complete,
        ids: idsOf(found.matches),
      }).toStrictEqual({
        complete: true,
        ids: ["finance-plan", "sales-plan"],
      });
    });

    it("finds nothing for a caller with no policies", async () => {
      const { index } = await ready();
      await index.upsert([record("board-minutes", "policy:board")]);

      await expect(
        index.query([1, 0, 0], { policies: [], topK: 10 })
      ).resolves.toStrictEqual({ matches: [], complete: true });
    });

    it("finds a record only under the policy it was last indexed under", async () => {
      const { index } = await ready();
      await index.upsert([record("plan", "policy:sales")]);
      await index.upsert([record("plan", "policy:board")]);

      const [sales, board] = await Promise.all(
        ["policy:sales", "policy:board"].map(
          async (policy) =>
            await index.query([1, 0, 0], { policies: [policy], topK: 10 })
        )
      );

      expect([
        idsOf(sales?.matches ?? []),
        idsOf(board?.matches ?? []),
      ]).toStrictEqual([[], ["plan"]]);
    });

    it("refuses a policy key longer than every provider matches exactly", async () => {
      const { index } = await ready();
      const shared = "k".repeat(maxPolicyKeyBytes);

      const kinds = await Promise.all([
        kindOf(index.upsert([record("board-minutes", `${shared}board`)])),
        kindOf(
          index.query([1, 0, 0], { policies: [`${shared}sales`], topK: 10 })
        ),
      ]);
      // Exactly 64 bytes, multi-byte characters included, is exact.
      const exact = "é".repeat(maxPolicyKeyBytes / 2);
      await index.upsert([record("plan", exact)]);
      const found = await index.query([1, 0, 0], {
        policies: [exact],
        topK: 10,
      });

      expect({
        kinds,
        found: idsOf(found.matches),
        listed: idsOf(await listAll(index)),
      }).toStrictEqual({
        kinds: ["invalid", "invalid"],
        found: ["plan"],
        listed: ["plan"],
      });
    });

    it("keeps reserved keys and IDs from every caller", async () => {
      const { index } = await ready();
      const reserved = `${reservedPrefix}filter-probe`;

      const kinds = await Promise.all([
        kindOf(index.query([1, 0, 0], { policies: [reserved], topK: 5 })),
        kindOf(index.upsert([record(reserved, "policy:sales")])),
        kindOf(index.upsert([record("plan", reserved)])),
        kindOf(index.delete([reserved])),
      ]);

      expect({ kinds, listed: await listAll(index) }).toStrictEqual({
        kinds: ["invalid", "invalid", "invalid", "invalid"],
        listed: [],
      });
    });

    it("searches every policy of a large grant set that fits one search", async () => {
      const { index } = await ready();
      const policies = Array.from(
        { length: 150 },
        (_, n) => `policy:team-${n}`
      );
      await index.upsert([
        record("first", policies[0] ?? ""),
        record("last", policies.at(-1) ?? "", [0.9, 0.1, 0]),
        record("hidden", "policy:board"),
      ]);

      const found = await index.query([1, 0, 0], { policies, topK: 10 });

      expect({
        complete: found.complete,
        ids: found.matches.map(({ id }) => id),
      }).toStrictEqual({ complete: true, ids: ["first", "last"] });
    });

    it("says it is incomplete past one search's policies, and searches the first ones", async () => {
      const { index } = await ready();
      // Most important first: a key that sorts last still comes first.
      const policies = [
        "policy:z-priority",
        ...Array.from(
          { length: 2000 },
          (_, n) => `policy:${String(n).padStart(4, "0")}`
        ),
      ];
      const covered = policyBatches(policies).batches.flat();
      const lastCovered = covered.at(-1) ?? "";
      const firstLeftOut = policies[covered.length] ?? "";
      await index.upsert([
        record("priority", "policy:z-priority"),
        record("last-covered", lastCovered, [0.9, 0.1, 0]),
        record("left-out", firstLeftOut),
      ]);

      const found = await index.query([1, 0, 0], { policies, topK: 10 });

      expect({
        complete: found.complete,
        ids: found.matches.map(({ id }) => id),
      }).toStrictEqual({
        complete: false,
        ids: ["priority", "last-covered"],
      });
    });

    it("puts the nearest first and returns at most topK", async () => {
      const { index } = await ready();
      await index.upsert([
        record("far", "policy:sales", [0, 1, 0]),
        record("near", "policy:sales", [0.8, 0.2, 0]),
        record("nearest", "policy:sales", [1, 0, 0]),
      ]);

      const found = await index.query([1, 0, 0], {
        policies: ["policy:sales"],
        topK: 2,
      });

      expect(found.matches.map(({ id }) => id)).toStrictEqual([
        "nearest",
        "near",
      ]);
    });

    it("refuses input that doesn't fit the generation or the portable limits", async () => {
      const { index } = await ready();
      await index.upsert([record("kept", "policy:sales")]);
      // A hole at 1, as in a sparse array a caller built.
      const sparse: number[] = [];
      sparse[0] = 1;
      sparse[2] = 0;
      const search = { policies: ["policy:sales"], topK: 5 };

      const kinds = await Promise.all([
        kindOf(index.query([1, 0], search)),
        kindOf(index.query(sparse, search)),
        kindOf(index.query([1, 0, 0], { ...search, topK: 101 })),
        kindOf(index.query([1, 0, 0], { ...search, topK: 0 })),
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
              sourceVersion: "v".repeat(257),
            },
          ])
        ),
        kindOf(index.upsert([record("x".repeat(65), "policy:sales")])),
        // One bad record refuses the whole write.
        kindOf(
          index.upsert([
            record("plan", "policy:sales"),
            record("", "policy:sales"),
          ])
        ),
        kindOf(index.delete(["kept", "x".repeat(65)])),
      ]);

      expect({ kinds, listed: idsOf(await listAll(index)) }).toStrictEqual({
        kinds: Array.from({ length: 11 }, () => "invalid"),
        listed: ["kept"],
      });
    });
  });

  describe(`${name}: writes`, () => {
    it("keeps one record per ID when a write is repeated", async () => {
      const { index } = await ready();
      const records = [
        record("plan", "policy:sales"),
        record("notes", "policy:sales", [0.9, 0.1, 0]),
      ];

      await index.upsert(records);
      await index.upsert(records);
      const found = await index.query([1, 0, 0], {
        policies: ["policy:sales"],
        topK: 10,
      });

      expect({
        found: found.matches.map(({ id }) => id),
        listed: await listAll(index),
      }).toStrictEqual({
        found: ["plan", "notes"],
        listed: [
          { id: "notes", sourceVersion: "notes@1" },
          { id: "plan", sourceVersion: "plan@1" },
        ],
      });
    });

    it("keeps the last record of an ID given twice in one write", async () => {
      const { index } = await ready();

      await index.upsert([
        record("plan", "policy:sales", [1, 0, 0], "plan@1"),
        record("plan", "policy:finance", [1, 0, 0], "plan@2"),
      ]);
      const [sales, finance] = await Promise.all(
        ["policy:sales", "policy:finance"].map(
          async (policy) =>
            await index.query([1, 0, 0], { policies: [policy], topK: 10 })
        )
      );

      expect({
        sales: idsOf(sales?.matches ?? []),
        finance: idsOf(finance?.matches ?? []),
        listed: await listAll(index),
      }).toStrictEqual({
        sales: [],
        finance: ["plan"],
        listed: [{ id: "plan", sourceVersion: "plan@2" }],
      });
    });

    it("deletes exactly what it is told, and repeating a delete is no error", async () => {
      const { index } = await ready();
      await index.upsert([
        record("keep", "policy:sales", [0.9, 0.1, 0]),
        record("erase", "policy:sales"),
      ]);

      await index.delete(["erase", "erase", "never-there"]);
      await index.delete(["erase"]);
      const found = await index.query([1, 0, 0], {
        policies: ["policy:sales"],
        topK: 10,
      });

      expect({
        found: idsOf(found.matches),
        listed: idsOf(await listAll(index)),
      }).toStrictEqual({ found: ["keep"], listed: ["keep"] });
    });

    it("lists every record exactly once across pages", async () => {
      const { index } = await ready();
      const records = Array.from({ length: 2500 }, (_, n) =>
        record(`chunk-${String(n).padStart(4, "0")}`, `policy:${n % 7}`)
      );
      await index.upsert(records);

      const listed = await listAll(index);

      expect(listed).toStrictEqual(
        records
          .map(({ id, sourceVersion }) => ({ id, sourceVersion }))
          .toSorted((a, b) => a.id.localeCompare(b.id))
      );
    });
  });

  describe(`${name}: generations`, () => {
    it("never mixes two generations' records", async () => {
      const made = await harness({ generations: conformanceGenerations });
      await Promise.all(
        conformanceGenerations.map(async (of) => await made.provider.create(of))
      );
      const current = made.provider.open(generation);
      const next = made.provider.open(nextGeneration);
      await current.upsert([record("old", "policy:sales")]);
      await next.upsert([record("new", "policy:sales")]);

      const found = await current.query([1, 0, 0], {
        policies: ["policy:sales"],
        topK: 10,
      });

      const generations = await made.provider.generations();

      expect({
        found: idsOf(found.matches),
        current: idsOf(await listAll(current)),
        next: idsOf(await listAll(next)),
        generations: generations
          .map(({ id }) => id)
          .filter((id) => id === generation.id || id === nextGeneration.id)
          .toSorted((a, b) => a.localeCompare(b)),
      }).toStrictEqual({
        found: ["old"],
        current: ["old"],
        next: ["new"],
        generations: [generation.id, nextGeneration.id].toSorted((a, b) =>
          a.localeCompare(b)
        ),
      });
    });

    it("says a ready index works for its generation", async () => {
      const { index } = await ready();

      await expect(index.status()).resolves.toMatchObject({
        generation: generation.id,
        dimensions: generation.dimensions,
        filtering: "working",
      });
    });

    it("refuses a generation whose ID doesn't name what it was made with", async () => {
      const made = await harness({ generations: conformanceGenerations });
      const relabelled = { ...generation, route: "elsewhere" };

      const kinds = await Promise.all([
        kindOf(made.provider.create(relabelled)),
        kindOf(Promise.resolve().then(() => made.provider.open(relabelled))),
      ]);

      expect(kinds).toStrictEqual(["invalid", "invalid"]);
    });

    it("drops one generation's records and leaves the other's", async () => {
      const made = await harness({ generations: conformanceGenerations });
      await Promise.all(
        conformanceGenerations.map(async (of) => await made.provider.create(of))
      );
      await made.provider
        .open(generation)
        .upsert([record("old", "policy:sales")]);
      await made.provider
        .open(nextGeneration)
        .upsert([record("new", "policy:sales")]);

      await made.provider.drop(generation);
      await made.provider.drop(generation);

      // A dropped generation lists nothing, or is gone altogether.
      const dropped = await listAll(made.provider.open(generation)).catch(
        (error: unknown) => {
          if (error instanceof VectorIndexError && error.kind === "invalid") {
            return [];
          }
          throw error;
        }
      );
      expect({
        dropped,
        kept: idsOf(await listAll(made.provider.open(nextGeneration))),
      }).toStrictEqual({ dropped: [], kept: ["new"] });
    });

    it("reconciles an index with its canonical records", async () => {
      const { index } = await ready();
      await index.upsert([
        record("current", "policy:sales"),
        record("stale", "policy:sales", [1, 0, 0], "stale@1"),
        record("orphan", "policy:sales"),
      ]);
      const canonical = new Map([
        ["current", "current@1"],
        ["stale", "stale@2"],
        ["missing", "missing@1"],
      ]);

      const before = await reconcileGeneration(index, canonical);
      await index.upsert([
        record("stale", "policy:sales", [1, 0, 0], "stale@2"),
        record("missing", "policy:sales"),
      ]);
      await index.delete(before.extra);
      const after = await reconcileGeneration(index, canonical);

      expect({ before, after }).toStrictEqual({
        before: { missing: ["missing"], stale: ["stale"], extra: ["orphan"] },
        after: { missing: [], stale: [], extra: [] },
      });
    });
  });

  describe(`${name}: when the provider fails`, () => {
    it("reports an outage as unavailable, never as no matches", async () => {
      const { index, faults } = await ready();
      await index.upsert([record("plan", "policy:sales")]);
      faults.outage();

      const kinds = await Promise.all([
        kindOf(index.query([1, 0, 0], { policies: ["policy:sales"], topK: 5 })),
        kindOf(index.upsert([record("notes", "policy:sales")])),
        kindOf(index.delete(["plan"])),
        kindOf(index.ids()),
      ]);

      expect(kinds).toStrictEqual([
        "unavailable",
        "unavailable",
        "unavailable",
        "unavailable",
      ]);
    });

    it("gives up on a provider that doesn't answer", async () => {
      const { index, faults } = await ready({ deadlineMs: 50 });
      faults.hang();

      const kinds = await Promise.all([
        kindOf(index.query([1, 0, 0], { policies: ["policy:sales"], topK: 5 })),
        kindOf(index.upsert([record("plan", "policy:sales")])),
        kindOf(index.delete(["plan"])),
        kindOf(index.ids()),
      ]);

      expect(kinds).toStrictEqual([
        "unavailable",
        "unavailable",
        "unavailable",
        "unavailable",
      ]);
    });

    it("reports a write applied in part as failed, and completes it when repeated", async () => {
      const { index, faults } = await ready();
      const records = Array.from({ length: 2500 }, (_, n) =>
        record(`chunk-${String(n).padStart(4, "0")}`, "policy:sales")
      );
      faults.partialWrite();

      const failed = await kindOf(index.upsert(records));
      faults.heal();
      const partly = await listAll(index);
      await index.upsert(records);
      const listed = await listAll(index);

      expect({
        failed,
        partly: partly.length < records.length,
        listed: listed.length,
      }).toStrictEqual({ failed: "unavailable", partly: true, listed: 2500 });
    });

    it("answers again once the provider is back", async () => {
      const { index, faults } = await ready();
      await index.upsert([record("plan", "policy:sales")]);
      faults.outage();
      await kindOf(
        index.query([1, 0, 0], { policies: ["policy:sales"], topK: 5 })
      );
      faults.heal();

      const found = await index.query([1, 0, 0], {
        policies: ["policy:sales"],
        topK: 5,
      });

      expect(idsOf(found.matches)).toStrictEqual(["plan"]);
    });
  });
};
