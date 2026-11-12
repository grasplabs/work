import type {
  Entity,
  EntityId,
  EntityKind,
  MemoryChangeOutcome,
  Proposal,
  Reader,
} from "./contract.ts";
import {
  asSeen,
  coveredSql,
  foldIdentifier,
  foldName,
  mentionedSql,
} from "./entities.ts";
import { familyOf, joinedSql, standingOf } from "./joins.ts";
import { entityRowOf, visibleSql } from "./memories.ts";
import { readableSql } from "./reader-sets.ts";

// Linking entities (contract.ts "Cards, proposals and the member link").
//
// An add links an entity on exact evidence: its known id or an exact
// identifier (remember.ts), or an exact name (`linkedByName`) only where
// one entity of its kind alone holds that name through memories read by
// exactly the add's readers (entities.ts `coveredSql`), so no link is
// decided on what other readers hold. Short of that, a likely match is a proposal (`proposeFor`): the
// same name held by another entity, or one name whose words are all
// among the other's, whole. A proposal names the two memories that gave
// the names that matched, and is seen and decided only by a reader who
// may read both: so it shows them no name they can't read, and a
// proposal they can't see answers as one never made. Accepting one is
// a person's act, recorded with who and when; the two entities then
// read as one (the base's aliases), and nothing is written over.
//
// The member link (`member_entities`) is written by `linkMember` alone,
// for a sign-in the host verified: no add, extraction, proposal or merge
// writes or moves it, so finding a name or an email in a document never
// makes one. It grants nothing: who may read is the host's to say.

/** Most proposals one new entity's names make. */
export const proposalsPerEntityMax = 20;

/** Runs of white space. */
const spaces = /\s+/u;

/** The words of a folded name. */
const wordsOf = (folded: string): string[] =>
  folded.split(spaces).filter((word) => word.length > 0);

/**
 * Whether two folded names are a likely match: the same, or every word
 * of the shorter is a word of the longer.
 */
const likelyMatch = (a: string, b: string): boolean => {
  if (a === b) {
    return true;
  }
  const [shorter, longer] =
    wordsOf(a).length <= wordsOf(b).length
      ? [wordsOf(a), new Set(wordsOf(b))]
      : [wordsOf(b), new Set(wordsOf(a))];
  return shorter.length > 0 && shorter.every((word) => longer.has(word));
};

/**
 * The entity of `kind` an add's entity links to by an exact name, given
 * no identifier: the one entity of that kind (as it stands: merges read
 * as one) holding one of `names` through a memory read by exactly the
 * add's set of readers (`readerSet`), or none when none or several do.
 */
export const linkedByName = (
  sql: SqlStorage,
  kind: EntityKind,
  names: readonly string[],
  readerSet: number
): number | undefined => {
  if (names.length === 0) {
    return undefined;
  }
  const found = sql
    .exec<{ entity: number }>(
      `SELECT DISTINCT stands.row AS entity
      FROM json_each(?2) AS asked
      JOIN entity_names
        ON entity_names.type = 'name' AND entity_names.folded = asked.value
      JOIN memories AS m ON m.row = entity_names.memory
      JOIN entities AS stands ON stands.row = entity_names.entity
      WHERE stands.kind = ?1 AND ${coveredSql("m")}
      LIMIT 2`,
      kind,
      JSON.stringify(names.map((name) => foldName(name))),
      readerSet
    )
    .toArray();
  return found.length === 1 ? found[0]?.entity : undefined;
};

/**
 * Proposals for the entity at `entity`, new in an add: each other entity
 * of its kind holding a name that likely matches one of its own (above),
 * through any memory, at most `proposalsPerEntityMax`, none for a pair
 * already proposed. Run in the add's transaction, after its names are
 * kept.
 */
export const proposeFor = (sql: SqlStorage, entity: number): void => {
  const own = sql
    .exec<{ memory: number; value: string; folded: string; kind: string }>(
      `SELECT entity_names.memory AS memory, entity_names.value AS value,
        entity_names.folded AS folded, entities.kind AS kind
      FROM entity_names JOIN entities ON entities.row = entity_names.entity
      WHERE entity_names.entity = ? AND entity_names.type = 'name'
      ORDER BY entity_names.memory`,
      entity
    )
    .toArray();
  const proposed = new Set<number>();
  for (const name of own) {
    if (proposed.size >= proposalsPerEntityMax) {
      return;
    }
    const candidates = sql
      .exec<{ entity: number; memory: number; value: string; folded: string }>(
        `SELECT stands.row AS entity, min(entity_names.memory) AS memory,
          entity_names.value AS value, entity_names.folded AS folded
        FROM entity_names
        JOIN entities AS stands ON stands.row = entity_names.entity
        WHERE stands.kind = ?1 AND entity_names.type = 'name'
          AND stands.row != ?2
          AND EXISTS (SELECT 1 FROM json_each(?3) AS word
            WHERE instr(' ' || entity_names.folded || ' ', ' ' || word.value || ' ') > 0)
          AND NOT EXISTS (SELECT 1 FROM entity_proposals AS p
            WHERE (p.entity = ?2 AND p.candidate = stands.row)
              OR (p.entity = stands.row AND p.candidate = ?2))
        GROUP BY stands.row, entity_names.folded
        ORDER BY stands.row
        LIMIT 200`,
        name.kind,
        entity,
        JSON.stringify(wordsOf(name.folded))
      )
      .toArray();
    for (const candidate of candidates) {
      if (
        proposed.size >= proposalsPerEntityMax ||
        proposed.has(candidate.entity) ||
        !likelyMatch(name.folded, candidate.folded)
      ) {
        continue;
      }
      proposed.add(candidate.entity);
      sql.exec(
        `INSERT INTO entity_proposals (id, entity, candidate, memory,
          candidate_memory, name, candidate_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        entity,
        candidate.entity,
        name.memory,
        candidate.memory,
        name.value,
        candidate.value
      );
    }
  }
};

/**
 * `?1` the entity's row or null, `?4` the proposal's id or null, `?5` the
 * most: the open proposals whose two memories the reader may read, of
 * two entities that don't yet stand as one, each as it stands, the
 * earliest first.
 */
const proposalsSql = `
WITH ${readableSql},
open AS (
  SELECT p.row AS row, p.id AS id, ${joinedSql("p.entity")} AS entity,
    ${joinedSql("p.candidate")} AS candidate, p.name AS name,
    p.candidate_name AS candidate_name, p.memory AS memory,
    p.candidate_memory AS candidate_memory
  FROM entity_proposals AS p
  WHERE (?4 IS NULL OR p.id = ?4)
    AND NOT EXISTS (SELECT 1 FROM entity_proposal_decisions AS decided
      WHERE decided.proposal = p.row
        AND decided.reader_set IN (SELECT reader_set FROM readable))
)
SELECT p.row AS row, p.id AS id, p.entity AS entity, p.candidate AS candidate,
  p.name AS name, p.candidate_name AS candidate_name
FROM open AS p
JOIN memories AS m ON m.row = p.memory
JOIN memories AS c ON c.row = p.candidate_memory
WHERE p.entity != p.candidate
  AND (?1 IS NULL OR p.entity = ?1 OR p.candidate = ?1)
  AND ${visibleSql("m")} AND ${visibleSql("c")}
ORDER BY p.row
LIMIT ?5`;

/** A proposal as `proposalsSql` returns it. */
interface ProposalRow extends Record<string, SqlStorageValue> {
  row: number;
  id: string;
  entity: number;
  candidate: number;
  name: string;
  candidate_name: string;
}

/** Runs `proposalsSql` as `reader`. */
const proposalRows = (
  sql: SqlStorage,
  reader: Reader,
  {
    entity,
    id,
    limit,
  }: { entity: number | null; id: string | null; limit: number }
): ProposalRow[] =>
  sql
    .exec<ProposalRow>(
      proposalsSql,
      entity,
      reader.person,
      JSON.stringify(reader.groups),
      id,
      limit
    )
    .toArray();

/** The open proposals the reader may see (contract.ts `listProposals`). */
export const listProposals = (
  sql: SqlStorage,
  {
    reader,
    entity,
    limit,
  }: { reader: Reader; entity?: EntityId; limit: number }
): Proposal[] => {
  let entityRow: number | null = null;
  if (entity !== undefined) {
    const found = entityRowOf(sql, entity);
    if (found === undefined) {
      return [];
    }
    entityRow =
      standingOf(sql, reader, [found.row]).get(found.row) ?? found.row;
  }
  const rows = proposalRows(sql, reader, {
    entity: entityRow,
    id: null,
    limit,
  });
  const held = sql
    .exec<{ row: number; id: string; kind: string }>(
      "SELECT row, id, kind FROM entities WHERE row IN (SELECT value FROM json_each(?))",
      JSON.stringify([
        ...new Set(rows.flatMap((row) => [row.entity, row.candidate])),
      ])
    )
    .toArray();
  const seen = new Map(asSeen(sql, held, reader).map((one) => [one.id, one]));
  const entities = new Map<number, Entity>();
  for (const { row, id: entityId } of held) {
    const one = seen.get(entityId);
    if (one !== undefined) {
      entities.set(row, one);
    }
  }
  return rows.flatMap((row) => {
    const one = entities.get(row.entity);
    const other = entities.get(row.candidate);
    return one === undefined || other === undefined
      ? []
      : [
          {
            id: row.id,
            entity: one,
            candidate: other,
            name: row.name,
            candidateName: row.candidate_name,
          },
        ];
  });
};

/** Who a join is for: the accepting person's own set of readers, and their hash. */
export interface JoinedFor {
  readerSet: number;
  onlyFor: string;
}

/**
 * Makes the entity at `from` read as the one at `into` (each as it
 * stands for the person) for `joinedFor`'s readers alone, and those
 * joined into `from` for them now into `into`: no join of theirs points
 * at one joined itself. No memory changes.
 */
const joinInto = (
  sql: SqlStorage,
  { from, into, at }: { from: number; into: number; at: number },
  { readerSet, onlyFor }: JoinedFor
): void => {
  sql.exec(
    "UPDATE entity_joins SET into_entity = ? WHERE into_entity = ? AND reader_set = ?",
    into,
    from,
    readerSet
  );
  sql.exec(
    `INSERT INTO entity_joins (merged, into_entity, reader_set, only_for, at)
    VALUES (?, ?, ?, ?, ?)`,
    from,
    into,
    readerSet,
    onlyFor,
    at
  );
};

/** Whether the entity standing at `row` for `reader`, or one joined into it, has a member link. */
const isMemberEntity = (
  sql: SqlStorage,
  reader: Reader,
  row: number
): boolean =>
  sql
    .exec(
      "SELECT 1 FROM member_entities WHERE entity IN (SELECT value FROM json_each(?))",
      JSON.stringify(familyOf(sql, reader, row))
    )
    .toArray().length > 0;

/**
 * The reader accepts or declines the proposal `id` for themselves
 * (contract.ts `decideProposal`): one they may see that they haven't
 * decided. Accepted, the newer entity reads as the candidate for them
 * alone (`joinInto`, `joinedFor`: their own set of readers), unless only
 * the newer has a member link: then the candidate reads as it, so a
 * member link never moves; two member links are two people, and are
 * never joined. Run in one transaction.
 */
export const decideProposal = (
  sql: SqlStorage,
  {
    id,
    reader,
    accept,
    at,
  }: { id: string; reader: Reader; accept: boolean; at: number },
  joinedFor: JoinedFor
): MemoryChangeOutcome => {
  const [proposal] = proposalRows(sql, reader, { entity: null, id, limit: 1 });
  if (proposal === undefined) {
    return "nothing";
  }
  if (accept) {
    const entityLinked = isMemberEntity(sql, reader, proposal.entity);
    const candidateLinked = isMemberEntity(sql, reader, proposal.candidate);
    if (entityLinked && candidateLinked) {
      return "nothing";
    }
    joinInto(
      sql,
      entityLinked
        ? { from: proposal.candidate, into: proposal.entity, at }
        : { from: proposal.entity, into: proposal.candidate, at },
      joinedFor
    );
  }
  sql.exec(
    `INSERT INTO entity_proposal_decisions (proposal, reader_set, only_for, accepted, at)
    VALUES (?, ?, ?, ?, ?)`,
    proposal.row,
    joinedFor.readerSet,
    joinedFor.onlyFor,
    accept ? 1 : 0,
    at
  );
  return "done";
};
/**
 * Links `member` to their person entity at a verified sign-in, once: the
 * first person entity holding `email` as an identifier, or a new one with
 * no memory (seen by nobody until a memory names it). A member linked
 * already keeps their link. Run in one transaction.
 */
export const linkMember = (
  sql: SqlStorage,
  {
    member,
    subject,
    email,
    at,
  }: { member: string; subject: string; email: string; at: number }
): void => {
  const folded = foldIdentifier({ type: "email", value: email });
  const known = sql
    .exec("SELECT 1 FROM member_entities WHERE member = ?", member)
    .toArray();
  if (known.length > 0) {
    return;
  }
  const [held] = sql
    .exec<{ entity: number }>(
      `SELECT min(stands.row) AS entity FROM entity_names
      JOIN entities AS stands
        ON stands.row = entity_names.entity
        AND stands.kind = 'person'
      WHERE entity_names.type = 'email' AND entity_names.folded = ?
        AND stands.row NOT IN (SELECT entity FROM member_entities)`,
      folded
    )
    .toArray();
  const entity =
    held?.entity ??
    sql
      .exec<{ row: number }>(
        "INSERT INTO entities (id, kind) VALUES (?, 'person') RETURNING row",
        crypto.randomUUID()
      )
      .one().row;
  sql.exec(
    `INSERT INTO member_entities (member, subject, entity, email, linked_at)
    VALUES (?, ?, ?, ?, ?)`,
    member,
    subject,
    entity,
    folded,
    at
  );
};

/** `?1` the member: their entity, if a memory the reader may read mentions it. */
const memberEntitySql = `
WITH ${readableSql}
SELECT entities.id AS id FROM member_entities
JOIN entities ON entities.row = ${joinedSql("member_entities.entity")}
WHERE member_entities.member = ?1 AND ${mentionedSql("entities.row")}`;

/** The reader's own person entity, if linked and they may see it. */
export const memberEntity = (
  sql: SqlStorage,
  reader: Reader
): EntityId | null =>
  sql
    .exec<{ id: string }>(
      memberEntitySql,
      reader.person,
      reader.person,
      JSON.stringify(reader.groups)
    )
    .toArray()
    .at(0)?.id ?? null;
