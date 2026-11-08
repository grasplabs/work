// `ctx.db` for reading: a record by ID, and queries over a table, typed by
// the App's schema. It is a facade and holds no authority: every read is
// one request (`ReadRequest`) handed to the invocation's executor, which
// the trusted host supplies, and the host decides what the caller may see.
//
// A query is built as a value: each modifier answers a new query, and
// nothing is read until a terminal is called. Building one checks it
// against the schema (a table, index, field or range it doesn't have is
// refused here, with a `QueryDefinitionError`), and the host checks the
// descriptor again, trusting nothing from here. The descriptor names
// tables, indexes and fields as the schema does; it never holds SQL, a
// physical ID, an owner or a role.
//
// Every terminal is bounded: `take` and `collect` return at most 100
// records (`collect` fails rather than truncates), a page holds at most
// 100, and there is no way to iterate a whole table in one read. Longer
// lists page, through a table of any size, each page bounded on its own;
// large exports and aggregates are a workflow's.
//
// Besides queries: `search(table, text)` reads a table's full-text search
// index in order of relevance; `group` counts and aggregates per value of
// one or two fields, at most 100 groups; `with` loads the records a
// query's `v.id` fields name, under the caller's access to their tables.
//
// Adapted from Baseflare's query builder and structured filters (MIT,
// © 2026 Baseflare contributors: packages/baseflare/src/server/db), with
// Convex-style index ranges and Grasp's bounds.

export { databaseReader } from "./database-reader.ts";
export type { DatabaseReader } from "./database-reader.ts";
export { databaseWriter } from "./database-writer.ts";
export type { DatabaseWriter } from "./database-writer.ts";
export { QueryDefinitionError } from "./query-error.ts";
export type { QueryDefinitionCode } from "./query-error.ts";
export type {
  Group,
  PaginationResult,
  Query,
  Related,
  SearchQuery,
  Withheld,
} from "./query-reads.ts";
export type { Doc } from "./query-types.ts";
