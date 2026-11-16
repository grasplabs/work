import type { EntityKind } from "./contract.ts";
import { coveredSql, foldName } from "./entities.ts";

// Linking entities (contract.ts "Cards and links").
//
// An add links an entity on exact evidence: its known id or an exact
// identifier (remember.ts), or an exact name of two words or more
// (`linkedByName`) only where one entity of its kind alone holds that
// name through memories read by exactly the add's readers (entities.ts
// `coveredSql`), so no link is decided on what other readers hold. A
// name of one word ("Jan") is no exact evidence: two people share one
// easily, and nothing splits an entity again. Short of exact evidence,
// a likely match is never a link: proposing one is GRA-1857's.

/**
 * The entity of `kind` an add's entity links to by an exact name, given
 * no identifier: the one entity of that kind holding one of `names` of
 * two words or more (a one-word name links nothing: above)
 * through a memory read by exactly the add's set of readers (`readers`,
 * its key), or none when none or several do.
 */
export const linkedByName = (
  sql: SqlStorage,
  kind: EntityKind,
  names: readonly string[],
  readers: string
): number | undefined => {
  const exact = names
    .map((name) => foldName(name))
    .filter((folded) => folded.includes(" "));
  if (exact.length === 0) {
    return undefined;
  }
  // Two rows are enough to tell one entity from several.
  const found = sql
    .exec<{ entity: number }>(
      `SELECT DISTINCT entity_names.entity AS entity
      FROM json_each(?2) AS asked
      -- The exact name first (the index of names), then the memory that
      -- gave it by its row, then the readers' check: never every memory of
      -- the add's readers.
      CROSS JOIN entity_names
        ON entity_names.type = 'name' AND entity_names.folded = asked.value
      CROSS JOIN memories AS m ON m.row = entity_names.memory
      CROSS JOIN entities ON entities.row = entity_names.entity
      WHERE entities.kind = ?1 AND ${coveredSql("m")}
      LIMIT 2`,
      kind,
      JSON.stringify(exact),
      readers
    )
    .toArray();
  return found.length === 1 ? found[0]?.entity : undefined;
};
