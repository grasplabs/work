// A store as migration 0026 leaves one made before the blocks: every chunk
// so far at rows from 1, as an add placed them then (all in block 0), and
// the blocks filled in by the migration's own statements, its trigger and
// its fill-in, read from the migration itself.
import { runInDurableObject } from "cloudflare:test";

import migrations from "../src/db/migrations/migrations.js";
import { indexWords } from "../src/words.ts";

/** The statements of the migration that made the blocks (0026), as the migrator splits them. */
const statements = (
  Object.values(migrations.migrations).find((migration) =>
    migration.includes("chunks_block_insert")
  ) ?? ""
)
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim());

/** Its trigger, and its fill-in of the chunks already stored (its last). */
const trigger = statements.find((statement) =>
  statement.includes("CREATE TRIGGER")
);
const fillIn = statements.at(-1);

/** The chunk a store holds, as the move reads and writes it. */
interface Chunk extends Record<string, SqlStorageValue> {
  row: number;
  version_row: number;
  position: number;
  text: string;
  hash: string | null;
}

/**
 * Makes `store`'s chunks so far as a store made before the blocks holds
 * them, migrated: each moved to the next row from 1, in row order, its
 * words indexed again there, with no trigger and no blocks; then the
 * migration's trigger and fill-in run. Run it before the store holds
 * vectors (a code points at its chunk's row).
 */
export const asMigrated = async (store: DurableObjectStub): Promise<void> => {
  if (trigger === undefined || fillIn === undefined) {
    throw new Error("Migration 0026 has no trigger or fill-in");
  }
  await runInDurableObject(store, (_instance, state) => {
    const { sql } = state.storage;
    state.storage.transactionSync(() => {
      sql.exec("DROP TRIGGER chunks_block_insert");
      sql.exec("DELETE FROM chunk_blocks");
      const chunks = sql
        .exec<Chunk>(
          "SELECT row, version_row, position, text, hash FROM chunks ORDER BY row"
        )
        .toArray();
      for (const [index, chunk] of chunks.entries()) {
        const row = index + 1;
        sql.exec("DELETE FROM chunks WHERE row = ?", chunk.row);
        sql.exec(
          `INSERT INTO chunks (row, version_row, position, text, hash)
          VALUES (?, ?, ?, ?, ?)`,
          row,
          chunk.version_row,
          chunk.position,
          chunk.text,
          chunk.hash
        );
        indexWords(sql, row, chunk.text, new Map());
      }
      sql.exec(trigger);
      sql.exec(fillIn);
    });
  });
};
