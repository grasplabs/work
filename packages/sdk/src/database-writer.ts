import { identifierMaxLength } from "@grasp-os/shared/identifier";
import type { WriteRequest } from "@grasp-os/shared/store-reads";

import { databaseReader, expectedRevisionOf } from "./database-reader.ts";
import type { DatabaseReader } from "./database-reader.ts";
import { tablesOf } from "./define-schema.ts";
import type { ReadExecutor } from "./query-builder.ts";
import { refuse } from "./query-error.ts";
import type { AnyTables, Present } from "./query-types.ts";
import { hasOnly, isPlainRecord } from "./query-values.ts";
import type { AnyTable, SchemaDefinition } from "./schema-types.ts";
import type { Id, ObjectInput, ObjectOutput } from "./values.ts";

// `ctx.db` for writing, a mutation's only: each write is one request
// (`WriteRequest`) handed to the invocation's executor, which stages it on
// the trusted host. Nothing is written until the mutation commits, which
// the host does after the handler returns; a write the host refuses (a
// field that doesn't validate, a table the caller can't change) throws
// here, from the call that staged it. The checks below are the SDK's
// courtesy, for a clear error where the call is; the host checks every
// request again, trusting nothing.

/** A table's fields, as its records hold them, never `undefined`. */
type Stored<Table extends AnyTable> = ObjectOutput<Table["fields"]>;

/** The fields of a table a patch may leave out of a record: optional ones. */
type OptionalField<Table extends AnyTable> = {
  [Key in keyof Stored<Table> & string]: undefined extends Stored<Table>[Key]
    ? Key
    : never;
}[keyof Stored<Table> & string];

/**
 * What a patch sets: any of the table's fields, as stored. A field left
 * out keeps its value; a patch never fills in a default.
 */
type PatchFields<Table extends AnyTable> = {
  readonly [Key in keyof Stored<Table>]?: Present<Stored<Table>[Key]>;
};

/** What `patch` asserts, and the optional fields it removes. */
interface PatchOptions<Table extends AnyTable> {
  /** The revision the record must be at, or the commit fails. */
  readonly expectedRevision: number;
  /** Optional fields to remove; never one the patch also sets. */
  readonly unset?: readonly OptionalField<Table>[];
}

/** What `replace` and `delete` assert. */
interface WriteOptions {
  /** The revision the record must be at, or the commit fails. */
  readonly expectedRevision: number;
}

/** `ctx.db` for a mutation: reading, and staging writes. */
export interface DatabaseWriter<
  Tables extends AnyTables,
> extends DatabaseReader<Tables> {
  /**
   * Stages a new record of `table`, its defaults filled in, and answers
   * its ID, which the host mints. The caller owns it.
   */
  readonly insert: <TableName extends keyof Tables & string>(
    table: TableName,
    fields: ObjectInput<Tables[TableName]["fields"]>
  ) => Promise<Id<TableName>>;
  /**
   * Stages setting some fields of record `id`, at `expectedRevision`. A
   * record the table's row rules keep from the caller (for reading or
   * writing) fails the commit as a missing one does (`data.conflict`); a
   * change that would move it out of their rules, `data.write_denied`.
   */
  readonly patch: <TableName extends keyof Tables & string>(
    table: TableName,
    id: Id<NoInfer<TableName>>,
    fields: PatchFields<Tables[TableName]>,
    options: PatchOptions<Tables[TableName]>
  ) => Promise<void>;
  /**
   * Stages replacing every field of record `id`, at `expectedRevision`,
   * refused under row rules as `patch` is.
   */
  readonly replace: <TableName extends keyof Tables & string>(
    table: TableName,
    id: Id<NoInfer<TableName>>,
    fields: ObjectInput<Tables[TableName]["fields"]>,
    options: WriteOptions
  ) => Promise<void>;
  /**
   * Stages deleting record `id`, at `expectedRevision`: one the table's
   * row rules keep from the caller fails as a missing one does.
   */
  readonly delete: <TableName extends keyof Tables & string>(
    table: TableName,
    id: Id<NoInfer<TableName>>,
    options: WriteOptions
  ) => Promise<void>;
}

/**
 * Stages one write for the invocation: supplied by the trusted host. An
 * insert answers the record's ID; the others answer nothing.
 */
type WriteExecutor = (request: WriteRequest) => Promise<unknown>;

/** The revision write options assert; refused unless valid. */
const requiredRevisionOf = (
  options: unknown,
  extra: readonly string[] = []
): number => {
  if (!hasOnly(options, ["expectedRevision", ...extra])) {
    return refuse(
      "query.invalid_terminal",
      "A write takes `{ expectedRevision }` as its options."
    );
  }
  const revision = expectedRevisionOf({
    expectedRevision: options.expectedRevision,
  });
  return (
    revision ??
    refuse(
      "query.invalid_terminal",
      "A write's `expectedRevision` is a whole number of at least 1."
    )
  );
};

/** The fields a write sets: a plain object. */
const fieldsOf = (fields: unknown): Record<string, unknown> =>
  isPlainRecord(fields)
    ? fields
    : refuse("query.invalid_terminal", "A write's fields are an object.");

/** A record ID a write names. */
const idOf = (id: unknown): string =>
  typeof id === "string" && id !== "" && id.length <= identifierMaxLength
    ? id
    : refuse("query.invalid_terminal", "A write names a record ID.");

/**
 * `ctx.db` for a mutation over `schema`'s tables: reads run by `read`,
 * writes staged by `write`. The host builds one per invocation.
 */
export const databaseWriter = <Tables extends AnyTables>(
  schema: SchemaDefinition<Tables>,
  read: ReadExecutor,
  write: WriteExecutor
): DatabaseWriter<Tables> => {
  const reader = databaseReader(schema, read);
  const states = tablesOf(schema);
  const tableOf = (table: unknown): string =>
    typeof table === "string" && Object.hasOwn(states, table)
      ? table
      : refuse("query.unknown_table", "The schema has no such table.");
  const writer = {
    ...reader,
    insert: async (table: unknown, fields: unknown) =>
      await write({
        kind: "insert",
        table: tableOf(table),
        fields: fieldsOf(fields),
      }),
    patch: async (
      table: unknown,
      id: unknown,
      fields: unknown,
      options: unknown
    ) => {
      const name = tableOf(table);
      const expectedRevision = requiredRevisionOf(options, ["unset"]);
      const unset: unknown = isPlainRecord(options) ? options.unset : undefined;
      if (
        unset !== undefined &&
        (!Array.isArray(unset) ||
          !unset.every((field) => typeof field === "string"))
      ) {
        refuse("query.invalid_terminal", "`unset` lists field names.");
      }
      await write({
        kind: "patch",
        table: name,
        id: idOf(id),
        fields: fieldsOf(fields),
        unset: Array.isArray(unset) ? unset.map(String) : [],
        expectedRevision,
      });
    },
    replace: async (
      table: unknown,
      id: unknown,
      fields: unknown,
      options: unknown
    ) => {
      await write({
        kind: "replace",
        table: tableOf(table),
        id: idOf(id),
        fields: fieldsOf(fields),
        expectedRevision: requiredRevisionOf(options),
      });
    },
    delete: async (table: unknown, id: unknown, options: unknown) => {
      await write({
        kind: "delete",
        table: tableOf(table),
        id: idOf(id),
        expectedRevision: requiredRevisionOf(options),
      });
    },
  };
  // SAFETY: each method checks at run time what `DatabaseWriter` types
  // (a table of the schema, a record ID, options), and the host answers
  // an insert with the ID it minted for that table, and nothing else.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return Object.freeze(writer) as DatabaseWriter<Tables>;
};
