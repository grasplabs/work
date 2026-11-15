// What a writer's erasure costs the store (erasure.ts `eraseWriter`), held
// by cost as memories-cost.test.ts holds reads: the rows the store's SQL
// reads, as workerd counts them (each cursor's `rowsRead`), through the
// store's public method. The call records the erasure, which hides the
// writer's memories, counts them, and deletes a batch of them: rows
// linear in the writer's memories, never in anyone else's.
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
  const rowsFor = async (count: number): Promise<number> => {
    const writer = `app:${crypto.randomUUID()}`;
    await writtenBy(stub, writer, count);
    return (
      (await rowsReadBy(
        async () => await stub.eraseWriter({ writer, reason: "deleted" })
      )) / count
    );
  };
  return [await rowsFor(small), await rowsFor(large)];
};

/** How much more a memory of a writer four times as large may cost: index trees grow a level. */
const margin = 1.1;

describe("what a writer's erasure costs", () => {
  it("reads rows in proportion to the writer's memories, and none for anyone else's", async () => {
    const [small = 0, large = 0] = await perMemory(100, 400, 0);
    expect(large).toBeLessThanOrEqual(small * margin);

    // Others' memories, many of them, cost it nothing more.
    const [crowded = 0] = await perMemory(100, 100, 2000);
    expect(crowded).toBeLessThanOrEqual(small * margin);
  });
});
