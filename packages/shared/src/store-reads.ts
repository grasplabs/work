import { isRecord } from "./json.ts";
import {
  filterMaxDepth,
  filterMaxNodes,
  queryMaxBoundValues,
  rangeMaxBounds,
} from "./store-limits.ts";

// A read of a business store, as it crosses from App code to the store's
// host: a record by ID, or a query's descriptor, which the SDK's query
// builder (runtime/src/database-reader.ts) makes and the host executes. A descriptor
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
//   `x`, never null or a field left out, and `neq: null` matches any
//   value.
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
  | {
      kind: "paginate";
      pageSize: number;
      cursor: string | null;
      /** Where the page ends, whatever `pageSize` says (a live list's). */
      endCursor: string | null;
    }
  | { kind: "aggregate"; operation: "count" }
  | { kind: "aggregate"; operation: "sum" | "min" | "max"; field: string }
  | GroupTerminal;

/**
 * A grouped aggregate: the records counted per distinct value of one or
 * two scalar fields (`by`), with the sum, average, least or greatest of
 * declared numeric fields in each group besides. A group's key holds each
 * `by` field's value, null for an explicit null, and leaves out a field
 * the group's records leave out.
 */
export interface GroupTerminal {
  kind: "group";
  by: string[];
  sum: string[];
  avg: string[];
  min: string[];
  max: string[];
}

/**
 * A query: which table, through which index (null: the default order, by
 * creation time), the range on that index, a filter, the order and the
 * terminal. With `search`, it reads the table's search index instead, in
 * order of relevance, with no index, range or order of its own. With
 * `with`, each record it returns carries the records its `v.id` fields
 * name.
 */
export interface QueryRequest {
  descriptorVersion: typeof readDescriptorVersion;
  table: string;
  index: string | null;
  range: RangeBound[];
  filter: FilterNode | null;
  order: "asc" | "desc";
  terminal: QueryTerminal;
  /** The text to look for in the table's search index. */
  search?: string;
  /** The fields whose related records each returned record carries. */
  with?: string[];
}

/** A record by ID. */
export interface GetRequest {
  table: string;
  id: string;
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

/**
 * Why `value`, read as a filter tree, is past a filter's bounds (deeper
 * than `filterMaxDepth`, more than `filterMaxNodes` nodes), or undefined
 * if it isn't. Iterative, with an
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
    if (!isRecord(node)) {
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

/** How many values `node` binds as SQL parameters, counted iteratively. */
const filterBoundValues = (node: FilterNode): number => {
  let values = 0;
  const stack: FilterNode[] = [node];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    stack.push(...filterChildren(next));
    if (!("field" in next)) {
      continue;
    }
    if (next.op === "in") {
      // The list's values, null aside, bind as one JSON value.
      values += next.values.some((value) => value !== null) ? 1 : 0;
    } else if (next.op !== "exists" && next.value !== null) {
      values += 1;
    }
  }
  return values;
};

/**
 * Why a query's range and filter together bind more values than
 * `queryMaxBoundValues`, or undefined if they don't: what keeps a store's
 * statement within its SQLite's parameter limit.
 */
export const boundValuesIssue = (
  range: readonly RangeBound[],
  filter: FilterNode | null
): string | undefined => {
  const values =
    range.filter(({ value }) => value !== null).length +
    (filter === null ? 0 : filterBoundValues(filter));
  return values > queryMaxBoundValues
    ? `A query's range and filter compare with at most ${queryMaxBoundValues} values (an \`in\` counts once)`
    : undefined;
};

// A write of a business store, as it crosses from a mutation's App code to
// core's function host: one staged change at a time, which the host
// validates against the pinned schema (defaults on insert, never on
// patch), authorizes and keeps until the commit. It never holds a record
// ID for an insert (the host mints it), a managed field, an owner, a role
// or a receipt.

/** Fields of a record as App code writes them: JSON, keyed by field. */
export type WriteFields = Record<string, unknown>;

/** One write a mutation stages through `ctx.db`. */
export type WriteRequest =
  | { kind: "insert"; table: string; fields: WriteFields }
  | {
      kind: "patch";
      table: string;
      id: string;
      fields: WriteFields;
      unset: string[];
    }
  | { kind: "replace"; table: string; id: string; fields: WriteFields }
  | { kind: "delete"; table: string; id: string };

// The combining accents unicode61 keeps inside a word, then drops, when it
// removes diacritics (`remove_diacritics 2`): SQLite's own table of them
// (`sqlite3Fts5UnicodeIsdiacritic`). So decomposed "cafe\u0301s" is one
// word, "cafes", as its precomposed form is. Every other mark splits:
// the rest of U+0300 to U+036F, spacing marks (Mc, such as Devanagari's
// vowel signs), viramas and enclosing marks.

/**
 * What separates a search's words: anything but a letter, a number, a
 * private-use character or one of the accents above (the last ranges),
 * the token classes of the full-text index's unicode61 tokenizer. So
 * `INV-2024-001` is three words here as it is three tokens there, and a
 * search's words are what FTS5 reads (`searchMaxTerms`), however they
 * are joined.
 */
const searchSeparator =
  /[^\p{L}\p{N}\p{Co}\u0300-\u0304\u0306-\u030C\u030F\u0311\u031B\u0323-\u0328\u032D\u032E\u0330\u0331]+/u;

/**
 * What a word holds at least one of, as unicode61 tokens do: accents
 * alone, which it drops, make no word.
 */
const wordCharacter = /[\p{L}\p{N}\p{Co}]/u;

/**
 * The words a search's text looks for, in order, as the full-text index
 * tokenizes them. A record matches when it holds every word, the last
 * one as a prefix, so a search box finds as its person types.
 */
export const searchTerms = (text: string): string[] =>
  text.split(searchSeparator).filter((term) => wordCharacter.test(term));
