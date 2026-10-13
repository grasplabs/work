// Compile-time guarantees of explicit migrations (spec 17.2): the row a
// handler gets is typed by its `input`, or is stored JSON without one, and
// what it returns must be the input of its `output`, the target table's
// fields. This file is type-checked by `vp check` and never run: every
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
  // @ts-expect-error -- a category the target's enum doesn't hold
  handler: () => ({ title: "Note", category: "other" }),
});
