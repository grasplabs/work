// Compile-time guarantees of `appTest`, checked against the Notes
// fixture's schema and generated references: each snapshot is typed as
// the query's return, and `t.run`'s `ctx.db` as the App's tables. This
// file is type-checked by `vp check` and never run: every
// `@ts-expect-error` below must stay an error.
import { expectTypeOf } from "vite-plus/test";

import type { Id } from "../src/index.ts";
import { appTest } from "../src/testing.ts";
import type { LiveQuery, TestIdentity } from "../src/testing.ts";
import { expect } from "../src/vitest.ts";
import { api } from "./notes/server/_generated/api.ts";
import schema from "./notes/server/schema.ts";

appTest(schema, {
  "creating a note updates the authorized live list": async (t) => {
    const ada = t.withIdentity({ name: "Ada" });
    const live = await ada.subscribe(api.notes.list, {
      pagination: { pageSize: 50 },
    });
    const createdId = await ada.mutation(api.notes.create, {
      title: "First note",
    });
    const snapshot = await live.next((page) =>
      page.items.some((note) => note._id === createdId)
    );
    const created = snapshot.items.find((note) => note._id === createdId);
    // The module an App's tests import as `vitest`, by its own path here.
    // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- see above
    expect(created).toMatchObject({ title: "First note" });
    await live.close();
  },
  "a test seeds and inspects the App's tables directly": async (t) => {
    const id = await t.run(
      async (ctx) => await ctx.db.insert("notes", { title: "Seeded" })
    );
    expectTypeOf(id).toEqualTypeOf<Id<"notes">>();
    const titles = await t.run(async (ctx) => {
      const notes = await ctx.db.query("notes").take(10);
      return notes.map((note) => note.title);
    });
    expectTypeOf(titles).toEqualTypeOf<string[]>();
    // @ts-expect-error the schema has no such table
    await t.run(async (ctx) => await ctx.db.query("tasks").take(1));
    // @ts-expect-error a note's title is a string
    await t.run(async (ctx) => await ctx.db.insert("notes", { title: 1 }));
  },
});

declare const viewer: TestIdentity;
declare const noteId: Id<"notes">;

expectTypeOf(
  viewer.subscribe(api.notes.get, { id: noteId })
).resolves.toEqualTypeOf<
  LiveQuery<Awaited<ReturnType<typeof viewer.query<typeof api.notes.get>>>>
>();

// Only a query is followed.
// @ts-expect-error a mutation isn't a live query
void viewer.subscribe(api.notes.create, { title: "No" });

// Its arguments are the query's.
// @ts-expect-error `pageSize` is a number
void viewer.subscribe(api.notes.list, { pagination: { pageSize: "50" } });

declare const t: Parameters<
  Parameters<typeof appTest<(typeof schema)["tables"]>>[1][string]
>[0];

// An identity has a name, and a role the App has.
// @ts-expect-error a role is a user or a builder
t.withIdentity({ name: "Ada", role: "admin" });
// @ts-expect-error an identity has a name
t.withIdentity({ role: "user" });
