/**
 * The records independent workflows freeze (migrations 0080, 0089, 0095
 * and 0101) can't be rewritten by an insert either: whatever form asks to
 * write over a key a table already holds, primary or unique, the database
 * refuses it and the row stays as it was. A new key is written as before.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

type Row = Record<string, string | number | null>;

interface ImmutableTable {
  table: string;
  /** The primary key's columns. */
  key: readonly string[];
  /** What a row needs to exist first, for one fresh ID. */
  parents: (id: string) => readonly { table: string; row: Row }[];
  /** A row of the table for one fresh ID. */
  row: (id: string) => Row;
  /**
   * Columns a rewrite would change: none of a key's, or the rewrite would
   * be a new row rather than one over this one.
   */
  change: Row;
  /**
   * A row under a new primary key that takes another unique index's key
   * of `row`, which REPLACE would delete just the same.
   */
  sameUniqueKey?: (row: Row) => Row;
}

const workflow = (id: string) => ({
  table: "workflow_resources",
  row: { id: `wf-${id}`, name: `wf-${id}`, owner_id: "owner", created_at: 1 },
});

const receipt = (id: string): Row => ({
  id: `receipt-${id}`,
  invoker_type: "app",
  invoker_id: `app-${id}`,
  idempotency_key: `key-${id}`,
  workflow_resource_id: `wf-${id}`,
  workflow_resource_version: 1,
  manifest_hash: "manifest",
  principal_id: "principal",
  authority_generation: 1,
  input_hash: "input",
  created_at: 1,
});

const tables: readonly ImmutableTable[] = [
  {
    table: "workflow_resource_versions",
    key: ["workflow_resource_id", "version"],
    parents: (id) => [workflow(id)],
    row: (id) => ({
      workflow_resource_id: `wf-${id}`,
      version: 1,
      definition_version: "1.0.0",
      definition: "{}",
      definition_json_hash: "definition",
      profile_version: "1",
      evaluator_hash: "evaluator",
      contract: "{}",
      contract_hash: "contract",
      manifest: "{}",
      manifest_hash: "manifest",
      author_id: "author",
      created_at: 1,
    }),
    change: { manifest: '{"actions":[]}', manifest_hash: "tampered" },
    sameUniqueKey: (row) => ({ ...row, version: 2 }),
  },
  {
    table: "workflow_start_receipts",
    key: ["id"],
    parents: (id) => [workflow(id)],
    row: receipt,
    change: { input_hash: "tampered", manifest_hash: "tampered" },
    sameUniqueKey: (row) => ({ ...row, id: `${String(row.id)}-again` }),
  },
  {
    table: "workflow_resource_params",
    key: ["workflow_resource_id", "revision"],
    parents: (id) => [workflow(id)],
    row: (id) => ({
      workflow_resource_id: `wf-${id}`,
      revision: 1,
      values: "{}",
      set_by: "author",
      set_at: 1,
    }),
    change: { values: '{"limit":1000}', set_by: "someone-else" },
  },
  {
    table: "workflow_catalog_contracts",
    key: ["key"],
    parents: () => [],
    row: (id) => ({
      key: `contract-${id}`,
      kind: "tool",
      contract: "{}",
      fingerprint: "fingerprint",
      published_by: "admin",
      published_at: 1,
    }),
    change: { contract: '{"tampered":true}', fingerprint: "tampered" },
  },
  {
    table: "trigger_resource_versions",
    key: ["trigger_id", "version"],
    parents: (id) => [
      workflow(id),
      {
        table: "trigger_resources",
        row: {
          id: `trigger-${id}`,
          owner_id: "owner",
          kind: "schedule",
          current_version: 1,
          enabled: 1,
          created_at: 1,
        },
      },
    ],
    row: (id) => ({
      trigger_id: `trigger-${id}`,
      version: 1,
      workflow_resource_id: `wf-${id}`,
      workflow_resource_version: 1,
      config_hash: "config",
      principal_binding: "binding",
      created_at: 1,
    }),
    change: { config_hash: "tampered", principal_binding: "someone-else" },
  },
  {
    table: "workflow_resource_runs",
    key: ["id"],
    parents: (id) => [
      workflow(id),
      { table: "workflow_start_receipts", row: receipt(id) },
    ],
    row: (id) => ({
      id: `receipt-${id}`,
      workflow_resource_id: `wf-${id}`,
      version: 1,
      manifest_hash: "manifest",
      build_hash: "build",
      principal_id: "principal",
      status: "done",
      created_at: 1,
      ended_at: 2,
    }),
    change: { build_hash: "tampered", status: "starting", ended_at: null },
  },
];

const insertSql = (verb: string, table: string, row: Row, tail = "") => {
  const columns = Object.keys(row).map((column) => `"${column}"`);
  return env.DB.prepare(
    `${verb} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})${tail}`
  ).bind(...Object.values(row));
};

/** The forms that resolve a conflict instead of failing on it. */
const rewrites = (spec: ImmutableTable, row: Row) => {
  const set = Object.keys(spec.change)
    .map((column) => `"${column}" = excluded."${column}"`)
    .join(", ");
  return {
    "INSERT OR REPLACE": insertSql("INSERT OR REPLACE", spec.table, row),
    "REPLACE INTO": insertSql("REPLACE", spec.table, row),
    "INSERT OR IGNORE": insertSql("INSERT OR IGNORE", spec.table, row),
    "ON CONFLICT DO UPDATE": insertSql(
      "INSERT",
      spec.table,
      row,
      ` ON CONFLICT (${spec.key.join(", ")}) DO UPDATE SET ${set}`
    ),
  };
};

const refusal = async (statement: D1PreparedStatement): Promise<string> => {
  try {
    await statement.run();
    return "written";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const seeded = async (spec: ImmutableTable): Promise<Row> => {
  const id = crypto.randomUUID();
  const row = spec.row(id);
  // In order, parents first, as one transaction.
  await env.DB.batch([
    ...spec
      .parents(id)
      .map((parent) => insertSql("INSERT", parent.table, parent.row)),
    insertSql("INSERT", spec.table, row),
  ]);
  return row;
};

const rowsOf = async (table: string) => {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${table} ORDER BY rowid`
  ).all();
  return results;
};

describe("immutable records", () => {
  it.each(tables)(
    "$table refuses every insert over a key it holds",
    async (spec) => {
      const row = await seeded(spec);
      const before = await rowsOf(spec.table);
      const overwrites = {
        ...rewrites(spec, { ...row, ...spec.change }),
        ...(spec.sameUniqueKey === undefined
          ? {}
          : Object.fromEntries(
              Object.entries(
                rewrites(spec, { ...spec.sameUniqueKey(row), ...spec.change })
              ).map(([form, statement]) => [
                `${form}, other unique key`,
                statement,
              ])
            )),
      };
      const outcomes: Record<string, boolean> = {};
      for (const [form, statement] of Object.entries(overwrites)) {
        // One at a time, so each is tried against the row as seeded.
        // oxlint-disable-next-line no-await-in-loop -- see above
        const outcome = await refusal(statement);
        // The table's own refusal, read as the unique violation it is.
        outcomes[form] = outcome.includes(
          `UNIQUE constraint failed: ${spec.table}.`
        );
      }
      expect(outcomes).toStrictEqual(
        Object.fromEntries(Object.keys(overwrites).map((form) => [form, true]))
      );
      await expect(rowsOf(spec.table)).resolves.toStrictEqual(before);
    }
  );

  it.each(tables)("$table takes a new key", async (spec) => {
    const first = await seeded(spec);
    const second = await seeded(spec);
    const stored = await rowsOf(spec.table);
    expect(
      stored.filter((written) =>
        [first, second].some((row) =>
          spec.key.every((column) => written[column] === row[column])
        )
      )
    ).toHaveLength(2);
  });
});
