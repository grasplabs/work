/**
 * The records independent workflows freeze (migrations 0080, 0089, 0095
 * and 0101) can't be rewritten by an insert either: whatever form asks to
 * write over a key a table already holds, primary, unique or the implicit
 * rowid, the database refuses it and the row stays as it was. A new key is
 * written as before. Knowledge's sections refuse the same (knowledge
 * migration 0014), so no replace leaves a search row behind.
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
  otherKey?: {
    columns: readonly string[];
    row: (row: Row) => Row;
  };
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
    otherKey: {
      columns: ["workflow_resource_id", "definition_version"],
      row: (row) => ({ ...row, version: 2 }),
    },
  },
  {
    table: "workflow_start_receipts",
    key: ["id"],
    parents: (id) => [workflow(id)],
    row: receipt,
    change: { input_hash: "tampered", manifest_hash: "tampered" },
    otherKey: {
      columns: [
        "invoker_type",
        "invoker_id",
        "principal_id",
        "idempotency_key",
      ],
      row: (row) => ({ ...row, id: `${String(row.id)}-again` }),
    },
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

const insertSql = (
  verb: string,
  table: string,
  row: Row,
  tail = "",
  db: D1Database = env.DB
) => {
  const columns = Object.keys(row).map((column) => `"${column}"`);
  return db
    .prepare(
      `${verb} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})${tail}`
    )
    .bind(...Object.values(row));
};

/** The forms that resolve a conflict instead of failing on it. */
const forms = [
  "INSERT OR REPLACE",
  "REPLACE INTO",
  "INSERT OR IGNORE",
  "ON CONFLICT DO UPDATE",
] as const;

const rewrites = (
  spec: ImmutableTable,
  row: Row,
  target: readonly string[] = spec.key
): Record<(typeof forms)[number], D1PreparedStatement> => {
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
      ` ON CONFLICT (${target.join(", ")}) DO UPDATE SET ${set}`
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

/** A table's rows, each with its rowid. */
const rowsOf = async (table: string, db: D1Database = env.DB) => {
  const { results } = await db
    .prepare(`SELECT rowid AS row_id, * FROM ${table} ORDER BY rowid`)
    .all();
  return results;
};

const rowidOf = async (spec: ImmutableTable, row: Row): Promise<number> => {
  const found = await env.DB.prepare(
    `SELECT rowid AS id FROM ${spec.table} WHERE ${spec.key.map((column) => `"${column}" = ?`).join(" AND ")}`
  )
    .bind(...spec.key.map((column) => row[column]))
    .first<{ id: number }>();
  if (found === null) {
    throw new Error(`No ${spec.table} row seeded`);
  }
  return found.id;
};

/** Whether `outcome` is the table's own refusal of `key`, not SQLite's. */
const refusedBy = (outcome: string, table: string, key = "") =>
  outcome.includes(`UNIQUE constraint failed: ${table}.${key}`) &&
  outcome.includes(`(${table} `);

describe("immutable records", () => {
  it.each(tables)(
    "$table refuses every insert over a key it holds",
    async (spec) => {
      const overwrites: Record<string, (row: Row) => D1PreparedStatement> = {};
      for (const form of forms) {
        overwrites[form] = (row) =>
          rewrites(spec, { ...row, ...spec.change })[form];
        const { otherKey } = spec;
        if (otherKey !== undefined) {
          overwrites[`${form}, other unique key`] = (row) =>
            rewrites(
              spec,
              { ...otherKey.row(row), ...spec.change },
              otherKey.columns
            )[form];
        }
      }
      const outcomes: Record<string, { refused: boolean; unchanged: boolean }> =
        {};
      for (const [form, overwrite] of Object.entries(overwrites)) {
        // Each against a row of its own, so none sees what another wrote.
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        const row = await seeded(spec);
        // oxlint-disable-next-line no-await-in-loop -- see above
        const before = await rowsOf(spec.table);
        // oxlint-disable-next-line no-await-in-loop -- see above
        const outcome = await refusal(overwrite(row));
        // oxlint-disable-next-line no-await-in-loop -- see above
        const after = await rowsOf(spec.table);
        outcomes[form] = {
          // The table's own refusal, read as the unique violation it is,
          // and told from SQLite's by what it adds.
          refused: refusedBy(outcome, spec.table),
          unchanged: JSON.stringify(after) === JSON.stringify(before),
        };
      }
      expect(outcomes).toStrictEqual(
        Object.fromEntries(
          Object.keys(overwrites).map((form) => [
            form,
            { refused: true, unchanged: true },
          ])
        )
      );
    }
  );

  it.each(tables)(
    "$table refuses a new key under an old row's rowid",
    async (spec) => {
      const row = await seeded(spec);
      const rowid = await rowidOf(spec, row);
      // Everything else about it new: its parents, every key but the rowid.
      const fresh = crypto.randomUUID();
      const parents = spec
        .parents(fresh)
        .map((parent) => insertSql("INSERT", parent.table, parent.row));
      if (parents.length > 0) {
        await env.DB.batch(parents);
      }
      const before = await rowsOf(spec.table);
      const replace = await refusal(
        insertSql("INSERT OR REPLACE", spec.table, {
          rowid,
          ...spec.row(fresh),
        })
      );
      const replaceInto = await refusal(
        insertSql("REPLACE", spec.table, { rowid, ...spec.row(fresh) })
      );
      // Nor rowid -1, which every insert that names none has to its
      // triggers: a row there would match, and refuse, them all.
      const reserved = await refusal(
        insertSql("INSERT", spec.table, { rowid: -1, ...spec.row(fresh) })
      );
      const after = await rowsOf(spec.table);
      // The old row still there, its key is still taken: nothing can be
      // written under it in its place.
      const again = await refusal(
        insertSql("INSERT", spec.table, { ...row, ...spec.change })
      );
      expect({
        replace: refusedBy(replace, spec.table, "rowid"),
        replaceInto: refusedBy(replaceInto, spec.table, "rowid"),
        reserved: reserved.includes(`${spec.table} keep rowid -1`),
        unchanged: JSON.stringify(after) === JSON.stringify(before),
        again: again.includes(`UNIQUE constraint failed: ${spec.table}.`),
      }).toStrictEqual({
        replace: true,
        replaceInto: true,
        reserved: true,
        unchanged: true,
        again: true,
      });
    }
  );

  it("refuses a section written over its key or rowid, which would leave its search row", async () => {
    const db = env.KNOWLEDGE;
    const id = crypto.randomUUID();
    const section = (position: number): Row => ({
      document_id: `doc-${id}`,
      version: 1,
      position,
      headings: "[]",
      text: `section ${position}`,
    });
    await db.batch([
      insertSql(
        "INSERT",
        "collections",
        {
          id: `col-${id}`,
          name: `col-${id}`,
          description: "",
          owner: "owner",
          access: "all",
          source: "local",
          created_at: 1,
        },
        "",
        db
      ),
      insertSql(
        "INSERT",
        "documents",
        {
          id: `doc-${id}`,
          collection_id: `col-${id}`,
          path: `doc-${id}.md`,
          title: "Doc",
          type: "page",
          description: "",
          owner: "owner",
          tags: "[]",
          current_version: 1,
          created_at: 1,
          updated_at: 1,
        },
        "",
        db
      ),
      insertSql(
        "INSERT",
        "versions",
        {
          document_id: `doc-${id}`,
          number: 1,
          text: "",
          author: "owner",
          created_at: 1,
        },
        "",
        db
      ),
      insertSql("INSERT", "sections", section(0), "", db),
    ]);
    const { id: rowid } = (await db
      .prepare("SELECT rowid AS id FROM sections WHERE document_id = ?")
      .bind(`doc-${id}`)
      .first<{ id: number }>()) ?? { id: -1 };
    const state = async () =>
      JSON.stringify([
        await rowsOf("sections", db),
        await rowsOf("search_rows", db),
      ]);
    const before = await state();
    const changed = { ...section(0), text: "changed" };
    const outcomes = {
      replace: await refusal(
        insertSql("INSERT OR REPLACE", "sections", changed, "", db)
      ),
      upsert: await refusal(
        insertSql(
          "INSERT",
          "sections",
          changed,
          " ON CONFLICT (document_id, position) DO UPDATE SET text = excluded.text",
          db
        )
      ),
      rowid: await refusal(
        insertSql(
          "INSERT OR REPLACE",
          "sections",
          { rowid, ...section(1) },
          "",
          db
        )
      ),
      reserved: await refusal(
        insertSql("INSERT", "sections", { rowid: -1, ...section(1) }, "", db)
      ),
    };
    const after = await state();
    // A new section is still written, and indexed.
    await insertSql("INSERT", "sections", section(1), "", db).run();
    const { results: indexed } = await db
      .prepare(
        "SELECT position FROM search_rows WHERE document_id = ? ORDER BY position"
      )
      .bind(`doc-${id}`)
      .all<{ position: number }>();
    expect({
      replace: refusedBy(outcomes.replace, "sections", "document_id"),
      upsert: refusedBy(outcomes.upsert, "sections", "document_id"),
      rowid: refusedBy(outcomes.rowid, "sections", "rowid"),
      reserved: outcomes.reserved.includes("sections keep rowid -1"),
      unchanged: after === before,
      indexed: indexed.map(({ position }) => position),
    }).toStrictEqual({
      replace: true,
      upsert: true,
      rowid: true,
      reserved: true,
      unchanged: true,
      indexed: [0, 1],
    });
  });

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
