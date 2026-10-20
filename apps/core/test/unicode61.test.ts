import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { unicode61Dropped, unicode61Kept } from "../src/knowledge/unicode61.ts";

// The purge's table of the search index's token characters
// (src/knowledge/unicode61.ts) against the tokenizer itself, every code
// point: a purge decides where a term ends by that table, so a code point
// the table gets wrong leaves a term the index still finds (GRA-698).
// `fts5vocab` lists each probe's tokens: one probe per code point, "xq",
// the code point, "qx", which is two tokens where it ends a token, one
// ("xqqx") where the tokenizer drops it, and one holding it otherwise.

/** Code points probed at once. */
const batch = 50_000;

/** The ranges of code points of each kind, in order, as the table lists them. */
const probed = async (): Promise<{
  kept: [number, number][];
  dropped: [number, number][];
}> => {
  const db = env.KNOWLEDGE;
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS unicode61_probe_v"),
    db.prepare("DROP TABLE IF EXISTS unicode61_probe"),
    db.prepare(
      "CREATE VIRTUAL TABLE unicode61_probe USING fts5(x, tokenize = 'unicode61 remove_diacritics 2')"
    ),
    db.prepare(
      "CREATE VIRTUAL TABLE unicode61_probe_v USING fts5vocab(unicode61_probe, 'instance')"
    ),
  ]);
  const kinds = new Map<number, "kept" | "dropped">();
  for (let start = 1; start <= 0x10_ff_ff; start += batch) {
    const end = Math.min(0x10_ff_ff, start + batch - 1);
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time
    await db.batch([
      db.prepare("DELETE FROM unicode61_probe"),
      // Surrogates aren't characters: SQLite's char() makes none of them.
      db
        .prepare(
          `WITH RECURSIVE s(n) AS (SELECT ?1 UNION ALL SELECT n + 1 FROM s WHERE n < ?2)
           INSERT INTO unicode61_probe (rowid, x)
           SELECT n, 'xq' || char(n) || 'qx' FROM s WHERE n NOT BETWEEN 55296 AND 57343`
        )
        .bind(start, end),
    ]);
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time
    const { results } = await db
      .prepare(
        "SELECT doc, count(*) AS tokens, max(term) AS term FROM unicode61_probe_v GROUP BY doc"
      )
      .all<{ doc: number; tokens: number; term: string }>();
    for (const { doc, tokens, term } of results) {
      if (tokens === 1) {
        kinds.set(doc, term === "xqqx" ? "dropped" : "kept");
      }
    }
  }
  const kept: [number, number][] = [];
  const dropped: [number, number][] = [];
  const ranges = { kept, dropped };
  for (const [point, kind] of [...kinds].toSorted(([a], [b]) => a - b)) {
    const last = ranges[kind].at(-1);
    if (last !== undefined && last[1] === point - 1) {
      last[1] = point;
    } else {
      ranges[kind].push([point, point]);
    }
  }
  return ranges;
};

describe("the search index's token characters", () => {
  it(
    "are, in the purge's table, exactly what the tokenizer keeps and drops",
    { timeout: 120_000 },
    async () => {
      const found = await probed();
      // A failure prints what the tokenizer says, to put in the table.
      expect({ kept: unicode61Kept, dropped: unicode61Dropped }).toStrictEqual(
        found
      );
    }
  );
});
