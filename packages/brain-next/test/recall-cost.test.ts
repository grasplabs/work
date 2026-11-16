import type {
  Access,
  ChunkRef,
  Reader,
  VectorModel,
} from "@grasp-os/brain-next/contract";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { recallBudgetMax, vectorsPerPutMax } from "../src/contract.ts";
import { countRowsRead } from "./rows-read.ts";

// What a recall costs the store, against what the reader may not read.
// #2134's rule: chunks of sources the reader may not read are never
// grouped, counted, ranked or scanned. No answer shows that rule broken
// (a recall that counted every chunk's stop words still answers the
// same), so this file holds it by cost: the rows the store's SQL reads,
// as workerd counts them (each cursor's `rowsRead`).
//
// A hidden chunk costs a recall nothing (GRA-1803): each set of readers'
// chunks are kept in blocks of rows of their own, and every way asks its
// index only within the reader's blocks (chunk-blocks.ts), so a chunk the
// reader may not read is never listed, joined or dropped. Before, each
// one holding what the question asks was listed by the index and dropped
// at the reader's check: 36 rows a hidden chunk for the words way, 10 for
// the stop words, 30 for an ID, 20 for a date. The vector scan read only
// the reader's own groups' codes already.
//
// So each way reads the same rows beside 1,200 and 4,800 hidden chunks,
// of 6 and 24 other groups, as beside none, every chunk holding the
// question's words, stop words, ID and date: within `seekMargin` rows,
// what an index seek touches more as the trees grow deeper (measured: 4
// rows, 5 for a date, once, from none to 1,200, and none from 1,200 to
// 4,800). A way that lists hidden chunks again (an index asked outside
// the reader's blocks, a join that scans the chunks) reads a row or more
// for each, thousands here, and fails.

/** The shared store, from empty storage, its SQL's reads counted. */
const countedStore = async () => {
  await reset();
  const stub = env.BRAIN_STORE.getByName("brain");
  const rowsReadBy = await countRowsRead(stub);
  return { stub, rowsReadBy };
};

// Groups only one person is in: the shared store keeps nothing one
// person's alone.
const reader: Reader = { person: "reader", groups: ["team:reader"] };
const own: Access = { kind: "audience", group: "team:reader" };

/** The `index`th hidden source's readers: a group of its own. */
const someoneElse = (index: number): Access => ({
  kind: "audience",
  group: `team:someone-${index}`,
});

/** Passages in each hidden source. */
const hiddenPassages = 200;

/** How many hidden sources the store holds as each way is measured. */
const hiddenSizes = [0, 6, 24];

/** Rows an index seek may read more as the trees grow deeper. */
const seekMargin = 8;

/** What every chunk holds: telling words, stop words, an ID and a date. */
const words = "The invoice of the warehouse INV-2024-0042 and the, 14/03/2026";

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
    // A date written otherwise: the exact way by its day, its cap.
    date: recall("14 maart 2026"),
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

describe("what a recall reads of what the reader may not read", () => {
  it("reads, for each way, the same rows however many hidden chunks the store holds", async () => {
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
    const names: readonly Way[] = [
      "words",
      "stopWords",
      "exact",
      "date",
      "vectors",
    ];
    const read = new Map<Way, number[]>(names.map((name) => [name, []]));
    let held = 0;
    for (const size of hiddenSizes) {
      const hidden: ChunkRef[] = [];
      for (; held < size; held += 1) {
        const source = `upload:hidden-${held}`;
        // oxlint-disable-next-line no-await-in-loop -- one add at a time
        const { version } = await stub.addSource({
          source,
          change: crypto.randomUUID(),
          text: passagesOf(hiddenPassages),
          access: someoneElse(held),
        });
        hidden.push(
          ...Array.from({ length: hiddenPassages }, (_, position) => ({
            source,
            version,
            position,
          }))
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- one size at a time
      await putVectorsOf(stub, hidden);
      for (const name of names) {
        // oxlint-disable-next-line no-await-in-loop -- one way at a time
        read.get(name)?.push(await rowsReadBy(ways[name]));
      }
    }

    // Each way's rows at each size, and whether they stay within
    // `seekMargin` of its rows beside no hidden chunk.
    const measured = Object.fromEntries(
      names.map((name) => {
        const rows = read.get(name) ?? [];
        const [alone = 0] = rows;
        return [
          name,
          {
            rows,
            flat: rows.every(
              (row) => row >= alone && row - alone <= seekMargin
            ),
          },
        ];
      })
    );
    expect(measured).toStrictEqual(
      Object.fromEntries(
        names.map((name) => [name, { rows: measured[name]?.rows, flat: true }])
      )
    );
  });
});
