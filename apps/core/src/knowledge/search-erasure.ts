import { errorFields, log } from "@grasp-os/shared/log";
import { eq, lte, ne, or, sql } from "drizzle-orm";
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
// A personal purge deletes a whole collection, whose terms it doesn't
// name: before deleting it, it reads every version of its documents, each
// of which the index held once, and checks the tokens they gave the index
// (threat model in GRA-696). Its
// common words ("the", single letters) head pages all the time, so a
// separator that holds one of its tokens counts only when no live row
// still holds the token: then it reveals nothing the index doesn't. That
// check is capped; past the caps, the index is rebuilt.
//
// Secure deletes are turned on by the migration `0011_search_secure_delete`,
// with a rebuild. Remote D1 may refuse what local workerd allows (reading
// the setting or `%_idx`); each refusal falls back to the rebuild, logged.

/**
 * How long after a purge recorded a rebuild as owed its writes are surely
 * over, whether or not it got to mark them done (a purge whose request
 * died): a rebuild after that clears it too.
 */
export const owedRebuildStaleMs = 60 * 60_000;

/**
 * Drops deleted rows' terms from the search index's pages for good, by
 * rebuilding it from its content, and clears, in the same transaction, the
 * rebuilds purges owe whose writes were done before it began
 * (`searchRebuilds`): never one whose purge may still be writing, which a
 * rebuild before its writes doesn't cover. One that fails leaves them
 * owed. Throws when it fails.
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
    db
      .delete(searchRebuilds)
      .where(
        or(
          lte(searchRebuilds.writesDoneAt, startedAt),
          lte(searchRebuilds.owedAt, startedAt - owedRebuildStaleMs)
        )
      ),
  ]);
};

/**
 * The statement that records rebuild `id` as owed, for a purge's batch
 * that records it before anything changes: a purge that then fails, or
 * whose rebuild does, leaves it owed, and the next one rebuilds. With
 * `writesDone`, the purge's writes are that batch's own, done when it
 * commits.
 */
export const rebuildOwed = (
  db: DrizzleD1Database,
  id: string,
  { writesDone = false }: { writesDone?: boolean } = {}
) => {
  const now = Date.now();
  return db
    .insert(searchRebuilds)
    .values({ id, owedAt: now, ...(writesDone ? { writesDoneAt: now } : {}) });
};

/**
 * Marks owed rebuild `id`'s purge's writes done: a rebuild from now on
 * covers them, and clears it.
 */
export const owedWritesDone = async (
  db: DrizzleD1Database,
  id: string
): Promise<void> => {
  await db
    .update(searchRebuilds)
    .set({ writesDoneAt: Date.now() })
    .where(eq(searchRebuilds.id, id));
};

/**
 * Whether a purge recorded a rebuild that hasn't run since, other than
 * `except`'s own.
 */
const anyRebuildOwed = async (
  db: DrizzleD1Database,
  except?: string
): Promise<boolean> => {
  const owed = await db
    .select({ id: searchRebuilds.id })
    .from(searchRebuilds)
    .where(except === undefined ? undefined : ne(searchRebuilds.id, except))
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
 * index. Undefined for a token shorter than three characters, which the
 * trigrams spanning its neighbours hold whole, and unless every term is plain
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
  // A token shorter than a trigram is held whole by the trigrams that
  // span it and its neighbours (" jo", "-12"), whose neighbours the
  // purge's terms don't say: rebuilt.
  if ([...tokens].some((token) => token.length < 3)) {
    return undefined;
  }
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

// Personal purges: a whole collection.

/** How far a personal purge checks a collection's tokens before it rebuilds instead. */
export const collectionCheckCaps = {
  /** The collection's versions, every one of which the index may have held. */
  versions: 2000,
  /** Characters of those versions' text, read and tokenised. */
  characters: 1024 * 1024,
  /** Distinct page-directory keys looked up. */
  keys: 20_000,
  /** Lookups of whether a live row still holds a token. */
  liveLookups: 1000,
} as const;

/**
 * The longest token whose keys are worked out: a longer one (a key, a
 * hash, text without spaces) has as many trigrams as characters when it
 * holds a digit, and is left to the rebuild.
 */
const maxTokenLength = 256;

/** Versions' text read at once: no more than the character cap in all. */
const versionsPerRead = 20;

/** Keys looked up in one query. */
const keysPerLookup = 500;

/** Lookups of live rows in one batch. */
const liveLookupsPerBatch = 50;

/**
 * What `unicode61` may take as part of a token: a letter, a digit, a
 * private-use character, or a mark (which `remove_diacritics` drops or
 * keeps). Taking a mark for part of one only sends more text to the rebuild.
 */
const tokenCharacter = /[\p{L}\p{N}\p{Co}\p{M}]/u;

/** A token whose characters are all plain ASCII letters and digits. */
const asciiToken = /^[A-Za-z0-9]+$/u;

/** A character that isn't plain ASCII. */
const notAscii = /\P{ASCII}/u;

/**
 * Adds to `into` the page-directory keys of the tokens in one value of an
 * indexed column, as `indexKeysOf` gives for a term's, and, for a token
 * shorter than three characters, the trigrams that span it whole with its
 * neighbours (" jo", "jo."), which the text says here. "unknown" when the
 * tokenizers' reading of a token can't be worked out exactly: a character
 * that isn't plain ASCII in it, right beside it (JavaScript's Unicode
 * tables aren't SQLite's, which might join the two), or in a trigram of
 * its neighbours (JavaScript's case folding isn't SQLite's). "capped" for
 * a token longer than `maxTokenLength`, and as soon as `into` holds more
 * than `maxKeys`, checked after each key.
 */
export const addCollectionKeys = (
  value: string,
  into: Map<string, IndexKey>,
  maxKeys: number
): "ok" | "unknown" | "capped" => {
  // Code points, as the tokenizers count characters.
  // oxlint-disable-next-line typescript/no-misused-spread -- code points are meant
  const characters = [...value];
  /** Adds `key`, saying whether `into` is past the cap now. */
  const added = (key: IndexKey): boolean => {
    into.set(`${key.table}:${key.key}`, key);
    return into.size > maxKeys;
  };
  let start = 0;
  while (start < characters.length) {
    if (tokenCharacter.test(characters[start] ?? "")) {
      let end = start;
      while (
        end < characters.length &&
        tokenCharacter.test(characters[end] ?? "")
      ) {
        end += 1;
        if (end - start > maxTokenLength) {
          return "capped";
        }
      }
      const token = characters.slice(start, end).join("");
      const beside = `${characters[start - 1] ?? ""}${characters[end] ?? ""}`;
      if (!asciiToken.test(token) || notAscii.test(beside)) {
        return "unknown";
      }
      for (const key of keysOfToken(token.toLowerCase())) {
        if (added(key)) {
          return "capped";
        }
      }
      if (token.length < 3) {
        const first = Math.max(0, end - 3);
        const last = Math.min(start, characters.length - 3);
        for (let at = first; at <= last; at += 1) {
          const trigram = characters.slice(at, at + 3).join("");
          if (notAscii.test(trigram)) {
            return "unknown";
          }
          if (
            added({
              table: "search_trigrams",
              key: `0${trigram.toLowerCase()}`,
              least: 3,
            })
          ) {
            return "capped";
          }
        }
      }
      start = end;
    } else {
      start += 1;
    }
  }
  return "ok";
};

/** What a personal purge's check counted, logged when it stops at a cap. */
interface CheckCounts {
  versions?: number;
  characters?: number;
  keys?: number;
  liveLookups?: number;
}

/**
 * What a personal purge read of its collection before deleting it: the
 * page-directory keys of its tokens, or why they aren't checked (a token
 * that can't be read exactly, frontmatter that doesn't read, a cap
 * reached, with the counts).
 */
export type CollectionPlan =
  | {
      readonly kind: "keys";
      readonly keys: readonly IndexKey[];
      /** The (document, version) pairs read (`rebuildOwedIfChanged`). */
      readonly versions: readonly string[];
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "capped"; readonly counts: CheckCounts };

/** Logs that a personal purge's check reached a cap: counts only. */
const loggedCapped = (counts: CheckCounts): CollectionPlan => {
  log.warn("knowledge.purge.collection_check_capped", { ...counts });
  return { kind: "capped", counts };
};

/** A version's (document, number) pair: a save to its document adds one. */
const versionPair = sql`v.document_id || ':' || v.number`;

/** Whether version `v` is of a document of `collectionId`. */
const versionInCollection = (collectionId: string) => sql`v.document_id IN (
  SELECT id FROM documents WHERE collection_id = ${collectionId}
)`;

/**
 * The values a version of a document at `path` gave the search index, or
 * undefined when that can't be told (`indexedValuesOf`, documents.ts).
 */
export type IndexedValues = (
  path: string,
  text: string
) => readonly string[] | undefined;

/** `collectionPlan`, which throws when a read fails. */
const readCollection = async (
  db: DrizzleD1Database,
  collectionId: string,
  valuesOf: IndexedValues
): Promise<CollectionPlan> => {
  // How much there is, before any text is read: no more of the history
  // than one version past the cap.
  const [size] = await db.all<{ versions: number; characters: number }>(sql`
    SELECT count(*) AS versions, coalesce(sum(size), 0) AS characters
    FROM (
      SELECT length(v.text) AS size FROM versions AS v
      WHERE ${versionInCollection(collectionId)}
      LIMIT ${collectionCheckCaps.versions + 1}
    )
  `);
  const counts = {
    versions: size?.versions ?? 0,
    characters: size?.characters ?? 0,
  };
  if (
    counts.versions > collectionCheckCaps.versions ||
    counts.characters > collectionCheckCaps.characters
  ) {
    return loggedCapped(counts);
  }
  const listed = await db.all<{ documentId: string; number: number }>(sql`
    SELECT v.document_id AS documentId, v.number AS number FROM versions AS v
    WHERE ${versionInCollection(collectionId)}
    ORDER BY v.document_id, v.number
    LIMIT ${collectionCheckCaps.versions + 1}
  `);
  const versions = listed.map(
    ({ documentId, number }) => `${documentId}:${number}`
  );
  if (versions.length > collectionCheckCaps.versions) {
    return loggedCapped({ versions: versions.length });
  }
  const keys = new Map<string, IndexKey>();
  let characters = 0;
  for (let at = 0; at < listed.length; at += versionsPerRead) {
    const page = listed
      .slice(at, at + versionsPerRead)
      .map(({ documentId, number }) => [documentId, number]);
    // By the versions' primary key, one lookup each: never a scan.
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const rows = await db.all<{ path: string; text: string }>(sql`
      SELECT d.path AS path, v.text AS text
      FROM json_each(${JSON.stringify(page)}) AS read
      JOIN versions AS v ON v.document_id = json_extract(read.value, '$[0]')
        AND v.number = json_extract(read.value, '$[1]')
      JOIN documents AS d ON d.id = v.document_id
    `);
    // A version gone meanwhile (the collection changing): rebuilt.
    if (rows.length !== page.length) {
      return { kind: "unknown" };
    }
    for (const row of rows) {
      const values = valuesOf(row.path, row.text);
      if (values === undefined) {
        return { kind: "unknown" };
      }
      // A title or description repeats on every section's row.
      for (const value of new Set(values)) {
        characters += value.length;
        if (characters > collectionCheckCaps.characters) {
          return loggedCapped({ characters, keys: keys.size });
        }
        const added = addCollectionKeys(value, keys, collectionCheckCaps.keys);
        if (added === "unknown") {
          return { kind: "unknown" };
        }
        if (added === "capped") {
          return loggedCapped({ characters, keys: keys.size });
        }
      }
    }
  }
  return { kind: "keys", keys: [...keys.values()], versions };
};

/**
 * Reads every version of `collectionId`'s documents, each of which the
 * search index held once (a later save's secure deletes can leave a page
 * separator of it), a page of versions at a time, and gives the keys of
 * the tokens their values (`valuesOf`) gave the index (`CollectionPlan`).
 * A version a content purge rewrote is read as it is now: its terms were
 * erased then. How much text there is is read first, and reading stops at
 * `collectionCheckCaps`; when a read fails, the plan is unknown, logged
 * by the error's name, and the index is rebuilt.
 */
export const collectionPlan = async (
  db: DrizzleD1Database,
  collectionId: string,
  valuesOf: IndexedValues
): Promise<CollectionPlan> => {
  try {
    return await readCollection(db, collectionId, valuesOf);
  } catch (error) {
    // Not readable here (a platform that refuses it): rebuilt instead.
    log.warn("knowledge.purge.index_check_failed", {
      errorName: errorNameOf(error),
    });
    return { kind: "unknown" };
  }
};

/**
 * The statement, for the batch that deletes `collectionId`, that records a
 * rebuild as owed (`id`) when the collection's versions aren't `versions`,
 * those `collectionPlan` read: a save meanwhile, whose text the plan
 * didn't read. The same pairs, in any order, are as many, and none of them
 * is missing from `versions`. Its writes are the batch's, done when it
 * commits.
 */
export const rebuildOwedIfChanged = (
  db: DrizzleD1Database,
  id: string,
  collectionId: string,
  versions: readonly string[]
) => {
  const now = Date.now();
  const read = JSON.stringify(versions);
  // Builders, not `db.run`: drizzle's D1 batch can't bind a raw
  // statement's parameters.
  return db.insert(searchRebuilds).select(
    db
      .select({
        id: sql<string>`${id}`.as("id"),
        owedAt: sql<number>`${now}`.as("owed_at"),
        writesDoneAt: sql<number>`${now}`.as("writes_done_at"),
      })
      .from(sql`(SELECT 1)`).where(sql`(
        SELECT count(*) FROM versions AS v
        WHERE ${versionInCollection(collectionId)}
      ) != ${versions.length} OR EXISTS (
        SELECT 1 FROM versions AS v WHERE ${versionInCollection(collectionId)}
          AND ${versionPair} NOT IN (SELECT value FROM json_each(${read}))
      )`)
  );
};

/** A held separator, and the FTS5 query that finds a live row explaining it. */
interface Held {
  readonly table: IndexKey["table"];
  readonly query: string;
}

/**
 * The query for a live row that holds what separator `found` holds of its
 * key, each one lookup however large the index: the trigram itself, in
 * the trigram index; the separator's prefix, in a prefix index, when it
 * has the two or three characters the prefix indexes keep; otherwise the
 * key's whole token, as a term. Never a longer prefix, whose query merges
 * every term that starts with it.
 */
const liveQueryOf = (table: IndexKey["table"], found: Found): Held => {
  const token = found.key.slice(1);
  if (table === "search_trigrams") {
    return { table, query: `"${token.replaceAll('"', '""')}"` };
  }
  const prefix = (found.separator ?? "").slice(1);
  return !found.key.startsWith("0") && prefix.length >= 2
    ? { table, query: `"${prefix}"*` }
    : { table, query: `"${token}"` };
};

/**
 * Whether the search index still holds something of `keys`' tokens that
 * no live row explains, after their rows' secure deletes: "clean" when
 * not, "rebuild" when it does, "capped" when finding out took more than
 * `collectionCheckCaps` allows.
 */
const collectionLeft = async (
  db: DrizzleD1Database,
  keys: readonly IndexKey[]
): Promise<"clean" | "rebuild" | "capped"> => {
  const held = new Map<string, Held>();
  for (const table of ["search_words", "search_trigrams"] as const) {
    const ofTable = keys.filter((key) => key.table === table);
    for (let at = 0; at < ofTable.length; at += keysPerLookup) {
      const chunk = ofTable.slice(at, at + keysPerLookup);
      // oxlint-disable-next-line no-await-in-loop -- one chunk at a time
      const found = await separatorsOf(
        db,
        table,
        chunk.map(({ key }) => key)
      );
      const least = new Map(chunk.map((key) => [key.key, key.least]));
      for (const one of found) {
        if (holdsToken(one, least.get(one.key) ?? 1)) {
          const live = liveQueryOf(table, one);
          held.set(`${live.table}:${live.query}`, live);
        }
      }
    }
  }
  if (held.size > collectionCheckCaps.liveLookups) {
    loggedCapped({ keys: keys.length, liveLookups: held.size });
    return "capped";
  }
  const lookups = [...held.values()];
  for (let at = 0; at < lookups.length; at += liveLookupsPerBatch) {
    // Builders, not `db.all`: drizzle's D1 batch can't bind a raw
    // statement's parameters.
    const [first, ...rest] = lookups
      .slice(at, at + liveLookupsPerBatch)
      .map(({ table, query }) =>
        db
          .select({ live: sql<number>`1` })
          .from(sql.raw(table))
          .where(sql`${sql.raw(table)} MATCH ${query}`)
          .limit(1)
      );
    if (first !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time
      const results = await db.batch([first, ...rest]);
      if (results.some((rows) => rows.length === 0)) {
        return "rebuild";
      }
    }
  }
  return "clean";
};

/**
 * Leaves nothing of a deleted collection's text in the search index, after
 * the batch that deleted it, which recorded its own rebuild as owed (`id`,
 * so a purge run again after this fails still rebuilds). Clears that
 * record and returns when every delete was a secure one, the plan read the
 * collection's keys, no other purge owes a rebuild (a change to the
 * collection meanwhile included: `rebuildOwedIfChanged`), and nothing of
 * the keys is left that no live row explains; rebuilds otherwise. Throws
 * when the rebuild fails.
 */
export const eraseCollectionFromSearchIndex = async (
  db: DrizzleD1Database,
  plan: CollectionPlan,
  { secure, id }: { secure: boolean; id: string }
): Promise<void> => {
  if (secure && plan.kind === "keys") {
    try {
      if (
        !(await anyRebuildOwed(db, id)) &&
        (await collectionLeft(db, plan.keys)) === "clean"
      ) {
        await db.delete(searchRebuilds).where(eq(searchRebuilds.id, id));
        return;
      }
    } catch (error) {
      // The error's name only: its message repeats the lookup's tokens.
      log.warn("knowledge.purge.index_check_failed", {
        errorName: errorNameOf(error),
      });
    }
  }
  await rebuildSearchIndex(db);
};
