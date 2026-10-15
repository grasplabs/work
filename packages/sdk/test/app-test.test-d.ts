// Compile-time guarantees of `appTest` (spec 28.2), checked against the
// Notes fixture's generated references: the spec's first example, word
// for word, type-checks against the real SDK, with each snapshot typed as
// the query's return. This file is type-checked by `vp check` and never
// run: every `@ts-expect-error` below must stay an error.
import { expectTypeOf } from "vite-plus/test";

import type { Id } from "../src/index.ts";
import { appTest } from "../src/testing.ts";
import type { LiveQuery, TestPrincipal } from "../src/testing.ts";
import { api } from "./notes/.grasp/references.ts";

appTest({
  fixtures: "notes",
  tests: {
    "creating a note updates the authorized live list": async (t) => {
      const viewer = await t.as("note-owner");
      const live = await viewer.subscribe(api.notes.list, {
        pagination: { pageSize: 50 },
      });
      const createdId = await viewer.mutation(api.notes.create, {
        title: "First note",
      });
      const snapshot = await live.next((page) =>
        page.items.some((note) => note._id === createdId)
      );
      t.equal(
        snapshot.items.find((note) => note._id === createdId)?.title,
        "First note"
      );
      await live.close();
    },
  },
});

declare const viewer: TestPrincipal;
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
