import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import {
  addCollectionKeys,
  holdsAny,
  indexKeysOf,
  owedRebuildStaleMs,
  owedWritesDone,
  rebuildOwed,
  rebuildSearchIndex,
} from "../src/knowledge/search-erasure.ts";
import type { IndexKey } from "../src/knowledge/search-erasure.ts";

// What a purge leaves of a term in the search index's page directory
// (search-erasure.ts, threat model in GRA-693): the rule that decides
// whether a separator a secure delete left still holds too much of a
// purged token, so the index is rebuilt; and that secure deletes are on
// from the database's own migrations, before any purge.

/** Whether separator `separator` left for `term`'s keys in `table` holds too much of it. */
const holds = (
  term: string,
  table: "search_words" | "search_trigrams",
  separator: string
): boolean => {
  const keys = (indexKeysOf([term]) ?? []).filter((key) => key.table === table);
  return holdsAny(
    keys,
    keys.map(({ key }) => ({ key, separator }))
  );
};

/** The rebuilds purges owe, by ID. */
const owed = async (): Promise<string[]> => {
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT id FROM search_rebuilds ORDER BY id"
  ).all<{ id: string }>();
  return results.map(({ id }) => id);
};

describe("a purged term's page separators", () => {
  it("are on in a new database, from its migrations, before any purge", async () => {
    const settings = await env.KNOWLEDGE.batch([
      env.KNOWLEDGE.prepare(
        "SELECT v FROM search_words_config WHERE k = 'secure-delete'"
      ),
      env.KNOWLEDGE.prepare(
        "SELECT v FROM search_trigrams_config WHERE k = 'secure-delete'"
      ),
    ]);
    expect(settings.map(({ results }) => results)).toStrictEqual([
      [{ v: 1 }],
      [{ v: 1 }],
    ]);
  });

  it("leave a word's fragment of three letters, never four, nor the whole of a short word", () => {
    expect({
      wordFragment: holds("Visser", "search_words", "0vis"),
      wordFour: holds("Visser", "search_words", "0viss"),
      wordWhole: holds("Visser", "search_words", "0visser"),
      shortWhole: holds("Tom", "search_words", "0tom"),
      shortInTrigrams: holds("Tom", "search_trigrams", "0tom"),
      shortFragment: holds("Tom", "search_words", "0to"),
    }).toStrictEqual({
      wordFragment: false,
      wordFour: true,
      wordWhole: true,
      shortWhole: true,
      shortInTrigrams: true,
      shortFragment: false,
    });
  });

  it("leave no three characters of a token with a digit: a PIN, an ID, a group of a number", () => {
    expect({
      pinPrefix: holds("4821", "search_words", "0482"),
      pinInPrefixIndex: holds("4821", "search_words", "2482"),
      pinTrigram: holds("4821", "search_trigrams", "0821"),
      idPrefix: holds("AB12-901", "search_words", "0ab1"),
      pinTwo: holds("4821", "search_words", "048"),
    }).toStrictEqual({
      pinPrefix: true,
      pinInPrefixIndex: true,
      pinTrigram: true,
      idPrefix: true,
      pinTwo: false,
    });
  });

  it("are checked only for terms whose tokens are known exactly: plain ASCII, and no token shorter than a trigram", () => {
    expect({
      ascii: indexKeysOf(["Visser", "tom.visser@acme.test"]) === undefined,
      pin: indexKeysOf(["4821"]) === undefined,
      accented: indexKeysOf(["Renée"]),
      otherScript: indexKeysOf(["東京"]),
      // Held whole by the trigrams spanning its neighbours (" 12"), which
      // a purge's terms don't say.
      shortNumber: indexKeysOf(["Room 12"]),
      shortWord: indexKeysOf(["Jo"]),
    }).toStrictEqual({
      ascii: false,
      pin: false,
      accented: undefined,
      otherScript: undefined,
      shortNumber: undefined,
      shortWord: undefined,
    });
  });

  it("stay owed a rebuild until one runs after the purge's writes are done, or surely over", async () => {
    const db = drizzle(env.KNOWLEDGE);
    // A purge still writing, one whose writes are done, and one that
    // recorded its rebuild long ago and never said (its request died).
    await db.batch([
      rebuildOwed(db, "a-writing"),
      rebuildOwed(db, "b-done"),
      rebuildOwed(db, "c-died"),
    ]);
    await owedWritesDone(db, "b-done");
    await env.KNOWLEDGE.prepare(
      "UPDATE search_rebuilds SET owed_at = owed_at - ? WHERE id = 'c-died'"
    )
      .bind(owedRebuildStaleMs + 1000)
      .run();
    const before = await owed();
    // Another purge's rebuild, before the first purge's writes are done.
    await rebuildSearchIndex(db);
    const afterRebuild = await owed();
    await owedWritesDone(db, "a-writing");
    await rebuildSearchIndex(db);
    expect({ before, afterRebuild, afterAll: await owed() }).toStrictEqual({
      before: ["a-writing", "b-done", "c-died"],
      afterRebuild: ["a-writing"],
      afterAll: [],
    });
  });
});

/** What a personal purge reads of `value`: its keys, or why it stopped. */
const collectionKeysOf = (value: string, maxKeys = 20_000) => {
  const into = new Map<string, IndexKey>();
  const outcome = addCollectionKeys(value, into, maxKeys);
  return { outcome, keys: [...into.values()] };
};

/** The keys of `value` in `table`, or why there are none. */
const keysIn = (value: string, table: IndexKey["table"]) => {
  const { outcome, keys } = collectionKeysOf(value);
  return outcome === "ok"
    ? keys.filter((key) => key.table === table).map(({ key }) => key)
    : outcome;
};

describe("a deleted collection's page separators", () => {
  it("are checked for the trigrams that hold a short word whole with its neighbours", () => {
    expect({
      words: keysIn("Ask Jo.", "search_words"),
      trigrams: keysIn("Ask Jo.", "search_trigrams"),
      atTheEnd: keysIn("I", "search_trigrams"),
    }).toStrictEqual({
      words: ["0ask", "1ask", "2ask", "0jo", "1jo", "2jo"],
      trigrams: ["0ask", "0 jo", "0jo."],
      atTheEnd: [],
    });
  });

  it("are checked through punctuation of any script apart from tokens, never a token they can't read exactly", () => {
    expect({
      dash: keysIn("plan — team", "search_words"),
      beside: keysIn("team’s", "search_words"),
      inATrigram: keysIn("—Jo", "search_words"),
      accented: keysIn("café", "search_words"),
      otherScript: keysIn("Visserさん", "search_words"),
    }).toStrictEqual({
      dash: ["0plan", "0team"],
      beside: "unknown",
      inATrigram: "unknown",
      accented: "unknown",
      otherScript: "unknown",
    });
  });

  it("are collected once each, and stop at the cap", () => {
    const repeated = collectionKeysOf("1 ".repeat(500_000));
    const many = collectionKeysOf(
      // Words of letters, of a key each.
      Array.from(
        { length: 50 },
        (_, at) =>
          `zz${String.fromCodePoint(97 + (at % 26))}${String.fromCodePoint(97 + Math.floor(at / 26))}q`
      ).join(" "),
      10
    );
    expect({
      repeated: { outcome: repeated.outcome, few: repeated.keys.length < 20 },
      many: { outcome: many.outcome, keys: many.keys.length },
    }).toStrictEqual({
      repeated: { outcome: "ok", few: true },
      many: { outcome: "capped", keys: 11 },
    });
  });
});
