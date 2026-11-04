import { describe, expect, test } from "vite-plus/test";

import { answerValue, schemaManifest } from "../src/host.ts";
import type { SchemaAnswer } from "../src/host.ts";
import { readSchemaAnswers } from "../src/schema-answer.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";

// What an App's answer makes of a record's field a narrowing doesn't fit:
// pure, so unit tests; the store running answers over its records is
// tested through the store (apps/core/test/schema-changes.test.ts).

const convert = (to: "string" | "number" | "boolean"): SchemaAnswer => ({
  table: "notes",
  field: "size",
  kind: "convert",
  to,
});

/** What `answer` makes of `value` (none: left out), held by a record of `fields`. */
const made = (
  answer: SchemaAnswer,
  value?: unknown,
  fields: Record<string, unknown> = {}
) => answerValue(answer, value !== undefined, value, fields);

describe("a standard conversion", () => {
  test("reads text, numbers and booleans as written, and never guesses", () => {
    expect({
      decimal: made(convert("number"), " 12.5 "),
      exponent: made(convert("number"), "1e3"),
      hex: made(convert("number"), "0x10"),
      empty: made(convert("number"), ""),
      infinite: made(convert("number"), "Infinity"),
      word: made(convert("number"), "twelve"),
      fromBoolean: made(convert("number"), true),
      text: made(convert("string"), 12),
      textOfBoolean: made(convert("string"), false),
      textOfObject: made(convert("string"), { a: 1 }),
      yes: made(convert("boolean"), " TRUE "),
      maybe: made(convert("boolean"), "yes"),
      fromNumber: made(convert("boolean"), 1),
      missing: made(convert("number")),
    }).toStrictEqual({
      decimal: { answered: true, value: 12.5 },
      exponent: { answered: true, value: 1000 },
      hex: { answered: false },
      empty: { answered: false },
      infinite: { answered: false },
      word: { answered: false },
      fromBoolean: { answered: false },
      text: { answered: true, value: "12" },
      textOfBoolean: { answered: true, value: "false" },
      textOfObject: { answered: false },
      yes: { answered: true, value: true },
      maybe: { answered: false },
      fromNumber: { answered: false },
      missing: { answered: false },
    });
  });
});

describe("a map, a value and another field", () => {
  test("map only what they hold, and fill in what a record lacks", () => {
    const map: SchemaAnswer = {
      table: "notes",
      field: "status",
      kind: "map",
      values: { todo: "open", "1": "done" },
    };
    expect({
      mapped: made(map, "todo"),
      byNumber: made(map, 1),
      unmapped: made(map, "doing"),
      inherited: made(map, "toString"),
      value: made({
        table: "notes",
        field: "status",
        kind: "value",
        value: "open",
      }),
      field: made(
        { table: "notes", field: "status", kind: "field", from: "state" },
        undefined,
        { state: "open" }
      ),
      fieldMissing: made(
        { table: "notes", field: "status", kind: "field", from: "state" },
        "x"
      ),
    }).toStrictEqual({
      mapped: { answered: true, value: "open" },
      byNumber: { answered: true, value: "done" },
      unmapped: { answered: false },
      inherited: { answered: false },
      value: { answered: true, value: "open" },
      field: { answered: true, value: "open" },
      fieldMissing: { answered: false },
    });
  });
});

/** Refuses with `message`, as `app` does. */
const refuse = (message: string): never => {
  throw new Error(message);
};

describe("an App's answers", () => {
  const schema = schemaManifest(
    defineSchema({
      notes: defineTable({ title: v.string(), size: v.number() }),
    }),
    { tables: { notes: { read: "owner", write: "owner" } } }
  );

  test("each name a field of the schema once, with exactly their kind's keys", () => {
    expect(
      readSchemaAnswers(
        [{ table: "notes", field: "size", kind: "convert", to: "number" }],
        schema,
        refuse
      )
    ).toStrictEqual([
      { table: "notes", field: "size", kind: "convert", to: "number" },
    ]);
    for (const [answers, message] of [
      [{}, /a list/u],
      [[{ table: "tags", field: "size", kind: "value", value: 1 }], /table/u],
      [
        [{ table: "notes", field: "colour", kind: "value", value: 1 }],
        /colour/u,
      ],
      [[{ table: "notes", field: "size", kind: "guess" }], /kind/u],
      [
        [{ table: "notes", field: "size", kind: "value", value: 1, extra: 1 }],
        /value/u,
      ],
      [
        [{ table: "notes", field: "size", kind: "convert", to: "date" }],
        /convert/u,
      ],
      [
        [{ table: "notes", field: "size", kind: "field", from: "size" }],
        /another field/u,
      ],
      [
        [
          { table: "notes", field: "size", kind: "value", value: 1 },
          { table: "notes", field: "size", kind: "value", value: 2 },
        ],
        /Two/u,
      ],
    ] as const) {
      expect(() => readSchemaAnswers(answers, schema, refuse)).toThrow(message);
    }
  });
});
