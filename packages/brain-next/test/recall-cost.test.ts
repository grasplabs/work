import type {
  Access,
  ChunkRef,
  Reader,
  VectorModel,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { recallBudgetMax, vectorsPerPutMax } from "../src/contract.ts";

// What a recall costs the store, against what the reader may not read.
// #2134's rule: chunks of sources the reader may not read are never
// grouped, counted, ranked or scanned. No answer shows that rule broken
// (a recall that counted every chunk's stop words still answers the
// same), so this file holds it by cost: the rows the store's SQL reads,
// as workerd counts them (each cursor's `rowsRead`).
//
// What it found, and so what it holds: a hidden chunk is not free. Each
// one holding a word, a stop word or an ID the question asks is still
// read: the word index's lookup lists it, and the joins drop it at the
// reader's check, some 10 to 36 rows a hidden chunk on this corpus. That
// is the store as designed today (the filter joins the index's matches;
// it doesn't drive the index), not a break. The vector scan reads only
// the reader's own groups' codes, and so reads nothing of a hidden one.
//
// So each way is held to a budget of rows per hidden chunk: what it reads
// for each of 1,200 hidden chunks beside the reader's own 3, measured on
// main, with 3 % of margin. The counts are exact: the same corpus reads
// the same rows run after run (with the reader's own sources alone, they
// differ by a few rows from one run to the next, as the sources' random
// keys sort; with 1,200 hidden chunks, not at all). A way that groups,
// counts, ranks or scans hidden chunks it may not read pays more for each
// and fails: counting every chunk's stop words costs the words way 8 %
// more a hidden chunk, ranking hidden chunks under the exact way's cap
// 26 % more, dropping the reader's check 50 to 66 % more, and scanning other
// groups' codes makes the vector scan read the hidden codes too (about
// one row a hidden chunk, against none).

/** Rows the store's SQL read, counted at the store itself. */
interface Counter {
  rows: () => number;
  reset: () => void;
}

/** The counters of the stores of this file, by their object's id. */
const counters = new Map<string, Counter>();

/** A store of its own, its SQL's reads counted. */
const countedStore = async () => {
  const stub = env.BRAIN_STORE.getByName(crypto.randomUUID());
  // The store woken and its SQL wrapped once: every cursor its statements
  // open is kept, and their rows read summed when asked. The test runs in
  // the store's own isolate, so the counter is reached here.
  await runInDurableObject(stub, (_instance, state) => {
    const { sql } = state.storage;
    const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
    const exec = sql.exec.bind(sql);
    Object.defineProperty(sql, "exec", {
      value: (...args: Parameters<typeof sql.exec>) => {
        const cursor = exec(...args);
        cursors.push(cursor);
        return cursor;
      },
    });
    counters.set(stub.id.toString(), {
      rows: () => cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      reset: () => {
        cursors.length = 0;
      },
    });
  });
  /** The rows `ask` has the store's SQL read. */
  const rowsReadBy = async (ask: () => Promise<unknown>): Promise<number> => {
    const counter = counters.get(stub.id.toString());
    counter?.reset();
    await ask();
    return counter?.rows() ?? Number.NaN;
  };
  return { stub, rowsReadBy };
};

const reader: Reader = { person: "reader", groups: [] };
const own: Access = { kind: "owner", person: "reader" };
const someoneElse: Access = { kind: "owner", person: "someone-else" };

/** Hidden sources, and passages in each. */
const hiddenSources = 6;
const hiddenPassages = 200;
const hiddenChunks = hiddenSources * hiddenPassages;

/** What every chunk holds: telling words, stop words and an ID. */
const words = "The invoice of the warehouse INV-2024-0042 and the";

/** `count` passages, each a paragraph of its own, each holding `words`. */
const passagesOf = (count: number): string =>
  Array.from({ length: count }, (_, index) =>
    `${words} ${index} `.padEnd(650, "x")
  ).join("\n\n");

/** A vector model of 8 dimensions, centred on 0. */
const model: VectorModel = {
  name: "cost-test@1",
  centre: Array.from({ length: 8 }, () => 0),
};

/** A vector of random numbers from -1 to 1. */
const randomVector = (): number[] =>
  Array.from({ length: 8 }, () => Math.random() * 2 - 1);

type Store = ReturnType<typeof env.BRAIN_STORE.getByName>;

/** Puts a vector for each of `chunks`, as many puts as it takes. */
const putVectorsOf = async (
  stub: Store,
  chunks: readonly ChunkRef[]
): Promise<void> => {
  for (let start = 0; start < chunks.length; start += vectorsPerPutMax) {
    // oxlint-disable-next-line no-await-in-loop -- one put at a time
    await stub.putVectors({
      model,
      vectors: chunks
        .slice(start, start + vectorsPerPutMax)
        .map((chunk) => ({ chunk, vector: randomVector() })),
    });
  }
};

/** The ways recall reads, each asked of the store as the reader. */
const waysOf = (stub: Store) => {
  const recall = (question: string) => async () =>
    await stub.recall({
      question,
      reader,
      budget: { tokens: recallBudgetMax },
    });
  return {
    // Telling words and stop words: the words way, its stop words counted.
    words: recall("invoice of the warehouse"),
    // A telling word no chunk holds: what the stop words alone find.
    stopWords: recall("zebra of the"),
    // An ID: the exact way, its cap.
    exact: recall("INV-2024-0042"),
    vectors: async () =>
      await stub.searchVectors({
        model: model.name,
        vector: randomVector(),
        reader,
        limit: 10,
      }),
  };
};

type Way = keyof ReturnType<typeof waysOf>;

/** Rows per hidden chunk each way may read: main's own, with 3 % margin. */
const budgets: Record<Way, number> = {
  words: 37.1,
  stopWords: 10.3,
  exact: 30.9,
  vectors: 0.05,
};

describe("what a recall reads of what the reader may not read", () => {
  it("reads, for each way, no more rows per hidden chunk than its budget", async () => {
    const { stub, rowsReadBy } = await countedStore();
    const ownChunks: ChunkRef[] = [];
    for (let index = 0; index < 3; index += 1) {
      const source = `upload:own-${index}`;
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      const { version } = await stub.addSource({
        source,
        change: crypto.randomUUID(),
        text: `${words} ${index}`,
        access: own,
      });
      ownChunks.push({ source, version, position: 0 });
    }
    await putVectorsOf(stub, ownChunks);
    const ways = waysOf(stub);
    const names: readonly Way[] = ["words", "stopWords", "exact", "vectors"];
    const alone = new Map<Way, number>();
    for (const name of names) {
      // oxlint-disable-next-line no-await-in-loop -- one way at a time
      alone.set(name, await rowsReadBy(ways[name]));
    }
    const hidden: ChunkRef[] = [];
    for (let index = 0; index < hiddenSources; index += 1) {
      const source = `upload:hidden-${index}`;
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      const { version } = await stub.addSource({
        source,
        change: crypto.randomUUID(),
        text: passagesOf(hiddenPassages),
        access: someoneElse,
      });
      hidden.push(
        ...Array.from({ length: hiddenPassages }, (_, position) => ({
          source,
          version,
          position,
        }))
      );
    }
    await putVectorsOf(stub, hidden);
    const read: Partial<Record<Way, number>> = {};
    for (const name of names) {
      // oxlint-disable-next-line no-await-in-loop -- one way at a time
      const beside = await rowsReadBy(ways[name]);
      read[name] =
        Math.round(((beside - (alone.get(name) ?? 0)) / hiddenChunks) * 100) /
        100;
    }

    expect(
      Object.fromEntries(
        names.map((name) => [
          name,
          {
            perHiddenChunk: read[name],
            over: (read[name] ?? 0) > budgets[name],
          },
        ])
      )
    ).toStrictEqual(
      Object.fromEntries(
        names.map((name) => [name, { perHiddenChunk: read[name], over: false }])
      )
    );
  });
});
