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
  nullSentinel,
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
  /**
   * The fields it is ordered by, past those its range holds equal, the
   * record ID (`_id`) last.
   */
  readonly orderFields: readonly string[];
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
      orderFields: ["_createdAt", "_id"],
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
    orderFields: [...index.fields.slice(equal.length), "_id"],
  };
};

/**
 * What a read reads records through: SQLite's statements, and nothing
 * else of the store, so the host can tell whether a read ever ran one.
 */
export type RecordSql = Pick<SqlStorage, "exec">;

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

/** The keys each object-valued semantic kind holds (spec 32.1). */
const semanticKeys: Readonly<
  Partial<Record<ValueDescriptor["kind"], readonly string[]>>
> = {
  file: ["id"],
  money: ["minorUnits", "currency"],
  schedule: ["cron", "timeZone"],
};

/** A stored value no member of its pinned type can be shown as. */
const unprojectable = (): Error =>
  dataErrors.create("data.incompatible_record");

/** How a value is projected to a descriptor (`projected`). */
type Projection = (value: unknown, descriptor: ValueDescriptor) => unknown;

/**
 * An object's value as `fields` declare it: their keys only, each
 * projected (a key declared without a descriptor, as a semantic kind's
 * are, kept as stored), with defaults where a defaulted key is missing.
 */
const projectedObject = (
  value: unknown,
  fields: Readonly<Record<string, ValueDescriptor | undefined>>,
  project: Projection
): unknown => {
  if (Array.isArray(value)) {
    throw unprojectable();
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const shown: Record<string, unknown> = {};
  for (const [field, declared] of Object.entries(fields)) {
    if (Object.hasOwn(value, field)) {
      shown[field] =
        declared === undefined ? value[field] : project(value[field], declared);
    } else if (
      declared?.presence === "default" &&
      declared.defaultValue !== undefined
    ) {
      shown[field] = declared.defaultValue;
    }
  }
  return shown;
};

/**
 * A union's value as one of `members` has it: the member the stored value
 * itself is valid under, as the validator picks it (the first that
 * validates, whatever its kind, nested unions included), so a smaller
 * member never drops fields of the one it was written as; failing that
 * (it holds keys a later schema added), the first member whose projection
 * is valid; failing that, `data.incompatible_record`, never the value as
 * stored.
 */
const projectedUnion = (
  value: unknown,
  members: readonly ValueDescriptor[],
  project: Projection
): unknown => {
  const fitting = members.find((member) => validates(member, value));
  if (fitting !== undefined) {
    return project(value, fitting);
  }
  for (const member of members) {
    let projection: unknown;
    try {
      projection = project(value, member);
    } catch {
      continue;
    }
    if (validates(member, projection)) {
      return projection;
    }
  }
  throw unprojectable();
};

/**
 * `value` as `descriptor` (a pinned schema's) has it, at every depth:
 * objects keep only the keys they declare, with their defaults where a
 * defaulted key is missing, and so do the object-valued semantic kinds;
 * records, arrays and unions project what they hold. Keys a later schema
 * stored are left out, however deep (spec 32.7). A value that holds an
 * object or a list where its type holds neither, or that no member of a
 * union can be shown as, fails (`data.incompatible_record`) rather than
 * show what the pinned schema doesn't declare.
 */
const projected = (value: unknown, descriptor: ValueDescriptor): unknown => {
  if (value === null) {
    return null;
  }
  const kept = semanticKeys[descriptor.kind];
  if (descriptor.kind === "object" || kept !== undefined) {
    return projectedObject(
      value,
      descriptor.kind === "object"
        ? descriptor.fields
        : Object.fromEntries((kept ?? []).map((key) => [key, undefined])),
      projected
    );
  }
  if (descriptor.kind === "record") {
    if (!isPlainObject(value)) {
      throw unprojectable();
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        projected(item, descriptor.value),
      ])
    );
  }
  if (descriptor.kind === "array") {
    if (!Array.isArray(value)) {
      throw unprojectable();
    }
    return value.map((item: unknown) => projected(item, descriptor.item));
  }
  if (descriptor.kind === "union") {
    return projectedUnion(value, descriptor.members, projected);
  }
  if (isPlainObject(value) || Array.isArray(value)) {
    throw unprojectable();
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
export interface Scan {
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
  sql: RecordSql,
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

/**
 * One page, as `paginate` answers it: the last without a cursor, any
 * other with one (spec 9.2's page envelope).
 */
export type PageAnswer =
  | { items: ReadDocument[]; nextCursor: null; hasMore: false }
  | { items: ReadDocument[]; nextCursor: string; hasMore: true };

/** What a terminal answers. */
export type QueryAnswer =
  | ReadDocument[]
  | ReadDocument
  | PageAnswer
  | number
  | null;

/** A query's one statement, ready to run: SQL, parameters and its table. */
interface Plan {
  readonly table: ReadTable;
  readonly statement: string;
  readonly params: readonly (string | number | null)[];
  /** Whether rows carry a `matched` column the filter computed. */
  readonly filtered: boolean;
}

/**
 * Where a page starts after its cursor's anchor: terms that are top-level
 * conjuncts of the WHERE clause (an index range SQLite seeks to), and how
 * many of the leading order fields they hold equal, which the ORDER BY
 * leaves out, as SQLite only reads an expression index in order when it
 * does.
 */
export interface Seek {
  readonly terms: readonly Fragment[];
  readonly fixed: number;
}

/** What a plan selects, besides a record's managed fields. */
export interface PlanOptions {
  /** Whether the terminal needs documents. */
  readonly documents: boolean;
  /** The declared field an aggregate reads, as `agg`. */
  readonly aggregate?: string;
  /** Whether to select the order fields' values, as `o0`, `o1`, …. */
  readonly anchors?: boolean;
  readonly seek?: Seek;
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
  { documents, aggregate, anchors = false, seek }: PlanOptions
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
    ...(anchors
      ? access.orderFields.map(
          (field, position) => `${fieldExpression(field)} AS o${position}`
        )
      : []),
  ];
  const seekTerms = seek?.terms ?? [];
  const where = [
    `table_id = ${tableIdLiteral(table.tableId)}`,
    ...(table.ownerScoped ? ["owner_id = ?"] : []),
    ...[access.where, ...seekTerms]
      .map(({ sql }) => sql)
      .filter((term) => term !== ""),
  ];
  const order = access.orderFields
    .slice(seek?.fixed ?? 0)
    .map((field) => `${fieldExpression(field)} ${direction}`);
  return {
    table,
    statement: `SELECT ${columns.join(", ")} FROM sdk_records INDEXED BY ${access.index} WHERE ${where.join(" AND ")} ORDER BY ${order.join(", ")} LIMIT ${queryMaxScannedEntries + 1}`,
    params: [
      ...(filter?.params ?? []),
      ...(table.ownerScoped ? [scope.principal] : []),
      ...access.where.params,
      ...seekTerms.flatMap(({ params }) => params),
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
  sql: RecordSql,
  plan: Plan,
  shared?: Scan
): IterableIterator<Match, undefined> => {
  // A scan of its own unless the caller's spans several statements.
  const scan: Scan = shared ?? { entries: 0, bytes: 0 };
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
 * An order field's value at a page's anchor: left out (`[]`), an explicit
 * null (`[null]`) or a value, as the field's expression gives it.
 */
export type AnchorValue = [] | [null] | [string | number];

/**
 * Where a page ends, for the next to start after: the last record's ID
 * and, when they fit in a cursor, its order fields' values. Without them,
 * the next page looks the record up again.
 */
export interface Anchor {
  readonly id: string;
  readonly values?: readonly AnchorValue[];
}

/** One page: its records, whether more follow, and its last record's anchor. */
export interface PageRead {
  readonly items: ReadDocument[];
  readonly hasMore: boolean;
  readonly last: Required<Anchor> | undefined;
}

/** An order field's value as SQLite read it, as an anchor holds it. */
const anchorValueOf = (value: SqlStorageValue | undefined): AnchorValue => {
  if (value === null || value === undefined) {
    return [];
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return [null];
  }
  if (typeof value === "number" || typeof value === "string") {
    return [value];
  }
  throw new Error("An order field read as bytes");
};

/** `expression` equal to an anchor's value, as SQLite reads the index. */
const sameAs = (expression: string, value: AnchorValue): Fragment => {
  if (value.length === 0) {
    return { sql: `${expression} IS NULL`, params: [] };
  }
  const [held] = value;
  return held === null
    ? { sql: `${expression} = ${nullSentinel}`, params: [] }
    : { sql: `${expression} = ?`, params: [held] };
};

/**
 * What comes strictly after an anchor's value of one order field, in the
 * index's order, as terms SQLite seeks by, each with how many more
 * fields it holds equal. SQLite sorts NULL (a field left out) first, then
 * the null sentinel, then values, so ascending, after a field left out
 * comes anything not NULL; descending, after a value come lesser values
 * (the sentinel among them), then NULL, in two steps.
 */
const afterOf = (
  field: string,
  value: AnchorValue,
  direction: "asc" | "desc"
): { term: Fragment; fixes: number }[] => {
  const expression = fieldExpression(field);
  // A managed field is a column that is never NULL: no step for a field
  // left out.
  const leftOut = isManagedField(field)
    ? []
    : [{ term: { sql: `${expression} IS NULL`, params: [] }, fixes: 1 }];
  if (value.length === 0) {
    // Ascending, every held value comes after, and `>=` the sentinel is
    // an index range over exactly those (never a walk over the field's
    // left-out entries); descending, nothing does.
    return direction === "asc"
      ? [
          {
            term: { sql: `${expression} >= ${nullSentinel}`, params: [] },
            fixes: 0,
          },
        ]
      : [];
  }
  const [held] = value;
  if (held === null) {
    return direction === "asc"
      ? [
          {
            term: { sql: `${expression} > ${nullSentinel}`, params: [] },
            fixes: 0,
          },
        ]
      : leftOut;
  }
  return direction === "asc"
    ? [{ term: { sql: `${expression} > ?`, params: [held] }, fixes: 0 }]
    : [
        { term: { sql: `${expression} < ?`, params: [held] }, fixes: 0 },
        ...leftOut,
      ];
};

/**
 * The seeks that read, in order, every entry after `anchor`: first those
 * equal to it in every order field with a later record ID, then, field by
 * field from the last, those equal in the fields before it and after it
 * in this one. Each seek is one index range, so a page costs what it
 * reads, however deep it is.
 */
const seeksAfter = (
  orderFields: readonly string[],
  values: readonly AnchorValue[],
  id: string,
  direction: "asc" | "desc"
): Seek[] => {
  const fields = orderFields.slice(0, -1);
  if (values.length !== fields.length) {
    throw dataErrors.create("data.cursor_expired");
  }
  const equal = (count: number): Fragment[] =>
    fields
      .slice(0, count)
      .map((field, position) =>
        sameAs(fieldExpression(field), values[position] ?? [])
      );
  const seeks: Seek[] = [
    {
      terms: [
        ...equal(fields.length),
        {
          sql: `record_id ${direction === "asc" ? ">" : "<"} ?`,
          params: [id],
        },
      ],
      fixed: fields.length,
    },
  ];
  for (let position = fields.length - 1; position >= 0; position -= 1) {
    const field = fields[position] ?? "_id";
    for (const { term, fixes } of afterOf(
      field,
      values[position] ?? [],
      direction
    )) {
      seeks.push({
        terms: [...equal(position), term],
        fixed: position + fixes,
      });
    }
  }
  return seeks;
};

/**
 * The order fields' values of record `id` as the caller may see it, for a
 * cursor that carried only the ID; `data.cursor_expired` when the record
 * is gone.
 */
const anchorValuesOf = (
  sql: RecordSql,
  table: ReadTable,
  scope: ReadScope,
  orderFields: readonly string[],
  id: string
): AnchorValue[] => {
  const fields = orderFields.slice(0, -1);
  const columns = fields.map(
    (field, position) => `${fieldExpression(field)} AS o${position}`
  );
  const [row] = sql
    .exec(
      `SELECT ${["record_id", ...columns].join(", ")} FROM sdk_records WHERE table_id = ? AND record_id = ?${table.ownerScoped ? " AND owner_id = ?" : ""}`,
      table.tableId,
      id,
      ...(table.ownerScoped ? [scope.principal] : [])
    )
    .toArray();
  if (row === undefined) {
    throw dataErrors.create("data.cursor_expired");
  }
  return fields.map((_field, position) => anchorValueOf(row[`o${position}`]));
};

/**
 * The statements a page of `query` runs after `anchor` (or from the start),
 * in order: one per seek, each an index range of its own.
 */
export const pagePlans = (
  sql: RecordSql,
  pinned: PinnedSchema,
  scope: ReadScope,
  query: QueryRequest,
  anchor: Anchor | null
): Plan[] => {
  const table = readableTable(pinned, scope, query.table);
  const { orderFields } = accessOf(pinned, table, query);
  // A cursor that carries only the record ID has its anchor read first, so
  // a page that then fails with `data.index_required` has read a record,
  // carries its table's generation (store-host.ts) and may rerun under
  // commits. Accepted: only a damaged store lacks its indexes.
  const seeks: (Seek | undefined)[] =
    anchor === null
      ? [undefined]
      : seeksAfter(
          orderFields,
          anchor.values ??
            anchorValuesOf(sql, table, scope, orderFields, anchor.id),
          anchor.id,
          query.order
        );
  return seeks.map((seek) =>
    planQuery(pinned, scope, table, query, {
      documents: true,
      anchors: true,
      seek,
    })
  );
};

/**
 * One page of `query` (a `paginate` terminal) for `scope` from `pinned`,
 * after `anchor` or from the start: at most `pageSize` records in order,
 * one more read to know whether more follow, and the last record's anchor
 * for the next page's cursor. Keyset paging: a record changed between
 * pages may move past or into a later page, as spec 9.2 allows; the
 * bounds of every other terminal apply across all of a page's seeks.
 */
export const readPage = (
  sql: RecordSql,
  pinned: PinnedSchema,
  scope: ReadScope,
  query: QueryRequest,
  anchor: Anchor | null
): PageRead => {
  const { terminal } = query;
  if (terminal.kind !== "paginate") {
    throw new Error("Not a page");
  }
  const table = readableTable(pinned, scope, query.table);
  const { orderFields } = accessOf(pinned, table, query);
  const scan: Scan = { entries: 0, bytes: 0 };
  const found: Match[] = [];
  for (const plan of pagePlans(sql, pinned, scope, query, anchor)) {
    if (found.length > terminal.pageSize) {
      break;
    }
    for (const match of matchesOf(sql, plan, scan)) {
      found.push(match);
      if (found.length > terminal.pageSize) {
        break;
      }
    }
  }
  const page = found.slice(0, terminal.pageSize);
  const lastMatch = page.at(-1);
  return {
    items: page.map(({ row, valueJson }) =>
      documentOf(table, row, valueJson ?? "{}")
    ),
    hasMore: found.length > terminal.pageSize,
    last:
      lastMatch === undefined
        ? undefined
        : {
            id: lastMatch.row.record_id,
            values: orderFields
              .slice(0, -1)
              .map((_field, position) =>
                anchorValueOf(lastMatch.row[`o${position}`])
              ),
          },
  };
};

/**
 * Answers `query` for `scope` from `pinned`: one statement through the
 * index the query names, under the caller's access, bounded as the threat
 * model above says. A page is read with `readPage`.
 */
export const runQuery = (
  sql: RecordSql,
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
      // Pages carry cursors, which the host signs (`StoreHost.read`).
      throw new Error("A page is read with `readPage`");
    }
    default: {
      return terminal satisfies never;
    }
  }
};
