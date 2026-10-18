import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { holdsAny, indexKeysOf } from "../src/knowledge/search-erasure.ts";

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

  it("are checked only for terms whose tokens are known exactly: plain ASCII, and no number shorter than a trigram", () => {
    expect({
      ascii: indexKeysOf(["Visser", "tom.visser@acme.test"]) === undefined,
      pin: indexKeysOf(["4821"]) === undefined,
      accented: indexKeysOf(["Renée"]),
      otherScript: indexKeysOf(["東京"]),
      // Held whole by the trigrams spanning its neighbours (" 12"), which
      // a purge's terms don't say.
      shortNumber: indexKeysOf(["Room 12"]),
    }).toStrictEqual({
      ascii: false,
      pin: false,
      accented: undefined,
      otherScript: undefined,
      shortNumber: undefined,
    });
  });
});
