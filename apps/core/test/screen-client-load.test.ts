import { GraspClient } from "@grasp-os/sdk/host";
import { storeIdSchema } from "@grasp-os/shared/ids";
import { querySubscriptionLimits } from "@grasp-os/shared/screens";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { storeMaxWatches } from "../src/store-watches.ts";
import { pastAccessRecheck } from "./apps.ts";
import { apiOf, referenceTo } from "./notes-client-app.ts";
import type { Opened, Push } from "./screen-client.ts";
import {
  mockSessionIdp,
  openedApp,
  pageTransport,
  clientFor,
  reading,
  eventually,
  shown,
  requestOf,
  later,
  storeObjectOf,
  pushSchema,
  pageFollower,
  titlesOf,
  silentlyRetitle,
  memberOf,
  withSecrets,
} from "./screen-client.ts";
import { openRpc, outcome } from "./sign-in.ts";

// Live queries (spec 11) under load and loss: what a person follows is
// charged to their budget and bounded by the store's watches, a write the
// store never told of is still found, and a page that leaves no room for
// a result is read again once there is room.

mockSessionIdp();

describe("live queries under load and loss", { timeout: 180_000 }, () => {
  it("charges the reads a burst of commits causes to the person's budget, however many queries they follow", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const writer = await memberOf(opened);
    // A second tab of the owner's: each follows up to its bound.
    const { core } = await openRpc(opened.cookie);
    const otherTab = core.authenticate().screens;
    const followers = Array.from({ length: 150 }, () => pageFollower());
    for (let batch = 0; batch < followers.length / 15; batch += 1) {
      // Following counts as a request: fifteen a moment.
      // oxlint-disable-next-line no-await-in-loop -- one moment after the other
      await later(batch + 1, async () => {
        await Promise.all(
          followers
            .slice(batch * 15, batch * 15 + 15)
            .map(async (follower, at) => {
              const index = batch * 15 + at;
              const screens = index < 100 ? opened.screens : otherTab;
              await screens
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

    // Another person's commits to the table every one of them read.
    const started = Date.now();
    for (let note = 1; note <= 12; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one commit after the other
      await writer.client.mutation(api.create, { title: `Note ${note}` });
      // oxlint-disable-next-line no-await-in-loop -- spread over a few seconds
      await scheduler.wait(400);
    }
    await scheduler.wait(2000);
    const seconds = (Date.now() - started) / 1000;
    const reads =
      followers.reduce((sum, { received }) => sum + received.length, 0) -
      before;

    const { liveReads, concurrentReads } = querySubscriptionLimits;
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
              // Another screen, still there.
            })
        )
      );
      held.push(...ids.map(({ id }) => id));
    }
    const { client } = clientFor(opened);
    const list = reading(client, api.list, { pagination: {} });
    await scheduler.wait(3000);
    expect(list.now()).toStrictEqual({ value: undefined, error: undefined });

    // Some of the others stop following: this screen gets its turn.
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
    await opened.screens
      .frame(opened.app, opened.lease)
      .watchQuery(request, first.callback);
    await eventually(() => {
      expect(titlesOf(first.received.at(-1))).toStrictEqual(["Original"]);
    });

    await silentlyRetitle(opened, "Changed since");
    const joiner = pageFollower();
    await opened.screens
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
      await opened.screens
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

  it("sends nothing a page was owed once a refusal ended its subscription", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { them, lease, member } = await memberOf(opened);
    const received: Push[] = [];
    const stalled = {
      first: Promise.withResolvers<null>(),
      refusal: Promise.withResolvers<null>(),
    };
    // The page doesn't take its first push, nor the refusal, until the
    // test lets it: what core held for it meanwhile must not go out after.
    // Core waits for what a page's callback answers: that is the point.
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- see above
    const callback: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      received.push(read);
      if (read.revision === 1) {
        await stalled.first.promise;
      } else if (!read.result.ok) {
        await stalled.refusal.promise;
      }
    };
    await member.api.screens
      .frame(opened.app, lease)
      .watchQuery(requestOf(api.list, { pagination: {} }), callback);
    await eventually(() => {
      expect(received).toHaveLength(1);
    });
    const owner = clientFor(opened).client;
    // A read the page owes, waiting behind the first.
    await owner.mutation(api.create, { title: "Elsewhere" });
    await scheduler.wait(1500);

    await opened.builder.api.apps.members.remove(opened.app, them);
    await pastAccessRecheck(async () => {
      await vi.waitFor(
        async () => {
          await owner.mutation(api.create, { title: "Again" });
          expect(received.some(({ result }) => !result.ok)).toBeTruthy();
        },
        { timeout: 10_000, interval: 250 }
      );
    });
    stalled.first.resolve(null);
    await scheduler.wait(1500);
    stalled.refusal.resolve(null);
    await scheduler.wait(500);

    expect(
      received.map(({ revision, result }) => ({ revision, ok: result.ok }))
    ).toStrictEqual([
      { revision: 1, ok: true },
      { revision: received[1]?.revision, ok: false },
    ]);
  });

  it("checks a subscription against the following frame's own lease", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    // The builder's own lease names an approved build; this frame's is
    // one core never signed.
    await expect(
      outcome(
        opened.screens
          .frame(opened.app, "not-a-lease-core-signed")
          .watchQuery(
            requestOf(api.list, { pagination: {} }),
            pageFollower().callback
          )
      )
    ).resolves.toBe("screen.unreviewed");
  });

  it("backs off following a query that core lets go of after every push", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const page = pageTransport(opened, opened.screens);
    let follows = 0;
    // Core lets go of each subscription right after its first push.
    const client = new GraspClient({
      call: page.call,
      watch: async (request, onSnapshot, onLost) => {
        follows += 1;
        const handle = await page.watch(
          request,
          (push) => {
            onSnapshot(push);
            onLost();
          },
          () => {
            // Told already.
          }
        );
        return handle;
      },
    });
    // The wait before each follow is fully jittered (client-core.ts), so
    // how many fit in a window is chance: some draws stay near the 250 ms
    // floor. Taking the middle of every draw makes the waits 0.5, 1, 2 and
    // 4 s; a wall clock slowed by load only fits fewer.
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const list = reading(client, api.list, { pagination: {} });
      await scheduler.wait(6000);
      list.stop();
    } finally {
      random.mockRestore();
    }

    expect(follows).toBeGreaterThan(1);
    expect(follows).toBeLessThanOrEqual(5);
  });
});
/**
 * Counts the store's reads of a page of `pageSize` records of the opened
 * App's store from now on, as its object answers them.
 */
const countPageReads = async (opened: Opened, pageSize: number) => {
  const storeId = opened.release.store?.storeId;
  const counted = { reads: 0 };
  let undo: (() => void) | undefined;
  const pageOfSize = z.object({
    kind: z.literal("query"),
    query: z.object({
      terminal: z.object({
        kind: z.literal("paginate"),
        pageSize: z.literal(pageSize),
      }),
    }),
  });
  await runInDurableObject(storeObjectOf(opened), (instance) => {
    // SAFETY: a store's object's prototype holds its methods.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const methods = Object.getPrototypeOf(instance) as {
      read: (...args: unknown[]) => Promise<string>;
    };
    const original: unknown = Reflect.get(methods, "read");
    if (typeof original !== "function") {
      throw new TypeError("A store's object reads");
    }
    methods.read = async function read(
      this: unknown,
      ...args: unknown[]
    ): Promise<string> {
      if (args[0] === storeId && pageOfSize.safeParse(args[2]).success) {
        counted.reads += 1;
      }
      const answer: unknown = await Reflect.apply(original, this, args);
      return String(answer);
    };
    undo = () => {
      Reflect.set(methods, "read", original);
    };
  });
  return {
    count: () => counted.reads,
    restore: () => {
      undo?.();
    },
  };
};

describe(
  "live queries and the room a page leaves",
  { timeout: 120_000 },
  () => {
    it("reads a query held back by what other subscriptions waited on once those are released", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const { client } = clientFor(opened);
      // Two notes near a body's bound: a list of them near an answer's.
      for (const title of ["One", "Two"]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await client.mutation(api.create, { title, body: "x".repeat(100_000) });
      }
      const held = Promise.withResolvers<null>();
      // A page that holds back the first push of each of two queries.
      // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
      const holding: (push: unknown) => void = async () => {
        await held.promise;
      };
      const subscriptions = [];
      for (const pageSize of [10, 11]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        const subscription = await opened.screens
          .frame(opened.app, opened.lease)
          .watchQuery(
            requestOf(api.list, { pagination: { pageSize } }),
            holding
          );
        subscriptions.push(subscription);
      }
      await scheduler.wait(1500);
      // A third: no room left for its first result.
      const third = pageFollower();
      await opened.screens
        .frame(opened.app, opened.lease)
        .watchQuery(
          requestOf(api.list, { pagination: { pageSize: 12 } }),
          third.callback
        );
      await scheduler.wait(1500);
      expect(third.received).toStrictEqual([]);

      // The two are released, and the pushes they held finish after.
      await Promise.all(
        subscriptions.map(async (subscription) => {
          await subscription.release();
        })
      );
      held.resolve(null);

      await eventually(() => {
        expect(titlesOf(third.received[0])).toStrictEqual(["Two", "One"]);
      });
    });

    it("reads a query whose result found no room again only once there is room for it", async () => {
      const opened = await openedApp(withSecrets());
      const api = apiOf(opened.release);
      const { client } = clientFor(opened);
      for (const title of ["One", "Two"]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await client.mutation(api.create, { title, body: "x".repeat(100_000) });
      }
      const held = Promise.withResolvers<null>();
      // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
      const holding: (push: unknown) => void = async () => {
        await held.promise;
      };
      for (const pageSize of [10, 11]) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await opened.screens
          .frame(opened.app, opened.lease)
          .watchQuery(
            requestOf(api.list, { pagination: { pageSize } }),
            holding
          );
      }
      await scheduler.wait(1500);
      // A third list finds no room; a small query of another table is
      // taken at once.
      const third = pageFollower();
      await opened.screens
        .frame(opened.app, opened.lease)
        .watchQuery(
          requestOf(api.list, { pagination: { pageSize: 12 } }),
          third.callback
        );
      const secrets = referenceTo<Record<never, never>, unknown, "query">(
        opened.release,
        "notes.secrets"
      );
      const tell = referenceTo<{ text: string }, unknown, "mutation">(
        opened.release,
        "notes.tell"
      );
      const small = pageFollower();
      await opened.screens
        .frame(opened.app, opened.lease)
        .watchQuery(requestOf(secrets, {}), small.callback);
      await scheduler.wait(1500);

      // Each small push the page takes leaves no more room for the third.
      const reads = await countPageReads(opened, 12);
      try {
        for (let told = 1; told <= 5; told += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one after the other
          await client.mutation(tell, { text: `Told ${told}` });
          // oxlint-disable-next-line no-await-in-loop -- see above
          await eventually(() => {
            expect(small.received.length).toBeGreaterThan(told);
          });
        }
        expect({
          third: third.received,
          readsWithoutRoom: reads.count(),
        }).toStrictEqual({ third: [], readsWithoutRoom: 0 });
      } finally {
        reads.restore();
      }
      held.resolve(null);
    });
  }
);
