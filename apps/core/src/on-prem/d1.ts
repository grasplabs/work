/**
 * The on-prem profile's D1: core's D1 databases (`DB`, `KNOWLEDGE`) on plain
 * workerd, which has D1's client but no D1 service behind it.
 *
 * Core never sees this module. On Cloudflare its D1 bindings are real D1.
 * On-prem, the workerd config binds each of them to workerd's built-in D1
 * client (`cloudflare-internal:d1-api`, as a wrapped binding) and points the
 * client's `fetcher` at this Worker, with the database's binding name as its
 * props (scripts/workerd-smoke.ts writes that config). So the D1 binding is
 * the adapter interface, and this is the on-prem implementation of it: the
 * same arrangement Miniflare uses for Wrangler's local dev and the tests,
 * whose object this one answers like, so on-prem behaves as the tests do.
 *
 * Each database is one SQLite Durable Object, named by its binding. Before
 * its first query it applies its migrations, the files Wrangler applies on
 * Cloudflare (`wrangler d1 migrations apply`), and records them where
 * Wrangler does, in `d1_migrations`: an on-prem install needs no Wrangler.
 *
 * Not here: D1's export and import, and time travel. Core uses none of them.
 */
import { DurableObject } from "cloudflare:workers";

/** One migration file, split at its statement breakpoints. */
export interface D1Migration {
  name: string;
  queries: readonly string[];
}

/** What the workerd config gives this Worker. */
interface D1Env {
  /** One object per database. */
  DATABASES: DurableObjectNamespace<D1Store>;
  /** Each database's migrations by binding name, in the order they apply. */
  MIGRATIONS: Readonly<Record<string, readonly D1Migration[]>>;
}

/** Which database a D1 binding's client is: its binding name. */
interface D1Props {
  database: string;
}

/** A parameter as D1's client sends it: a byte array is a blob. */
type D1Param = string | number | null | readonly number[];

/** One statement as D1's client sends it. */
interface D1Query {
  sql: string;
  params?: readonly D1Param[] | null;
}

/** How D1's client wants rows back. */
type ResultsFormat = "ARRAY_OF_OBJECTS" | "ROWS_AND_COLUMNS" | "NONE";

/** A column's value as D1's client takes it: a blob as a byte array. */
type D1Value = string | number | null | number[];

/** The header the client reads a session's bookmark from. */
const bookmarkHeader = "x-cf-d1-session-commit-token";

/** The header this Worker names the database in, for its object. */
const databaseHeader = "x-grasp-d1-database";

/** Where Wrangler records the migrations it applied. */
const migrationsTable = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

const leadingComments = /^\s*--.*$/gmu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isParam = (value: unknown): value is D1Param =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  (Array.isArray(value) &&
    value.every((byte: unknown) => typeof byte === "number"));

const isQuery = (value: unknown): value is D1Query =>
  isRecord(value) &&
  typeof value.sql === "string" &&
  (value.params === undefined ||
    value.params === null ||
    (Array.isArray(value.params) && value.params.every(isParam)));

/** The statements a request carries: one, or a batch. */
const queriesOf = (body: unknown): D1Query[] => {
  const queries = Array.isArray(body) ? body : [body];
  if (!queries.every(isQuery)) {
    throw new Error("Malformed D1 query.");
  }
  return queries;
};

const formatOf = (url: string): ResultsFormat => {
  const format = new URL(url).searchParams.get("resultsFormat");
  return format === "ROWS_AND_COLUMNS" || format === "NONE"
    ? format
    : "ARRAY_OF_OBJECTS";
};

const toSql = (param: D1Param): SqlStorageValue =>
  typeof param === "object" && param !== null
    ? new Uint8Array(param).buffer
    : param;

const toD1 = (value: SqlStorageValue): D1Value =>
  value instanceof ArrayBuffer ? [...new Uint8Array(value)] : value;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** One database: a SQLite Durable Object that answers D1's client. */
export class D1Store extends DurableObject<D1Env> {
  #migrated = false;

  /**
   * Answers `POST /query` and `POST /execute` as D1 does: every statement
   * of the request in one transaction, each one's rows and what it changed.
   */
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (
      request.method !== "POST" ||
      (pathname !== "/query" && pathname !== "/execute")
    ) {
      return new Response(null, { status: 404 });
    }
    try {
      // Synchronous, so no other request runs before it is done.
      this.#migrate(request.headers.get(databaseHeader) ?? "");
      const queries = queriesOf(await request.json());
      const results = this.#transaction(queries, formatOf(request.url));
      return Response.json(results, {
        headers: {
          [bookmarkHeader]: await this.ctx.storage.getCurrentBookmark(),
        },
      });
    } catch (error) {
      return Response.json({ success: false, error: messageOf(error) });
    }
  }

  /** Applies the database's migrations it hasn't yet, each in one transaction. */
  #migrate(database: string): void {
    if (this.#migrated) {
      return;
    }
    const migrations = this.env.MIGRATIONS[database];
    if (migrations === undefined) {
      throw new Error(`No D1 database ${database}.`);
    }
    const { sql } = this.ctx.storage;
    sql.exec(migrationsTable);
    const applied = new Set(
      sql
        .exec<{ name: string }>("SELECT name FROM d1_migrations")
        .toArray()
        .map(({ name }) => name)
    );
    for (const { name, queries } of migrations) {
      if (!applied.has(name)) {
        this.ctx.storage.transactionSync(() => {
          for (const query of queries) {
            sql.exec(query);
          }
          sql.exec("INSERT INTO d1_migrations (name) VALUES (?)", name);
        });
      }
    }
    this.#migrated = true;
  }

  #transaction(queries: readonly D1Query[], format: ResultsFormat) {
    const statements = queries.filter(
      ({ sql }) => sql.replace(leadingComments, "").trim().length > 0
    );
    if (statements.length === 0) {
      throw new Error("No SQL statements detected.");
    }
    return this.ctx.storage.transactionSync(() =>
      statements.map((query) => this.#query(query, format))
    );
  }

  #changes(): { totalChanges: number; lastRowId: number } {
    const [row] = this.ctx.storage.sql
      .exec<{ totalChanges: number; lastRowId: number }>(
        "SELECT total_changes() AS totalChanges, last_insert_rowid() AS lastRowId"
      )
      .toArray();
    return row ?? { totalChanges: 0, lastRowId: 0 };
  }

  #query({ sql, params }: D1Query, format: ResultsFormat) {
    const { storage } = this.ctx;
    const startedAt = performance.now();
    const sizeBefore = storage.sql.databaseSize;
    const before = this.#changes();
    const cursor = storage.sql.exec(sql, ...(params ?? []).map(toSql));
    const columns = cursor.columnNames;
    const rows = [...cursor.raw()].map((row) => row.map(toD1));
    const after = this.#changes();
    const sizeAfter = storage.sql.databaseSize;
    const changes = after.totalChanges - before.totalChanges;
    return {
      success: true,
      results:
        format === "ROWS_AND_COLUMNS"
          ? { columns, rows }
          : rows.map((row) =>
              Object.fromEntries(columns.map((name, i) => [name, row[i]]))
            ),
      meta: {
        served_by: "grasp-os-on-prem",
        duration: performance.now() - startedAt,
        changes,
        last_row_id: after.lastRowId,
        changed_db:
          changes !== 0 ||
          after.lastRowId !== before.lastRowId ||
          sizeAfter !== sizeBefore,
        size_after: sizeAfter,
        rows_read: cursor.rowsRead,
        rows_written: cursor.rowsWritten,
      },
    };
  }
}

/** Passes each D1 client's request to its database's object. */
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { database } = ctx.props;
    const forwarded = new Request(request);
    forwarded.headers.set(databaseHeader, database);
    return await env.DATABASES.getByName(database).fetch(forwarded);
  },
} satisfies ExportedHandler<D1Env, unknown, unknown, D1Props>;
