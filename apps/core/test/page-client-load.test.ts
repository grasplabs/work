import { storeIdSchema } from "@grasp-os/shared/ids";
import { querySubscriptionLimits } from "@grasp-os/shared/pages";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { storeMaxWatches } from "../src/store-watches.ts";
import { apiOf } from "./notes-client-app.ts";
import {
  mockSessionIdp,
  openedApp,
  clientFor,
  reading,
  eventually,
  shown,
  requestOf,
  later,
  storeObjectOf,
  pageFollower,
  titlesOf,
  silentlyRetitle,
} from "./page-client.ts";
import { openRpc } from "./sign-in.ts";

// Live queries (spec 11) under load: what a person follows is charged to
// their budget and bounded by the store's watches, and a write the store
// never told of is still found. page-client-loss.test.ts has the rest:
// what a refusal, a lease and a lost subscription leave, and the room a
// page leaves.

mockSessionIdp();

describe("live queries under load", { timeout: 180_000 }, () => {
  it("charges the reads a burst of commits causes to the person's budget, however many queries they follow", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    // The budget the tests set (`LIVE_READ_LIMITS` in vite.config.ts),
    // lower than a client's: spent in dozens of sandboxed reads rather
    // than hundreds. Stated here, not read through the product's parser,
    // so the bound below doesn't follow a parser that got it wrong.
    const liveReads = { burst: 50, perMinute: 300 };
    expect(env.LIVE_READ_LIMITS).toBe(
      `${liveReads.burst}/${liveReads.perMinute}`
    );
    // Two tabs of the owner's, thirty queries each: every commit wakes
    // more of them than the budget's burst, and the budget is the
    // person's, across tabs.
    const { core } = await openRpc(opened.cookie);
    const otherTab = core.authenticate().pages;
    const followers = Array.from({ length: 60 }, () => pageFollower());
    for (let batch = 0; batch < followers.length / 15; batch += 1) {
      // Following counts as a request: fifteen a moment.
      // oxlint-disable-next-line no-await-in-loop -- one moment after the other
      await later(batch + 1, async () => {
        await Promise.all(
          followers
            .slice(batch * 15, batch * 15 + 15)
            .map(async (follower, at) => {
              const index = batch * 15 + at;
              const pages = index < 30 ? opened.pages : otherTab;
              await pages
                .frame(opened.app, opened.lease)
                .watchQuery(
                  requestOf(api.list, { pagination: { pageSize: index + 1 } }),
                  follower.callback
                );
            })
        );
      });
    }
    await eventually(() => {
      expect(
        followers.every(({ received }) => received.length > 0)
      ).toBeTruthy();
    });
    const before = followers.reduce(
      (sum, { received }) => sum + received.length,
      0
    );

    // Commits every one of them shows, from the owner's second tab: only
    // a changed result is pushed.
    const writer = clientFor(opened, otherTab).client;
    const started = Date.now();
    for (let note = 1; note <= 6; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one commit after the other
      await writer.mutation(api.create, { title: `Note ${note}` });
      // oxlint-disable-next-line no-await-in-loop -- spread over a few seconds
      await scheduler.wait(400);
    }
    await scheduler.wait(2000);
    const seconds = (Date.now() - started) / 1000;
    const reads =
      followers.reduce((sum, { received }) => sum + received.length, 0) -
      before;

    const { concurrentReads } = querySubscriptionLimits;
    const bound =
      liveReads.burst + (liveReads.perMinute / 60) * seconds + concurrentReads;
    expect({ withinBudget: reads <= bound, read: reads > 0 }).toStrictEqual({
      withinBudget: true,
      read: true,
    });
  });

  it("follows again later when the store holds all the watches it may, instead of giving up", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const store = storeObjectOf(opened);
    const storeId = storeIdSchema.parse(opened.release.store?.storeId);
    const others = Math.ceil(
      storeMaxWatches / querySubscriptionLimits.perPerson
    );
    const held: string[] = [];
    for (let person = 0; person < others; person += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one person's at a time
      const ids = await Promise.all(
        Array.from(
          { length: querySubscriptionLimits.perPerson },
          async () =>
            await store.watch(storeId, `other-${person}`, {}, () => {
              // Another page, still there.
            })
        )
      );
      held.push(...ids.map(({ id }) => id));
    }
    const { client } = clientFor(opened);
    const list = reading(client, api.list, { pagination: {} });
    await scheduler.wait(3000);
    expect(list.now()).toStrictEqual({ value: undefined, error: undefined });

    // Some of the others stop following: this page gets its turn.
    await Promise.all(
      held.slice(0, 10).map(async (id) => {
        await store.unwatch(id);
      })
    );

    await vi.waitFor(
      () => {
        expect(shown(list.now())).toStrictEqual([]);
      },
      { timeout: 60_000, interval: 100 }
    );
  });

  it("gives a later reader a fresh read, not a result kept from before a write", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    await clientFor(opened).client.mutation(api.create, { title: "Original" });
    const request = requestOf(api.list, { pagination: {} });
    const first = pageFollower();
    await opened.pages
      .frame(opened.app, opened.lease)
      .watchQuery(request, first.callback);
    await eventually(() => {
      expect(titlesOf(first.received.at(-1))).toStrictEqual(["Original"]);
    });

    await silentlyRetitle(opened, "Changed since");
    const joiner = pageFollower();
    await opened.pages
      .frame(opened.app, opened.lease)
      .watchQuery(request, joiner.callback);

    await eventually(() => {
      expect(titlesOf(joiner.received[0])).toStrictEqual(["Changed since"]);
    });
  });

  it("finds a write the store never told of by checking its watch now and then", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    await clientFor(opened).client.mutation(api.create, { title: "Original" });
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    try {
      const follower = pageFollower();
      await opened.pages
        .frame(opened.app, opened.lease)
        .watchQuery(requestOf(api.list, { pagination: {} }), follower.callback);
      await eventually(() => {
        expect(titlesOf(follower.received.at(-1))).toStrictEqual(["Original"]);
      });

      await silentlyRetitle(opened, "Found later");
      await vi.advanceTimersByTimeAsync(querySubscriptionLimits.livenessMs);

      await eventually(() => {
        expect(titlesOf(follower.received.at(-1))).toStrictEqual([
          "Found later",
        ]);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
