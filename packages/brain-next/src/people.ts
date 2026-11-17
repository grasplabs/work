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
// (entities.ts), never a name. An entity of kind `person` holding one is
// their card, whole, whatever else it holds (another address of theirs, a
// reference, or, on a card two people were wrongly joined on, the other
// one's address: their card comes back only from a new version of a
// source naming them without her address): every memory about
// it or relating to it is covered, so it goes with its names. Any other
// entity holding one (a team, a project or a customer whose contact
// address was theirs, a shared desk) loses only that identifier: nothing
// else of it goes, so no one can take a team's or a project's knowledge
// with them by giving it their address. Every memory in their own word
// (its speaker is them) is covered too, whatever it is about. Covered
// memories are hidden at once (memories.ts `unerasedSql`, by
// `person_erasure_memories`) and deleted by the tick. A confirmation of
// theirs stands, its confirmer replaced by `erasedConfirmer`. Every export
// started before it is stale, if it changed anything (it holds what
// changed).
//
// What it closed stays closed, for good (`person_erasure_subjects`, and
// the erasure's own record for the person): an admin releasing the
// address in core doesn't reopen it here. A write leaves a closed
// identifier out and writes the rest, answering as it would for an
// identifier it holds nowhere. What is drawn from a source (extraction, a
// write resting on a version, a restore of one) also leaves out an entity
// of kind `person` holding a closed identifier, with what is about it or
// relates to it, and what is in their word, so nothing drawn again from a
// source that stays makes their card again (by a name it may).
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

/** The text a person's erasure hashes an identifier from. */
const identifierTextOf = (identifier: Identifier): string =>
  `identifier:${identifier.type}:${foldIdentifier(identifier)}`;

/** The SHA-256 a person's erasure closes an identifier by. */
export const identifierSubjectOf = async (
  identifier: Identifier
): Promise<string> => await subjectOfText(identifierTextOf(identifier));

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
            WHERE subject IN (SELECT value FROM json_each(?1))`,
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
 * `entities` (`identifiers` theirs, in order) as a write keeps them: every
 * identifier a person's erasure closed stripped; and the keys of those of
 * kind `person` that held one: the erased person's card, by exact
 * evidence, which what is drawn from a source leaves out whole
 * (`leavingOutCards`).
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
    if (entity.kind === "person" && kept.length < given.length) {
      erased.add(entity.key);
    }
    return kept.length === given.length
      ? entity
      : { ...entity, identifiers: kept };
  });
  return { entities: stripped, erased };
};

/**
 * What is drawn from a source (`entities` and `memories`, `identifiers`
 * the entities' in order) as a person's erasure leaves it: every closed
 * identifier stripped (`strippedOf`); an entity of kind `person` that held
 * one is the erased person's card, left out with every memory about it or
 * relating to it; an entity no memory left names is left out too. So
 * nothing drawn again from a source that stays makes or feeds their card.
 */
export const leavingOutCards = <
  Entity extends {
    kind: string;
    key: string;
    identifiers?: readonly Identifier[] | undefined;
  },
  Memory extends { about: string; object?: string | undefined },
>(
  sql: SqlStorage,
  {
    entities,
    memories,
  }: { entities: readonly Entity[]; memories: readonly Memory[] },
  identifiers: readonly string[][]
): { entities: Entity[]; memories: Memory[] } => {
  const stripped = strippedOf(sql, entities, identifiers);
  const kept = memories.filter(
    ({ about, object }) =>
      !(
        stripped.erased.has(about) ||
        (object !== undefined && stripped.erased.has(object))
      )
  );
  const named = new Set(
    kept.flatMap(({ about, object }) =>
      object === undefined ? [about] : [about, object]
    )
  );
  return {
    entities: stripped.entities.filter(({ key }) => named.has(key)),
    memories: kept,
  };
};

/** An identifier as the store keeps it on a name (`entity_names`): its type and folded value. */
export type HeldIdentifier = readonly [type: string, folded: string];

/**
 * An entity holding one of a person's identifiers: their card (kind
 * `person`), taken whole, or anyone else's, which only loses theirs.
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
            entities.kind = 'person' AS alone
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
 * alone (holding one of their identifiers, or closed by its id), every
 * memory about it or relating to it hidden and the entity closed; on any other entity, their identifiers' names deleted; the
 * memories in their word hidden; a confirmation made over a memory it
 * hides kept over the rest; their confirmations' confirmer replaced; and, when any of that changed something, every export started
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
  const holding = entitiesHolding(sql, identifiers);
  // And each card the erasure closed by its id (a ledger entry's): in a
  // copy of the store from before her address reached it, it holds none.
  // An id is the store's own UUID, so it names that card and no other.
  const byId = sql
    .exec<{ row: number; id: string }>(
      `SELECT row, id FROM entities
      WHERE id IN (SELECT substr(value, 8) FROM json_each(?1)
        WHERE value LIKE 'entity:%')`,
      JSON.stringify(subjects)
    )
    .toArray()
    .filter(({ row }) => !holding.some((entity) => entity.row === row))
    .map(({ row, id }) => ({ row, id, alone: true }));
  const entities = [...holding, ...byId];
  for (const closed of [
    ...subjects,
    ...entities.flatMap(({ id, alone }) =>
      alone ? [entityClosureOf(id)] : []
    ),
  ]) {
    // Kept by the first erasure that closed it.
    sql.exec(
      `INSERT OR IGNORE INTO person_erasure_subjects (subject, erasure)
      VALUES (?1, ?2)`,
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
  // A confirmation made over a memory it hides stands over the rest: the
  // memory it overruled goes, the confirmed one stays confirmed (the
  // tick's delete would take every confirmation made over what it
  // deletes).
  changed += sql.exec(
    `DELETE FROM memory_confirmed_over
    WHERE memory IN (
      SELECT memory FROM person_erasure_memories WHERE erasure = ?1
    )`,
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
 * Most hashes one step of a replay makes for its person entries
 * (`foundForReplay`), where the clock can't bound it: it moves only on
 * I/O. A step holds every call while it runs, so its hashing is kept to
 * a small share of the step's 10 s (erasure.ts `replayStepMs`), as a page
 * of the ledger is. Measured in workerd: about 3 µs a candidate with its
 * rows read (111 ms for 40,000), so this many take about 0.15 s. A replay
 * past it goes on in the next step from the hashes made.
 */
export const replayHashesPerStep = 50_000;

/**
 * How a replay hashes for `foundForReplay`: each text's SHA-256 made so
 * far in this replay, kept for its next steps (`hashed`), and `due`,
 * which counts each new one and throws once the step made its share.
 */
export interface ReplayHashing {
  hashed: Map<string, string>;
  due: () => void;
}

/**
 * What a replay of the ledger entry naming `subject` (a person) and
 * closing `subjects` applies to this copy of the store: their ids and
 * identifiers as it holds them, found by hashing the candidates (each
 * person a memory is in the word of or a confirmation names, each
 * identifier a name holds), as the entry keeps no plain value. Run while
 * the store takes nothing else (a replay), so nothing lands in between.
 * Each hash is made once in a replay (`hashed`); before each new one
 * `due` may stop the step (`replayHashesPerStep`), and the next step goes
 * on from what it made.
 */
export const foundForReplay = async (
  sql: SqlStorage,
  subject: string,
  subjects: readonly string[],
  { hashed, due }: ReplayHashing
): Promise<PersonFound> => {
  const hashOfText = async (text: string): Promise<string> => {
    const known = hashed.get(text);
    if (known !== undefined) {
      return known;
    }
    due();
    const made = await subjectOfText(text);
    hashed.set(text, made);
    return made;
  };
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
    if ((await hashOfText(person)) === subject) {
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
    const text = identifierTextOf({ type, value: folded });
    // oxlint-disable-next-line no-await-in-loop -- one hash at a time
    if (closed.has(await hashOfText(text))) {
      identifiers.push([type, folded]);
    }
  }
  return { people, identifiers, subjects: [...subjects] };
};
