import { z } from "zod";

import { identifierSchema } from "./ids.ts";
import {
  cursorMaxLength,
  filterMaxNodes,
  queryMaxScannedEntries,
  rangeMaxBounds,
  searchMaxTerms,
  storeNameMaxLength,
  storeNamePattern,
} from "./store-limits.ts";
import {
  boundValuesIssue,
  filterBudgetIssue,
  rangeShapeIssue,
  readDescriptorVersion,
  searchTerms,
} from "./store-reads.ts";
import type {
  FilterNode,
  GetRequest,
  QueryRequest,
  QueryTerminal,
  RangeBound,
  ReadRequest,
  WriteFields,
  WriteRequest,
} from "./store-reads.ts";
import { callerTeamsSchema } from "./stores.ts";

// The host's schema of a read (store-reads.ts has the shapes and what
// they mean): how a store checks a descriptor App code built, trusting
// nothing in it. Bounds that recursion could be made to overrun are
// checked first, iteratively, before any recursive reading.

export type {
  FilterCondition,
  FilterNode,
  GetRequest,
  GroupTerminal,
  QueryRequest,
  QueryScalar,
  QueryTerminal,
  RangeBound,
  RangeOperator,
  ReadRequest,
  WriteFields,
  WriteRequest,
} from "./store-reads.ts";

/** A finite JSON scalar: what a descriptor may compare a field with. */
const scalarSchema = z.union([
  z.string(),
  z.number().refine(Number.isFinite, "A finite number"),
  z.boolean(),
  z.null(),
]);

/**
 * A field a range or filter names: a declared field, or one of the
 * managed fields a read may compare.
 */
const fieldSchema = z
  .string()
  .max(storeNameMaxLength)
  .regex(
    /^(?:_id|_ownerId|_createdAt|_updatedAt|[A-Za-z][A-Za-z0-9_]*)$/u,
    "A declared field, or `_id`, `_ownerId`, `_createdAt` or `_updatedAt`"
  );

/** A table or index name, as the App's schema gives it. */
const nameSchema = z
  .string()
  .max(storeNameMaxLength)
  .regex(storeNamePattern, "A letter, then letters, digits or underscores");

const rangeBoundSchema = z.strictObject({
  field: fieldSchema,
  op: z.enum(["eq", "gt", "gte", "lt", "lte"]),
  value: scalarSchema,
}) satisfies z.ZodType<RangeBound>;

/**
 * A range: its length checked before any bound is read, then each bound,
 * then the shape of an index range.
 */
const rangeSchema = z
  .unknown()
  .transform((value, context) => {
    if (Array.isArray(value) && value.length > rangeMaxBounds) {
      context.addIssue({
        code: "custom",
        message: `An index range holds at most ${rangeMaxBounds} bounds`,
      });
      return z.NEVER;
    }
    return value;
  })
  .pipe(z.array(rangeBoundSchema))
  .superRefine((range, context) => {
    const issue = rangeShapeIssue(range);
    if (issue !== undefined) {
      context.addIssue({ code: "custom", message: issue });
    }
  });

const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.strictObject({
      and: z.array(filterNodeSchema).min(1).max(filterMaxNodes),
    }),
    z.strictObject({
      or: z.array(filterNodeSchema).min(1).max(filterMaxNodes),
    }),
    z.strictObject({ not: filterNodeSchema }),
    z.strictObject({
      field: fieldSchema,
      op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
      value: scalarSchema,
    }),
    z.strictObject({
      field: fieldSchema,
      op: z.literal("in"),
      values: z.array(scalarSchema),
    }),
    z.strictObject({
      field: fieldSchema,
      op: z.literal("exists"),
      value: z.boolean(),
    }),
  ])
);

/**
 * A filter: its depth, size and `in` lists checked iteratively first, and
 * read recursively only once they are within bounds.
 */
const filterSchema = z
  .unknown()
  .transform((value, context) => {
    const issue = filterBudgetIssue(value);
    if (issue !== undefined) {
      context.addIssue({ code: "custom", message: issue });
      return z.NEVER;
    }
    return value;
  })
  .pipe(filterNodeSchema);

const terminalSchema = z.union([
  z.strictObject({
    kind: z.literal("take"),
    count: z.number().int().min(0).max(queryMaxScannedEntries),
  }),
  z.strictObject({ kind: z.literal("first") }),
  z.strictObject({ kind: z.literal("unique") }),
  z.strictObject({ kind: z.literal("count") }),
  z.strictObject({ kind: z.literal("collect") }),
  z.strictObject({
    kind: z.literal("paginate"),
    pageSize: z.number().int().min(1).max(queryMaxScannedEntries),
    cursor: z.string().min(1).max(cursorMaxLength).nullable(),
    endCursor: z.string().min(1).max(cursorMaxLength).nullable(),
  }),
  z.strictObject({
    kind: z.literal("aggregate"),
    operation: z.literal("count"),
  }),
  z.strictObject({
    kind: z.literal("aggregate"),
    operation: z.enum(["sum", "min", "max"]),
    field: fieldSchema,
  }),
  z
    .strictObject({
      kind: z.literal("group"),
      by: z.array(nameSchema).min(1),
      sum: z.array(nameSchema),
      avg: z.array(nameSchema),
      min: z.array(nameSchema),
      max: z.array(nameSchema),
    })
    .superRefine(({ kind: _kind, ...lists }, context) => {
      // Each field once per list, so no list holds more than the table's
      // declared fields, however long a descriptor is.
      for (const [list, names] of Object.entries(lists)) {
        if (new Set(names).size !== names.length) {
          context.addIssue({
            code: "custom",
            message: `A grouped read names each field once in \`${list}\``,
          });
        }
      }
    }),
]) satisfies z.ZodType<QueryTerminal>;

export const queryRequestSchema = z
  .strictObject({
    descriptorVersion: z.literal(readDescriptorVersion),
    table: nameSchema,
    index: nameSchema.nullable(),
    range: rangeSchema,
    filter: filterSchema.nullable(),
    order: z.enum(["asc", "desc"]),
    terminal: terminalSchema,
    search: z.string().optional(),
    with: z.array(nameSchema).min(1).optional(),
  })
  .superRefine(({ range, filter, search, terminal }, context) => {
    const issue = boundValuesIssue(range, filter);
    if (issue !== undefined) {
      context.addIssue({ code: "custom", message: issue });
    }
    if (search !== undefined && searchTerms(search).length > searchMaxTerms) {
      context.addIssue({
        code: "custom",
        message: `A search looks for at most ${searchMaxTerms} words`,
      });
    }
    if (search !== undefined && terminal.kind === "group") {
      context.addIssue({
        code: "custom",
        message: "A search answers records, never groups",
      });
    }
  }) satisfies z.ZodType<QueryRequest>;

export const getRequestSchema = z.strictObject({
  table: nameSchema,
  id: identifierSchema,
}) satisfies z.ZodType<GetRequest>;

/** One read, as its request crosses RPC: checked again by the store. */
export const readRequestSchema = z.discriminatedUnion("kind", [
  getRequestSchema.extend({ kind: z.literal("get") }),
  z.strictObject({ kind: z.literal("query"), query: queryRequestSchema }),
]) satisfies z.ZodType<ReadRequest>;

/**
 * Whom a read is for, as core resolves it for the invocation and hands
 * the store: never anything App code supplies. The schema the caller is
 * pinned to (its tables, indexes and access modes are the store's own
 * record of it), the person, whether they are a member or a builder of
 * the App the read comes through (what `appMembers` and `appBuilders`
 * tables require), and that App and version, which a cursor is bound to.
 */
export const readScopeSchema = z.strictObject({
  schemaHash: z.string().regex(/^[0-9a-f]{64}$/u),
  principal: identifierSchema,
  appMember: z.boolean(),
  appBuilder: z.boolean(),
  /** The teams the reader is in, for `team` row rules (`writerRolesSchema`). */
  teams: callerTeamsSchema,
  consumer: z.strictObject({
    resourceId: identifierSchema,
    resourceVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
});
export type ReadScope = z.infer<typeof readScopeSchema>;

/**
 * A write's fields: an object, whose names and values the operation host
 * then checks against the pinned schema's fields.
 */
const writeFieldsSchema = z.custom<WriteFields>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Reflect.getPrototypeOf(value) === Object.prototype ||
      Reflect.getPrototypeOf(value) === null),
  { message: "An object of fields" }
);

/**
 * One write a mutation stages, as it crosses from App code to core's
 * operation host: checked for its shape here, and then against the pinned
 * schema, the caller's access and the store.
 */
export const writeRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("insert"),
    table: nameSchema,
    fields: writeFieldsSchema,
  }),
  z.strictObject({
    kind: z.literal("patch"),
    table: nameSchema,
    id: identifierSchema,
    fields: writeFieldsSchema,
    unset: z.array(nameSchema).max(64),
  }),
  z.strictObject({
    kind: z.literal("replace"),
    table: nameSchema,
    id: identifierSchema,
    fields: writeFieldsSchema,
  }),
  z.strictObject({
    kind: z.literal("delete"),
    table: nameSchema,
    id: identifierSchema,
  }),
]) satisfies z.ZodType<WriteRequest>;
