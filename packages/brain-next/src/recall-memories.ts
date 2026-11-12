import { recallLimit } from "./contract.ts";
import type { Finding, FoundMemory, Reader } from "./contract.ts";
import { foldIdentifier, foldName } from "./entities.ts";
import { joinedFamilySql, joinedSql } from "./joins.ts";
import {
  memoriesByWords,
  memoriesSql,
  memoryOf,
  memoryRows,
  visibleSql,
} from "./memories.ts";
import type { MemoryRow } from "./memories.ts";
import { readableSql } from "./reader-sets.ts";
import type { WayRunner } from "./recall-counts.ts";
import { isWritersOwn, writersOwnSql } from "./writers-own.ts";

// Memories in recall (GRA-1742): what recall.ts `find` adds to the
// passages. Two ways, each one statement or a few, all synchronous, so a
// recall stays one read of one snapshot:
//
// - Words: the current memories the reader may read that hold the
//   question's telling words (memories.ts `memoriesByWords`), scored on
//   their own words alone.
// - Entities: the entities the question names (a name or an exact
//   identifier, as written, that a memory the reader may read gave), then
//   one or two steps along the relations the reader may read, current as
//   of the moment asked. An entity related to more than `hubRelationsMax`
//   others the reader may read is a hub: its own facts are found, but it
//   is never stepped through, so one entity related to almost everything
//   neither floods the pack nor slows recall. The memories about the
//   entities reached come nearest first: those about a named entity (its
//   facts and its relations), then one step on, then two.
//
// And, for each memory found that is contested, the other current sides
// the reader may read, so the pack carries both with their sources.
//
// Every statement filters by the reader inside itself before anything is
// counted, ordered or capped (memories.ts `visibleSql`, `memoriesSql`): a
// hub is counted on the relations the reader may read, the named entities
// are those a readable memory names so, and every order is on a memory's
// own fields. So what a reader gets is what a store without the memories
// hidden from them would give.

/** Most entities a question names that the entities way starts from. */
export const namedEntitiesMax = 10;

/** Most words of a name the question is searched for: longer names are not found by it. */
export const nameWordsMax = 6;

/** Most relations the reader may read before an entity is a hub, not stepped through. */
export const hubRelationsMax = 25;

/** Steps along relations from a named entity. */
export const stepsMax = 2;

/** Punctuation and symbols at either end of a word of the question. */
const edges = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

/** Runs of white space. */
const spaces = /\s+/u;

/**
 * What the question may name an entity by, as names and identifiers are
 * compared (entities.ts): each run of up to `nameWordsMax` of its words,
 * as written and without the punctuation at its ends, folded; and each
 * word as an email and as a reference. No recogniser of names: an entity
 * is found only by a name a memory gave it, exactly.
 */
const namedBy = (question: string): [string, string][] => {
  const words = question.split(spaces).filter((word) => word.length > 0);
  const asked = new Map<string, [string, string]>();
  const add = (type: string, folded: string): void => {
    asked.set(JSON.stringify([type, folded]), [type, folded]);
  };
  for (let start = 0; start < words.length; start += 1) {
    for (
      let end = start + 1;
      end <= Math.min(words.length, start + nameWordsMax);
      end += 1
    ) {
      const run = words.slice(start, end);
      for (const written of [
        run.join(" "),
        run.map((word) => word.replaceAll(edges, "")).join(" "),
      ]) {
        const folded = foldName(written);
        if (folded.length > 0) {
          add("name", folded);
        }
      }
    }
  }
  for (const word of words) {
    for (const bare of new Set([word, word.replaceAll(edges, "")])) {
      if (bare.includes("@")) {
        add("email", foldIdentifier({ type: "email", value: bare }));
      }
      if (bare.includes(":")) {
        add("ref", bare);
      }
    }
  }
  return [...asked.values()];
};

/**
 * `?1` the names and identifiers asked (JSON, each `[type, folded]`),
 * `?4` the moment, `?5` the most: the entities a memory the reader may
 * read, learned by then, gives one of them, in the order of the first
 * such memory.
 */
const namedSql = `
WITH ${readableSql}
SELECT ${joinedSql("entity_names.entity")} AS entity
FROM json_each(?1) AS asked
JOIN entity_names
  ON entity_names.type = asked.value ->> 0
  AND entity_names.folded = asked.value ->> 1
JOIN memories AS m ON m.row = entity_names.memory
WHERE m.learned_at <= ?4 AND ${visibleSql("m")}
GROUP BY 1
ORDER BY min(m.row)
LIMIT ?5`;

/**
 * `?1` entities (JSON rows), `?4` the moment, `?5` the most counted: for
 * each, how many relations the reader may read, learned by then, it is
 * on (either side), counted up to `?5` and no further.
 */
const relationCountsSql = `
WITH ${readableSql}
SELECT asked.value AS entity, (
  SELECT count(*) FROM (
    SELECT 1 FROM memories AS m
    WHERE (m.entity IN (${joinedFamilySql("asked.value")})
        OR m.object IN (${joinedFamilySql("asked.value")}))
      AND m.object IS NOT NULL AND m.learned_at <= ?4 AND ${visibleSql("m")}
    LIMIT ?5
  )
) AS relations
FROM json_each(?1) AS asked`;

/**
 * `?1` entities (JSON rows) to step from: the relations on them the
 * reader may read that are current as of `?4`.
 */
const stepSql = memoriesSql({
  base: `SELECT m.row FROM json_each(?1) AS asked
    JOIN memories AS m ON m.entity IN (${joinedFamilySql("asked.value")})
      AND m.object IS NOT NULL
    UNION SELECT m.row FROM json_each(?1) AS asked
    JOIN memories AS m ON m.object IN (${joinedFamilySql("asked.value")})`,
  filter: "judged.is_current = 1",
  columns: `, ${joinedSql("m.entity")} AS entity_standing,
    ${joinedSql("m.object")} AS object_standing`,
  order: "m.row",
});

/**
 * `?1` the entities reached (JSON, each `[row, step, hub]`), `?5` the
 * most: the current memories the reader may read about them, the nearest
 * step first (a relation counts at the nearer of its two ends), then
 * confirmed, then the newest. A hub's own facts, never its relations.
 */
const reachedSql = memoriesSql({
  prelude: `reached AS MATERIALIZED (
  SELECT value ->> 0 AS entity, value ->> 1 AS step, value ->> 2 AS hub
  FROM json_each(?1)
)`,
  base: `SELECT m.row FROM reached
    JOIN memories AS m ON m.entity IN (${joinedFamilySql("reached.entity")})
    WHERE reached.hub = 0 OR m.object IS NULL
    UNION SELECT m.row FROM reached
    JOIN memories AS m ON m.object IN (${joinedFamilySql("reached.entity")})
    WHERE reached.hub = 0`,
  filter: `judged.is_current = 1 AND ${writersOwnSql}`,
  columns: `, (SELECT min(reached.step) FROM reached
    WHERE reached.entity IN (${joinedSql("m.entity")}, ${joinedSql("m.object")})) AS step`,
  order: `step, confirmation IS NULL, m.learned_at DESC, m.row DESC`,
});

/** A memory row of the entities way, with its step. */
type ReachedRow = MemoryRow & { step: number };

/** How a memory is ordered and placed: what `FoundMemory` adds to `Memory`. */
const foundOf = (
  row: MemoryRow,
  extra: { words?: number; exact?: number; step?: number }
): FoundMemory & { versionRow: number | null } => ({
  ...memoryOf(row),
  row: row.row,
  words: extra.words ?? 0,
  exact: extra.exact ?? 0,
  step: extra.step ?? 0,
  context: null,
  versionRow: row.version_row,
});

/** Runs `statement` with the reader's bindings around `first`. */
const run = <T extends Record<string, SqlStorageValue>>(
  sql: SqlStorage,
  statement: string,
  first: SqlStorageValue,
  reader: Reader,
  at: number,
  limit: number
): T[] =>
  sql
    .exec<T>(
      statement,
      first,
      reader.person,
      JSON.stringify(reader.groups),
      at,
      limit
    )
    .toArray();

/**
 * The entities way: the memories about the entities the question names
 * and those one or two steps along their relations, nearest first, at
 * most `recallLimit` (above).
 */
const byEntities = (
  sql: SqlStorage,
  asked: [string, string][],
  reader: Reader,
  at: number
): Reached[] => {
  const named = run<{ entity: number }>(
    sql,
    namedSql,
    JSON.stringify(asked),
    reader,
    at,
    namedEntitiesMax
  );
  if (named.length === 0) {
    return [];
  }
  const reached = new Map<number, { step: number; hub: boolean }>();
  let frontier = named.map(({ entity }) => entity);
  for (let step = 0; frontier.length > 0; step += 1) {
    const counts = run<{ entity: number; relations: number }>(
      sql,
      relationCountsSql,
      JSON.stringify(frontier),
      reader,
      at,
      hubRelationsMax + 1
    );
    const through: number[] = [];
    for (const { entity, relations } of counts) {
      const hub = relations > hubRelationsMax;
      reached.set(entity, { step, hub });
      if (!hub) {
        through.push(entity);
      }
    }
    if (step === stepsMax || through.length === 0) {
      break;
    }
    const next = new Set<number>();
    for (const relation of run<
      MemoryRow & { entity_standing: number; object_standing: number }
    >(sql, stepSql, JSON.stringify(through), reader, at, -1)) {
      for (const end of [relation.entity_standing, relation.object_standing]) {
        if (!reached.has(end)) {
          next.add(end);
        }
      }
    }
    frontier = [...next].toSorted((a, b) => a - b);
  }
  return run<ReachedRow>(
    sql,
    reachedSql,
    JSON.stringify(
      [...reached].map(([entity, { step, hub }]) => [entity, step, hub ? 1 : 0])
    ),
    reader,
    at,
    recallLimit
  ).map((row) => foundOf(row, { step: row.step }));
};

/**
 * `?1` the facts (JSON, each `[entity row, attribute]`): their current
 * memories the reader may read, as of `?4`.
 */
const sidesSql = memoriesSql({
  base: `SELECT m.row FROM json_each(?1) AS asked
    JOIN memories AS m ON m.entity = asked.value ->> 0
      AND m.attribute = asked.value ->> 1 AND m.one_value = 1`,
  filter: `judged.is_current = 1 AND ${writersOwnSql}`,
  order: "confirmation IS NULL, m.learned_at DESC, m.row DESC",
});

/**
 * The other current sides the reader may read of each contested memory
 * in `found`, those not found already: at most `recallLimit`.
 */
const rivalsOf = (
  sql: SqlStorage,
  found: readonly Reached[],
  reader: Reader,
  at: number
): Reached[] => {
  const facts = new Map<string, [number, string]>();
  const ids = new Set(found.map(({ id }) => id));
  for (const memory of found) {
    if (memory.contested && memory.attribute !== null) {
      const { entity } = sql
        .exec<{ entity: number }>(
          "SELECT entity FROM memories WHERE row = ?",
          memory.row
        )
        .one();
      facts.set(JSON.stringify([entity, memory.attribute]), [
        entity,
        memory.attribute,
      ]);
    }
  }
  if (facts.size === 0) {
    return [];
  }
  return memoryRows(
    sql,
    sidesSql,
    JSON.stringify([...facts.values()]),
    reader,
    at,
    -1
  )
    .filter(({ id }) => !ids.has(id))
    .slice(0, recallLimit)
    .map((row) => foundOf(row, {}));
};

/**
 * The passage around a memory's quote: the first chunk of its version
 * holding the quote whole, or none (no version, no quote, or a quote
 * across two chunks). The reader may read the version: they may read
 * the memory (memories.ts `visibleSql`).
 */
const contextOf = (
  sql: SqlStorage,
  { versionRow, quote }: { versionRow: number | null; quote: string | null }
): FoundMemory["context"] => {
  if (versionRow === null || quote === null) {
    return null;
  }
  return (
    sql
      .exec<{ position: number; text: string }>(
        `SELECT position, text FROM chunks
        WHERE version_row = ? AND instr(text, ?) > 0
        ORDER BY position LIMIT 1`,
        versionRow,
        quote
      )
      .toArray()
      .at(0) ?? null
  );
};

/** `found` with each one's context, as the pack takes it. */
const withContext = (
  sql: SqlStorage,
  found: readonly Reached[]
): FoundMemory[] =>
  found.map(({ versionRow, ...memory }) => ({
    ...memory,
    context: contextOf(sql, { versionRow, quote: memory.quote }),
  }));

/** A memory a way found, before its context is read. */
export type Reached = FoundMemory & { versionRow: number | null };

/**
 * The words way over memories: the current memories the reader may read
 * as of `at` that hold the question's telling words (memories.ts
 * `memoriesByWords`). Run with the words way over passages, as one way.
 */
export const memoriesByTheirWords = (
  sql: SqlStorage,
  { question, reader, at }: { question: string; reader: Reader; at: number }
): Reached[] =>
  memoriesByWords(sql, { question, reader, at })
    .filter((memory) => isWritersOwn(memory, reader))
    .map((memory) => ({
      ...memory,
      step: 0,
      context: null,
    }));

/**
 * The memories the reader may read for `question` as of `at`
 * (milliseconds): those its words found (`words`, from
 * `memoriesByTheirWords`), those along the entities it names, through
 * `way` (which counts it) when it names something, and the other sides
 * of the contested ones (above), each with its context.
 */
export const findMemories = (
  sql: SqlStorage,
  {
    question,
    reader,
    at,
    words,
  }: { question: string; reader: Reader; at: number; words: Reached[] },
  way: WayRunner
): Finding["memories"] => {
  const asked = namedBy(question);
  const entities =
    asked.length === 0
      ? []
      : way("entities", () => byEntities(sql, asked, reader, at));
  const rivals = rivalsOf(sql, [...words, ...entities], reader, at);
  return {
    words: withContext(sql, words),
    entities: withContext(sql, entities),
    rivals: withContext(sql, rivals),
  };
};
