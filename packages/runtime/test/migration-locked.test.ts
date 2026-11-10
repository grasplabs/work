import { describe, expect, test } from "vite-plus/test";

import { registerApp } from "../src/host.ts";
import { defineApp, defineMigration } from "../src/index.ts";
import { runMigration } from "../src/runner.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";

// Module code that makes `Math.random` non-configurable before a transform
// runs, so the runner can't take it away (src/determinism.ts). In a file
// of its own: what it does lasts as long as the isolate, which is this
// file's alone.

const fields = { title: v.string(), category: v.string().default("") };

describe("the runner", () => {
  test("refuses a batch whose randomness module code locked in place, running none of it", () => {
    let ran = 0;
    const app = registerApp({
      config: defineApp({ name: "Notes" }),
      schema: defineSchema({
        notes: defineTable(fields).access({ read: "owner", write: "owner" }),
      }),
      modules: {},
      migrations: [
        defineMigration({
          name: "random-category",
          fromSchema: "a".repeat(64),
          toSchema: "b".repeat(64),
          table: "notes",
          input: v.object({ title: v.string() }),
          output: v.object(fields),
          fixtures: [{ row: { title: "Plan" } }],
          handler: (_ctx, row) => {
            ran += 1;
            return {
              title: row.title,
              category: String(Math.random()),
            };
          },
        }),
      ],
    });
    Object.defineProperty(Math, "random", { configurable: false });

    const answer = runMigration(app, {
      name: "random-category",
      rows: [{ id: "n1", fields: { title: "Plan" } }],
    });

    expect(answer).toStrictEqual({
      ok: false,
      index: 0,
      message:
        "A migration is pure: randomness isn't available while it transforms rows.",
    });
    expect(ran).toBe(0);
    expect(() => [Date.now(), new Date(), performance.now()]).not.toThrow();
  });
});
