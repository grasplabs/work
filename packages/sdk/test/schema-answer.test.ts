import { describe, expect, test } from "vite-plus/test";

import { schemaManifest } from "../src/host.ts";
import { readSchemaAnswers } from "../src/schema-answer.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";

// An App's answers, as `app({ answers })` and a manifest read back check
// them: pure, so unit tests; the store giving the value to the records
// that don't fit is tested through the store
// (apps/core/test/schema-changes.test.ts).

const schema = schemaManifest(
  defineSchema({ notes: defineTable({ title: v.string(), size: v.number() }) }),
  { tables: { notes: { read: "owner", write: "owner" } } }
);

/** Refuses with `message`, as `app` does. */
const refuse = (message: string): never => {
  throw new Error(message);
};

describe("an App's answers", () => {
  test("each give a field of the schema a JSON value, once", () => {
    expect(
      readSchemaAnswers(
        [{ table: "notes", field: "size", value: 0 }],
        schema,
        refuse
      )
    ).toStrictEqual([{ table: "notes", field: "size", value: 0 }]);
    for (const [answers, message] of [
      [{}, /a list/u],
      [[{ table: "tags", field: "size", value: 1 }], /table/u],
      [[{ table: "notes", field: "colour", value: 1 }], /colour/u],
      [[{ table: "notes", field: "size", value: 1, kind: "map" }], /value \}/u],
      [[{ table: "notes", field: "size" }], /value \}/u],
      [[{ table: "notes", field: "size", value: Number.NaN }], /JSON/u],
      [
        [
          { table: "notes", field: "size", value: 1 },
          { table: "notes", field: "size", value: 2 },
        ],
        /Two/u,
      ],
    ] as const) {
      expect(() => readSchemaAnswers(answers, schema, refuse)).toThrow(message);
    }
  });
});
