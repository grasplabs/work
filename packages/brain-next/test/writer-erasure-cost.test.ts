// What a writer's erasure costs the store (erasure.ts `eraseWriter`), held
// by cost as memories-cost.test.ts holds reads: the rows the store's SQL
// reads, as workerd counts them (each cursor's `rowsRead`), through the
// store's public method. The call records the erasure, which hides the
// writer's memories, counts them, and deletes a batch of them: rows
// linear in the writer's memories, never in anyone else's. Every name,
// writer and statement is fixed, and each case has a store of its own
// from empty storage: what a read's word walk reads depends on the other
// names in the store, so names drawn at random would make the counts
// differ between runs for reasons that aren't erasures.
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

/** Every cursor the store's statements opened since the count was last cleared. */
const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];

/** The shared store, from empty storage, its SQL's reads counted. */
const countedStore = async () => {
  await reset();
  const stub = env.BRAIN_STORE.getByName("brain");
  await runInDurableObject(stub, (_instance, state) => {
    const { sql } = state.storage;
    const exec = sql.exec.bind(sql);
    Object.defineProperty(sql, "exec", {
      value: (...args: Parameters<typeof sql.exec>) => {
        const cursor = exec(...args);
        cursors.push(cursor);
        return cursor;
      },
    });
  });
  /** The rows `ask` has the store's SQL read. */
  const rowsReadBy = async (ask: () => Promise<unknown>): Promise<number> => {
    cursors.length = 0;
    await ask();
    return cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
  };
  return { stub, rowsReadBy };
};

type Store = Awaited<ReturnType<typeof countedStore>>["stub"];

/** Adds `count` memories by `writer`, each about an entity of its own, a hundred an add. */
const writtenBy = async (
  stub: Store,
  writer: string,
  count: number
): Promise<void> => {
  for (let start = 0; start < count; start += 100) {
    const keys = Array.from(
      { length: Math.min(100, count - start) },
      (_, index) => `e${index}`
    );
    // oxlint-disable-next-line no-await-in-loop -- one add at a time
    await stub.addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: "team:cost" },
      entities: keys.map((key) => ({
        key,
        kind: "customer",
        names: [`${writer} ${start} ${key}`],
      })),
      memories: keys.map((key) => ({
        about: key,
        type: "fact",
        statement: `${writer} wrote ${start} ${key}`,
        speaker: { kind: "system" },
        basis: { kind: "writer", writer },
      })),
    });
  }
};

/** Rows of a writer's erasure, per memory of its, at `small` and at `large` memories. */
const perMemory = async (small: number, large: number, others: number) => {
  const { stub, rowsReadBy } = await countedStore();
  await writtenBy(stub, "app:others", others);
  const rowsFor = async (count: number, writer: string): Promise<number> => {
    await writtenBy(stub, writer, count);
    return (
      (await rowsReadBy(
        async () =>
          await stub.eraseWriter({ writer, reason: "deleted", change: "reset" })
      )) / count
    );
  };
  return [await rowsFor(small, "app:small"), await rowsFor(large, "app:large")];
};

/** How much more a memory of a writer four times as large may cost: index trees grow a level. */
const margin = 1.1;

/**
 * Rows an index seek may read more as the indexes grow deeper (as in
 * memories-cost.test.ts): a check of each memory against every earlier
 * erasure of its writer would read one more row a memory an erasure.
 */
const seekMargin = 8;

/**
 * The reads of 20 memories of one writer's, erased `times` before they
 * were written, in a store of their own: the same names and statements
 * whatever `times` is.
 */
const readsAfter = async (times: number): Promise<Record<string, number>> => {
  const { stub, rowsReadBy } = await countedStore();
  const writer = "app:cost";
  for (let time = 0; time < times; time += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
    await stub.eraseWriter({ writer, reason: "deleted", change: `${time}` });
  }
  const name = "wcostreads";
  const { entities } = await stub.addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group: "team:cost" },
    entities: [{ key: "c", kind: "customer", names: [`${name} Holdings`] }],
    memories: Array.from({ length: 20 }, (_, index) => ({
      about: "c",
      type: "fact" as const,
      statement: `${name} said ${index}`,
      speaker: { kind: "system" as const },
      basis: { kind: "writer" as const, writer },
    })),
  });
  const entity = entities.c ?? "";
  const reader = { person: "p", groups: ["team:cost"] };
  return {
    readMemories: await rowsReadBy(
      async () => await stub.readMemories({ entity, reader })
    ),
    readCard: await rowsReadBy(
      async () => await stub.readCard({ entity, reader })
    ),
    findEntities: await rowsReadBy(
      async () => await stub.findEntities({ reader, name: `${name} Holdings` })
    ),
    recall: await rowsReadBy(
      async () =>
        await stub.recall({ question: name, reader, budget: { tokens: 4000 } })
    ),
  };
};

describe("what a writer's erasure costs", () => {
  it("leaves reads of the writer's later memories as dear as if it had never been erased, however often it was", async () => {
    const never = await readsAfter(0);
    const often = await readsAfter(20);
    expect(
      Object.fromEntries(
        Object.entries(often).map(([read, rows]) => [
          read,
          rows - (never[read] ?? 0) <= seekMargin,
        ])
      )
    ).toStrictEqual({
      readMemories: true,
      readCard: true,
      findEntities: true,
      recall: true,
    });
  });

  it("reads rows in proportion to the writer's memories, and none for anyone else's", async () => {
    const [small = 0, large = 0] = await perMemory(100, 400, 0);
    expect(large).toBeLessThanOrEqual(small * margin);

    // Others' memories, many of them, cost it nothing more.
    const [crowded = 0] = await perMemory(100, 100, 2000);
    expect(crowded).toBeLessThanOrEqual(small * margin);
  });
});
