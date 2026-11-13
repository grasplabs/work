import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { appPublishing } from "../src/app-publish.ts";
import { loadRelease } from "../src/app-releases.ts";
import { fixtureHostFor } from "../src/app-tests.ts";
import { releaseIdsOf } from "../src/apps.ts";
import { queryMaxReruns } from "../src/call-limits.ts";
import { rollback } from "../src/publish.ts";
import { maxTornReads } from "../src/query-subscriptions.ts";
import {
  appFiles,
  appWith,
  envWith,
  fixturesLeft,
  follower,
  identified,
  pushOfNotes,
  requestFor,
} from "./app-test-live-harness.ts";

/** A session of a sealed Notes App's test run, and its release. */
const session = async () => {
  const built = await appWith(appFiles);
  await rollback(env, appPublishing, built.owner, built.app, 1);
  const release = await loadRelease(env, built.app, 1);
  const host = fixtureHostFor(env, release, await releaseIdsOf(env, release));
  const opened = await host.open("live");
  await identified(opened);
  return { host, release, opened };
};

/**
 * A session of a sealed Notes App's test run whose store answers as it
 * does, but for its next `torn` looks at its tables' generations after
 * a read (store-reader.ts): each says every table moved on since, so
 * that run of a read is torn. `tear` asks for more such looks.
 */
const tearingSession = async (torn: number) => {
  let left = torn;
  const stores = new Proxy(env.DATA_STORES, {
    get: (namespace, key): unknown => {
      const value: unknown = Reflect.get(namespace, key);
      if (key !== "getByName" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(namespace) : value;
      }
      return (name: string) =>
        new Proxy(namespace.getByName(name), {
          get: (stub, method): unknown => {
            if (method === "generations" && left > 0) {
              return async () => {
                left -= 1;
                await Promise.resolve();
                return {};
              };
            }
            // An RPC stub's methods call through it whatever `this` is.
            return Reflect.get(stub, method);
          },
        });
    },
  });
  const built = await appWith(appFiles);
  await rollback(env, appPublishing, built.owner, built.app, 1);
  const release = await loadRelease(env, built.app, 1);
  const host = fixtureHostFor(
    envWith({ DATA_STORES: stores }),
    release,
    await releaseIdsOf(env, release)
  );
  const opened = await host.open("torn");
  await identified(opened);
  const followed = follower();
  await opened.subscribe(
    "note-owner",
    requestFor(release, "notes.list", { pagination: {} }),
    followed.onSnapshot,
    followed.onLost
  );
  const tear = (more: number) => {
    left += more;
  };
  return { release, opened, followed, tear };
};

// Live queries in an App's tests (`subscribe`, spec 28.2): a principal
// follows a query through the realtime manager a page's page follows
// one through, on the test's own fixture store. What the tests here check
// is what that host did: the spec's own example passes as written,
// snapshots are read as the principal who follows, a refusal or a query
// nothing matches fails the test, and core releases a subscription when
// the test closes it or ends.

describe("a test session's live queries", { timeout: 120_000 }, () => {
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

  it("keep following one subscription through one writer's writes, one after another", async () => {
    const { release, opened } = await session();
    const followed = follower();
    await opened.subscribe(
      "note-owner",
      requestFor(release, "notes.list", { pagination: {} }),
      followed.onSnapshot,
      followed.onLost
    );
    await vi.waitFor(() => {
      expect(followed.pushes).toHaveLength(1);
    });
    const writes = 20;
    for (let round = 0; round < writes; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one writer, a write at a time
      await opened.call(
        "note-owner",
        requestFor(release, "notes.create", { title: `Note ${round}` })
      );
    }
    await vi.waitFor(
      () => {
        const last = pushOfNotes.safeParse(followed.pushes.at(-1));
        expect(last.data?.result.value.items).toHaveLength(writes);
      },
      { timeout: 20_000 }
    );

    expect({
      lost: followed.lost(),
      released: followed.released(),
    }).toStrictEqual({ lost: 0, released: 0 });
    await opened.close();
  });

  /** Looks a read takes when every run of it is torn. */
  const tornRead = 1 + queryMaxReruns;

  it("read a subscription again, still followed, after reads writes tore, as many as it may", async () => {
    const { opened, followed } = await tearingSession(
      (maxTornReads - 1) * tornRead
    );

    await vi.waitFor(
      () => {
        expect(followed.pushes).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    expect(
      pushOfNotes.parse(followed.pushes[0]).result.value.items
    ).toStrictEqual([]);
    expect({
      lost: followed.lost(),
      released: followed.released(),
    }).toStrictEqual({ lost: 0, released: 0 });
    await opened.close();
  });

  it("count only torn reads in a row: a read writes didn't tear starts the count again", async () => {
    const { release, opened, followed, tear } = await tearingSession(
      (maxTornReads - 1) * tornRead
    );
    await vi.waitFor(
      () => {
        expect(followed.pushes).toHaveLength(1);
      },
      { timeout: 10_000 }
    );

    tear((maxTornReads - 1) * tornRead);
    await opened.call(
      "note-owner",
      requestFor(release, "notes.create", { title: "After" })
    );

    await vi.waitFor(
      () => {
        const last = pushOfNotes.safeParse(followed.pushes.at(-1));
        expect(last.data?.result.value.items).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    expect({
      lost: followed.lost(),
      released: followed.released(),
    }).toStrictEqual({ lost: 0, released: 0 });
    await opened.close();
  });

  it("let go of a subscription once one read too many in a row was torn", async () => {
    const { opened, followed } = await tearingSession(maxTornReads * tornRead);

    await vi.waitFor(
      () => {
        expect(followed.lost()).toBe(1);
      },
      { timeout: 10_000 }
    );
    // Nothing torn pushed as though it were an answer.
    expect(followed.pushes).toStrictEqual([]);
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
