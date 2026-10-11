import { z } from "zod";

import { identifierSchema } from "./ids.ts";
import {
  cursorMaxLength,
  filterMaxInValues,
  filterMaxNodes,
  queryMaxResults,
  queryMaxStringLength,
  rangeMaxBounds,
  storeNameMaxLength,
  storeNamePattern,
} from "./store-limits.ts";
import {
  boundValuesIssue,
  filterBudgetIssue,
  rangeShapeIssue,
  readDescriptorVersion,
} from "./store-reads.ts";
import type {
  FilterNode,
  GetRequest,
  QueryRequest,
  QueryTerminal,
  RangeBound,
  ReadRequest,
} from "./store-reads.ts";

// The host's schema of a read (store-reads.ts has the shapes and what
// they mean): how a store checks a descriptor App code built, trusting
// nothing in it. Bounds that recursion could be made to overrun are
// checked first, iteratively, before any recursive reading.

export type {
  FilterCondition,
  FilterNode,
  GetRequest,
  QueryRequest,
  QueryScalar,
  QueryTerminal,
  RangeBound,
  RangeOperator,
  ReadRequest,
} from "./store-reads.ts";

/** A finite JSON scalar: what a descriptor may compare a field with. */
const scalarSchema = z.union([
  z.string().max(queryMaxStringLength),
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
    /^(?:_id|_ownerId|_rev|_createdAt|_updatedAt|[A-Za-z][A-Za-z0-9_]*)$/u,
    "A declared field, or `_id`, `_ownerId`, `_rev`, `_createdAt` or `_updatedAt`"
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
      values: z.array(scalarSchema).max(filterMaxInValues),
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
    count: z.number().int().min(0).max(queryMaxResults),
  }),
  z.strictObject({ kind: z.literal("first") }),
  z.strictObject({ kind: z.literal("unique") }),
  z.strictObject({ kind: z.literal("count") }),
  z.strictObject({ kind: z.literal("collect") }),
  z.strictObject({
    kind: z.literal("paginate"),
    pageSize: z.number().int().min(1).max(queryMaxResults),
    cursor: z.string().min(1).max(cursorMaxLength).nullable(),
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
  })
  .superRefine(({ range, filter }, context) => {
    const issue = boundValuesIssue(range, filter);
    if (issue !== undefined) {
      context.addIssue({ code: "custom", message: issue });
    }
  }) satisfies z.ZodType<QueryRequest>;

export const getRequestSchema = z.strictObject({
  table: nameSchema,
  id: identifierSchema,
  expectedRevision: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
}) satisfies z.ZodType<GetRequest>;

/** One read, as its request crosses RPC: checked again by the store. */
export const readRequestSchema = z.discriminatedUnion("kind", [
  getRequestSchema.extend({ kind: z.literal("get") }),
  z.strictObject({ kind: z.literal("query"), query: queryRequestSchema }),
]) satisfies z.ZodType<ReadRequest>;
