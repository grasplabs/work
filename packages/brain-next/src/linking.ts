import type { EntityKind, Proposal, ProposalPage, Reader } from "./contract.ts";
import { asSeen, coveredSql, foldName } from "./entities.ts";
import { visibleSql } from "./memories.ts";
import { readableSql } from "./reader-sets.ts";

// Linking entities (contract.ts "Cards and proposals").
//
// An add links an entity on exact evidence: its known id or an exact
// identifier (remember.ts), or an exact name (`linkedByName`) only where
// one entity of its kind alone holds that name through memories read by
// exactly the add's readers (entities.ts `coveredSql`), so no link is
// decided on what other readers hold.
//
// Short of that, a likely match is a proposal, never a link: worked out
// when a reader asks (`listProposals`), from the names they may read
// alone, and never stored. Two entities of one kind are a likely match
// when a name of one, as a memory the reader may read gave it, has all
// its words among the words of a name of the other, whole. Every name
// either side holds is read through the reader's check in the same
// statement, before anything is counted, ordered or paged, so a name or
// an entity hidden from the reader never adds, removes or moves a
// proposal; and an add does no work for it.

/**
 * The entity of `kind` an add's entity links to by an exact name, given
 * no identifier: the one entity of that kind holding one of `names`
 * through a memory read by exactly the add's set of readers
 * (`readerSet`), or none when none or several do.
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
  // Two rows are enough to tell one entity from several.
  const found = sql
    .exec<{ entity: number }>(
      `SELECT DISTINCT entity_names.entity AS entity
      FROM json_each(?2) AS asked
      JOIN entity_names
        ON entity_names.type = 'name' AND entity_names.folded = asked.value
      JOIN memories AS m ON m.row = entity_names.memory
      JOIN entities ON entities.row = entity_names.entity
      WHERE entities.kind = ?1 AND ${coveredSql("m")}
      LIMIT 2`,
      kind,
      JSON.stringify(names.map((name) => foldName(name))),
      readerSet
    )
    .toArray();
  return found.length === 1 ? found[0]?.entity : undefined;
};

/**
 * `?1` the entity's id, `?4` the candidate id to page after (or null),
 * `?5` how many: the entities of its kind the reader may see whose name,
 * as a memory they may read gave it, likely matches a name of the asked
 * entity they may read (one name's words all among the other's, whole),
 * by id, each with the pair of names that matched first by the names
 * themselves. A folded name is words with single spaces between them
 * (entities.ts `foldName`), so its words are its spaces' pieces.
 */
const proposalsSql = `
WITH ${readableSql},
asked AS (SELECT row, kind FROM entities WHERE id = ?1),
own AS MATERIALIZED (
  SELECT n.folded AS folded, min(n.value) AS value
  FROM entity_names AS n
  JOIN memories AS m ON m.row = n.memory
  WHERE n.entity = (SELECT row FROM asked) AND n.type = 'name'
    AND ${visibleSql("m")}
  GROUP BY n.folded
),
split(name, word, rest) AS (
  SELECT folded, '', folded || ' ' FROM own
  UNION ALL
  SELECT name, substr(rest, 1, instr(rest, ' ') - 1),
    substr(rest, instr(rest, ' ') + 1)
  FROM split WHERE rest != ''
),
own_words AS MATERIALIZED (
  SELECT DISTINCT name, word FROM split WHERE word != ''
),
own_sizes AS (SELECT name, count(*) AS words FROM own_words GROUP BY name),
others AS MATERIALIZED (
  SELECT e.row AS row, e.id AS id, e.kind AS kind, n.folded AS folded,
    min(n.value) AS value
  FROM entity_names AS n
  JOIN entities AS e ON e.row = n.entity
  JOIN memories AS m ON m.row = n.memory
  WHERE n.type = 'name' AND e.kind = (SELECT kind FROM asked)
    AND e.row != (SELECT row FROM asked)
    AND ${visibleSql("m")}
  GROUP BY e.row, n.folded
),
shared AS (
  SELECT others.row AS row, others.id AS id, others.kind AS kind,
    others.folded AS folded, others.value AS value, own_words.name AS name,
    count(*) AS words
  FROM others
  JOIN own_words
    ON instr(' ' || others.folded || ' ', ' ' || own_words.word || ' ') > 0
  GROUP BY others.row, others.folded, own_words.name
),
matched AS (
  SELECT shared.row AS row, shared.id AS id, shared.kind AS kind,
    shared.value AS other_name, own.value AS name,
    row_number() OVER (
      PARTITION BY shared.row ORDER BY own.value, shared.value
    ) AS place
  FROM shared
  JOIN own_sizes ON own_sizes.name = shared.name
  JOIN own ON own.folded = shared.name
  WHERE shared.words = own_sizes.words
    OR shared.words = length(shared.folded)
      - length(replace(shared.folded, ' ', '')) + 1
)
SELECT row, id, kind, name, other_name FROM matched
WHERE place = 1 AND (?4 IS NULL OR id > ?4)
ORDER BY id
LIMIT ?5`;

/** A proposal as `proposalsSql` returns it. */
interface ProposalRow extends Record<string, SqlStorageValue> {
  row: number;
  id: string;
  kind: string;
  name: string;
  other_name: string;
}

/**
 * A page of the proposals the reader may see for the entity `entity`
 * (contract.ts `listProposals`): after the candidate `after`, at most
 * `limit`, and whether more follow.
 */
export const listProposals = (
  sql: SqlStorage,
  {
    entity,
    reader,
    after,
    limit,
  }: { entity: string; reader: Reader; after?: string; limit: number }
): ProposalPage => {
  const rows = sql
    .exec<ProposalRow>(
      proposalsSql,
      entity,
      reader.person,
      JSON.stringify(reader.groups),
      after ?? null,
      limit + 1
    )
    .toArray();
  const page = rows.slice(0, limit);
  const [asked] =
    page.length === 0
      ? []
      : sql
          .exec<{ row: number; id: string; kind: string }>(
            "SELECT row, id, kind FROM entities WHERE id = ?",
            entity
          )
          .toArray();
  // The asked entity and each candidate, with the names the reader may see.
  const seen = new Map(
    asSeen(sql, [...(asked === undefined ? [] : [asked]), ...page], reader).map(
      (one) => [one.id, one]
    )
  );
  const own = seen.get(entity);
  const proposals: Proposal[] = page.flatMap((row) => {
    const candidate = seen.get(row.id);
    return own === undefined || candidate === undefined
      ? []
      : [
          {
            entity: own,
            candidate,
            name: row.name,
            candidateName: row.other_name,
          },
        ];
  });
  return { proposals, more: rows.length > limit };
};
