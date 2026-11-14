import { z } from "zod";

import {
  attributeRuleOf,
  entityKinds,
  newMemorySchema,
  restoringNow,
} from "./contract.ts";
import type { CorrectedMemory, Reader, Speaker } from "./contract.ts";
import { hashOf } from "./files.ts";
import {
  confirmOver,
  currentOfAttributeSql,
  currentOneSql,
  lineageOfWriter,
  memoryRows,
  memoryTypeSchema,
  readMoment,
  stampWrite,
} from "./memories.ts";
import { readerSetKeyOf } from "./reader-sets.ts";
import { answerSchema, valueKeyFor } from "./remember.ts";
import { isRestoring } from "./restoring.ts";
import { indexMemoryWords } from "./words.ts";

// Correcting a memory (contract.ts `correctMemory`): a fix beside it, never
// a change to it. The fix is the corrector's word, filed under exactly the
// readers of the memory it corrects, so nobody reads it who couldn't read
// that memory, and everybody who could still can; and, as a person's own
// word, confirmed over what it corrects, so it is read first. Found by its id, current and readable
// to the reader, in the statement every read of memories uses
// (memories.ts), never by a list that a cap could cut.

const entityKindSchema = z.enum(entityKinds);

/** A correction as `correctMemory` takes it: the request, checked. */
interface Correcting {
  id: string;
  reader: Reader;
  writer: string;
  speaker: Speaker;
  value: string | undefined;
  statement: string;
}

/** A refusal of a correction: what rule it broke, never a value. */
const refusedCorrection = (why: string): Error =>
  new Error(`The Brain refused it: ${why}`);

/**
 * Whether every reader of the memory at `row`'s own readers may read it
 * now: it rests on no version, or on one whose readers, and its source's
 * current version's, are exactly its own (the same set's key). Only then
 * can a fix under its readers reach no one it is hidden from.
 */
const readersKeptSql = `SELECT m.readers AS readers, m.one_value AS one_value,
  about.kind AS kind,
  (m.source IS NULL OR EXISTS (
    SELECT 1 FROM source_versions AS based
    JOIN reader_sets AS based_set ON based_set.id = based.reader_set
    JOIN current_versions ON current_versions.source = based.source
    JOIN source_versions AS current ON current.row = current_versions.version_row
    JOIN reader_sets AS current_set ON current_set.id = current.reader_set
    WHERE based.source = m.source AND based.version = m.version
      AND based_set.key = m.readers AND current_set.key = m.readers
  )) AS kept
FROM memories AS m JOIN entities AS about ON about.row = m.entity
WHERE m.row = ?`;

/**
 * Corrects the memory `id`, current and readable to the reader (contract.ts
 * `correctMemory`): writes the fix in `writer`'s word, about its entity and
 * attribute, under exactly its readers, and confirms it in `writer`'s name
 * over the current memories of that attribute the reader may read that say
 * something else. The memory is found by its id alone, never in a list.
 * Answers the fix's id, or null (contract.ts). Run in one transaction: what
 * it reads and writes is one snapshot.
 */
const correctNow = (
  sql: SqlStorage,
  { id, reader, writer, speaker, value, statement }: Correcting
): string | null => {
  const at = readMoment(sql);
  const [target] = memoryRows(sql, currentOneSql, id, reader, at, 1);
  if (target === undefined || target.object !== null) {
    return null;
  }
  const [held] = sql
    .exec<{
      readers: string;
      one_value: number;
      kind: string;
      kept: number;
    }>(readersKeptSql, target.row)
    .toArray();
  if (held === undefined || held.kept !== 1) {
    return null;
  }
  const kind = entityKindSchema.parse(held.kind);
  const rule =
    target.attribute === null
      ? undefined
      : attributeRuleOf(kind, target.attribute);
  if (rule?.relation !== undefined) {
    return null;
  }
  if ((rule === undefined) !== (value === undefined)) {
    throw refusedCorrection(
      "a fix gives a value exactly when its memory's attribute holds one"
    );
  }
  const type = memoryTypeSchema.parse(target.type);
  // Held to an add's rules for a memory (contract.ts `newMemorySchema`),
  // and an instruction to its writer alone (`newMemoriesSchema`).
  const fix = newMemorySchema.safeParse({
    about: "about",
    ...(target.attribute === null ? {} : { attribute: target.attribute }),
    ...(value === undefined ? {} : { value }),
    type,
    statement,
    speaker,
    basis: { kind: "writer", writer },
  });
  const isInstruction =
    type === "instruction" || target.attribute === "instruction";
  if (
    !fix.success ||
    (isInstruction &&
      held.readers !== readerSetKeyOf({ kind: "owner", person: writer }))
  ) {
    throw refusedCorrection("the fix breaks a memory's rules");
  }
  const fixId = crypto.randomUUID();
  const valueKey = valueKeyFor(rule, value ?? null, null);
  const { row } = sql
    .exec<{ row: number }>(
      `INSERT INTO memories (id, entity, attribute, object, value, value_key,
        one_value, type, statement, quote, source, version, subject, writer,
        lineage, lineage_order, speaker, valid_from, valid_until, learned_at,
        readers)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0, ?,
        NULL, NULL, ?, ?)
      RETURNING row`,
      fixId,
      target.entity_row,
      target.attribute,
      value ?? null,
      valueKey,
      held.one_value,
      type,
      statement,
      writer,
      lineageOfWriter(writer),
      JSON.stringify(speaker),
      stampWrite(sql),
      held.readers
    )
    .one();
  indexMemoryWords(sql, row, statement, new Map());
  // Confirmed only as a person's own word: a correction is how a person
  // confirms a memory. Another writer's fix (an App's, a workflow's)
  // stands beside what it corrects, the two contested, for a person to
  // confirm one. Confirmed over what the reader may read of the attribute
  // that says something else now: the memory corrected among them, unless
  // the fix says the same. Under no attribute, over the memory alone.
  if (speaker.kind !== "internal" || speaker.person !== writer) {
    return fixId;
  }
  const over =
    target.attribute === null
      ? [target]
      : memoryRows(
          sql,
          currentOfAttributeSql,
          target.entity_row,
          reader,
          readMoment(sql),
          -1,
          target.attribute
        ).filter(
          (memory) => memory.row !== row && memory.value_key !== valueKey
        );
  confirmOver(sql, row, writer, over);
  return fixId;
};

/**
 * The fix `fix` as a correction answers it: its id, and when the store
 * learned it, the same on every repeat of its change. Null for one no
 * longer held (an erasure took it since).
 */
const correctedOf = (sql: SqlStorage, fix: string): CorrectedMemory | null => {
  const [held] = sql
    .exec<{ learned_at: number }>(
      "SELECT learned_at FROM memories WHERE id = ?",
      fix
    )
    .toArray();
  return held === undefined
    ? null
    : { memory: fix, learnedAt: new Date(held.learned_at) };
};

const encoder = new TextEncoder();

/**
 * Corrects (`correctNow`) under the change `change`, or answers the fix
 * that change made before: the same change with another correction is
 * refused. A change kept with corrections is its own (`correct:`), so it
 * never answers an add's. One that corrected nothing records nothing, so
 * a retry of it is judged afresh.
 */
export const correctMemory = async (
  storage: DurableObjectStorage,
  { change, ...correcting }: Correcting & { change: string }
): Promise<CorrectedMemory | null> => {
  const key = await hashOf(encoder.encode(`correct:${change}`));
  const { reader: _reader, ...asked } = correcting;
  const hash = await hashOf(encoder.encode(JSON.stringify(asked)));
  const { sql } = storage;
  return storage.transactionSync(() => {
    // Nothing is written while a restore runs (restoring.ts), as an add.
    if (isRestoring(sql)) {
      throw new Error(restoringNow);
    }
    const [before] = sql
      .exec<{ hash: string; answer: string }>(
        "SELECT hash, answer FROM memory_changes WHERE key = ?",
        key
      )
      .toArray();
    if (before !== undefined) {
      if (before.hash !== hash) {
        throw refusedCorrection(
          "this change was made before as another correction"
        );
      }
      const [made] = answerSchema.parse(JSON.parse(before.answer)).memories;
      return made === undefined ? null : correctedOf(sql, made);
    }
    const fix = correctNow(sql, correcting);
    if (fix === null) {
      return null;
    }
    sql.exec(
      "INSERT INTO memory_changes (key, hash, answer) VALUES (?, ?, ?)",
      key,
      hash,
      JSON.stringify({ memories: [fix], entities: {} })
    );
    return correctedOf(sql, fix);
  });
};
