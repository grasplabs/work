import type { ValueDescriptor } from "@grasp-os/sdk";
import {
  allowsNull,
  indexBase,
  schemaFromDescriptor,
} from "@grasp-os/sdk/host";
import type {
  IndexBase,
  ManifestTable,
  SchemaManifest,
} from "@grasp-os/sdk/host";
import {
  queryMaxResults,
  queryMaxScannedBytes,
  queryMaxScannedEntries,
} from "@grasp-os/shared/store-limits";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { GetRequest, QueryRequest } from "@grasp-os/shared/store-reads";
import { dataErrors, storedFieldsSchema } from "@grasp-os/shared/stores";

import {
  fieldExpression,
  filterSql,
  numberExpression,
  isManagedField,
  rangeSql,
  tableIdLiteral,
} from "./store-expressions.ts";
import type { FieldTypes, Fragment } from "./store-expressions.ts";
import { defaultIndexName } from "./store-indexes.ts";
import type { PhysicalIndex } from "./store-indexes.ts";

// How a business store answers a read (store-host.ts): a record by ID, or
// a query's descriptor (sdk/src/database.ts), executed against the store's
// own SQLite through the index it names, under the access the caller's
// pinned schema declares. Everything here runs synchronously inside the
// store's object, so one read sees one state of the store.
//
// Threat model (who reads: App code, through core, which resolves the
// caller and hands the store a `ReadScope`; the descriptor itself is
// whatever App code built, and is trusted for nothing):
//
// - A caller reads records it may not see, through any terminal: the
//   table's read mode comes from the store's own record of the pinned
//   schema (`sdk_schemas`), never from the request. `none` refuses;
//   `appMembers` and `appBuilders` refuse a caller core didn't find to be
//   one (`data.access_denied`); `owner` adds `owner_id = principal` to the
//   one SQL statement every terminal runs, so counts, aggregates, `unique`
//   and pages are computed over the caller's records only, and the owner
//   leads the index, so other owners' records are never scanned either.
//   Nothing is filtered after the fact.
// - A record ID discloses another table's or owner's record: `get` looks a
//   record up by its table and ID, under the same owner predicate, and
//   answers null for a record that is missing, in another table or not
//   the caller's alike; `expectedRevision` is checked only on a record the
//   caller may see.
// - A descriptor smuggles SQL, or names what it shouldn't: tables,
//   indexes and fields are resolved through the pinned manifest, so a
//   name it lacks is refused before any SQL is built; table IDs and index
//   names come from the store's catalog and its planner; field names
//   reach SQL only through the shared emitter, as identifiers inside JSON
//   paths; every value is a bound parameter.
// - A query scans without bound: every query reads through the index it
//   names (`INDEXED BY`, so SQLite fails rather than scans when the index
//   can't serve it), within the range checked against that index, and
//   examines at most `queryMaxScannedEntries` entries and
//   `queryMaxScannedBytes` of documents (`data.scan_limit`, never a
//   partial answer). `collect` fails past 100 records rather than
//   truncating. A descriptor's own size is bounded at the boundary (its
//   filter's depth, nodes and lists, and 64 bound values in all), so its
//   statement stays within SQLite's expression and parameter limits.
// - A condition drops a record through SQL NULL: conditions are emitted
//   two-valued (store-expressions.ts), so `NOT` keeps records whose field
//   is null or left out, and comparisons never reach them.
// - A pinned consumer reads fields its schema doesn't know, or misses one
//   it relies on: documents are projected to the pinned table's fields,
//   with their defaults where a stored record lacks one (spec 32.7).
// - A caller reads a schema the store doesn't hold, or claims a role: the
//   schema hash and roles are core's (`ReadScope`), and an unknown hash is
//   refused (`data.unknown_schema`).
//
// What this module trusts, and who answers for it:
//
// - `ReadScope` (principal, roles, schema hash, consumer) is taken as
//   given: only core holds the store's binding, and core must build the
//   scope for each invocation from its own records, never from what App
//   code sends. That is a hard requirement on the operation boundary
//   (GRA-244).
// - An older schema's access is the access a read under its hash gets: a
//   table tightened from `appMembers` to `owner` in a newer schema is
//   still read by members under the older hash. So the hash must be the
//   consumer's own pinned manifest's (GRA-244), and a hash a newer
//   access mode superseded must be retired once no consumer is pinned to
//   it (GRA-246); this store keeps every hash it was handed until then.

/** A store's record of one schema: what reads pinned to it are checked by. */
export interface PinnedSchema {
  readonly manifest: SchemaManifest;
  /** Each table's ID in this store, by name. */
  readonly tableIds: Readonly<Record<string, string>>;
  /** The physical index of each declared index, by table and name. */
  readonly indexes: ReadonlyMap<string, ReadonlyMap<string, PhysicalIndex>>;
}

/** A record as a read returns it: managed fields, then declared ones. */
export type ReadDocument = Record<string, unknown>;

/** The managed fields a read compares, with their base types. */
const managedBases: Readonly<Record<string, IndexBase>> = {
  _id: "string",
  _ownerId: "string",
  _rev: "number",
  _createdAt: "number",
  _updatedAt: "number",
};

const invalid = (issue: string): Error =>
  dataErrors.create("data.invalid_query", { issues: [issue] });

/** A table of the pinned schema, and whether it is read by owner only. */
export interface ReadTable {
  readonly name: string;
  readonly tableId: string;
  readonly declared: ManifestTable;
  readonly ownerScoped: boolean;
}

/**
 * Table `name` of the pinned schema, if the caller may read it: refused
 * when the schema has no such table (`data.unknown_table`) or the caller
 * isn't who its read mode admits (`data.access_denied`).
 */
export const readableTable = (
  pinned: PinnedSchema,
  scope: ReadScope,
  name: string
): ReadTable => {
  const declared = Object.hasOwn(pinned.manifest.tables, name)
    ? pinned.manifest.tables[name]
    : undefined;
  const tableId = Object.hasOwn(pinned.tableIds, name)
    ? pinned.tableIds[name]
    : undefined;
  if (declared === undefined || tableId === undefined) {
    throw dataErrors.create("data.unknown_table", { table: name });
  }
  const mode = declared.access.read;
  const admitted =
    mode === "owner" ||
    (mode === "appMembers" && (scope.appMember || scope.appBuilder)) ||
    (mode === "appBuilders" && scope.appBuilder);
  if (!admitted) {
    throw dataErrors.create("data.access_denied", { table: name });
  }
  return { name, tableId, declared, ownerScoped: mode === "owner" };
};

/** The types of `table`'s fields, as the emitter checks conditions by. */
const typesOf = (table: ReadTable): FieldTypes => {
  const declared = (field: string) =>
    Object.hasOwn(table.declared.fields, field)
      ? table.declared.fields[field]
      : undefined;
  return {
    base: (field) => {
      if (isManagedField(field)) {
        return managedBases[field];
      }
      const descriptor = declared(field);
      return descriptor === undefined ? undefined : indexBase(descriptor);
    },
    nullable: (field) => {
      const descriptor = isManagedField(field) ? undefined : declared(field);
      return descriptor !== undefined && allowsNull(descriptor);
    },
  };
};

/** What a query reads through: its index, range terms and order. */
export interface Access {
  readonly index: string;
  /** The range's terms, after the table and owner predicates. */
  readonly where: Fragment;
  /** The columns it is ordered by, past those its range holds equal. */
  readonly order: readonly string[];
}

/**
 * How `query` reads `table`: through its declared index, within a range
 * that holds its first fields equal and bounds the next (its shape was
 * checked at the boundary; here, that its fields are the index's, in
 * order), or through the default order when it names none, and then no
 * range.
 */
const accessOf = (
  pinned: PinnedSchema,
  table: ReadTable,
  query: QueryRequest
): Access => {
  if (query.index === null) {
    if (query.range.length > 0) {
      throw invalid("A range bounds a declared index; this query names none");
    }
    return {
      index: defaultIndexName(table.ownerScoped),
      where: { sql: "", params: [] },
      order: ["created_at", "record_id"],
    };
  }
  const index = pinned.indexes.get(table.name)?.get(query.index);
  if (index === undefined) {
    throw dataErrors.create("data.unknown_index", {
      table: table.name,
      index: query.index,
    });
  }
  const types = typesOf(table);
  const equal = query.range.filter(({ op }) => op === "eq");
  const bounded = query.range.slice(equal.length);
  const terms: Fragment[] = [];
  for (const [position, bound] of equal.entries()) {
    if (bound.field !== index.fields[position]) {
      throw invalid("An index range bounds the index's fields in order");
    }
    terms.push(rangeSql(types, bound.field, [bound]));
  }
  const [first] = bounded;
  if (first !== undefined) {
    if (first.field !== index.fields[equal.length]) {
      throw invalid("An index range bounds the index's fields in order");
    }
    terms.push(rangeSql(types, first.field, bounded));
  }
  return {
    index: index.name,
    where: {
      sql: terms.map(({ sql }) => sql).join(" AND "),
      params: terms.flatMap(({ params }) => params),
    },
    order: [
      ...index.fields
        .slice(equal.length)
        .map((field) => fieldExpression(field)),
      "record_id",
    ],
  };
};

/** A record's row, as a read selects it. */
export interface ReadRow extends Record<string, SqlStorageValue> {
  record_id: string;
  owner_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

/** Each union member's validator, made once per descriptor. */
const validators = new WeakMap<
  ValueDescriptor,
  ReturnType<typeof schemaFromDescriptor>
>();

/** Whether `value` is valid under `descriptor`, as the SDK checks it. */
const validates = (descriptor: ValueDescriptor, value: unknown): boolean => {
  let schema = validators.get(descriptor);
  if (schema === undefined) {
    schema = schemaFromDescriptor(JSON.stringify(descriptor));
    validators.set(descriptor, schema);
  }
  const checked = schema["~standard"].validate(value);
  return !(checked instanceof Promise) && checked.issues === undefined;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` is of the JSON shape `descriptor` describes, by kind. */
const shapeFits = (value: unknown, descriptor: ValueDescriptor): boolean => {
  if (descriptor.kind === "object" || descriptor.kind === "record") {
    return isPlainObject(value);
  }
  if (descriptor.kind === "array") {
    return Array.isArray(value);
  }
  return !isPlainObject(value) && !Array.isArray(value);
};

/**
 * `value` as `descriptor` (a pinned schema's) has it, at every depth:
 * objects keep only the keys they declare, with their defaults where a
 * defaulted key is missing; records, arrays and unions project what they
 * hold. Keys a later schema stored are left out, however deep (spec
 * 32.7); scalars are what they are.
 */
const projected = (value: unknown, descriptor: ValueDescriptor): unknown => {
  if (value === null) {
    return null;
  }
  if (descriptor.kind === "object") {
    if (!isPlainObject(value)) {
      return value;
    }
    const kept: Record<string, unknown> = {};
    for (const [field, declared] of Object.entries(descriptor.fields)) {
      if (Object.hasOwn(value, field)) {
        kept[field] = projected(value[field], declared);
      } else if (
        declared.presence === "default" &&
        declared.defaultValue !== undefined
      ) {
        kept[field] = declared.defaultValue;
      }
    }
    return kept;
  }
  if (descriptor.kind === "record") {
    return isPlainObject(value)
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            projected(item, descriptor.value),
          ])
        )
      : value;
  }
  if (descriptor.kind === "array") {
    return Array.isArray(value)
      ? value.map((item: unknown) => projected(item, descriptor.item))
      : value;
  }
  if (descriptor.kind === "union") {
    // The member the stored value itself fits, as the validator picks it
    // (the first that validates), so a smaller member never drops fields
    // of the one it was written as; failing that (it holds keys a later
    // schema added), the first member whose projection validates, then
    // the first of its shape.
    const candidates = descriptor.members.filter((member) =>
      shapeFits(value, member)
    );
    if (candidates.length <= 1) {
      const [only] = candidates;
      return only === undefined ? value : projected(value, only);
    }
    const fitting = candidates.find((member) => validates(member, value));
    if (fitting !== undefined) {
      return projected(value, fitting);
    }
    for (const member of candidates) {
      const projection = projected(value, member);
      if (validates(member, projection)) {
        return projection;
      }
    }
    return projected(value, candidates[0] ?? descriptor);
  }
  return value;
};

/** `stored` fields as the declared `fields` have them (`projected`). */
const projectedFields = (
  stored: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, ValueDescriptor>>
): Record<string, unknown> => {
  const projection = projected(stored, {
    descriptorVersion: 1,
    presence: "required",
    nullable: false,
    kind: "object",
    fields,
  });
  return isPlainObject(projection) ? projection : {};
};

/**
 * A stored record as the pinned table has it: its managed fields, then
 * its declared fields, projected at every depth (`projected`).
 */
const documentOf = (
  table: ReadTable,
  row: ReadRow,
  valueJson: string
): ReadDocument => ({
  _id: row.record_id,
  _ownerId: row.owner_id,
  _rev: row.revision,
  _createdAt: row.created_at,
  _updatedAt: row.updated_at,
  ...projectedFields(
    storedFieldsSchema.parse(JSON.parse(valueJson)),
    table.declared.fields
  ),
});

/** What the scan has seen, against its bounds. */
interface Scan {
  entries: number;
  bytes: number;
}

/** Counts one entry (and its document's bytes) against the scan's bounds. */
const scanned = (scan: Scan, bytes: number): void => {
  scan.entries += 1;
  scan.bytes += bytes;
  if (
    scan.entries > queryMaxScannedEntries ||
    scan.bytes > queryMaxScannedBytes
  ) {
    throw dataErrors.create("data.scan_limit", { scanned: scan.entries - 1 });
  }
};

/**
 * Answers `request`, a record by ID, for `scope` from `pinned`: the record
 * as the pinned table has it, or null when there is none the caller may
 * see. A different `expectedRevision` on one it may see is a conflict.
 */
export const readRecord = (
  sql: SqlStorage,
  pinned: PinnedSchema,
  scope: ReadScope,
  request: GetRequest
): ReadDocument | null => {
  const table = readableTable(pinned, scope, request.table);
  const owner = table.ownerScoped ? " AND owner_id = ?" : "";
  const params = table.ownerScoped
    ? [table.tableId, request.id, scope.principal]
    : [table.tableId, request.id];
  const [row] = sql
    .exec<ReadRow & { value_json: string }>(
      `SELECT record_id, owner_id, revision, created_at, updated_at, value_json FROM sdk_records WHERE table_id = ? AND record_id = ?${owner}`,
      ...params
    )
    .toArray();
  if (row === undefined) {
    return null;
  }
  if (
    request.expectedRevision !== null &&
    row.revision !== request.expectedRevision
  ) {
    throw dataErrors.create("data.conflict", {
      table: table.name,
      id: request.id,
    });
  }
  return documentOf(table, row, row.value_json);
};

/** What a terminal answers. */
export type QueryAnswer = ReadDocument[] | ReadDocument | number | null;

/** A query's one statement, ready to run: SQL, parameters and its table. */
interface Plan {
  readonly table: ReadTable;
  readonly statement: string;
  readonly params: readonly (string | number | null)[];
  /** Whether rows carry a `matched` column the filter computed. */
  readonly filtered: boolean;
}

/** What a plan selects, besides a record's managed fields. */
export interface PlanOptions {
  /** Whether the terminal needs documents. */
  readonly documents: boolean;
  /** The declared field an aggregate reads, as `agg`. */
  readonly aggregate?: string;
}

/**
 * The one statement `query` runs on `table` for `scope`: through the
 * index it names (`INDEXED BY`), the table, the owner when the table is
 * read by owner only and the index range in its WHERE, the filter as a
 * computed column, ordered along the index and limited to one entry past
 * the scan bound. Documents reach JavaScript only when the terminal needs
 * them; their size is counted whenever SQLite reads them.
 */
export const planQuery = (
  pinned: PinnedSchema,
  scope: ReadScope,
  table: ReadTable,
  query: QueryRequest,
  { documents, aggregate }: PlanOptions
): Plan => {
  const access = accessOf(pinned, table, query);
  const filter =
    query.filter === null ? null : filterSql(typesOf(table), query.filter);
  const direction = query.order === "desc" ? "DESC" : "ASC";
  const reads = documents || filter !== null || aggregate !== undefined;
  const columns = [
    "record_id",
    "owner_id",
    "revision",
    "created_at",
    "updated_at",
    ...(documents ? ["value_json"] : []),
    ...(reads ? ["length(CAST(value_json AS BLOB)) AS bytes"] : []),
    ...(filter === null ? [] : [`${filter.sql} AS matched`]),
    ...(aggregate === undefined
      ? []
      : [`${numberExpression(aggregate)} AS agg`]),
  ];
  const where = [
    `table_id = ${tableIdLiteral(table.tableId)}`,
    ...(table.ownerScoped ? ["owner_id = ?"] : []),
    ...(access.where.sql === "" ? [] : [access.where.sql]),
  ];
  const order = access.order.map((column) => `${column} ${direction}`);
  return {
    table,
    statement: `SELECT ${columns.join(", ")} FROM sdk_records INDEXED BY ${access.index} WHERE ${where.join(" AND ")} ORDER BY ${order.join(", ")} LIMIT ${queryMaxScannedEntries + 1}`,
    params: [
      ...(filter?.params ?? []),
      ...(table.ownerScoped ? [scope.principal] : []),
      ...access.where.params,
    ],
    filtered: filter !== null,
  };
};

/** A row a plan matched, with its document when the plan read it. */
export interface Match {
  readonly row: ReadRow;
  readonly valueJson: string | undefined;
}

/**
 * The rows `plan` matches, in order, as they are read: each entry counted
 * against the scan's bounds as it is read, so whoever stops early reads
 * no further, and whoever reads past a bound gets `data.scan_limit`.
 */
export const matchesOf = (
  sql: SqlStorage,
  plan: Plan
): IterableIterator<Match, undefined> => {
  const scan: Scan = { entries: 0, bytes: 0 };
  const cursor = sql.exec<
    ReadRow & { value_json?: string; bytes?: number; matched?: number }
  >(plan.statement, ...plan.params);
  const rows = cursor[Symbol.iterator]();
  const iterator: IterableIterator<Match, undefined> = {
    next: () => {
      for (let read = rows.next(); read.done !== true; read = rows.next()) {
        const row = read.value;
        scanned(scan, row.bytes ?? 0);
        if (!plan.filtered || row.matched === 1) {
          return { done: false, value: { row, valueJson: row.value_json } };
        }
      }
      return { done: true, value: undefined };
    },
    [Symbol.iterator]: () => iterator,
  };
  return iterator;
};

/** The first `limit` matches' documents, at most. */
export const documentsOf = (
  table: ReadTable,
  matches: Iterator<Match>,
  limit: number
): ReadDocument[] => {
  const documents: ReadDocument[] = [];
  while (documents.length < limit) {
    const next = matches.next();
    if (next.done === true) {
      break;
    }
    const { row, valueJson } = next.value;
    if (valueJson === undefined) {
      throw new Error("A plan for documents read none");
    }
    documents.push(documentOf(table, row, valueJson));
  }
  return documents;
};

/**
 * The sum, least or greatest value of the aggregated field over every
 * match, as SQLite read it (`agg`): values that are numbers only, never
 * null (the sentinel) or a field left out. A result that isn't finite
 * (a sum past the largest number) is refused, never answered.
 */
const aggregateOf = (
  operation: "sum" | "min" | "max",
  matches: Iterable<Match>
): number | null => {
  let sum = 0;
  let least: number | null = null;
  let greatest: number | null = null;
  for (const { row } of matches) {
    const value = row.agg;
    if (typeof value === "number" && Number.isFinite(value)) {
      sum += value;
      least = least === null ? value : Math.min(least, value);
      greatest = greatest === null ? value : Math.max(greatest, value);
    }
  }
  let result: number | null = sum;
  if (operation !== "sum") {
    result = operation === "min" ? least : greatest;
  }
  if (result !== null && !Number.isFinite(result)) {
    throw dataErrors.create("data.aggregate_overflow");
  }
  return result;
};

/** How many matches there are. */
const countOf = (matches: Iterable<Match>): number => {
  let count = 0;
  for (const _match of matches) {
    count += 1;
  }
  return count;
};

/**
 * Answers `query` for `scope` from `pinned`: one statement through the
 * index the query names, under the caller's access, bounded as the threat
 * model above says. `paginate` comes with cursors.
 */
export const runQuery = (
  sql: SqlStorage,
  pinned: PinnedSchema,
  scope: ReadScope,
  query: QueryRequest
): QueryAnswer => {
  const table = readableTable(pinned, scope, query.table);
  const { terminal } = query;
  const counting =
    terminal.kind === "count" ||
    (terminal.kind === "aggregate" && terminal.operation === "count");
  const plan = (): Plan =>
    planQuery(pinned, scope, table, query, { documents: !counting });
  switch (terminal.kind) {
    case "take": {
      // Planned even for none, so a query that isn't valid is refused.
      const planned = plan();
      return terminal.count === 0
        ? []
        : documentsOf(table, matchesOf(sql, planned), terminal.count);
    }
    case "first": {
      return documentsOf(table, matchesOf(sql, plan()), 1)[0] ?? null;
    }
    case "unique": {
      const found = documentsOf(table, matchesOf(sql, plan()), 2);
      if (found.length > 1) {
        throw dataErrors.create("data.not_unique", { table: table.name });
      }
      return found[0] ?? null;
    }
    case "collect": {
      const found = documentsOf(
        table,
        matchesOf(sql, plan()),
        queryMaxResults + 1
      );
      if (found.length > queryMaxResults) {
        throw dataErrors.create("data.result_limit", { table: table.name });
      }
      return found;
    }
    case "count": {
      return countOf(matchesOf(sql, plan()));
    }
    case "aggregate": {
      if (terminal.operation === "count") {
        return countOf(matchesOf(sql, plan()));
      }
      // Declared numeric fields only (spec 9.2), never a managed one.
      if (
        isManagedField(terminal.field) ||
        typesOf(table).base(terminal.field) !== "number"
      ) {
        throw invalid(
          `\`${terminal.field}\` isn't a declared numeric field of table \`${table.name}\``
        );
      }
      return aggregateOf(
        terminal.operation,
        matchesOf(
          sql,
          planQuery(pinned, scope, table, query, {
            documents: false,
            aggregate: terminal.field,
          })
        )
      );
    }
    case "paginate": {
      throw invalid("`paginate` isn't available yet");
    }
    default: {
      return terminal satisfies never;
    }
  }
};
