import type { Access, Reader } from "@grasp-os/brain-next/contract";
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { recallBudgetMax } from "../src/contract.ts";
import { indexWords } from "../src/words.ts";
import { exportSettled, restoredAfterLoss } from "./export-reads.ts";
import type { Store } from "./export-reads.ts";
import { countRowsRead } from "./rows-read.ts";
import { copyOf } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

// Where each set of readers' chunks are kept (chunk-blocks.ts): recall asks
// its indexes only within the reader's blocks, so every way of putting a
// chunk in the store must leave it in a block of its set, or recall misses
// it. An add places it in its set's own block; these hold the two other
// ways: a release before the blocks, after a rollback, adds a chunk after
// the last row, wherever that is (the trigger of migration 0025 records
// its block); and a restore places its chunks as an add does, so a hidden
// chunk costs the restored store's recalls nothing either. What recall
// reads of hidden chunks on a store of adds is recall-cost.test.ts's.

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
    // What an older release's add writes: the chunk after the last row,
    // inside the other set's block, its words indexed there.
    await runInDurableObject(shared(), (_instance, state) => {
      const { sql } = state.storage;
      state.storage.transactionSync(() => {
        const chunk = sql
          .exec<{
            row: number;
            version_row: number;
            text: string;
            hash: string;
          }>(
            `SELECT chunks.row AS row, chunks.version_row AS version_row,
              chunks.text AS text, chunks.hash AS hash
            FROM chunks
            JOIN source_versions ON source_versions.row = chunks.version_row
            WHERE source_versions.source = 'upload:ledger'`
          )
          .one();
        sql.exec("DELETE FROM chunks WHERE row = ?", chunk.row);
        const { row } = sql
          .exec<{ row: number }>(
            `INSERT INTO chunks (version_row, position, text, hash)
            VALUES (?, 0, ?, ?) RETURNING row`,
            chunk.version_row,
            chunk.text,
            chunk.hash
          )
          .one();
        indexWords(sql, row, chunk.text, new Map());
      });
    });

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
});
