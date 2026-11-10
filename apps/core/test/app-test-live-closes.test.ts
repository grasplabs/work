import { describe, expect, it } from "vite-plus/test";

import { withFiles } from "./app-definitions.ts";
import {
  appFiles,
  appWith,
  failuresOf,
  suiteOf,
} from "./app-test-live-harness.ts";

// Live queries in an App's tests (`subscribe`, spec 28.2): a principal
// follows a query through the realtime manager a page's page follows
// one through, on the test's own fixture store. What the tests here check
// is what that host did: the spec's own example passes as written,
// snapshots are read as the principal who follows, a refusal or a query
// nothing matches fails the test, and core releases a subscription when
// the test closes it or ends.

describe("an App test's live queries", { timeout: 180_000 }, () => {
  it("release the host subscription when a test closes it", async () => {
    // More live queries one after another than a connection may follow at
    // once (100): each must be released by its close for the next to open.
    const built = await appWith(
      withFiles(appFiles, {
        "tests/close.test.ts": suiteOf({
          "follows and closes again and again": `
      const owner = t.withIdentity({ name: "note-owner" });
      // Queries of their own: a list's pages would count as one.
      for (let round = 0; round < 110; round += 1) {
        const id = await owner.mutation(api.notes.create, { title: \`Note \${round}\` });
        const live = await owner.subscribe(api.notes.get, { id });
        await live.close();
      }
      const live = await owner.subscribe(api.notes.list, page);
      await owner.mutation(api.notes.create, { title: "Still live" });
      await live.next((p) => p.items.some((note) => note.title === "Still live"));`,
          "can't follow more queries at once than a page's page may, a list's pages counting as one": `
      const owner = t.withIdentity({ name: "note-owner" });
      const ids = [];
      for (let round = 0; round < 100; round += 1) {
        ids.push(await owner.mutation(api.notes.create, { title: \`Note \${round}\` }));
      }
      for (const id of ids.slice(0, 99)) {
        await owner.subscribe(api.notes.get, { id });
      }
      // One paginated list's pages, more than the queries a page's page
      // may follow: one query.
      for (let size = 1; size <= 150; size += 1) {
        await owner.subscribe(api.notes.list, { pagination: { pageSize: size } });
      }
      await expect(owner.subscribe(api.notes.get, { id: ids[99] })).rejects.toMatchObject({ code: "page.too_many_queries" });`,
        }),
      })
    );
    await expect(failuresOf(built)).resolves.toStrictEqual([]);
  });
});
