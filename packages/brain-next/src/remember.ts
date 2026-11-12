import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { attributeRuleOf } from "./contract.ts";
import type {
  AddedMemories,
  AttributeRule,
  NewMemory,
  newMemoriesSchema,
} from "./contract.ts";
import {
  foldIdentifier,
  foldName,
  keepNames,
  linkedBy,
  mayName,
} from "./entities.ts";
import { erasuresSoFar, isPersonErasedSince, subjectOf } from "./erasure.ts";
import { hashOf } from "./files.ts";
import { linkedByName } from "./linking.ts";
import { entityRowOf, lineageOfSource, lineageOfWriter } from "./memories.ts";
import { readerSetKeyOf, readerSetOf } from "./reader-sets.ts";
import { indexMemoryWords } from "./words.ts";
import type { WordMemo } from "./words.ts";

// Adding memories (contract.ts `addMemories`): checked whole first, then
// written in one transaction with the entities they name, so an add is
// all or nothing, and two adds racing each other are one after the
// other: within a lineage the order of its memories decides which is
// current (memories.ts), never which add came first, so two writers never
// both win or both lose. The same change again answers what it added,
// whatever was added since; with other memories, it is refused.

/** An add as its schema reads it. */
type Adding = z.output<typeof newMemoriesSchema>;

/** A memory of an add, with where its entities are in the add and its attribute's rule. */
interface Planned {
  about: number;
  object: number | undefined;
  rule: AttributeRule | undefined;
}

/** What an add answered, as kept with its change. */
const answerSchema = z.strictObject({
  memories: z.array(z.string()),
  entities: z.record(z.string(), z.string()),
});

/** A refusal of an add: what rule it broke, never a value. */
const refused = (why: string): Error =>
  new Error(`The Brain refused it: ${why}`);

/**
 * Each memory of `adding` with its entities and its attribute's rule, or
 * a refusal: every entity key once, every one a memory names given and
 * every one given named; an attribute its entity's kind lists; a relation
 * with an entity of a kind it relates to and no value; any other
 * attribute with a value and no entity it relates to.
 */
const planOf = ({ entities, memories }: Adding): Planned[] => {
  const byKey = new Map(entities.map(({ key }, index) => [key, index]));
  if (byKey.size !== entities.length) {
    throw refused("two entities have the same key");
  }
  const mentioned = new Set<number>();
  const planned = memories.map((memory, index) => {
    const about = byKey.get(memory.about);
    const object =
      memory.object === undefined ? undefined : byKey.get(memory.object);
    if (
      about === undefined ||
      (memory.object !== undefined && object === undefined)
    ) {
      throw refused(`memory ${index} names an entity the add doesn't give`);
    }
    mentioned.add(about);
    if (object !== undefined) {
      mentioned.add(object);
    }
    if (memory.attribute === undefined) {
      return { about, object, rule: undefined };
    }
    const kind = entities[about]?.kind;
    const rule =
      kind === undefined ? undefined : attributeRuleOf(kind, memory.attribute);
    if (rule === undefined) {
      throw refused(
        `memory ${index} has an attribute its entity's kind hasn't`
      );
    }
    if (rule.relation === undefined) {
      if (memory.value === undefined || object !== undefined) {
        throw refused(
          `memory ${index} needs a value and no related entity for its attribute`
        );
      }
    } else {
      const related = object === undefined ? undefined : entities[object];
      if (
        related === undefined ||
        memory.value !== undefined ||
        !rule.relation.includes(related.kind)
      ) {
        throw refused(
          `memory ${index} needs a related entity of a kind its attribute relates to, and no value`
        );
      }
    }
    return { about, object, rule };
  });
  if (mentioned.size !== entities.length) {
    throw refused("an entity no memory mentions");
  }
  return planned;
};

/** The store's parts an add needs. */
export interface RememberStore {
  storage: DurableObjectStorage;
  db: DrizzleSqliteDODatabase;
}

const encoder = new TextEncoder();

/** What a refused repeat of a change says. */
const otherMemories =
  "The Brain refused it: this change was added before with other memories";

/** What an add for an erased person says, as a source's (sources.ts). */
const erasedPerson = "The Brain refused it: what this adds was erased";

/**
 * The entities of an add as rows: each known `id` (of its kind), else
 * the first holding one of its identifiers, or another entity of the add
 * with one of them, else, given no identifier, the one entity of its kind
 * holding one of its names by memories of exactly the add's readers
 * (linking.ts `linkedByName`), else a new one.
 */
const entityRowsOf = (
  sql: SqlStorage,
  { entities, reader }: Adding,
  readers: string
): number[] => {
  const linked = new Map<string, number>();
  return entities.map((entity, index) => {
    const keys = entity.identifiers.map((id) =>
      JSON.stringify([entity.kind, id.type, foldIdentifier(id)])
    );
    let row: number | undefined;
    if (entity.id === undefined) {
      row =
        keys
          .map((key) => linked.get(key))
          .find((found) => found !== undefined) ??
        linkedBy(sql, entity.kind, entity.identifiers, readers) ??
        (entity.identifiers.length === 0
          ? linkedByName(sql, entity.kind, entity.names, readers)
          : undefined);
    } else {
      const known = entityRowOf(sql, entity.id);
      // An id the add may not name is refused in the words of an unknown
      // one: whether it exists is no answer of the store's.
      if (
        known === undefined ||
        known.kind !== entity.kind ||
        !mayName(sql, known.row, readers, reader)
      ) {
        throw refused(`entity ${index} names no entity of its kind`);
      }
      ({ row } = known);
    }
    row ??= sql
      .exec<{ row: number }>(
        "INSERT INTO entities (id, kind) VALUES (?, ?) RETURNING row",
        crypto.randomUUID(),
        entity.kind
      )
      .one().row;
    for (const key of keys) {
      if (!linked.has(key)) {
        linked.set(key, row);
      }
    }
    return row;
  });
};

/** Whether this store holds the version and no erasure hides it; a refusal (`why`) if not. */
const holdVersion = (
  sql: SqlStorage,
  source: string,
  version: number,
  why: string
): void => {
  const [found] = sql
    .exec<{ row: number }>(
      `SELECT row FROM source_versions
      WHERE source = ? AND version = ?
        AND row NOT IN (SELECT version_row FROM erasing_versions)`,
      source,
      version
    )
    .toArray();
  if (found === undefined) {
    throw refused(why);
  }
};

/** Where an add writes its memories: its entities' rows and ids, and what every memory shares. */
interface Into {
  sql: SqlStorage;
  entities: Adding["entities"];
  rows: readonly number[];
  ids: readonly string[];
  /** The add's readers, by their set's key (`reader_sets.key`). */
  readers: string;
  learnedAt: number;
  onlyFor: string | null;
  memo: WordMemo;
}

/**
 * What one-value attributes compare a memory by: its value folded, or the
 * id of the entity a relation relates to; none without an attribute.
 */
const valueKeyOf = (
  { ids }: Into,
  memory: NewMemory,
  plan: Planned
): string | null => {
  if (plan.rule === undefined) {
    return null;
  }
  if (plan.rule.relation === undefined) {
    return foldName(memory.value ?? "");
  }
  return plan.object === undefined ? null : (ids[plan.object] ?? null);
};

/** Where a memory's basis puts it: its version, writer, lineage and place in that lineage. */
const basisOf = (
  sql: SqlStorage,
  basis: NewMemory["basis"],
  index: number
): {
  source: string | null;
  version: number | null;
  writer: string | null;
  lineage: string;
  order: number;
} => {
  if (basis.kind === "writer") {
    return {
      source: null,
      version: null,
      writer: basis.writer,
      lineage: lineageOfWriter(basis.writer),
      order: 0,
    };
  }
  holdVersion(
    sql,
    basis.source,
    basis.version,
    `memory ${index} rests on a version this store doesn't hold`
  );
  return {
    source: basis.source,
    version: basis.version,
    writer: null,
    lineage: lineageOfSource(basis.source),
    order: basis.version,
  };
};

/** The names and identifiers of the entities a memory mentions, kept as it gave them. */
const keepMentions = (into: Into, plan: Planned, row: number): void => {
  for (const at of plan.object === undefined
    ? [plan.about]
    : [plan.about, plan.object]) {
    const entity = into.entities[at];
    const entityRow = into.rows[at];
    if (entity !== undefined && entityRow !== undefined) {
      keepNames(into.sql, entityRow, row, entity.names, entity.identifiers);
    }
  }
};

/**
 * Writes `memory`, the add's `index`th, with its words and stems and the
 * names and identifiers of the entities it mentions, as it gave them.
 * Answers its id.
 */
const writeMemory = (
  into: Into,
  memory: NewMemory,
  plan: Planned | undefined,
  index: number
): string => {
  const { sql, rows } = into;
  const aboutRow = plan === undefined ? undefined : rows[plan.about];
  if (plan === undefined || aboutRow === undefined) {
    throw refused(`memory ${index} names an entity the add doesn't give`);
  }
  const based = basisOf(sql, memory.basis, index);
  const id = crypto.randomUUID();
  const { row } = sql
    .exec<{ row: number }>(
      `INSERT INTO memories (id, entity, attribute, object, value, value_key,
        one_value, type, statement, quote, source, version, writer, lineage,
        lineage_order, speaker, valid_from, valid_until, learned_at,
        readers, only_for)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING row`,
      id,
      aboutRow,
      memory.attribute ?? null,
      plan.object === undefined ? null : (rows[plan.object] ?? null),
      memory.value ?? null,
      valueKeyOf(into, memory, plan),
      plan.rule?.values === "one" ? 1 : 0,
      memory.type,
      memory.statement,
      memory.basis.quote ?? null,
      based.source,
      based.version,
      based.writer,
      based.lineage,
      based.order,
      JSON.stringify(memory.speaker),
      memory.validFrom?.getTime() ?? null,
      memory.validUntil?.getTime() ?? null,
      into.learnedAt,
      into.readers,
      into.onlyFor
    )
    .one();
  indexMemoryWords(sql, row, memory.statement, into.memo);
  keepMentions(into, plan, row);
  return id;
};

/**
 * Marks version `version` of `source` fully extracted by the add `into`
 * writes (contract.ts `extracted`): every memory of an earlier version of
 * it ends then, for readers of the add and of that version (memories.ts).
 * Once per version and set of readers: a repeat changes nothing.
 */
const markExtracted = (
  sql: SqlStorage,
  { source, version }: { source: string; version: number },
  { learnedAt, readers, onlyFor }: Into
): void => {
  holdVersion(
    sql,
    source,
    version,
    "it marks extracted a version this store doesn't hold"
  );
  sql.exec(
    `INSERT OR IGNORE INTO memory_extractions
      (source, version, lineage, at, readers, only_for)
    VALUES (?, ?, ?, ?, ?, ?)`,
    source,
    version,
    lineageOfSource(source),
    learnedAt,
    readers,
    onlyFor
  );
};

/**
 * Adds `adding` (above), or answers what its change added before. Its
 * memories are readable by its `access` (and, resting on a version, by
 * that version's readers too: memories.ts).
 */
export const addMemories = async (
  { storage, db }: RememberStore,
  adding: Adding
): Promise<AddedMemories> => {
  const planned = planOf(adding);
  const { sql } = storage;
  const soFar = erasuresSoFar(sql);
  const key = await hashOf(encoder.encode(adding.change));
  const hash = await hashOf(
    encoder.encode(
      JSON.stringify([
        adding.access,
        adding.entities,
        adding.memories,
        adding.extracted ?? null,
      ])
    )
  );
  const onlyFor =
    adding.access.kind === "owner"
      ? await subjectOf(adding.access.person)
      : null;
  return storage.transactionSync(() => {
    const [before] = sql
      .exec<{ hash: string; answer: string }>(
        "SELECT hash, answer FROM memory_changes WHERE key = ?",
        key
      )
      .toArray();
    if (before !== undefined) {
      if (before.hash !== hash) {
        throw new Error(otherMemories);
      }
      return answerSchema.parse(JSON.parse(before.answer));
    }
    // An add for one person alone that began before their erasure, and
    // lands after it, may have been missed by it: refused, as a source's.
    if (onlyFor !== null && isPersonErasedSince(sql, onlyFor, soFar)) {
      throw new Error(erasedPerson);
    }
    // The set is stored (read sets match readers by it); memories name it
    // by its key alone, never its row id.
    readerSetOf(db, adding.access);
    const readers = readerSetKeyOf(adding.access);
    const rows = entityRowsOf(sql, adding, readers);
    const ids = rows.map(
      (row) =>
        sql
          .exec<{ id: string }>("SELECT id FROM entities WHERE row = ?", row)
          .one().id
    );
    const into: Into = {
      sql,
      entities: adding.entities,
      rows,
      ids,
      readers,
      learnedAt: Date.now(),
      onlyFor,
      memo: new Map(),
    };
    const memories = adding.memories.map((memory, index) =>
      writeMemory(into, memory, planned[index], index)
    );
    if (adding.extracted !== undefined) {
      markExtracted(sql, adding.extracted, into);
    }
    const answer: AddedMemories = {
      memories,
      entities: Object.fromEntries(
        adding.entities.map(({ key: entityKey }, index) => [
          entityKey,
          ids[index] ?? "",
        ])
      ),
    };
    sql.exec(
      "INSERT INTO memory_changes (key, hash, answer) VALUES (?, ?, ?)",
      key,
      hash,
      JSON.stringify(answer)
    );
    return answer;
  });
};
