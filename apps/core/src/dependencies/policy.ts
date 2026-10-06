import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { dependencyPolicy } from "../db/core/schema.ts";

// The dependency policy generation (`dependency_policy`): one number that
// goes up, in the batch that makes the change, each time who holds
// `dependencies.approve` changes. Whoever acts on the policy names the
// generation they read, and the write that acts checks it is still the
// current one: a decision made on what a person saw before a grant
// changed, or a build admitted on what it read before, is refused instead
// of landing after the change.

/** The one row's ID. */
const policyRow = "policy";

/** The generation now, as SQL: 0 until anything changed it. */
export const policyGenerationSql: SQL = sql`coalesce((SELECT ${dependencyPolicy.generation} FROM ${dependencyPolicy} WHERE ${dependencyPolicy.id} = ${policyRow}), 0)`;

/**
 * Moves the generation on by one if `condition` holds as the statement
 * runs, for the batch of the change it belongs to: a condition on what
 * that batch's earlier statements wrote (`storedEvent`).
 */
export const advancePolicy = (db: DrizzleD1Database, condition: SQL) =>
  db
    .insert(dependencyPolicy)
    .select(sql`SELECT ${policyRow}, 1 WHERE ${condition}`)
    .onConflictDoUpdate({
      target: dependencyPolicy.id,
      set: { generation: sql`${dependencyPolicy.generation} + 1` },
    });

/** The generation now. */
export const policyGeneration = async (
  db: DrizzleD1Database
): Promise<number> => {
  const row = await db.get<{ generation: number }>(
    sql`SELECT ${policyGenerationSql} AS generation`
  );
  return row.generation;
};
