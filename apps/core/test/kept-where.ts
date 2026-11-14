import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { onboardingStore } from "../src/onboarding/store.ts";

// Where a word is left, for the tests that look for a document's or a
// purged term's words wherever they could be kept: a D1 database's
// columns and the onboarding store's tables.

/** `text`'s UTF-8 bytes in hex, as SQLite's `hex()` writes them. */
const hexOf = (text: string): string =>
  [...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

/** Every `table.column` of `db` that holds `word`, as text or among a row's bytes. */
export const d1ColumnsWith = async (
  db: D1Database,
  word: string
): Promise<string[]> => {
  const { results: tables } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
    )
    .all<{ name: string }>();
  const found: string[] = [];
  for (const { name: table } of tables) {
    // oxlint-disable-next-line no-await-in-loop -- one table at a time
    const { results: columns } = await db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .bind(table)
      .all<{ name: string }>();
    for (const { name: column } of columns) {
      // oxlint-disable-next-line no-await-in-loop -- one column at a time
      const row = await db
        .prepare(
          `SELECT count(*) AS n FROM "${table}"
           WHERE instr(lower(CAST("${column}" AS TEXT)), ?) > 0
             OR instr(hex("${column}"), ?) > 0`
        )
        .bind(word, hexOf(word))
        .first<{ n: number }>();
      if ((row?.n ?? 0) > 0) {
        found.push(`${table}.${column}`);
      }
    }
  }
  return found;
};

/** The onboarding store's tables that hold `word`. */
export const onboardingTablesWith = async (word: string): Promise<string[]> =>
  await runInDurableObject(onboardingStore(env), (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'"
      )
      .toArray()
      .map(({ name }) => name)
      .filter((table) =>
        JSON.stringify(
          state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()
        )
          .toLowerCase()
          .includes(word)
      )
  );
