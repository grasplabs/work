import type { Access, Reader } from "@grasp-os/brain-next/contract";
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { chunkBlockRows } from "../src/chunk-blocks.ts";
import { recallBudgetMax } from "../src/contract.ts";
import { indexWords } from "../src/words.ts";
import { asMigrated } from "./blocks-migrated.ts";
import { exportSettled, restoredAfterLoss, tick } from "./export-reads.ts";
import type { Store } from "./export-reads.ts";
import { countRowsRead } from "./rows-read.ts";
import { copyOf } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

// Where each set of readers' chunks are kept (chunk-blocks.ts): recall asks
// its indexes only within the reader's blocks, so every way of putting a
// chunk in the store must leave it in a block of its set, or recall misses
// it. An add places it in its set's own block; these hold the two other
// ways: a release before the blocks, after a rollback, adds a chunk after
// the last row, wherever that is (the trigger of migration 0026 records
// its block); and a restore places its chunks as an add does, so a hidden
// chunk costs the restored store's recalls nothing either. And for random
// stores of adds, new versions under other readers, erasures (whose sets
// may be dropped and made again), those older releases' adds and a store
// migrated from before the blocks, every recall answers as it does with
// every block opened to every set: no readable chunk is ever outside its
// set's blocks. What recall reads of hidden chunks on a store of adds is
// recall-cost.test.ts's.

const shared = (): Store => env.BRAIN_STORE.getByName("brain");

const reader: Reader = { person: "reader", groups: ["team:reader"] };
const own: Access = { kind: "audience", group: "team:reader" };

/** The `index`th hidden source's readers: a group of its own. */
const someoneElse = (index: number): Access => ({
  kind: "audience",
  group: `team:someone-${index}`,
});

/** The sources a recall of `question` as the reader cites. */
const sourcesFound = async (question: string): Promise<string[]> => {
  const { items } = await shared().recall({
    question,
    reader,
    budget: { tokens: recallBudgetMax },
  });
  return items.map(({ source }) => source);
};

/** A chunk as the move reads and writes it. */
interface Chunk extends Record<string, SqlStorageValue> {
  row: number;
  version_row: number;
  position: number;
  text: string;
  hash: string | null;
}

/**
 * The current chunks of `source` as a release before the blocks writes
 * them after a rollback: each moved after the last row, wherever that is
 * (another set's block too), its words indexed there.
 */
const addedByOlderRelease = async (source: string): Promise<void> => {
  await runInDurableObject(shared(), (_instance, state) => {
    const { sql } = state.storage;
    state.storage.transactionSync(() => {
      const chunks = sql
        .exec<Chunk>(
          `SELECT chunks.row AS row, chunks.version_row AS version_row,
            chunks.position AS position, chunks.text AS text,
            chunks.hash AS hash
          FROM chunks
          JOIN current_versions
            ON current_versions.version_row = chunks.version_row
          WHERE current_versions.source = ?`,
          source
        )
        .toArray();
      for (const chunk of chunks) {
        sql.exec("DELETE FROM chunks WHERE row = ?", chunk.row);
        const { row } = sql
          .exec<{ row: number }>(
            `INSERT INTO chunks (version_row, position, text, hash)
            VALUES (?, ?, ?, ?) RETURNING row`,
            chunk.version_row,
            chunk.position,
            chunk.text,
            chunk.hash
          )
          .one();
        indexWords(sql, row, chunk.text, new Map());
      }
    });
  });
};

/** The Park–Miller generator's modulus and multiplier (MINSTD). */
const modulus = 2_147_483_647;
const multiplier = 48_271;

/** The same series of numbers in (0, 1) for a seed. */
const seriesOf = (seed: number): (() => number) => {
  let state = seed % modulus;
  return () => {
    state = (state * multiplier) % modulus;
    return state / modulus;
  };
};

/** The words random texts are made of: words, stems, stop words, IDs, dates. */
const vocabulary = [
  "invoice",
  "warehouse",
  "harbour",
  "lighthouse",
  "ledger",
  "contract",
  "renewal",
  "Rechnungen",
  "facturen",
  "the",
  "of",
  "and",
  "INV-2024-0042",
  "PO-7781",
  "14/03/2026",
  "2 april 2025",
  "supplier",
  "customer",
  "Rotterdam",
];

/** Questions for every way: words, stems, stop words, IDs, dates, a phrase. */
const questions = [
  "invoice of the warehouse",
  "harbour lighthouse ledger",
  "the of and",
  "zebra of the",
  "INV-2024-0042",
  "PO-7781 supplier",
  "14 maart 2026",
  "april 2025",
  '"lighthouse ledger"',
  "Rechnung Rotterdam",
];

/** The groups random readers and sources are drawn from. */
const groups = Array.from({ length: 12 }, (_, index) => `g${index}`);

/** A random source's readers: a group, or now and then nobody. */
const accessOf = (random: () => number): Access =>
  random() < 0.08
    ? { kind: "none" }
    : {
        kind: "audience",
        group: groups[Math.floor(random() * groups.length)] ?? "g0",
      };

/** A random text of one to four paragraphs of the vocabulary. */
const textOf = (random: () => number): string =>
  Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
    Array.from(
      { length: 4 + Math.floor(random() * 10) },
      () => vocabulary[Math.floor(random() * vocabulary.length)]
    ).join(" ")
  ).join("\n\n");

/** Every question asked by every reader, as of `asOf` if given: their packs. */
const packsFor = async (
  readers: readonly Reader[],
  asOf?: Date
): Promise<string> => {
  const packs: unknown[] = [];
  for (const asker of readers) {
    for (const question of questions) {
      // oxlint-disable-next-line no-await-in-loop -- one recall at a time
      const pack = await shared().recall({
        question,
        reader: asker,
        budget: { tokens: recallBudgetMax },
        ...(asOf === undefined ? {} : { asOf }),
      });
      packs.push({
        asker,
        question,
        items: pack.items,
        notFound: pack.notFound,
      });
    }
  }
  return JSON.stringify(packs);
};

/** Every block that holds a chunk opened to every set: recall as before blocks. */
const openEveryBlock = async (): Promise<void> => {
  await runInDurableObject(shared(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT OR IGNORE INTO chunk_blocks (reader_set, block)
      SELECT reader_sets.id, held.block FROM reader_sets,
        (SELECT DISTINCT row / ${chunkBlockRows} AS block FROM chunks) AS held`
    );
  });
};

/** The seeds the random stores are made from: one of them migrated (even). */
const seeds = [101, 102];

/**
 * Makes the random store of `seed`: adds, new versions under other
 * readers, erasures, older releases' adds, and for an even seed a store
 * migrated from before the blocks. Answers whether every reader's packs,
 * now and as of the first adds, are the same as with every block opened
 * to every set.
 */
const answersAsOpen = async (seed: number): Promise<boolean> => {
  await reset();
  const random = seriesOf(seed);
  const sources = 40;
  const erased = new Set<number>();
  for (let index = 0; index < sources; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one add at a time
    await shared().addSource({
      source: `upload:s${index}`,
      change: "1",
      text: textOf(random),
      access: accessOf(random),
    });
  }
  const then = new Date();
  if (seed % 2 === 0) {
    await asMigrated(shared());
  }
  for (let round = 0; round < 3; round += 1) {
    // New versions, under other readers or the same.
    for (let index = 0; index < sources; index += 1) {
      if (random() < 0.3 && !erased.has(index)) {
        // oxlint-disable-next-line no-await-in-loop -- one add at a time
        await shared().addSource({
          source: `upload:s${index}`,
          change: `${round + 2}`,
          text: textOf(random),
          access: accessOf(random),
        });
      }
    }
    // Erasures: their sets may be dropped, and made again after.
    for (let index = 0; index < sources; index += 1) {
      if (random() < 0.05 && !erased.has(index)) {
        erased.add(index);
        // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
        await shared().eraseSource({
          source: `upload:s${index}`,
          reason: "deleted",
        });
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time
    await tick(shared());
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time
    await tick(shared());
    if (random() < 0.5) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await addedByOlderRelease(`upload:s${Math.floor(random() * sources)}`);
    }
    for (let index = 0; index < 5; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await shared().addSource({
        source: `upload:n${round}-${index}`,
        change: "1",
        text: textOf(random),
        access: accessOf(random),
      });
    }
  }
  const readers: Reader[] = Array.from({ length: 6 }, (_, index) => ({
    person: index < 3 ? `p${index}` : null,
    groups: groups.filter(() => random() < 0.35),
  }));
  const blockedNow = await packsFor(readers);
  const blockedThen = await packsFor(readers, then);
  await openEveryBlock();
  const openNow = await packsFor(readers);
  const openThen = await packsFor(readers, then);
  return blockedNow === openNow && blockedThen === openThen;
};

describe("where a chunk is kept", () => {
  /** The shared store before any test added to it: empty. */
  let empty: Copy = { tables: [], others: [] };

  beforeAll(async () => {
    await reset();
    empty = await copyOf(shared());
  });

  it("finds a passage a release before the blocks added after the last row, in another set's block", async () => {
    await reset();
    await shared().addSource({
      source: "upload:ledger",
      change: "1",
      text: "The lighthouse ledger is kept in the harbour office.",
      access: own,
    });
    await shared().addSource({
      source: "upload:other",
      change: "1",
      text: "Something else, for someone else.",
      access: someoneElse(0),
    });
    // An older release's add: the chunk after the last row, inside the
    // other set's block.
    await addedByOlderRelease("upload:ledger");

    await expect(sourcesFound("lighthouse ledger")).resolves.toContain(
      "upload:ledger"
    );
  });

  it("reads after a restore what it read before: no row of a hidden chunk", async () => {
    await reset();
    for (let index = 0; index < 3; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await shared().addSource({
        source: `upload:own-${index}`,
        change: "1",
        text: `The invoice of the warehouse ${index}`,
        access: own,
      });
    }
    // Hidden sources interleaved with nothing of the reader's after them:
    // a restore that writes chunks in the order it reads them, without
    // blocks, would put them among the reader's.
    for (let index = 0; index < 6; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await shared().addSource({
        source: `upload:hidden-${index}`,
        change: "1",
        text: Array.from({ length: 200 }, (_, position) =>
          `The invoice of the warehouse ${position} `.padEnd(650, "x")
        ).join("\n\n"),
        access: someoneElse(index),
      });
    }
    const ask = async () => await sourcesFound("invoice of the warehouse");
    const before = await (await countRowsRead(shared()))(ask);
    const { id } = await shared().startExport("test");
    const exported = await exportSettled(shared, id);
    const restored = await restoredAfterLoss(shared, id, empty);
    const after = await (await countRowsRead(shared()))(ask);

    expect({ exported, restored, after: after - before <= 8 }).toStrictEqual({
      exported: "done",
      restored: "done",
      after: true,
    });
    await expect(ask()).resolves.toStrictEqual(
      expect.arrayContaining(["upload:own-0", "upload:own-1", "upload:own-2"])
    );
  });

  it("answers every reader as with every block open to every set, for random stores", async () => {
    const differing: number[] = [];
    for (const seed of seeds) {
      // oxlint-disable-next-line no-await-in-loop -- one store at a time
      if (!(await answersAsOpen(seed))) {
        differing.push(seed);
      }
    }

    expect(differing).toStrictEqual([]);
  });
});
