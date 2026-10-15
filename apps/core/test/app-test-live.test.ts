import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { activateVersion } from "../src/app-activation.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { fixtureHostFor } from "../src/app-tests.ts";
import { commitFiles, createApp, findApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { notesFiles } from "./notes-client-app.ts";
import { person } from "./sealed-apps.ts";

// Live queries in an App's tests (`subscribe`, spec 28.2): a principal
// follows a query through the realtime manager a screen's page follows
// one through, on the test's own fixture store. What the tests here check
// is what that host did: the spec's own example passes as written,
// snapshots are read as the principal who follows, a refusal or a query
// nothing matches fails the test, and core releases a subscription when
// the test closes it or ends.

/** A push of `notes.list`'s, as far as the tests read it. */
const pushOfNotes = z.object({
  revision: z.number(),
  result: z.object({
    value: z.object({ items: z.array(z.object({ title: z.string() })) }),
  }),
});

/** The Notes App the session client's tests use, with a fixture. */
const appFiles: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(notesFiles).filter(([path]) => !path.startsWith("screens/"))
  ),
  "tests/fixtures/notes.json": JSON.stringify({
    principals: {
      "note-owner": { role: "user" },
      "other-owner": { role: "user" },
    },
  }),
};

/** Spec 28.2's first example, word for word, but for the package's scope. */
const specExample = `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "#grasp";

export default appTest({
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
`;

/** A suite of `tests`, each `"name": async (t) => { body }`. */
const suiteOf = (
  tests: Record<string, string>
): string => `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "#grasp";

const page = { pagination: { pageSize: 50 } };

export default appTest({
  fixtures: "notes",
  tests: {
${Object.entries(tests)
  .map(
    ([name, body]) => `    ${JSON.stringify(name)}: async (t) => {
${body}
    },`
  )
  .join("\n")}
  },
});
`;

interface Built {
  owner: Acting & Identity;
  app: AppId;
}

/** A builder's App with `files` as its first version. */
const appWith = async (files: Record<string, string>): Promise<Built> => {
  const owner = await person("builder");
  const { id } = await createApp(env, owner, { name: "Notes" });
  await commitFiles(env, owner, id, files, "First version");
  return { owner, app: id };
};

/** Core's env as code reads it, with `changes` over it; env itself unchanged. */
const envWith = (changes: Partial<Env>): Env =>
  new Proxy(env, {
    get: (target, key, receiver): unknown =>
      Object.hasOwn(changes, key)
        ? Reflect.get(changes, key)
        : Reflect.get(target, key, receiver),
  });

/** Why activating version 1 failed: each failing test, and why. */
const failuresOf = async (
  { owner, app }: Built,
  on: Env = env
): Promise<unknown> => {
  try {
    await activateVersion(on, owner, app, 1);
  } catch (error) {
    if (isExpectedError(error) && error.code === "version.tests_failed") {
      return error.details?.failures;
    }
    throw error;
  }
  return [];
};

/** The fixture stores core still records. */
const fixturesLeft = async (): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM app_test_fixtures"
  ).first<{ n: number }>();
  return row?.n ?? -1;
};

/** A call's request for `path` of `release`, as a test principal sends it. */
const requestFor = (release: Release, path: string, input: unknown): string => {
  const operation = release.app.operations[path];
  return JSON.stringify({
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: path,
      fingerprint: release.fingerprints[path],
      kind: operation?.kind,
    },
    input,
  });
};

describe("an App test's live queries", { timeout: 180_000 }, () => {
  it("pass the spec's first example as written, through the real host", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/notes.test.ts": specExample,
    });
    await expect(failuresOf(built)).resolves.toStrictEqual([]);
    await expect(findApp(env, built.app)).resolves.toMatchObject({
      currentVersion: 1,
    });
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("show each principal only the rows they may read", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/access.test.ts": suiteOf({
        "another owner's snapshots never hold the note": `
      const owner = await t.as("note-owner");
      const other = await t.as("other-owner");
      const mine = await owner.subscribe(api.notes.list, page);
      const theirs = await other.subscribe(api.notes.list, page);
      const createdId = await owner.mutation(api.notes.create, { title: "Mine" });
      await mine.next((p) => p.items.some((note) => note._id === createdId));
      const seen = [];
      await other.mutation(api.notes.create, { title: "Theirs" });
      const last = await theirs.next((p) => {
        seen.push(...p.items.map((note) => note._id));
        return p.items.some((note) => note.title === "Theirs");
      });
      t.equal(seen.includes(createdId), false, "the other owner saw the note");
      t.equal(last.items.map((note) => note.title), ["Theirs"]);`,
        "a refusal it expects": `
      const owner = await t.as("note-owner");
      const live = await owner.subscribe({ ...api.notes.list, contractId: "notes.nothing" }, page);
      await t.rejectsCode(live.next(), "operation.not_found");`,
      }),
    });
    await expect(failuresOf(built)).resolves.toStrictEqual([]);
  });

  it("fail a test on a refusal it didn't expect, and one that waits for a snapshot that never comes", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/failing.test.ts": suiteOf({
        "follows a query the App doesn't have": `
      const owner = await t.as("note-owner");
      const live = await owner.subscribe({ ...api.notes.list, contractId: "notes.nothing" }, page);
      await live.next();`,
        "waits for a note nobody makes": `
      const owner = await t.as("note-owner");
      const live = await owner.subscribe(api.notes.list, page);
      await live.next((p) => p.items.length > 0);`,
        "waits for two snapshots at once": `
      const owner = await t.as("note-owner");
      const live = await owner.subscribe(api.notes.list, page);
      void live.next(() => false).catch(() => null);
      await live.next();`,
        "reads a live query it closed": `
      const owner = await t.as("note-owner");
      const live = await owner.subscribe(api.notes.list, page);
      await live.close();
      await live.next();`,
      }),
    });
    await expect(
      failuresOf(built, envWith({ APP_TEST_LIMITS_MS: "3000" }))
    ).resolves.toStrictEqual([
      expect.stringMatching(
        /^tests\/failing\.test\.ts, "follows a query the App doesn't have": unexpected error operation\.not_found: /u
      ),
      'tests/failing.test.ts, "waits for a note nobody makes": didn\'t finish within 3 seconds, still waiting in live.next on notes.list, whose last snapshot was {"hasMore":false,"items":[],"nextCursor":null}',
      'tests/failing.test.ts, "waits for two snapshots at once": live.next on notes.list waits for one snapshot at a time',
      'tests/failing.test.ts, "reads a live query it closed": live.next on notes.list after it was closed',
    ]);
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("fail a test that leaves more snapshots unread than a live query keeps", async () => {
    // A write at a time, each read and pushed on its own (past the
    // manager's gathering window): never a `next` to take them.
    const built = await appWith({
      ...appFiles,
      "tests/unread.test.ts": suiteOf({
        "never reads what it follows": `
      const owner = await t.as("note-owner");
      await owner.subscribe(api.notes.list, page);
      for (let round = 0; round < 110; round += 1) {
        await owner.mutation(api.notes.create, { title: \`Note \${round}\` });
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }`,
      }),
    });
    await expect(
      failuresOf(built, envWith({ APP_TEST_LIMITS_MS: "29000" }))
    ).resolves.toStrictEqual([
      'tests/unread.test.ts, "never reads what it follows": more than 100 snapshots of the live query of notes.list went unread: take them with live.next, or close it',
    ]);
  });

  it("release the host subscription when a test closes it", async () => {
    // More live queries one after another than a connection may follow at
    // once (100): each must be released by its close for the next to open.
    const built = await appWith({
      ...appFiles,
      "tests/close.test.ts": suiteOf({
        "follows and closes again and again": `
      const owner = await t.as("note-owner");
      for (let round = 0; round < 110; round += 1) {
        const live = await owner.subscribe(api.notes.list, page);
        await live.close();
      }
      const live = await owner.subscribe(api.notes.list, page);
      await owner.mutation(api.notes.create, { title: "Still live" });
      await live.next((p) => p.items.length === 1);`,
        "can't follow more at once than a screen's page may": `
      const owner = await t.as("note-owner");
      for (let round = 0; round < 100; round += 1) {
        await owner.subscribe(api.notes.list, page);
      }
      await t.rejectsCode(owner.subscribe(api.notes.list, page), "screen.too_many_queries");`,
      }),
    });
    await expect(failuresOf(built)).resolves.toStrictEqual([]);
  });

  it("follow a query again when core can't keep it fresh, as a screen does, and fail one it never can", async () => {
    const built = await appWith({
      ...appFiles,
      "tests/lost.test.ts": suiteOf({
        "follows the note it makes": `
      const owner = await t.as("note-owner");
      const live = await owner.subscribe(api.notes.list, page);
      await owner.mutation(api.notes.create, { title: "Kept" });
      await live.next((p) => p.items.length === 1);`,
      }),
    });
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

    // Refused first: a version made current isn't tested again.
    await expect(
      failuresOf(built, refusingWatches(Number.POSITIVE_INFINITY))
    ).resolves.toStrictEqual([
      'tests/lost.test.ts, "follows the note it makes": core stopped following the live query of notes.list 5 times in a row',
    ]);
    await expect(failuresOf(built, refusingWatches(2))).resolves.toStrictEqual(
      []
    );
  });
});

/**
 * A follower's callbacks, as stubs of a test isolate's would be (each
 * released by disposing it), and what core did with them.
 */
const follower = () => {
  const pushes: unknown[] = [];
  let lost = 0;
  let released = 0;
  const release = {
    [Symbol.dispose]: () => {
      released += 1;
    },
  };
  return {
    pushes,
    lost: () => lost,
    released: () => released,
    onSnapshot: Object.assign((push: unknown) => {
      pushes.push(push);
    }, release),
    onLost: Object.assign(() => {
      lost += 1;
    }, release),
  };
};

describe("a test session's live queries", { timeout: 120_000 }, () => {
  /** A session of a sealed Notes App's test run, and its release. */
  const session = async () => {
    const built = await appWith(appFiles);
    await activateVersion(env, built.owner, built.app, 1);
    const release = await loadRelease(env, built.app, 1);
    const host = fixtureHostFor(env, release, appFiles);
    return { host, release, opened: await host.open("notes", "live") };
  };

  it("push a subscription's snapshots one at a time, each newer than the last and holding every note before it", async () => {
    const { release, opened } = await session();
    // A page that takes its time, and in its own time for each push: one
    // pushed before the last was taken would be recorded out of order.
    const recorded: { revision: number; titles: string[] }[] = [];
    const onSnapshot = async (push: unknown): Promise<void> => {
      await scheduler.wait(Math.floor(Math.random() * 400));
      const { revision, result } = pushOfNotes.parse(push);
      recorded.push({
        revision,
        titles: result.value.items.map(({ title }) => title),
      });
    };
    await opened.subscribe(
      "note-owner",
      requestFor(release, "notes.list", { pagination: {} }),
      onSnapshot,
      () => null
    );
    const titles = ["One", "Two", "Three", "Four", "Five", "Six"];
    for (const title of titles) {
      // One write after another, each past the manager's gathering
      // window, so each is read and pushed while the page takes its time.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await opened.call(
        "note-owner",
        requestFor(release, "notes.create", { title })
      );
      // oxlint-disable-next-line no-await-in-loop -- see above
      await scheduler.wait(70);
    }
    await vi.waitFor(
      () => {
        expect(recorded.at(-1)?.titles).toHaveLength(titles.length);
      },
      { timeout: 10_000 }
    );

    const outOfOrder = recorded.filter((snapshot, index) => {
      const before = recorded[index - 1];
      return (
        before !== undefined &&
        (snapshot.revision <= before.revision ||
          !before.titles.every((title) => snapshot.titles.includes(title)))
      );
    });
    expect(outOfOrder).toStrictEqual([]);
    await opened.close();
  });

  it("are released by the session when its test ends without closing them", async () => {
    const { release, opened } = await session();
    const list = requestFor(release, "notes.list", { pagination: {} });
    const left = follower();
    await opened.subscribe("note-owner", list, left.onSnapshot, left.onLost);
    await vi.waitFor(() => {
      expect(left.pushes).toHaveLength(1);
    });
    expect(left.released()).toBe(0);

    await opened.close();

    // Both callbacks let go of, and nothing sent to a test that ended.
    await vi.waitFor(() => {
      expect(left.released()).toBe(2);
    });
    expect(left.lost()).toBe(0);
    await expect(fixturesLeft()).resolves.toBe(0);
  });

  it("are released by the suite's host for a session its test never closed", async () => {
    const { host, release, opened } = await session();
    const left = follower();
    await opened.subscribe(
      "other-owner",
      requestFor(release, "notes.list", { pagination: {} }),
      left.onSnapshot,
      left.onLost
    );
    await vi.waitFor(() => {
      expect(left.pushes).toHaveLength(1);
    });

    await host.closeAll();

    await vi.waitFor(() => {
      expect(left.released()).toBe(2);
    });
  });

  it("push nothing more once released", async () => {
    const { release, opened } = await session();
    const followed = follower();
    const answer = await opened.subscribe(
      "note-owner",
      requestFor(release, "notes.list", { pagination: {} }),
      followed.onSnapshot,
      followed.onLost
    );
    if (!("subscription" in answer)) {
      throw new Error(`Refused: ${answer.refusal}`);
    }
    await vi.waitFor(() => {
      expect(followed.pushes).toHaveLength(1);
    });

    await answer.subscription.release();
    await opened.call(
      "note-owner",
      requestFor(release, "notes.create", { title: "Unseen" })
    );
    await scheduler.wait(500);

    expect({
      pushes: followed.pushes.length,
      lost: followed.lost(),
      released: followed.released(),
    }).toStrictEqual({ pushes: 1, lost: 1, released: 2 });
    await opened.close();
  });

  it("follow nothing once the session closed", async () => {
    const { release, opened } = await session();
    await opened.close();
    const late = follower();
    const answer = await opened.subscribe(
      "note-owner",
      requestFor(release, "notes.list", { pagination: {} }),
      late.onSnapshot,
      late.onLost
    );
    expect(Object.keys(answer)).toStrictEqual(["refusal"]);
    await scheduler.wait(200);
    // Nothing of the test's kept, and nothing pushed to it.
    expect({
      pushes: late.pushes.length,
      lost: late.lost(),
      released: late.released(),
    }).toStrictEqual({ pushes: 0, lost: 0, released: 0 });
  });
});
