import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

// What a removed App takes (migration 0170, app-removal.ts): every table of
// core's database that names an App either refuses a new row naming a
// removed one (its `<table>_removed_app_insert` trigger) or is left open on
// purpose, for the reason the migration gives. A new table that names an
// App, classified neither way, fails here, so the guard keeps up with the
// schema.

/** Open on purpose: see migration 0170 for why each one is. */
const leftOpen = new Set([
  "access_revocations",
  "notifications",
  "app_statistics",
  "app_statistic_steps",
  "improvement_signals",
  "dependency_admission_refusals",
  "run_lineage_accounts",
  "workflow_resource_run_controls",
  "sdk_release_pins",
  "sdk_release_tombstones",
  "dependency_approvers",
]);

/**
 * A column by which a table can name an App, as its `CREATE TABLE` names
 * it (D1 refuses `pragma_table_info`).
 */
const appColumn =
  /[`"](?:\w*app_id|subject_id|object_id|invoker_id|resource_id)[`"]/u;

describe("the database's guard for removed Apps", () => {
  it("refuses new rows in every table that names an App, but those left open on purpose", async () => {
    const { results: all } = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL"
    ).all<{ name: string; sql: string }>();
    const naming = all.filter(({ sql }) => appColumn.test(sql));
    const { results: guarded } = await env.DB.prepare(
      "SELECT tbl_name AS name FROM sqlite_master WHERE type = 'trigger' AND name = tbl_name || '_removed_app_insert'"
    ).all<{ name: string }>();
    const tables = new Set(naming.map(({ name }) => name));
    const refusing = new Set(guarded.map(({ name }) => name));

    expect({
      unclassified: [...tables]
        .filter((table) => !refusing.has(table) && !leftOpen.has(table))
        .toSorted(),
      bothWays: [...leftOpen].filter((table) => refusing.has(table)).toSorted(),
      stale: [...leftOpen].filter((table) => !tables.has(table)).toSorted(),
    }).toStrictEqual({ unclassified: [], bothWays: [], stale: [] });
  });
});
