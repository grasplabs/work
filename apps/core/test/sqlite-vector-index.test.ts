import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { sqliteVectorIndexProvider } from "../src/knowledge/sqlite-vector-index.ts";
import type {
  SqliteVectorOptions,
  SqliteVectorStores,
} from "../src/knowledge/sqlite-vector-index.ts";
import { vectorIndexProviderOf } from "../src/knowledge/vector-index-profile.ts";
import { VectorIndexError } from "../src/knowledge/vector-index.ts";
import type {
  VectorIndex,
  VectorRecord,
} from "../src/knowledge/vector-index.ts";
import { reconcileGeneration } from "../src/knowledge/vector-rebuild.ts";
import type { ModelsEnv } from "../src/models.ts";
import {
  conformanceGenerations,
  vectorIndexConformance,
} from "./vector-index-conformance.ts";

// The `sqlite` profile, on the real Durable Objects in workerd. It passes
// the behaviour suite every vector index implementation passes
// (vector-index-conformance.ts), and these tests add what is its own: a
// key's records spread over sub-shards, the index as the deployment's
// default under EU rules, a shard woken again from its storage, and a
// write cut off at each of its steps, as a crash leaves it, then
// reconciled with its canonical records the way a rebuild does
// (vector-rebuild.ts). Faults come from a stand-in in front of each
// object that fails or never answers the calls a test names.

const [generation] = conformanceGenerations;

interface Faults {
  outage: boolean;
  hang: boolean;
  /** Calls by method name to let through before failing the next one. */
  failAfter: Map<string, number>;
}

const never = Promise.withResolvers<never>().promise;

/** `namespace`, whose objects' calls fail or hang as `faults` says. */
const faulty = <Target extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<Target>,
  faults: Faults
): Pick<DurableObjectNamespace<Target>, "getByName"> => ({
  getByName: (name) =>
    new Proxy(namespace.getByName(name), {
      get: (stub, method) => {
        const member: unknown = Reflect.get(stub, method);
        if (typeof method !== "string" || typeof member !== "function") {
          return member;
        }
        return async (...args: unknown[]): Promise<unknown> => {
          if (faults.hang) {
            await never;
          }
          const left = faults.failAfter.get(method);
          if (left !== undefined) {
            faults.failAfter.set(method, left - 1);
          }
          if (faults.outage || left === 0) {
            faults.failAfter.delete(method);
            throw new Error(`The object didn't answer ${method}.`);
          }
          return await Reflect.apply(member, stub, args);
        };
      },
    }),
});

/** A provider of its own catalog, over the real objects behind faults. */
const sqliteIndex = (options: SqliteVectorOptions = {}) => {
  const faults: Faults = { outage: false, hang: false, failAfter: new Map() };
  const stores: SqliteVectorStores = {
    catalog: faulty(env.VECTOR_CATALOG, faults),
    shards: faulty(env.VECTOR_SHARDS, faults),
  };
  const name = crypto.randomUUID();
  return {
    name,
    faults,
    provider: sqliteVectorIndexProvider(stores, { name, ...options }),
  };
};

vectorIndexConformance("sqlite", ({ deadlineMs }) => {
  const { provider, faults } = sqliteIndex(
    deadlineMs === undefined
      ? {}
      : { queryDeadlineMs: deadlineMs, writeDeadlineMs: deadlineMs }
  );
  return {
    provider,
    faults: {
      outage: () => {
        faults.outage = true;
      },
      hang: () => {
        faults.hang = true;
      },
      // The first shard write of a write goes through, the next fails.
      partialWrite: () => {
        faults.failAfter.set("put", 1);
      },
      heal: () => {
        faults.outage = false;
        faults.hang = false;
        faults.failAfter.clear();
      },
    },
  };
});

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

const found = async (
  index: VectorIndex,
  policies: string[],
  topK = 10
): Promise<string[]> => {
  const { matches } = await index.query([1, 0, 0], { policies, topK });
  return matches.map(({ id }) => id);
};

const listed = async (index: VectorIndex) => {
  const { entries } = await index.ids();
  return entries;
};

/**
 * What a rebuild's reconcile and fill phases do: compares the index with
 * the canonical records, writes the missing and stale ones again and
 * deletes the extra, until nothing differs; returns the first difference.
 */
const rebuild = async (
  index: VectorIndex,
  canonical: readonly VectorRecord[]
) => {
  const versions = new Map(
    canonical.map(({ id, sourceVersion }) => [id, sourceVersion])
  );
  const first = await reconcileGeneration(index, versions);
  const redo = new Set([...first.missing, ...first.stale]);
  await index.upsert(canonical.filter(({ id }) => redo.has(id)));
  await index.delete(first.extra);
  return { first, after: await reconcileGeneration(index, versions) };
};

describe("sqlite: shards", () => {
  it("spreads a key's records over sub-shards and searches them all", async () => {
    const { provider } = sqliteIndex({ shardCapacity: 2 });
    await provider.create(generation);
    const index = provider.open(generation);
    const records = [0.9, 0.8, 0.7, 0.6, 0.5].map((near, n) =>
      record(`chunk-${n}`, "policy:sales", [near, 1 - near, 0])
    );
    await index.upsert([...records, record("other", "policy:board")]);

    const before = await found(index, ["policy:sales"], 4);
    await index.delete(["chunk-1"]);
    await index.upsert([record("chunk-5", "policy:sales", [1, 0, 0])]);

    expect({
      before,
      after: await found(index, ["policy:sales"]),
      board: await found(index, ["policy:board"]),
    }).toStrictEqual({
      before: ["chunk-0", "chunk-1", "chunk-2", "chunk-3"],
      after: ["chunk-5", "chunk-0", "chunk-2", "chunk-3", "chunk-4"],
      board: ["other"],
    });
  });

  it("answers from its storage once a shard wakes again", async () => {
    const { provider, name } = sqliteIndex();
    await provider.create(generation);
    const index = provider.open(generation);
    await index.upsert([
      record("near", "policy:sales", [0.9, 0.1, 0]),
      record("nearest", "policy:sales"),
    ]);
    await found(index, ["policy:sales"]);
    const shard = env.VECTOR_SHARDS.getByName(
      JSON.stringify([name, generation.id, "policy:sales", 0])
    );

    await runInDurableObject(shard, (_, state) => {
      state.abort("restarted by the test");
    }).catch(() => {});

    await expect(found(index, ["policy:sales"])).resolves.toStrictEqual([
      "nearest",
      "near",
    ]);
  });
});

describe("sqlite: as the deployment's index", () => {
  it("serves a deployment whose rules keep everything in the EU", async () => {
    const euModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const euOnly: ModelsEnv = {
      ...env,
      MODEL_GATEWAY: {
        gateway: "grasp-os-test",
        models: [euModel],
        eu: { models: [euModel], deployment: true },
      },
    };
    const provider = vectorIndexProviderOf(euOnly);
    await provider.create(generation);
    const id = `eu-${crypto.randomUUID()}`;
    await provider.open(generation).upsert([record(id, "policy:eu-only")]);

    const matches = await found(provider.open(generation), ["policy:eu-only"]);
    await provider.open(generation).delete([id]);

    expect({ profile: provider.profile, found: matches }).toStrictEqual({
      profile: "sqlite",
      found: [id],
    });
  });
});

describe("sqlite: a write cut off by a crash", () => {
  it("leaves a moved record findable only under its new key once rebuilt", async () => {
    const { provider, faults } = sqliteIndex();
    await provider.create(generation);
    const index = provider.open(generation);
    await index.upsert([
      record("plan", "policy:board"),
      record("notes", "policy:board"),
    ]);
    const moved = record("plan", "policy:sales", [1, 0, 0], "plan@2");
    const canonical = [moved, record("notes", "policy:board")];
    // Placed under its new key, then cut off before its old vector goes.
    faults.failAfter.set("remove", 0);

    const failed = await kindOf(index.upsert([moved]));
    const { first, after } = await rebuild(index, canonical);

    expect({
      failed,
      first,
      after,
      board: await found(index, ["policy:board"]),
      sales: await found(index, ["policy:sales"]),
    }).toStrictEqual({
      failed: "unavailable",
      first: { missing: [], stale: ["plan"], extra: [] },
      after: { missing: [], stale: [], extra: [] },
      board: ["notes"],
      sales: ["plan"],
    });
  });

  it("deletes a written vector whose record is gone, once rebuilt", async () => {
    const { provider, faults } = sqliteIndex();
    await provider.create(generation);
    const index = provider.open(generation);
    await index.upsert([record("kept", "policy:sales", [0.9, 0.1, 0])]);
    // Written to its shard, then cut off before the catalog records it.
    faults.failAfter.set("commit", 0);
    const failed = await kindOf(
      index.upsert([record("erased", "policy:sales")])
    );
    const findable = await found(index, ["policy:sales"]);

    // The source deleted "erased" meanwhile: it isn't canonical.
    const { first, after } = await rebuild(index, [
      record("kept", "policy:sales", [0.9, 0.1, 0]),
    ]);

    expect({
      failed,
      findable,
      first,
      after,
      found: await found(index, ["policy:sales"]),
    }).toStrictEqual({
      failed: "unavailable",
      findable: ["erased", "kept"],
      first: { missing: [], stale: [], extra: ["erased"] },
      after: { missing: [], stale: [], extra: [] },
      found: ["kept"],
    });
  });

  it("finishes a delete cut off before the catalog forgot the record", async () => {
    const { provider, faults } = sqliteIndex();
    await provider.create(generation);
    const index = provider.open(generation);
    await index.upsert([
      record("kept", "policy:sales", [0.9, 0.1, 0]),
      record("erased", "policy:sales"),
    ]);
    faults.failAfter.set("forget", 0);

    const failed = await kindOf(index.delete(["erased"]));
    const { first, after } = await rebuild(index, [
      record("kept", "policy:sales", [0.9, 0.1, 0]),
    ]);

    expect({
      failed,
      first,
      after,
      found: await found(index, ["policy:sales"]),
    }).toStrictEqual({
      failed: "unavailable",
      first: { missing: [], stale: [], extra: ["erased"] },
      after: { missing: [], stale: [], extra: [] },
      found: ["kept"],
    });
  });

  it("keeps a record in one place when a write after a failed one moves it back", async () => {
    const { provider, faults } = sqliteIndex();
    await provider.create(generation);
    const index = provider.open(generation);
    await index.upsert([record("plan", "policy:sales")]);
    // A write moves "plan" to board but stops before its shard writes;
    // a later write moves it back to sales and completes.
    faults.failAfter.set("put", 0);
    const failed = await kindOf(index.upsert([record("plan", "policy:board")]));
    await index.upsert([record("plan", "policy:sales", [1, 0, 0], "plan@3")]);

    expect({
      failed,
      sales: await found(index, ["policy:sales"]),
      board: await found(index, ["policy:board"]),
      listed: await listed(index),
    }).toStrictEqual({
      failed: "unavailable",
      sales: ["plan"],
      board: [],
      listed: [{ id: "plan", sourceVersion: "plan@3" }],
    });
  });
});
