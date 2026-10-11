import { z } from "zod";

import {
  cursorMaxLength,
  filterMaxDepth,
  filterMaxInValues,
  filterMaxNodes,
  queryMaxResults,
  storeNameMaxLength,
  storeNamePattern,
} from "./store-limits.ts";

// A read of a business store, as it crosses from App code to the store's
// host: a record by ID, or a query's descriptor, which the SDK's query
// builder (sdk/src/database.ts) makes and the host executes. A descriptor
// is data and nothing else: names as the App's schema gives them, values,
// and the terminal asked for. It never holds SQL, a table's or an index's
// physical ID, an owner or a role: the host resolves names through the
// schema the caller is pinned to, and applies the caller's access itself.

/** A value a range or filter compares with: a JSON scalar. */
export type QueryScalar = string | number | boolean | null;

/** A finite JSON scalar: what a descriptor may compare a field with. */
const scalarSchema = z.union([
  z.string().max(4096),
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
  .max(storeNameMaxLength + 1)
  .regex(
    /^(?:_id|_ownerId|_rev|_createdAt|_updatedAt|[A-Za-z][A-Za-z0-9_]*)$/u,
    "A declared field, or `_id`, `_ownerId`, `_rev`, `_createdAt` or `_updatedAt`"
  );

/** A table or index name, as the App's schema gives it. */
const nameSchema = z
  .string()
  .max(storeNameMaxLength)
  .regex(storeNamePattern, "A letter, then letters, digits or underscores");

export type RangeOperator = "eq" | "gt" | "gte" | "lt" | "lte";

/** One bound of an index range, in the order the range was built. */
export interface RangeBound {
  field: string;
  op: RangeOperator;
  value: QueryScalar;
}

const rangeBoundSchema = z.strictObject({
  field: fieldSchema,
  op: z.enum(["eq", "gt", "gte", "lt", "lte"]),
  value: scalarSchema,
});

/**
 * A filter, as a tree: logic nodes, and conditions on one field each. The
 * SDK turns an author's filter object (`{ title: "a", AND: [...] }`) into
 * this form, so the host reads one shape.
 */
export type FilterNode =
  | { and: FilterNode[] }
  | { or: FilterNode[] }
  | { not: FilterNode }
  | {
      field: string;
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
      value: QueryScalar;
    }
  | { field: string; op: "in"; values: QueryScalar[] }
  | { field: string; op: "exists"; value: boolean };

const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(filterNodeSchema).max(filterMaxNodes) }),
    z.strictObject({ or: z.array(filterNodeSchema).max(filterMaxNodes) }),
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

/** The filters directly within a logic node; none for a condition. */
export const filterChildren = (node: FilterNode): readonly FilterNode[] => {
  if ("and" in node) {
    return node.and;
  }
  if ("or" in node) {
    return node.or;
  }
  return "not" in node ? [node.not] : [];
};

/** How deeply `node`'s logic nests, and how many nodes it has, all told. */
export const filterSize = (
  node: FilterNode
): { depth: number; nodes: number } => {
  const children = filterChildren(node);
  let depth = 0;
  let nodes = 1;
  for (const child of children) {
    const size = filterSize(child);
    depth = Math.max(depth, size.depth);
    nodes += size.nodes;
  }
  return { depth: depth + (children.length > 0 ? 1 : 0), nodes };
};

/** Whether `node` is within the bounds a filter has. */
const isBoundedFilter = (node: FilterNode): boolean => {
  const { depth, nodes } = filterSize(node);
  return depth <= filterMaxDepth && nodes <= filterMaxNodes;
};

/** What a query returns: its terminal, and that terminal's bounds. */
export type QueryTerminal =
  | { kind: "take"; count: number }
  | { kind: "first" }
  | { kind: "unique" }
  | { kind: "count" }
  | { kind: "collect" }
  | { kind: "paginate"; pageSize: number; cursor: string | null }
  | { kind: "aggregate"; operation: "count" }
  | { kind: "aggregate"; operation: "sum" | "min" | "max"; field: string };

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
]);

/**
 * A query: which table, through which index (null: the default order, by
 * creation time), the range on that index, a filter, the order and the
 * terminal.
 */
export interface QueryRequest {
  table: string;
  index: string | null;
  range: RangeBound[];
  filter: FilterNode | null;
  order: "asc" | "desc";
  terminal: QueryTerminal;
}

export const queryRequestSchema = z.strictObject({
  table: nameSchema,
  index: nameSchema.nullable(),
  // An index has at most 16 fields: every one equal, then a lower and an
  // upper bound on the next, at most.
  range: z.array(rangeBoundSchema).max(18),
  filter: filterNodeSchema
    .refine(isBoundedFilter, {
      message: `A filter nests at most ${filterMaxDepth} deep and holds at most ${filterMaxNodes} nodes`,
    })
    .nullable(),
  order: z.enum(["asc", "desc"]),
  terminal: terminalSchema,
});

/** A record by ID, optionally asserting the revision the caller expects. */
export interface GetRequest {
  table: string;
  id: string;
  expectedRevision: number | null;
}

export const getRequestSchema = z.strictObject({
  table: nameSchema,
  id: z.string().min(1).max(256),
  expectedRevision: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
});

/** One read App code asks of a store through `ctx.db`. */
export type ReadRequest =
  | ({ kind: "get" } & GetRequest)
  | { kind: "query"; query: QueryRequest };
