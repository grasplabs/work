import { describe, expect, it } from "vite-plus/test";

import { queryRequestSchema, readRequestSchema } from "../src/store-queries.ts";

// The host's schema of a read: the store checks every descriptor App code
// built with it, so it must refuse what is malformed or oversized without
// being overrun by it. Pure parsing, so unit tests.

const query = (changes: Record<string, unknown> = {}) => ({
  descriptorVersion: 1,
  table: "notes",
  index: "by_author_rank",
  range: [],
  filter: null,
  order: "asc",
  terminal: { kind: "collect" },
  ...changes,
});

const accepts = (value: unknown): boolean =>
  queryRequestSchema.safeParse(value).success;

/** A filter `depth` levels of `not` deep. */
const deepFilter = (depth: number): unknown => {
  let node: unknown = { field: "title", op: "eq", value: "a" };
  for (let level = 0; level < depth; level += 1) {
    node = { not: node };
  }
  return node;
};

/** A condition binding one value. */
const leaf = (index: number) => ({
  field: "title",
  op: "neq",
  value: `v${index}`,
});

/** An equality bound on `field`. */
const eq = (field: string) => ({ field, op: "eq", value: "a" });

describe("a query descriptor", () => {
  it("is accepted when well formed", () => {
    expect(
      accepts(
        query({
          range: [
            { field: "author", op: "eq", value: "p1" },
            { field: "rank", op: "gte", value: 1 },
            { field: "rank", op: "lt", value: 5 },
          ],
          filter: {
            and: [
              { field: "title", op: "neq", value: "a" },
              { not: { field: "rank", op: "in", values: [1, null] } },
              { field: "rank", op: "exists", value: false },
            ],
          },
          terminal: { kind: "paginate", pageSize: 20, cursor: null },
        })
      )
    ).toBeTruthy();
  });

  it("refuses unknown keys and versions, anywhere", () => {
    expect(accepts(query({ sql: "SELECT 1" }))).toBeFalsy();
    expect(accepts(query({ descriptorVersion: 2 }))).toBeFalsy();
    expect(
      accepts(
        query({ filter: { field: "title", op: "eq", value: "a", raw: 1 } })
      )
    ).toBeFalsy();
    expect(
      accepts(
        query({
          range: [{ field: "author", op: "eq", value: "a", tableId: "t" }],
        })
      )
    ).toBeFalsy();
    expect(
      accepts(query({ terminal: { kind: "take", count: 1, all: true } }))
    ).toBeFalsy();
  });

  it("refuses names that aren't identifiers", () => {
    expect(accepts(query({ table: "notes; DROP TABLE x" }))).toBeFalsy();
    expect(
      accepts(query({ filter: { field: "a')--", op: "eq", value: 1 } }))
    ).toBeFalsy();
    expect(accepts(query({ index: "_hidden" }))).toBeFalsy();
  });

  it("refuses a range that isn't shaped as an index range", () => {
    for (const range of [
      [{ field: "rank", op: "lt", value: 5 }, eq("author")],
      [eq("author"), eq("author")],
      [
        { field: "rank", op: "lt", value: 5 },
        { field: "rank", op: "gt", value: 1 },
      ],
      [
        { field: "rank", op: "gt", value: 1 },
        { field: "rank", op: "gte", value: 2 },
      ],
      [
        { field: "rank", op: "gt", value: 1 },
        { field: "other", op: "lt", value: 2 },
      ],
      [eq("author"), { field: "author", op: "gt", value: "b" }],
      Array.from({ length: 18 }, (_, index) => eq(`f${index}`)),
    ]) {
      expect(accepts(query({ range }))).toBeFalsy();
    }
    expect(
      accepts(
        query({
          range: Array.from({ length: 16 }, (_, index) => eq(`f${index}`)),
        })
      )
    ).toBeTruthy();
  });

  it("refuses oversized or empty filter parts", () => {
    expect(
      accepts(
        query({
          filter: {
            field: "rank",
            op: "in",
            values: Array.from({ length: 101 }, (_, index) => index),
          },
        })
      )
    ).toBeFalsy();
    expect(accepts(query({ filter: { and: [] } }))).toBeFalsy();
    expect(accepts(query({ filter: { or: [] } }))).toBeFalsy();
    expect(
      accepts(
        query({ filter: { field: "title", op: "eq", value: "x".repeat(4097) } })
      )
    ).toBeFalsy();
    expect(
      accepts(query({ filter: { field: "rank", op: "gt", value: Number.NaN } }))
    ).toBeFalsy();
  });

  it("refuses a deep filter before reading it recursively", () => {
    expect(accepts(query({ filter: deepFilter(8) }))).toBeTruthy();
    expect(accepts(query({ filter: deepFilter(9) }))).toBeFalsy();
    // Deep enough to overflow a recursive reading: refused, never thrown.
    expect(() =>
      queryRequestSchema.safeParse(query({ filter: deepFilter(100_000) }))
    ).not.toThrow();
    expect(accepts(query({ filter: deepFilter(100_000) }))).toBeFalsy();
  });

  it("refuses a wide filter before visiting its members", () => {
    const condition = { field: "title", op: "eq", value: "a" };
    const wide = { or: Array.from({ length: 262_144 }, () => condition) };
    const started = Date.now();
    expect(accepts(query({ filter: wide }))).toBeFalsy();
    // Refused from its list's length, not after reading every member.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(
      accepts(
        query({ filter: { or: Array.from({ length: 63 }, () => condition) } })
      )
    ).toBeTruthy();
    expect(
      accepts(
        query({ filter: { or: Array.from({ length: 64 }, () => condition) } })
      )
    ).toBeFalsy();
  });

  it("refuses a long range before reading its bounds", () => {
    const long = Array.from({ length: 1_000_000 }, () => "not a bound");
    const result = queryRequestSchema.safeParse(query({ range: long }));
    expect(result.error?.issues.map(({ message }) => message)).toStrictEqual([
      "An index range holds at most 17 bounds",
    ]);
  });

  it("binds at most 64 values across its range and filter, an `in` counting once", () => {
    const range = [
      ...Array.from({ length: 15 }, (_, index) => eq(`f${index}`)),
      { field: "f15", op: "gt", value: 1 },
      { field: "f15", op: "lt", value: 9 },
    ];
    const conditions = (count: number) =>
      Array.from({ length: count }, (_, index) => leaf(index));
    const longIn = {
      field: "rank",
      op: "in",
      values: [...Array.from({ length: 99 }, (_, index) => index), null],
    };
    // 17 range values, 46 conditions and one `in`: 64.
    expect(
      accepts(query({ range, filter: { and: [...conditions(46), longIn] } }))
    ).toBeTruthy();
    expect(
      accepts(query({ range, filter: { and: [...conditions(47), longIn] } }))
    ).toBeFalsy();
    // Null binds nothing, and neither does `exists`.
    expect(
      accepts(
        query({
          range,
          filter: {
            and: [
              ...conditions(47),
              { field: "rank", op: "eq", value: null },
              { field: "rank", op: "exists", value: true },
            ],
          },
        })
      )
    ).toBeTruthy();
  });

  it("refuses terminals out of bounds", () => {
    for (const terminal of [
      { kind: "take", count: 101 },
      { kind: "take", count: -1 },
      { kind: "paginate", pageSize: 0, cursor: null },
      { kind: "paginate", pageSize: 10, cursor: "" },
      { kind: "paginate", pageSize: 10, cursor: "c".repeat(4097) },
      { kind: "aggregate", operation: "count", field: "rank" },
      { kind: "aggregate", operation: "avg", field: "rank" },
      { kind: "all" },
    ]) {
      expect(accepts(query({ terminal }))).toBeFalsy();
    }
  });
});

describe("a read request", () => {
  it("is a record by ID or a query, nothing else", () => {
    expect(
      readRequestSchema.safeParse({
        kind: "get",
        table: "notes",
        id: "r1",
        expectedRevision: null,
      }).success
    ).toBeTruthy();
    expect(
      readRequestSchema.safeParse({ kind: "query", query: query() }).success
    ).toBeTruthy();
    expect(
      readRequestSchema.safeParse({
        kind: "get",
        table: "notes",
        id: "r1",
        expectedRevision: 0,
      }).success
    ).toBeFalsy();
    expect(
      readRequestSchema.safeParse({ kind: "sql", text: "SELECT 1" }).success
    ).toBeFalsy();
  });
});
