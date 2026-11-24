import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { findApp } from "../src/apps.ts";
import { withFiles } from "./app-definitions.ts";
import {
  appFiles,
  appWith,
  envWith,
  failuresOf,
  fixturesLeft,
  specExample,
  suiteOf,
} from "./app-test-live-harness.ts";

// Every store object answers as it does, but refuses its first
// `refusals` watches: core lets go of the query each time.
const refusingWatches = (refusals: number): Env => {
  let refused = 0;
  const stores = new Proxy(env.DATA_STORES, {
    get: (namespace, key): unknown => {
      const value: unknown = Reflect.get(namespace, key);
      if (key !== "getByName" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(namespace) : value;
      }
      return (name: string) =>
        new Proxy(namespace.getByName(name), {
          get: (stub, method): unknown => {
            if (method === "watch" && refused < refusals) {
              return async () => {
                refused += 1;
                await Promise.resolve();
                throw new Error("The store holds no more watches now.");
              };
            }
            // An RPC stub's methods call through it whatever `this` is.
            return Reflect.get(stub, method);
          },
        });
    },
  });
  return envWith({ DATA_STORES: stores });
};

// Live queries in an App's tests (`subscribe`, spec 28.2): a principal
// follows a query through the realtime manager a page's page follows
// one through, on the test's own fixture store. What the tests here check
// is what that host did: the spec's own example passes as written,
// snapshots are read as the principal who follows, a refusal or a query
// nothing matches fails the test, and core releases a subscription when
// the test closes it or ends.

describe("an App test's live queries", { timeout: 180_000 }, () => {
  it("pass the spec's first example as written, through the real host", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/notes.test.ts": specExample,
      })
    );
    await expect(failuresOf(built)).resolves.toStrictEqual([]);
    await expect(findApp(env, built.app)).resolves.toMatchObject({
      currentVersion: 1,
    });
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("show each identity only the rows they may read", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/access.test.ts": suiteOf({
          "another owner's snapshots never hold the note": `
      const owner = t.withIdentity({ name: "note-owner" });
      const other = t.withIdentity({ name: "other-owner" });
      const mine = await owner.subscribe(api.notes.list, page);
      const theirs = await other.subscribe(api.notes.list, page);
      const createdId = await owner.mutation(api.notes.create, { title: "Mine" });
      await mine.next((p) => p.items.some((note) => note._id === createdId));
      const seen: string[] = [];
      await other.mutation(api.notes.create, { title: "Theirs" });
      const last = await theirs.next((p) => {
        seen.push(...p.items.map((note) => note._id));
        return p.items.some((note) => note.title === "Theirs");
      });
      expect(seen.includes(createdId), "the other owner saw the note").toBe(false);
      expect(last.items.map((note) => note.title)).toEqual(["Theirs"]);`,
          "a refusal it expects": `
      const owner = t.withIdentity({ name: "note-owner" });
      const live = await owner.subscribe({ ...api.notes.list, name: "notes.nothing" }, page);
      await expect(live.next()).rejects.toMatchObject({ code: "function.not_found" });`,
        }),
      })
    );
    await expect(failuresOf(built)).resolves.toStrictEqual([]);
  });

  it("fail a test on a refusal it didn't expect, and one that waits for a snapshot that never comes", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/failing.test.ts": suiteOf({
          "follows a query the App doesn't have": `
      const owner = t.withIdentity({ name: "note-owner" });
      const live = await owner.subscribe({ ...api.notes.list, name: "notes.nothing" }, page);
      await live.next();`,
          "waits for a note nobody makes": `
      const owner = t.withIdentity({ name: "note-owner" });
      const live = await owner.subscribe(api.notes.list, page);
      await live.next((p) => p.items.length > 0);`,
          "waits for two snapshots at once": `
      const owner = t.withIdentity({ name: "note-owner" });
      const live = await owner.subscribe(api.notes.list, page);
      void live.next(() => false).catch(() => null);
      await live.next();`,
          "reads a live query it closed": `
      const owner = t.withIdentity({ name: "note-owner" });
      const live = await owner.subscribe(api.notes.list, page);
      await live.close();
      await live.next();`,
        }),
      })
    );
    await expect(
      failuresOf(built, envWith({ APP_TEST_LIMITS_MS: "3000" }))
    ).resolves.toStrictEqual([
      expect.stringMatching(
        /^tests\/failing\.test\.ts, "follows a query the App doesn't have": unexpected error function\.not_found: /u
      ),
      'tests/failing.test.ts, "waits for a note nobody makes": didn\'t finish within 3 seconds, still waiting in live.next on notes.list, whose last snapshot was {"hasMore":false,"items":[],"nextCursor":null}',
      'tests/failing.test.ts, "waits for two snapshots at once": live.next on notes.list waits for one snapshot at a time',
      'tests/failing.test.ts, "reads a live query it closed": live.next on notes.list after it was closed',
    ]);
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("follow a query again when core can't keep it fresh, as a page does, and fail one it never can", async () => {
    const built = await appWith(
      withFiles(appFiles, {
        "tests/lost.test.ts": suiteOf({
          "follows the note it makes": `
      const owner = t.withIdentity({ name: "note-owner" });
      const live = await owner.subscribe(api.notes.list, page);
      await owner.mutation(api.notes.create, { title: "Kept" });
      await live.next((p) => p.items.length === 1);`,
          // Never asks for a snapshot: core giving up on the query must
          // still fail it.
          "follows a query it never reads": `
      const owner = t.withIdentity({ name: "note-owner" });
      await owner.subscribe(api.notes.list, page);
      for (let round = 0; round < 15; round += 1) {
        await owner.mutation(api.notes.create, { title: \`Note \${round}\` });
        await new Promise((resolve) => { setTimeout(resolve, 200); });
      }`,
        }),
      })
    );

    // Refused first: a version made current isn't tested again.
    await expect(
      failuresOf(built, refusingWatches(Number.POSITIVE_INFINITY))
    ).resolves.toStrictEqual([
      'tests/lost.test.ts, "follows the note it makes": core stopped following the live query of notes.list 5 times in a row',
      'tests/lost.test.ts, "follows a query it never reads": core stopped following the live query of notes.list 5 times in a row',
    ]);
    await expect(failuresOf(built, refusingWatches(2))).resolves.toStrictEqual(
      []
    );
  });
});
