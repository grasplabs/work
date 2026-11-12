import { recallLimit } from "./contract.ts";
import type { Finding, FoundMemory, Reader } from "./contract.ts";
import { foldIdentifier, foldName } from "./entities.ts";
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

// Memories in recall (GRA-1742): what recall.ts `find` adds to the
// passages. Two ways, a few statements each, all synchronous, so a recall
// stays one read of one snapshot:
//
// - Words: the current memories the reader may read that hold the
//   question's telling words (memories.ts `memoriesByWords`), scored on
//   their own words alone.
// - Entities: the entities the question names (a name a memory the
//   reader may read gave, held in the question as whole words, or an exact
//   identifier written in it), then one or two steps along the relations
//   the reader may read that are current as of the moment asked. An entity
//   with more than `hubRelationsMax` such relations is a hub: its own facts
//   are found, but it is never stepped through, so one entity related to
//   almost everything neither floods the pack nor slows recall. The
//   memories about the entities reached come nearest first: those about a
//   named entity (its facts and its relations), then one step on, then
//   two; at most `recallLimit`, the contract's bound on each way's list.
//
// And, for each memory found that is contested, the other current sides
// the reader may read, so the pack carries both with their sources.
//
// Every statement filters by the reader inside itself before anything is
// counted, ordered or cut (memories.ts `visibleSql`, `memoriesSql`): a
// named entity is one a readable memory names so, a hub is counted on
// the current relations the reader may read, and every order is on a
// memory's own fields. So what a reader gets is what a store without the
// memories hidden from them would give.

/**
 * Most current relations the reader may read before an entity is a hub,
 * not stepped through (GRA-1742: "a cap on entities that are connected
 * to almost everything").
 */
export const hubRelationsMax = 25;

/** Steps along relations from a named entity: one or two (GRA-1742). */
export const stepsMax = 2;

/** Punctuation and symbols at either end of a word of the question. */
const edges = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

/** Runs of white space. */
const spaces = /\s+/u;

/**
 * What the question may name an entity by: its words folded as names are
 * (entities.ts `foldName`), as written and without the punctuation at
 * either end of each word, each between spaces so a name is found only
 * as whole words; and each word as an email and as a reference, as
 * identifiers are compared. No recogniser of names: an entity is found
 * only by a name or identifier a memory gave it, exactly.
 */
const namedBy = (
  question: string
): { written: string; bare: string; identifiers: [string, string][] } => {
  const words = question.split(spaces).filter((word) => word.length > 0);
  const bareWords = words.map((word) => word.replaceAll(edges, ""));
  const identifiers = new Map<string, [string, string]>();
  for (const word of new Set([...words, ...bareWords])) {
    if (word.includes("@")) {
      const email = foldIdentifier({ type: "email", value: word });
      identifiers.set(`email ${email}`, ["email", email]);
    }
    if (word.includes(":")) {
      identifiers.set(`ref ${word}`, ["ref", word]);
    }
  }
  return {
    written: ` ${foldName(words.join(" "))} `,
    bare: ` ${foldName(bareWords.join(" "))} `,
    identifiers: [...identifiers.values()],
  };
};

/**
 * `?1` the question's words as written, folded, between spaces, `?4` the
 * moment, `?5` the same without the punctuation at either end of each
 * word, `?6` its identifiers (JSON, each `[type, folded]`): the entities a
 * memory the reader may read, learned by then, gives a name held in the
 * question as whole words, or one of its identifiers.
 */
const namedSql = `
WITH ${readableSql}
SELECT DISTINCT entity_names.entity AS entity
FROM entity_names
JOIN memories AS m ON m.row = entity_names.memory
WHERE m.learned_at <= ?4 AND ${visibleSql("m")}
  AND (
    (entity_names.type = 'name' AND entity_names.folded != ''
      AND (instr(?1, ' ' || entity_names.folded || ' ') > 0
        OR instr(?5, ' ' || entity_names.folded || ' ') > 0))
    OR (entity_names.type != 'name' AND EXISTS (
      SELECT 1 FROM json_each(?6) AS asked
      WHERE asked.value ->> 0 = entity_names.type
        AND asked.value ->> 1 = entity_names.folded))
  )`;

/**
 * `?1` entities (JSON rows) to step from: the relations on them the
 * reader may read that are current as of `?4`, with both their ends.
 */
const stepSql = memoriesSql({
  base: `SELECT m.row FROM json_each(?1) AS asked
    JOIN memories AS m ON m.entity = asked.value AND m.object IS NOT NULL
    UNION SELECT m.row FROM json_each(?1) AS asked
    JOIN memories AS m ON m.object = asked.value`,
  filter: "judged.is_current = 1",
  columns: ", m.entity AS entity_end, m.object AS object_end",
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
  base: `SELECT m.row FROM reached JOIN memories AS m ON m.entity = reached.entity
    WHERE reached.hub = 0 OR m.object IS NULL
    UNION SELECT m.row FROM reached JOIN memories AS m ON m.object = reached.entity
    WHERE reached.hub = 0`,
  filter: "judged.is_current = 1",
  columns: `, (SELECT min(reached.step) FROM reached
    WHERE reached.entity IN (m.entity, m.object)) AS step`,
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
  question: string,
  reader: Reader,
  at: number
): Reached[] => {
  const { written, bare, identifiers } = namedBy(question);
  const named = sql
    .exec<{ entity: number }>(
      namedSql,
      written,
      reader.person,
      JSON.stringify(reader.groups),
      at,
      bare,
      JSON.stringify(identifiers)
    )
    .toArray();
  if (named.length === 0) {
    return [];
  }
  const reached = new Map<number, { step: number; hub: boolean }>();
  let frontier = named.map(({ entity }) => entity);
  for (let step = 0; frontier.length > 0; step += 1) {
    // The current relations the reader may read on each entity of this
    // step: how many make it a hub, and, for the others, where they lead.
    const relations = run<
      MemoryRow & { entity_end: number; object_end: number }
    >(sql, stepSql, JSON.stringify(frontier), reader, at, -1);
    const counts = new Map<number, number>();
    for (const { entity_end: from, object_end: to } of relations) {
      for (const end of new Set([from, to])) {
        counts.set(end, (counts.get(end) ?? 0) + 1);
      }
    }
    for (const entity of frontier) {
      reached.set(entity, {
        step,
        hub: (counts.get(entity) ?? 0) > hubRelationsMax,
      });
    }
    if (step === stepsMax) {
      break;
    }
    const next = new Set<number>();
    for (const { entity_end: from, object_end: to } of relations) {
      for (const [here, there] of [
        [from, to],
        [to, from],
      ] as const) {
        if (reached.get(here)?.hub === false && !reached.has(there)) {
          next.add(there);
        }
      }
    }
    frontier = [...next];
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
  filter: "judged.is_current = 1",
  order: "confirmation IS NULL, m.learned_at DESC, m.row DESC",
});

/**
 * The other current sides the reader may read of each contested memory
 * in `found`, those not found already: every one, so the pack carries a
 * contested fact whole.
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
  memoriesByWords(sql, { question, reader, at }).map((memory) => ({
    ...memory,
    step: 0,
    context: null,
  }));

/**
 * The memories the reader may read for `question` as of `at`
 * (milliseconds): those its words found (`words`, from
 * `memoriesByTheirWords`), those along the entities it names, through
 * `way` (which counts it) for a question of some word, and the other sides
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
  const entities =
    question.trim() === ""
      ? []
      : way("entities", () => byEntities(sql, question, reader, at));
  const rivals = rivalsOf(sql, [...words, ...entities], reader, at);
  return {
    words: withContext(sql, words),
    entities: withContext(sql, entities),
    rivals: withContext(sql, rivals),
  };
};
