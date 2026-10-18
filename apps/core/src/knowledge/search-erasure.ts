import { errorFields, log } from "@grasp-os/shared/log";
import { lte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { searchRebuilds } from "../db/knowledge/schema.ts";

// Taking purged terms out of the full-text index (0001_search.sql) for
// good, at a cost bounded by the terms, not by the corpus. Threat model
// in GRA-693.
//
// A plain FTS5 delete only marks a row deleted: its tokens stay in the
// index's pages until a merge, where they can't be found by a search but
// are still in the database. `secure-delete` makes every delete (a
// save's, a purge's) edit those pages in its own transaction instead.
// It leaves one trace: the page directory (`%_idx`) keeps, for each leaf
// page, a separator made from the page's first term, and a secure delete
// of that term leaves it there as long as the page holds other terms. So
// after a purge the separators each term's tokens would have are looked
// up, an index seek per segment, and only when one still holds a token
// is the whole index rebuilt, as every purge did before. Whatever can't
// be checked (secure-delete off or refused, a term that isn't plain
// ASCII, a directory that can't be read) is rebuilt too: the rebuild is
// the fallback, never skipped.
//
// What may stay: fragments of at most three characters of a word without
// digits, in the trigram index and the words index's prefix indexes, which
// hold the same for any text with those letters; never a whole token of a
// term longer than that, and of a token with a digit (an ID, a PIN, a
// group of a number) never as much as three characters.
//
// Nothing a lookup carries (the terms) is ever logged: a failed query's
// error repeats its parameters, so only the error's name is.
//
// Secure deletes are turned on by the migration `0011_search_secure_delete`,
// with a rebuild. Remote D1 may refuse what local workerd allows (reading
// the setting or `%_idx`); each refusal falls back to the rebuild, logged.

/**
 * Drops deleted rows' terms from the search index's pages for good, by
 * rebuilding it from its content, and clears the rebuilds purges recorded
 * as owed before it began (`searchRebuilds`), in the same transaction:
 * one that fails leaves them owed. Throws when it fails.
 */
export const rebuildSearchIndex = async (
  db: DrizzleD1Database
): Promise<void> => {
  const startedAt = Date.now();
  await db.batch([
    db.run(sql`INSERT INTO search_words (search_words) VALUES ('rebuild')`),
    db.run(
      sql`INSERT INTO search_trigrams (search_trigrams) VALUES ('rebuild')`
    ),
    db.delete(searchRebuilds).where(lte(searchRebuilds.owedAt, startedAt)),
  ]);
};

/**
 * The statement that records a rebuild as owed, for a purge's batch that
 * records it before anything changes: a purge that then fails, or whose
 * rebuild does, leaves it owed, and the next one rebuilds.
 */
export const rebuildOwed = (db: DrizzleD1Database) =>
  db.insert(searchRebuilds).values({ owedAt: Date.now() });

/** Whether a purge recorded a rebuild that hasn't run since. */
const anyRebuildOwed = async (db: DrizzleD1Database): Promise<boolean> => {
  const owed = await db
    .select({ id: searchRebuilds.id })
    .from(searchRebuilds)
    .limit(1);
  return owed.length > 0;
};

/** Whether `secure-delete` is on for both search tables. */
const secureDeleteIsOn = async (db: DrizzleD1Database): Promise<boolean> => {
  const [words, trigrams] = await db.batch([
    db.all<{ v: unknown }>(
      sql`SELECT v FROM search_words_config WHERE k = 'secure-delete'`
    ),
    db.all<{ v: unknown }>(
      sql`SELECT v FROM search_trigrams_config WHERE k = 'secure-delete'`
    ),
  ]);
  return words[0]?.v === 1 && trigrams[0]?.v === 1;
};

/**
 * Whether every delete in the search index is a secure one now, and the
 * index holds no tokens of rows deleted before. The migration turns it on,
 * with a rebuild; should it be off all the same (a database the setting
 * was lost on), it is turned on here, and the index rebuilt, in one
 * transaction, so whoever sees it on sees a clean index. False when it
 * can't be read or turned on (a platform that refuses it): the purge then
 * rebuilds after its writes, as before.
 */
export const secureDeleteReady = async (
  db: DrizzleD1Database
): Promise<boolean> => {
  try {
    if (await secureDeleteIsOn(db)) {
      return true;
    }
    await db.batch([
      db.run(
        sql`INSERT INTO search_words (search_words, rank) VALUES ('secure-delete', 1)`
      ),
      db.run(
        sql`INSERT INTO search_trigrams (search_trigrams, rank) VALUES ('secure-delete', 1)`
      ),
      db.run(sql`INSERT INTO search_words (search_words) VALUES ('rebuild')`),
      db.run(
        sql`INSERT INTO search_trigrams (search_trigrams) VALUES ('rebuild')`
      ),
    ]);
    return true;
  } catch (error) {
    log.warn("knowledge.purge.secure_delete_unavailable", errorFields(error));
    return false;
  }
};

/** Printable ASCII, the only text whose tokens are read here exactly. */
const plainAscii = /^[ -~]+$/u;

/** What `unicode61` takes for a token in ASCII text: letters and digits. */
const tokenBreak = /[^a-z0-9]+/u;

/** A key into an index's page directory, and the whole token it is for. */
export interface IndexKey {
  /** The table whose `%_idx` it is looked up in. */
  readonly table: "search_words" | "search_trigrams";
  /** A marker for the index (`0` the terms, `1` and `2` their prefixes), then the token. */
  readonly key: string;
  /** How many of the token's characters a separator holds too many of. */
  readonly least: number;
}

/** A token with a digit: an ID, a PIN, a group of a number. */
const digit = /[0-9]/u;

/** A token's windows of three characters, as the trigram index holds it. */
const windowsOf = (token: string): string[] =>
  Array.from({ length: Math.max(0, token.length - 2) }, (_, at) =>
    token.slice(at, at + 3)
  );

/** The page-directory keys of one token (see `indexKeysOf`). */
const keysOfToken = (token: string): IndexKey[] => {
  const numeric = digit.test(token);
  // A word's fragment of three, any text may leave; of a number, none.
  const least = Math.min(numeric ? 3 : 4, token.length);
  const short = token.length <= 3;
  // A word's trigram only when it is the whole word; a number's, each.
  const trigrams = numeric || token.length === 3 ? windowsOf(token) : [];
  return [
    { table: "search_words", key: `0${token}`, least },
    ...(short || numeric
      ? (["1", "2"] as const).map((marker): IndexKey => ({
          table: "search_words",
          key: `${marker}${token}`,
          least: Math.min(3, token.length),
        }))
      : []),
    ...trigrams.map((trigram): IndexKey => ({
      table: "search_trigrams",
      key: `0${trigram}`,
      least: 3,
    })),
  ];
};

/**
 * The page-directory keys a token of `terms` would have, in each index
 * that can hold it whole, or, for a token with a digit, three of its
 * characters: every token in the words index; one of three characters or
 * fewer, or with a digit, also in the words index's prefix indexes; one
 * of three, or each three characters of one with a digit, in the trigram
 * index. Undefined unless every term is plain
 * ASCII, whose tokens are exactly its runs of letters and digits, folded
 * to lower case (as `unicode61` and `trigram` fold them); anything else
 * is left to the rebuild.
 */
export const indexKeysOf = (
  terms: readonly string[]
): readonly IndexKey[] | undefined => {
  if (!terms.every((term) => plainAscii.test(term))) {
    return undefined;
  }
  const tokens = new Set(
    terms.flatMap((term) =>
      term
        .toLowerCase()
        .split(tokenBreak)
        .filter((token) => token !== "")
    )
  );
  return [...tokens].flatMap(keysOfToken);
};

/** A separator a lookup found for `key`, or null where there was none. */
export interface Found {
  readonly key: string;
  readonly separator: string | null;
}

/**
 * For every segment of `table`'s index and every key, the greatest page
 * separator at or below the key: where the key's token would be. A
 * separator a secure delete left is that one, since the page it heads
 * began with the token. Segments are found by skipping from one segment
 * ID to the next, keys by seek: index lookups, however large the index.
 */
const separatorsOf = async (
  db: DrizzleD1Database,
  table: IndexKey["table"],
  keys: readonly string[]
): Promise<readonly Found[]> => {
  const directory = sql.raw(`${table}_idx`);
  return await db.all<Found>(sql`
    WITH RECURSIVE segments(id) AS (
      SELECT min(segid) FROM ${directory}
      UNION ALL
      SELECT (SELECT min(segid) FROM ${directory} WHERE segid > segments.id)
      FROM segments WHERE segments.id IS NOT NULL
    )
    SELECT keys.value AS key, (
      SELECT CAST(entries.term AS TEXT) FROM ${directory} AS entries
      WHERE entries.segid = segments.id
        AND entries.term <= CAST(keys.value AS BLOB)
      ORDER BY entries.term DESC LIMIT 1
    ) AS separator
    FROM segments, json_each(${JSON.stringify(keys)}) AS keys
    WHERE segments.id IS NOT NULL
  `);
};

/**
 * Whether `found`'s separator still holds too much of its key's token: it
 * begins the key, for at least `least` of the token's characters.
 */
const holdsToken = ({ key, separator }: Found, least: number): boolean =>
  separator !== null &&
  separator.length > 1 &&
  key.startsWith(separator) &&
  separator.length - 1 >= least;

/**
 * Whether one of the separators `found` for `keys` (of one table) still
 * holds too much of its token (`holdsToken`, each key's own `least`).
 */
export const holdsAny = (
  keys: readonly IndexKey[],
  found: readonly Found[]
): boolean => {
  const least = new Map(keys.map(({ key, least: at }) => [key, at]));
  return found.some((one) => holdsToken(one, least.get(one.key) ?? 1));
};

/** Whether a page separator of the index still holds one of `keys`' tokens. */
const separatorsHold = async (
  db: DrizzleD1Database,
  keys: readonly IndexKey[]
): Promise<boolean> => {
  for (const table of ["search_words", "search_trigrams"] as const) {
    const ofTable = keys.filter((key) => key.table === table);
    if (ofTable.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- one index, then the other
      const found = await separatorsOf(
        db,
        table,
        ofTable.map(({ key }) => key)
      );
      if (holdsAny(ofTable, found)) {
        return true;
      }
    }
  }
  return false;
};

/** An error's name alone: never its message, which may repeat a query's terms. */
export const errorNameOf = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error;

/**
 * Leaves nothing of `terms` in the search index, after a purge's writes
 * deleted the rows that held them: when every delete was a secure one
 * (`secure`, from `secureDeleteReady` before the writes), the terms'
 * tokens are known (`tokensKnown`: no occurrence was part of a longer
 * token, as one beside a script written without spaces is, "東京Visser"),
 * no purge recorded a rebuild still owed (`rebuildOwed`), and no page
 * separator holds a token of them, there is nothing left to do;
 * otherwise the index is rebuilt. Throws when the rebuild fails.
 */
export const eraseFromSearchIndex = async (
  db: DrizzleD1Database,
  terms: readonly string[],
  { secure, tokensKnown }: { secure: boolean; tokensKnown: boolean }
): Promise<void> => {
  const keys = secure && tokensKnown ? indexKeysOf(terms) : undefined;
  if (keys !== undefined) {
    try {
      if (!(await anyRebuildOwed(db)) && !(await separatorsHold(db, keys))) {
        return;
      }
    } catch (error) {
      // Not readable here (a platform that refuses it): rebuilt instead.
      // The error's name only: its message repeats the lookup's terms.
      log.warn("knowledge.purge.index_check_failed", {
        errorName: errorNameOf(error),
      });
    }
  }
  await rebuildSearchIndex(db);
};
