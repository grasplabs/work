import type { Identifier, Speaker } from "./contract.ts";
import { erasedConfirmer } from "./contract.ts";
import { foldIdentifier } from "./entities.ts";
import { hashOf } from "./files.ts";

// A person's erasure in the shared store (contract.ts
// `erasePersonShared`; erasure.ts runs it through the ledger): erasing a
// person removes what the Brain derived about them and what is in their
// own word, and keeps the company's sources, even where their text names
// them. That is how the plan's "removes their personal content
// everywhere" reads for the shared store (decided 16 November, GRA-1747).
// A person's own store is erased whole instead (erasure.ts).
//
// Which entity is theirs is decided on exact evidence alone: an
// identifier the host verified as theirs, which a memory gave the entity
// (entities.ts), never a name. An entity every identifier of which is
// theirs is theirs alone: every memory about it or relating to it is
// covered, so the entity goes with its names. One that also holds another
// identifier (a shared mailbox, a card two people were joined on) keeps
// all but the memories that gave one of theirs: the strictest that takes
// nothing of anyone else's. Every memory in their own word (its speaker
// is them) is covered too, whatever it is about. Covered memories are
// hidden at once (memories.ts `unerasedSql`, by `person_erasure_memories`)
// and deleted by the tick. A confirmation of theirs stands, its confirmer
// replaced by `erasedConfirmer`. Every export started before it is stale.
//
// What it closed stays closed (`person_erasure_subjects`, and the
// erasure's own record for the person): an add naming one of their
// identifiers or entities, or in their word, is refused, and extraction
// and a restore leave out what names one, so nothing drawn again from a
// source that stays makes their card again.
//
// The store and the ledger keep these as SHA-256 hashes, never plain: the
// person by their id (as the erasure's subject), an identifier as
// `identifier:<type>:<folded>`, an entity as `entity:<id>`.

const encoder = new TextEncoder();

const subjectOfText = async (text: string): Promise<string> =>
  await hashOf(encoder.encode(text));

/** The ledger's name for a person: the SHA-256 of their id. */
export const personSubjectOf = async (person: string): Promise<string> =>
  await subjectOfText(person);

/** The SHA-256 a person's erasure closes an identifier by. */
export const identifierSubjectOf = async (
  identifier: Identifier
): Promise<string> =>
  await subjectOfText(
    `identifier:${identifier.type}:${foldIdentifier(identifier)}`
  );

/** The SHA-256 a person's erasure closes an entity by. */
export const entitySubjectOf = async (id: string): Promise<string> =>
  await subjectOfText(`entity:${id}`);

/** The person whose word `speaker` is, if an internal person's. */
const personOf = (speaker: Speaker): string | undefined =>
  speaker.kind === "internal" ? speaker.person : undefined;

/** What a write is checked against what erasures closed (`isClosed`). */
export interface Naming {
  /** SHA-256 of identifiers and entity ids (`identifierSubjectOf`, `entitySubjectOf`). */
  subjects: string[];
  /** SHA-256 of the people whose word it is (`personSubjectOf`). */
  people: string[];
}

/** What `entities` and `speakers` name, hashed, for `isClosed`. */
export const namingOf = async (
  entities: readonly { id?: string; identifiers: readonly Identifier[] }[],
  speakers: readonly Speaker[]
): Promise<Naming> => ({
  subjects: await Promise.all([
    ...entities.flatMap(({ identifiers }) =>
      identifiers.map(
        async (identifier) => await identifierSubjectOf(identifier)
      )
    ),
    ...entities.flatMap(({ id }) =>
      id === undefined ? [] : [entitySubjectOf(id)]
    ),
  ]),
  people: await Promise.all(
    speakers.flatMap((speaker) => {
      const person = personOf(speaker);
      return person === undefined ? [] : [personSubjectOf(person)];
    })
  ),
});

/** Whether a person's erasure closed anything `naming` names: one or two seeks each. */
export const isClosed = (
  sql: SqlStorage,
  { subjects, people }: Naming
): boolean =>
  (subjects.length > 0 || people.length > 0) &&
  sql
    .exec(
      `SELECT 1 FROM person_erasure_subjects
      WHERE subject IN (SELECT value FROM json_each(?1))
      UNION ALL SELECT 1 FROM erasures
      WHERE kind = 'person' AND subject IN (SELECT value FROM json_each(?2))
      LIMIT 1`,
      JSON.stringify(subjects),
      JSON.stringify(people)
    )
    .toArray().length > 0;

/** An identifier as the store keeps it on a name (`entity_names`): its type and folded value. */
export type HeldIdentifier = readonly [type: string, folded: string];

/** An entity a person's erasure takes: theirs alone, or also holding another identifier (`shared`). */
export interface HeldEntity {
  row: number;
  id: string;
  shared: boolean;
}

/**
 * The entities holding one of `identifiers` (above), in one statement:
 * each with its id, and whether it holds another identifier too.
 */
export const entitiesHolding = (
  sql: SqlStorage,
  identifiers: readonly HeldIdentifier[]
): HeldEntity[] =>
  identifiers.length === 0
    ? []
    : sql
        .exec<{ row: number; id: string; shared: number }>(
          `SELECT DISTINCT entities.row AS row, entities.id AS id,
            EXISTS (
              SELECT 1 FROM entity_names AS other
              WHERE other.entity = entities.row AND other.type <> 'name'
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(?1) AS given
                  WHERE given.value ->> 0 = other.type
                    AND given.value ->> 1 = other.folded
                )
            ) AS shared
          FROM json_each(?1) AS given
          CROSS JOIN entity_names
            ON entity_names.type = given.value ->> 0
            AND entity_names.folded = given.value ->> 1
          CROSS JOIN entities ON entities.row = entity_names.entity
          ORDER BY entities.row`,
          JSON.stringify(identifiers)
        )
        .toArray()
        .map(({ row, id, shared }) => ({ row, id, shared: shared === 1 }));

/** Whether two finds of `entitiesHolding` are the same. */
export const sameEntities = (
  one: readonly HeldEntity[],
  other: readonly HeldEntity[]
): boolean => JSON.stringify(one) === JSON.stringify(other);

/** What a person's erasure applies: found in the store, or given by the host. */
export interface PersonFound {
  /** The person's ids as memories and confirmations hold them (one, or none in a store that holds nothing of theirs). */
  people: string[];
  /** Their identifiers as names hold them. */
  identifiers: HeldIdentifier[];
  /** The entities holding one (`entitiesHolding`), as found before the transaction. */
  entities: HeldEntity[];
  /** What the erasure closes: its identifiers' and its entities' subjects. */
  subjects: string[];
}

/**
 * Applies a person's erasure `key` to what `found` names, in the caller's
 * transaction (above): what it closed recorded, the memories it covers
 * hidden, their confirmations' confirmer replaced, and every export
 * started before it made stale (exports.ts `namedSql`, by a row naming
 * the erasure's subject). Safe to repeat.
 */
export const applyPerson = (
  sql: SqlStorage,
  { key, subject }: { key: string; subject: string },
  { people, identifiers, entities, subjects }: PersonFound
): void => {
  for (const closed of subjects) {
    sql.exec(
      "INSERT OR IGNORE INTO person_erasure_subjects (subject, erasure) VALUES (?, ?)",
      closed,
      key
    );
  }
  const given = JSON.stringify(identifiers);
  for (const { row, shared } of entities) {
    if (shared) {
      sql.exec(
        `INSERT OR IGNORE INTO person_erasure_memories (memory, erasure)
        SELECT DISTINCT entity_names.memory, ?2 FROM json_each(?3) AS given
        CROSS JOIN entity_names
          ON entity_names.entity = ?1
          AND entity_names.type = given.value ->> 0
          AND entity_names.folded = given.value ->> 1`,
        row,
        key,
        given
      );
    } else {
      sql.exec(
        `INSERT OR IGNORE INTO person_erasure_memories (memory, erasure)
        SELECT row, ?2 FROM memories WHERE entity = ?1
        UNION SELECT row, ?2 FROM memories WHERE object = ?1`,
        row,
        key
      );
    }
  }
  const theirs = JSON.stringify(people);
  // Every memory in their word: one scan of the memories, once.
  sql.exec(
    `INSERT OR IGNORE INTO person_erasure_memories (memory, erasure)
    SELECT row, ?2 FROM memories
    WHERE speaker ->> 'kind' = 'internal'
      AND speaker ->> 'person' IN (SELECT value FROM json_each(?1))`,
    theirs,
    key
  );
  sql.exec(
    `UPDATE memory_confirmations SET person = ?2
    WHERE person IN (SELECT value FROM json_each(?1))`,
    theirs,
    erasedConfirmer
  );
  sql.exec(
    `INSERT OR IGNORE INTO export_sources (export, subject, version, written)
    SELECT id, ?1, 0, 1 FROM exports`,
    subject
  );
};

/**
 * What a replay of the ledger entry naming `subject` (a person) and
 * closing `subjects` applies to this copy of the store: their ids and
 * identifiers as it holds them, found by hashing the candidates (each
 * person a memory is in the word of or a confirmation names, each
 * identifier a name holds), as the entry keeps no plain value. Run while
 * the store takes nothing else (a replay), so nothing lands in between.
 */
export const foundForReplay = async (
  sql: SqlStorage,
  subject: string,
  subjects: readonly string[]
): Promise<PersonFound> => {
  const closed = new Set(subjects);
  const candidates = sql
    .exec<{ person: string }>(
      `SELECT DISTINCT speaker ->> 'person' AS person FROM memories
      WHERE speaker ->> 'kind' = 'internal'
      UNION SELECT DISTINCT person FROM memory_confirmations`
    )
    .toArray();
  const people: string[] = [];
  for (const { person } of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- one hash at a time
    if ((await personSubjectOf(person)) === subject) {
      people.push(person);
    }
  }
  const named = sql
    .exec<{ type: "email" | "ref"; folded: string }>(
      "SELECT DISTINCT type, folded FROM entity_names WHERE type <> 'name'"
    )
    .toArray();
  const identifiers: HeldIdentifier[] = [];
  for (const { type, folded } of named) {
    // oxlint-disable-next-line no-await-in-loop -- one hash at a time
    if (closed.has(await identifierSubjectOf({ type, value: folded }))) {
      identifiers.push([type, folded]);
    }
  }
  return {
    people,
    identifiers,
    entities: entitiesHolding(sql, identifiers),
    subjects: [...subjects],
  };
};
