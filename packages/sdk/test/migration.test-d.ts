// Compile-time guarantees of explicit migrations (spec 17.2): the row a
// handler gets is typed by its `input`, or is stored JSON without one, and
// what it returns must be the input of its `output`, the target table's
// fields; its fixtures' rows are what its `input` accepts, and what they
// expect is the target table's fields. This file is type-checked by `vp check` and never run: every
// `@ts-expect-error` below must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { migration, v } from "../src/index.ts";
import type { JsonValue } from "../src/index.ts";

const noteFields = {
  title: v.string(),
  body: v.string().default(""),
  category: v.enum(["launch", "general"]),
};

const hashes = { fromSchema: "a".repeat(64), toSchema: "b".repeat(64) };

migration({
  name: "derive-category",
  table: "notes",
  ...hashes,
  input: v.object({ title: noteFields.title, body: noteFields.body }),
  output: v.object(noteFields),
  fixtures: [
    {
      row: { title: "Launch plan" },
      expect: { title: "Launch plan", body: "", category: "launch" },
    },
  ],
  handler: (ctx, row) => {
    expectTypeOf(ctx.id).toEqualTypeOf<string>();
    // `body` has a default, so the row always holds it.
    expectTypeOf(row.body).toEqualTypeOf<string>();
    return {
      ...row,
      category: row.body.includes("launch") ? "launch" : "general",
    };
  },
});

migration({
  name: "untyped",
  table: "notes",
  ...hashes,
  output: v.object(noteFields),
  fixtures: [{ row: { title: "Note", legacy: [1, "two"] } }],
  handler: (_ctx, row) => {
    expectTypeOf(row).toEqualTypeOf<Readonly<Record<string, JsonValue>>>();
    const title = typeof row.title === "string" ? row.title : "Untitled";
    return { title, category: "general" as const };
  },
});

migration({
  name: "wrong-output",
  table: "notes",
  ...hashes,
  output: v.object(noteFields),
  fixtures: [{ row: { title: "Note" } }],
  // @ts-expect-error -- a category the target's enum doesn't hold
  handler: () => ({ title: "Note", category: "other" }),
});

migration({
  name: "fixture-off-input",
  table: "notes",
  ...hashes,
  input: v.object({ title: noteFields.title }),
  output: v.object(noteFields),
  // @ts-expect-error -- a row its input doesn't accept
  fixtures: [{ row: { title: 42 } }],
  handler: (_ctx, row) => ({ title: row.title, category: "general" }),
});

migration({
  name: "fixture-off-output",
  table: "notes",
  ...hashes,
  output: v.object(noteFields),
  fixtures: [
    {
      row: { title: "Note" },
      // @ts-expect-error -- a category the target's enum doesn't hold
      expect: { title: "Note", body: "", category: "other" },
    },
  ],
  handler: () => ({ title: "Note", category: "general" }),
});

// @ts-expect-error -- a migration without fixtures
migration({
  name: "unchecked",
  table: "notes",
  ...hashes,
  output: v.object(noteFields),
  handler: () => ({ title: "Note", category: "general" }),
});
