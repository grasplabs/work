import { describe, expect, it } from "vite-plus/test";

import { withFiles } from "./app-definitions.ts";
import {
  appFiles,
  appWith,
  envWith,
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
  it("fail a test that leaves more snapshots unread than a live query keeps", async () => {
    // A write at a time, the next only once the last was pushed: both
    // live queries share each read (the same principal and call), so the
    // one never read is pushed a snapshot per write, never fewer.
    const built = await appWith(
      withFiles(appFiles, {
        "tests/unread.test.ts": suiteOf({
          "never reads what it follows": `
      const owner = await t.as("note-owner");
      await owner.subscribe(api.notes.list, page);
      const paced = await owner.subscribe(api.notes.list, page);
      for (let round = 0; round < 110; round += 1) {
        const id = await owner.mutation(api.notes.create, { title: \`Note \${round}\` });
        await paced.next((p) => p.items.some((note) => note._id === id));
      }`,
        }),
      })
    );
    await expect(
      failuresOf(built, envWith({ APP_TEST_LIMITS_MS: "29000" }))
    ).resolves.toStrictEqual([
      'tests/unread.test.ts, "never reads what it follows": more than 100 snapshots of the live query of notes.list went unread: take them with live.next, or close it',
    ]);
  });
});
