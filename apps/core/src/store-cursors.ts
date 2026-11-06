import {
  fromBase64Url,
  sha256Hex,
  toBase64Url,
} from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { cursorMaxLength } from "@grasp-os/shared/store-limits";
import type { FilterNode, RangeBound } from "@grasp-os/shared/store-reads";
import { dataErrors } from "@grasp-os/shared/stores";
import { z } from "zod";

import { emitterVersion } from "./store-expressions.ts";
import type { Anchor } from "./store-queries.ts";

// A page's cursor (spec 9.2): a keyset cursor, where the next page of one
// query starts. It is base64url JSON of the last record's anchor (its ID
// and, when they fit, its order fields' values) and two short hashes: of
// the query, and of the generation it was read under.
//
// Threat model, and why a plain cursor holds:
//
// - A cursor shows what its holder couldn't read: an anchor holds the
//   last record's ID and the values of the query's order fields, which
//   are the index's fields (each a declared field of the pinned table,
//   `table.index` checks it) and `_createdAt`, `_id`. Every one of them
//   is in the record the caller was just answered: the store hides no
//   field from a caller who may read a record (documents are projected to
//   the pinned table's declared fields, for everyone alike), and row rules
//   decide which records, never which fields. The one order value that
//   isn't a record's is a search's relevance (BM25), which weighs words
//   over rows the caller can't see (store-search.ts): so a search's
//   cursor holds the record's ID alone, and the next page reads its
//   relevance again under the caller's access (store-queries.ts,
//   `searchMatches`).
// - A forged or edited cursor reads past row rules or the owner: a cursor
//   only says where in the index a page starts. Every page's statements,
//   the lookup of an ID-only anchor's values and a search anchor's
//   relevance included, run under the caller's owner predicate and row
//   rules (store-queries.ts), so a forged anchor seeks to a place the
//   caller could reach with an index range of their own, and reads only
//   rows they may read. An anchor ID of a record they can't see is
//   `data.cursor_expired`, exactly as a missing one, so a cursor is no
//   oracle either. Anything that doesn't parse is `data.invalid_cursor`.
// - A cursor carried to another query: the query hash covers the table,
//   index, range, filter, order and search text, recomputed from the
//   request, so it is `data.invalid_cursor` rather than a page that
//   silently skips or repeats records. It isn't a secret: anyone may hash
//   a query, and needn't, since nothing a cursor positions is beyond what
//   they may read anyway. Nor is it bound to a caller, for that reason.
// - A cursor outlives what made it (spec 9.2: the App's version, the
//   schema it is pinned to, the expressions' version, and a search's
//   table generation, as relevance moves with any write): the generation
//   hash differs, so it is `data.cursor_expired` and the list starts over.
// - A cursor grows without bound: at most `cursorMaxLength` characters (a
//   longer one is refused at the boundary as `data.invalid_query`); when
//   the last record's values wouldn't fit, the cursor holds only its ID,
//   and the next page looks the record up under the same access.

/** The query a cursor is for, and the generation it was read under. */
export interface CursorBinding {
  readonly table: string;
  readonly index: string | null;
  readonly range: readonly RangeBound[];
  readonly filter: FilterNode | null;
  readonly order: "asc" | "desc";
  /** The text a search's pages look for; null for a query's. */
  readonly search: string | null;
  readonly schemaHash: string;
  /** The version of the App that read the page. */
  readonly resourceVersion: number;
  /**
   * For a search, its table's generation when the page was read: a
   * search's order is its relevance, which any write to the table moves.
   * Null for a query's, whose keyset is the record's own values.
   */
  readonly searchGeneration: number | null;
}

const anchorValueSchema = z.union([
  z.tuple([]),
  z.tuple([z.null()]),
  z.tuple([z.union([z.string(), z.number()])]),
]);

const cursorSchema = z.strictObject({
  query: z.string(),
  generation: z.string(),
  id: z.string().min(1).max(256),
  values: z.array(anchorValueSchema).max(17).optional(),
});

/** A filter as JSON, for the query hash (bounded: depth 8). */
const filterJson = (node: FilterNode): Json => {
  if ("and" in node) {
    return { and: node.and.map(filterJson) };
  }
  if ("or" in node) {
    return { or: node.or.map(filterJson) };
  }
  if ("not" in node) {
    return { not: filterJson(node.not) };
  }
  if (node.op === "in") {
    return { field: node.field, op: node.op, values: [...node.values] };
  }
  return { field: node.field, op: node.op, value: node.value };
};

/** The first 64 bits of `value`'s SHA-256: tells queries apart, no more. */
const shortHash = async (value: Json): Promise<string> => {
  const hash = await sha256Hex(canonicalJson(value));
  return hash.slice(0, 16);
};

/** The hashes of `binding`'s query and generation. */
const hashesOf = async (
  binding: CursorBinding
): Promise<{ query: string; generation: string }> => ({
  query: await shortHash({
    table: binding.table,
    index: binding.index,
    range: binding.range.map(({ field, op, value }) => ({ field, op, value })),
    filter: binding.filter === null ? null : filterJson(binding.filter),
    order: binding.order,
    search: binding.search,
  }),
  generation: await shortHash({
    schemaHash: binding.schemaHash,
    resourceVersion: binding.resourceVersion,
    emitterVersion,
    searchGeneration: binding.searchGeneration,
  }),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A cursor for the page after `anchor`, for `binding`: with the anchor's
 * values when it fits within `cursorMaxLength`, otherwise its ID only.
 */
export const encodeCursor = async (
  binding: CursorBinding,
  anchor: Anchor
): Promise<string> => {
  const hashes = await hashesOf(binding);
  for (const content of [anchor, { id: anchor.id }]) {
    const cursor = toBase64Url(
      encoder.encode(JSON.stringify({ ...hashes, ...content }))
    );
    if (cursor.length <= cursorMaxLength) {
      return cursor;
    }
  }
  throw new Error("A record ID doesn't fit in a cursor");
};

/**
 * The anchor `cursor` holds, if it is one for `binding`'s query:
 * `data.cursor_expired` when it is, but read under another generation;
 * `data.invalid_cursor` otherwise.
 */
export const decodeCursor = async (
  binding: CursorBinding,
  cursor: string
): Promise<Anchor> => {
  let content: unknown = null;
  try {
    content = JSON.parse(decoder.decode(fromBase64Url(cursor)));
  } catch {
    // Not base64url JSON: refused as below.
  }
  const parsed = cursorSchema.safeParse(content);
  if (!parsed.success) {
    throw dataErrors.create("data.invalid_cursor");
  }
  const { query, generation, ...anchor } = parsed.data;
  const hashes = await hashesOf(binding);
  if (query !== hashes.query) {
    throw dataErrors.create("data.invalid_cursor");
  }
  if (generation !== hashes.generation) {
    throw dataErrors.create("data.cursor_expired");
  }
  return anchor;
};
