import { recallLimit } from "./contract.ts";
import type { Finding, FoundMemory, Reader } from "./contract.ts";
import { foldIdentifier, foldName } from "./entities.ts";
import {
  endedAtSql,
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
//   with more than `hubRelationsMax` such relations is a hub: it is never
//   stepped through, so one entity related to almost everything neither
//   floods the pack nor slows recall. What is returned: every fact of an
//   entity reached, and every relation whose two ends were both reached
//   (a relation is a memory about both, GRA-1742), at the step of its
//   nearer end, or of its other end when the nearer is a hub; a relation
//   leading to an entity not reached (a third step) is not. Nearest step
//   first, at most `recallLimit`, the contract's bound on each way's list.
//   Each step is read with the room the list has left, and none further
//   once it is full: nearer steps always rank first, so what a fuller
//   walk would add never reaches the list.
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
 * not stepped through. GRA-1742 asks for "a cap on entities that are
 * connected to almost everything"; the number is ours, chosen here: well
 * above the relations a person, customer or supplier usually has, well
 * below a company-wide tool or team. Measure before moving it.
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
-- Names first, then each one's memory by its row: never the memories
-- the reader may read, scanned for the few that give a name.
CROSS JOIN memories AS m ON m.row = entity_names.memory
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
 * Whether the relation `m` is one the reader may read, current as of
 * `?4`: learned and started by then, not ended for the reader (memories.ts
 * `endedAtSql`), not yet expired.
 */
const currentRelationSql = `m.learned_at <= ?4 AND ${visibleSql("m")}
  AND (m.valid_from IS NULL OR m.valid_from <= ?4)
  AND (m.valid_until IS NULL OR m.valid_until > ?4)
  AND ${endedAtSql} IS NULL`;

/**
 * `?1` entities (JSON rows), `?5` where to stop counting: for each, how
 * many current relations the reader may read it is on (either side),
 * counted up to `?5` and no further, so a hub's relations are never all
 * read.
 */
const hubCountSql = `
WITH ${readableSql}
SELECT asked.value AS entity, (
  SELECT count(*) FROM (
    SELECT 1 FROM memories AS m
    WHERE m.entity = asked.value AND m.object IS NOT NULL
      AND ${currentRelationSql}
    UNION ALL
    SELECT 1 FROM memories AS m
    WHERE m.object = asked.value AND ${currentRelationSql}
    LIMIT ?5
  )
) AS relations
FROM json_each(?1) AS asked`;

/**
 * `?1` entities (JSON rows) to step from, none a hub: the relations on
 * them the reader may read that are current as of `?4`, with both their
 * ends.
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
 * `?1` one step of the walk (JSON: `here`, each `[row, whole]`; `before`,
 * the rows read whole at an earlier step; `reached`, every row the walk
 * has reached, this step's too), `?5` the room left: the current memories
 * the reader may read about the entities of this step, confirmed first,
 * then the newest. Of an entity read `whole`, its facts and its
 * relations; of another (a hub, or one on the last step), its own facts
 * and its relations to entities the walk reached: a relation between two
 * reached entities is a memory about both (GRA-1742), and one leading
 * further is not. Those on an entity of an earlier step read whole are
 * left out: that step gave them already.
 */
const stepReadSql = memoriesSql({
  prelude: `here AS MATERIALIZED (
  SELECT value ->> 0 AS entity, value ->> 1 AS whole
  FROM json_each(?1, '$.here')
),
before AS MATERIALIZED (
  SELECT value AS entity FROM json_each(?1, '$.before')
),
reached AS MATERIALIZED (
  SELECT value AS entity FROM json_each(?1, '$.reached')
)`,
  base: `SELECT m.row FROM here JOIN memories AS m ON m.entity = here.entity
    WHERE here.whole = 1 OR m.object IS NULL
    UNION SELECT m.row FROM here CROSS JOIN memories AS m ON m.object = here.entity
    WHERE here.whole = 1
    UNION SELECT m.row FROM here CROSS JOIN reached
    CROSS JOIN memories AS m
      ON m.object = reached.entity AND m.entity = here.entity
    WHERE here.whole = 0
    UNION SELECT m.row FROM here CROSS JOIN reached
    CROSS JOIN memories AS m
      ON m.entity = reached.entity AND m.object = here.entity
    WHERE here.whole = 0`,
  filter: `judged.is_current = 1
    AND m.entity NOT IN (SELECT entity FROM before)
    AND (m.object IS NULL OR m.object NOT IN (SELECT entity FROM before))`,
  order: "confirmation IS NULL, m.learned_at DESC, m.id DESC",
});

/** How a memory is ordered and placed: what `FoundMemory` adds to `Memory`. */
const foundOf = (
  row: MemoryRow,
  extra: { words?: number; exact?: number; step?: number }
): FoundMemory => ({
  ...memoryOf(row),
  words: extra.words ?? 0,
  exact: extra.exact ?? 0,
  step: extra.step ?? 0,
  context: null,
});

/**
 * Bindings a statement judging memories takes after its five (`?6` to
 * `?19`, unused here), before `?20`, the moment the dates a fact is true
 * are judged at (memories.ts `validSql`): unbound, so they are judged at
 * `?4`, the one moment of the recall.
 */
const unusedBindings = 15;

/**
 * Runs `statement`, one that judges memories (memories.ts `memoriesSql`,
 * `endedAtSql`), with the reader's bindings around `first`.
 */
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
      limit,
      ...Array.from<null>({ length: unusedBindings }).fill(null)
    )
    .toArray();

/** The entities of `frontier` that are hubs for the reader as of `at`. */
const hubsOf = (
  sql: SqlStorage,
  frontier: readonly number[],
  reader: Reader,
  at: number
): Set<number> =>
  new Set(
    run<{ entity: number; relations: number }>(
      sql,
      hubCountSql,
      JSON.stringify(frontier),
      reader,
      at,
      hubRelationsMax + 1
    )
      .filter(({ relations }) => relations > hubRelationsMax)
      .map(({ entity }) => entity)
  );

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
  // One step at a time, nearest first, each read with the room the list
  // has left: the nearer steps always rank first, so once they fill it,
  // what lies further is never read.
  const found: Reached[] = [];
  const reached = new Set<number>();
  const before: number[] = [];
  let frontier = named.map(({ entity }) => entity);
  for (let step = 0; ; step += 1) {
    for (const entity of frontier) {
      reached.add(entity);
    }
    // The last step is never stepped through: whether one of its entities
    // is a hub doesn't matter there, so it isn't counted.
    const last = step === stepsMax;
    const hubs = last ? new Set<number>() : hubsOf(sql, frontier, reader, at);
    const whole = last ? [] : frontier.filter((entity) => !hubs.has(entity));
    const wholeSet = new Set(whole);
    found.push(
      ...run<MemoryRow>(
        sql,
        stepReadSql,
        JSON.stringify({
          here: frontier.map((entity) => [
            entity,
            wholeSet.has(entity) ? 1 : 0,
          ]),
          before,
          reached: [...reached],
        }),
        reader,
        at,
        recallLimit - found.length
      ).map((row) => foundOf(row, { step }))
    );
    if (found.length >= recallLimit || whole.length === 0) {
      return found;
    }
    before.push(...whole);
    const next = new Set<number>();
    for (const { entity_end: from, object_end: to } of run<
      MemoryRow & { entity_end: number; object_end: number }
    >(sql, stepSql, JSON.stringify(whole), reader, at, -1)) {
      for (const end of [from, to]) {
        if (!reached.has(end)) {
          next.add(end);
        }
      }
    }
    if (next.size === 0) {
      return found;
    }
    frontier = [...next];
  }
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
  order: "confirmation IS NULL, m.learned_at DESC, m.id DESC",
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
          "SELECT entity FROM memories WHERE id = ?",
          memory.id
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
  { source, quote }: Pick<FoundMemory, "source" | "quote">
): FoundMemory["context"] => {
  if (source === null || quote === null) {
    return null;
  }
  return (
    sql
      .exec<{ position: number; text: string }>(
        `SELECT chunks.position AS position, chunks.text AS text
        FROM source_versions
        JOIN chunks ON chunks.version_row = source_versions.row
        WHERE source_versions.source = ? AND source_versions.version = ?
          AND instr(chunks.text, ?) > 0
        ORDER BY chunks.position LIMIT 1`,
        source.source,
        source.version,
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
  found.map((memory) => ({ ...memory, context: contextOf(sql, memory) }));

/** A memory a way found, before its context is read. */
export type Reached = FoundMemory;

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
