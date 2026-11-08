import {
  indexMaxFields,
  searchIndexMaxFields,
  storeMaxTables,
  storeNameMaxLength,
  storeNamePattern,
} from "@grasp-os/shared/store-limits";

import { refuse } from "./schema-error.ts";

/**
 * The fields every record has, which only the host sets: its ID, its
 * owner, its revision, and when it was created and last changed. A caller
 * can read them but never write, patch or unset them; an authored field
 * can't take their names (none starts with `_`).
 */
export const managedFields = Object.freeze([
  "_id",
  "_ownerId",
  "_rev",
  "_createdAt",
  "_updatedAt",
] as const);

/**
 * The bounds of one schema. Indexes per table and fields per index are the
 * host's own, the same for every deployment.
 */
export const schemaLimits = Object.freeze({
  /** Tables in one schema: as many as a store holds. */
  tables: storeMaxTables,
  /** Code units in a table, field or index name. */
  nameLength: storeNameMaxLength,
  /** Indexes on one table. */
  indexesPerTable: 32,
  /** Fields in one index. */
  fieldsPerIndex: indexMaxFields,
  /** Text fields in a table's search index. */
  fieldsPerSearchIndex: searchIndexMaxFields,
} as const);

/** A table, field or index name, checked; `what` says which, for the message. */
export const checkedName = (name: unknown, what: string): string => {
  if (
    typeof name !== "string" ||
    name.length > schemaLimits.nameLength ||
    !storeNamePattern.test(name)
  ) {
    return refuse(
      "schema.invalid_name",
      `A ${what} name is a letter, then at most ${schemaLimits.nameLength - 1} letters, digits or underscores.`
    );
  }
  return name;
};

/**
 * Names that collide when case is ignored, which a store's host (and the
 * SQL it is free to generate) can't tell apart.
 */
export const checkUnique = (names: readonly string[], what: string): void => {
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      refuse(
        "schema.name_conflict",
        `Two ${what} names differ only in case: \`${name}\`.`
      );
    }
    seen.add(key);
  }
};
