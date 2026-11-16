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
// (entities.ts), never a name. Only an entity of kind `person`, every
// identifier of which is theirs, is theirs alone: every memory about it
// or relating to it is covered, so the entity goes with its names. Any
// other entity holding one of theirs (a team, a project or a customer
// whose contact address was theirs, a shared mailbox, a card two people
// were joined on) loses only that identifier: nothing else of it goes,
// so no one can take a team's or a project's knowledge with them by
// giving it their address. Every memory in their own word (its speaker is
// them) is covered too, whatever it is about. Covered memories are hidden
// at once (memories.ts `unerasedSql`, by `person_erasure_memories`) and
// deleted by the tick. A confirmation of theirs stands, its confirmer
// replaced by `erasedConfirmer`. Every export started before it is stale,
// if it changed anything (it holds what changed).
//
// What it closed stays closed (`person_erasure_subjects`, and the
// erasure's own record for the person), until the host says the address
// is verified again for a member (`reopenIdentifiers`): any add strips a
// closed identifier and writes the rest, answering as it would for an
// identifier it holds nowhere; extraction also leaves out an entity of
// kind `person` all of whose identifiers are closed, with what is about it
// or relates to it, and what is in their word, so nothing drawn again from
// a source that stays makes their card again; a restore of an export
// passes over what rests on their entities or is in their word, and
// keeps none of their identifiers.
//
// The store and the ledger keep a person and an identifier as SHA-256
// hashes, never plain: the person by their id (as the erasure's subject),
// an identifier as `identifier:<type>:<folded>`. An entity is closed by
// its id (`entity:<id>`), the store's own UUID, no one's personal data.

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

/** What a person's erasure closes an entity by: its id. */
export const entityClosureOf = (id: string): string => `entity:${id}`;

/** The person whose word `speaker` is, if an internal person's. */
const personOf = (speaker: Speaker): string | undefined =>
  speaker.kind === "internal" ? speaker.person : undefined;

/**
 * What a write names, as a person's erasure closes it, made before its
 * transaction: each entity's identifiers' subjects, in its order, and the
 * subject of the person whose word each memory is (null for anyone else).
 */
export interface Naming {
  identifiers: string[][];
  speakers: (string | null)[];
}

/** What `entities` and `speakers` name (`Naming`). */
export const namingOf = async (
  entities: readonly { identifiers?: readonly Identifier[] | undefined }[],
  speakers: readonly Speaker[]
): Promise<Naming> => ({
  identifiers: await Promise.all(
    entities.map(
      async ({ identifiers = [] }) =>
        await Promise.all(
          identifiers.map(
            async (identifier) => await identifierSubjectOf(identifier)
          )
        )
    )
  ),
  speakers: await Promise.all(
    speakers.map(async (speaker) => {
      const person = personOf(speaker);
      return person === undefined ? null : await personSubjectOf(person);
    })
  ),
});

/** Of `subjects`, those a person's erasure closed: one seek each. */
export const closedOf = (
  sql: SqlStorage,
  subjects: readonly string[]
): Set<string> =>
  subjects.length === 0
    ? new Set()
    : new Set(
        sql
          .exec<{ subject: string }>(
            `SELECT subject FROM person_erasure_subjects
            WHERE subject IN (SELECT value FROM json_each(?))`,
            JSON.stringify(subjects)
          )
          .toArray()
          .map(({ subject }) => subject)
      );

/** Whether a person's erasure took the person whose subject is `person`. */
export const isErasedPerson = (
  sql: SqlStorage,
  person: string | null | undefined
): boolean =>
  person !== null &&
  person !== undefined &&
  sql
    .exec(
      "SELECT 1 FROM erasures WHERE kind = 'person' AND subject = ? LIMIT 1",
      person
    )
    .toArray().length > 0;

/**
 * `entities` (`naming.identifiers` theirs, in order) as an add writes
 * them: every identifier a person's erasure closed stripped; and the keys
 * of those of kind `person` that held identifiers and only closed ones:
 * the erased person themselves, by exact evidence.
 */
export const strippedOf = <
  Entity extends {
    kind: string;
    key: string;
    identifiers?: readonly Identifier[] | undefined;
  },
>(
  sql: SqlStorage,
  entities: readonly Entity[],
  identifiers: readonly string[][]
): { entities: Entity[]; erased: Set<string> } => {
  const closed = closedOf(sql, identifiers.flat());
  const erased = new Set<string>();
  const stripped = entities.map((entity, index) => {
    const given = entity.identifiers ?? [];
    const subjects = identifiers[index] ?? [];
    const kept = given.filter(
      (_identifier, at) => !closed.has(subjects[at] ?? "")
    );
    if (entity.kind === "person" && given.length > 0 && kept.length === 0) {
      erased.add(entity.key);
    }
    return kept.length === given.length
      ? entity
      : { ...entity, identifiers: kept };
  });
  return { entities: stripped, erased };
};

/** An identifier as the store keeps it on a name (`entity_names`): its type and folded value. */
export type HeldIdentifier = readonly [type: string, folded: string];

/**
 * An entity holding one of a person's identifiers: theirs alone (kind
 * `person`, and no identifier but theirs), or one that only loses theirs.
 */
export interface HeldEntity {
  row: number;
  id: string;
  alone: boolean;
}

/** The entities holding one of `identifiers` (above), in one statement. */
export const entitiesHolding = (
  sql: SqlStorage,
  identifiers: readonly HeldIdentifier[]
): HeldEntity[] =>
  identifiers.length === 0
    ? []
    : sql
        .exec<{ row: number; id: string; alone: number }>(
          `SELECT DISTINCT entities.row AS row, entities.id AS id,
            entities.kind = 'person' AND NOT EXISTS (
              SELECT 1 FROM entity_names AS other
              WHERE other.entity = entities.row AND other.type <> 'name'
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(?1) AS given
                  WHERE given.value ->> 0 = other.type
                    AND given.value ->> 1 = other.folded
                )
            ) AS alone
          FROM json_each(?1) AS given
          CROSS JOIN entity_names
            ON entity_names.type = given.value ->> 0
            AND entity_names.folded = given.value ->> 1
          CROSS JOIN entities ON entities.row = entity_names.entity
          ORDER BY entities.row`,
          JSON.stringify(identifiers)
        )
        .toArray()
        .map(({ row, id, alone }) => ({ row, id, alone: alone === 1 }));

/** What a person's erasure applies to: as the host gave it, or as a replay found it. */
export interface PersonFound {
  /** The person's id as memories and confirmations hold it (none in a store that holds nothing of theirs). */
  people: string[];
  /** Their identifiers as names hold them. */
  identifiers: HeldIdentifier[];
  /** What the erasure closes besides their entities: its identifiers' subjects (and, from a ledger entry, the entities it closed). */
  subjects: string[];
}

/**
 * Applies a person's erasure `key` to what `found` names, in the caller's
 * transaction (above): what it closes recorded; on each entity of theirs
 * alone, every memory about it or relating to it hidden and the entity
 * closed; on any other entity, their identifiers' names deleted; the
 * memories in their word hidden; their confirmations' confirmer
 * replaced; and, when any of that changed something, every export started
 * before it made stale (exports.ts `namedSql`, by a row naming the
 * erasure's subject). Each statement seeks by an index: the names by
 * identifier, the memories by entity, by object and by the person whose
 * word they are, the confirmations by person. Answers how many rows it
 * changed; the same again changes none.
 */
export const applyPerson = (
  sql: SqlStorage,
  { key, subject }: { key: string; subject: string },
  { people, identifiers, subjects }: PersonFound
): number => {
  let changed = 0;
  const entities = entitiesHolding(sql, identifiers);
  for (const closed of [
    ...subjects,
    ...entities.flatMap(({ id, alone }) =>
      alone ? [entityClosureOf(id)] : []
    ),
  ]) {
    sql.exec(
      "INSERT OR IGNORE INTO person_erasure_subjects (subject, erasure) VALUES (?, ?)",
      closed,
      key
    );
  }
  const given = JSON.stringify(identifiers);
  for (const { row, alone } of entities) {
    changed += alone
      ? sql.exec(
          `INSERT OR IGNORE INTO person_erasure_memories (memory, erasure)
          SELECT row, ?2 FROM memories WHERE entity = ?1
          UNION SELECT row, ?2 FROM memories WHERE object = ?1`,
          row,
          key
        ).rowsWritten
      : sql.exec(
          `DELETE FROM entity_names
          WHERE entity = ?1 AND type <> 'name'
            AND EXISTS (
              SELECT 1 FROM json_each(?2) AS given
              WHERE given.value ->> 0 = entity_names.type
                AND given.value ->> 1 = entity_names.folded
            )`,
          row,
          given
        ).rowsWritten;
  }
  const theirs = JSON.stringify(people);
  changed += sql.exec(
    `INSERT OR IGNORE INTO person_erasure_memories (memory, erasure)
    SELECT row, ?2 FROM memories
    WHERE speaker ->> 'kind' = 'internal'
      AND speaker ->> 'person' IN (SELECT value FROM json_each(?1))`,
    theirs,
    key
  ).rowsWritten;
  changed += sql.exec(
    `UPDATE memory_confirmations SET person = ?2
    WHERE person IN (SELECT value FROM json_each(?1))`,
    theirs,
    erasedConfirmer
  ).rowsWritten;
  if (changed > 0) {
    sql.exec(
      `INSERT OR IGNORE INTO export_sources (export, subject, version, written)
      SELECT id, ?1, 0, 1 FROM exports`,
      subject
    );
  }
  return changed;
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
  return { people, identifiers, subjects: [...subjects] };
};
