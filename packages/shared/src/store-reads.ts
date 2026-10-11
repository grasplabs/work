import {
  filterMaxDepth,
  filterMaxInValues,
  filterMaxNodes,
  rangeMaxBounds,
} from "./store-limits.ts";

// A read of a business store, as it crosses from App code to the store's
// host: a record by ID, or a query's descriptor, which the SDK's query
// builder (sdk/src/database.ts) makes and the host executes. A descriptor
// is data and nothing else: names as the App's schema gives them, values,
// and the terminal asked for. It never holds SQL, a table's or an index's
// physical ID, an owner or a role: the host resolves names through the
// schema the caller is pinned to, and applies the caller's access itself.
//
// The shapes and the structural checks live here, free of dependencies,
// so the SDK's reader (part of App bundles) shares them without Zod; the
// host's own schema of them is store-queries.ts.
//
// What conditions mean (two-valued: a record matches a condition or it
// doesn't, and no SQL NULL decides it). A field holds a value, holds an
// explicit null, or is left out; in order, left out < null < value.
// - `eq` with a value, `gt`, `gte`, `lt`, `lte` and `neq` match only a
//   record whose field holds a value: `neq: x` matches values other than
//   `x`, never null or a field left out.
// - `eq: null`, and `in` listing null, match an explicit null only, never
//   a field left out.
// - `exists: false` matches a field left out only; `exists: true`, null
//   or a value.
// - `not` is plain negation: `not` of `eq: "a"` matches every record
//   whose field isn't the value "a", null and left out included.
// - An index range's lower and upper bounds match values only, so an
//   upper bound never reaches null or a field left out; its equality
//   bounds mean what `eq` means.

/** The version of the descriptor format below. */
export const readDescriptorVersion = 1;

/** A value a range or filter compares with: a JSON scalar. */
export type QueryScalar = string | number | boolean | null;

export type RangeOperator = "eq" | "gt" | "gte" | "lt" | "lte";

/**
 * One bound of an index range, in the order the range was built:
 * equality on the index's first fields, then at most a lower and an
 * upper bound on the next. Lower and upper bounds match values only;
 * equality with null matches an explicit null only.
 */
export interface RangeBound {
  field: string;
  op: RangeOperator;
  value: QueryScalar;
}

/** One condition on one field, with the meaning the header gives it. */
export type FilterCondition =
  | {
      field: string;
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
      value: QueryScalar;
    }
  | { field: string; op: "in"; values: QueryScalar[] }
  | { field: string; op: "exists"; value: boolean };

/**
 * A filter, as a tree: `and` and `or` of at least one filter, `not` (plain
 * negation), and conditions on one field each. The SDK turns an author's
 * filter object (`{ title: "a", AND: [...] }`) into this form, so the host
 * reads one shape.
 */
export type FilterNode =
  | { and: FilterNode[] }
  | { or: FilterNode[] }
  | { not: FilterNode }
  | FilterCondition;

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

/**
 * A query: which table, through which index (null: the default order, by
 * creation time), the range on that index, a filter, the order and the
 * terminal.
 */
export interface QueryRequest {
  descriptorVersion: typeof readDescriptorVersion;
  table: string;
  index: string | null;
  range: RangeBound[];
  filter: FilterNode | null;
  order: "asc" | "desc";
  terminal: QueryTerminal;
}

/** A record by ID, optionally asserting the revision the caller expects. */
export interface GetRequest {
  table: string;
  id: string;
  expectedRevision: number | null;
}

/** One read App code asks of a store through `ctx.db`. */
export type ReadRequest =
  | ({ kind: "get" } & GetRequest)
  | { kind: "query"; query: QueryRequest };

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Why `value`, read as a filter tree, is past a filter's bounds (deeper
 * than `filterMaxDepth`, more than `filterMaxNodes` nodes, an `in` of more
 * than `filterMaxInValues`), or undefined if it isn't. Iterative, with an
 * explicit stack, and it stops at the first node past a bound: run it on
 * untrusted input before anything recursive reads or copies it, so no
 * input can exhaust the stack or the clock. It checks only the bounds;
 * the shape is the schema's.
 */
export const filterBudgetIssue = (value: unknown): string | undefined => {
  const tooMany = `A filter holds at most ${filterMaxNodes} nodes`;
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }];
  // Every node pushed, counted as it is pushed, so a wide list fails
  // before its members are visited.
  let nodes = 1;
  const push = (children: readonly unknown[], depth: number): boolean => {
    nodes += children.length;
    if (nodes > filterMaxNodes) {
      return false;
    }
    for (const child of children) {
      stack.push({ node: child, depth });
    }
    return true;
  };
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { node, depth } = next;
    if (depth > filterMaxDepth) {
      return `A filter nests at most ${filterMaxDepth} deep`;
    }
    if (!isObject(node)) {
      continue;
    }
    for (const key of ["and", "or"] as const) {
      const children = Object.hasOwn(node, key) ? node[key] : undefined;
      if (Array.isArray(children) && !push(children, depth + 1)) {
        return tooMany;
      }
    }
    if (Object.hasOwn(node, "not") && !push([node.not], depth + 1)) {
      return tooMany;
    }
    const values = Object.hasOwn(node, "values") ? node.values : undefined;
    if (Array.isArray(values) && values.length > filterMaxInValues) {
      return `An \`in\` lists at most ${filterMaxInValues} values`;
    }
  }
  return undefined;
};

const isLower = (op: RangeOperator): boolean => op === "gt" || op === "gte";

const isUpper = (op: RangeOperator): boolean => op === "lt" || op === "lte";

/**
 * Why `range` isn't shaped as an index range, or undefined if it is:
 * equalities first, each on a field of its own; then, on one more field,
 * at most a lower bound and then an upper bound; nothing after an upper
 * bound; at most `rangeMaxBounds` in all. Which fields an index has is
 * the host's to check against the pinned schema.
 */
export const rangeShapeIssue = (
  range: readonly RangeBound[]
): string | undefined => {
  if (range.length > rangeMaxBounds) {
    return `An index range holds at most ${rangeMaxBounds} bounds`;
  }
  const equal = new Set<string>();
  let position = 0;
  for (; position < range.length; position += 1) {
    const bound = range[position];
    if (bound === undefined || bound.op !== "eq") {
      break;
    }
    if (equal.has(bound.field)) {
      return "An index range holds each field equal once";
    }
    equal.add(bound.field);
  }
  const rest = range.slice(position);
  const [first, second, ...more] = rest;
  if (first === undefined) {
    return undefined;
  }
  const shaped =
    more.length === 0 &&
    !equal.has(first.field) &&
    (second === undefined
      ? isLower(first.op) || isUpper(first.op)
      : isLower(first.op) &&
        isUpper(second.op) &&
        second.field === first.field);
  return shaped
    ? undefined
    : "An index range is equality on the index's first fields, then a lower and/or an upper bound on the next one";
};
