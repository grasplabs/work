import { GraspClient } from "@grasp-os/sdk/host";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { pastAccessRecheck } from "./apps.ts";
import { apiOf, referenceTo } from "./notes-client-app.ts";
import type { Opened, Push } from "./page-client.ts";
import {
  mockSessionIdp,
  openedApp,
  pageTransport,
  clientFor,
  reading,
  eventually,
  requestOf,
  storeObjectOf,
  pushSchema,
  pageFollower,
  titlesOf,
  memberOf,
  withSecrets,
} from "./page-client.ts";
import { outcome } from "./sign-in.ts";

// Live queries (spec 11) under loss: nothing a page was owed goes out
// after a refusal, a subscription is checked against its frame's own
// lease, a query core lets go of is followed again ever more slowly, and
// a page that leaves no room for a result is read again once there is
// room. page-client-load.test.ts has live queries under load.

mockSessionIdp();

describe("live queries under loss", { timeout: 180_000 }, () => {
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
    await member.api.pages
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
    // The builder's own lease names the build core served; this frame's
    // is one core never signed.
    await expect(
      outcome(
        opened.pages
          .frame(opened.app, "not-a-lease-core-signed")
          .watchQuery(
            requestOf(api.list, { pagination: {} }),
            pageFollower().callback
          )
      )
    ).resolves.toBe("page.unreviewed");
  });

  it("backs off following a query that core lets go of after every push", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const page = pageTransport(opened, opened.pages);
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
        const subscription = await opened.pages
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
      await opened.pages
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
        await opened.pages
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
      await opened.pages
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
      await opened.pages
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
