import { GraspClient } from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { storeIdSchema } from "@grasp-os/shared/ids";
import { querySubscriptionLimits } from "@grasp-os/shared/screens";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { pastAccessRecheck } from "./apps.ts";
import { apiOf, referenceTo } from "./notes-client-app.ts";
import type { Push } from "./screen-client.ts";
import {
  mockSessionIdp,
  personApi,
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

// Live queries (spec 11): what a screen's `useQuery` does through the same
// client, over core's real connection, function route and store. A query
// is followed once however many components read it; a change saved
// elsewhere reaches it without the screen asking; pushes stay in order,
// never cross people, stop with access, survive a store restart, and
// pile up no further than one replacement each.

mockSessionIdp();

/**
 * A transport that counts what it follows and holds the answers of
 * calls while `held` is set, to deliver them late.
 */
const countingTransport = (transport: ClientTransport) => {
  let follows = 0;
  let gate: Promise<unknown> | undefined;
  return {
    transport: {
      call: async (request: string, app: string) => {
        const answer = await transport.call(request, app);
        await gate;
        return answer;
      },
      watch: async (...args: Parameters<ClientTransport["watch"]>) => {
        follows += 1;
        return await transport.watch(...args);
      },
    } satisfies ClientTransport,
    follows: () => follows,
    /** Holds every answer until the function it answers is called. */
    hold: () => {
      const { promise, resolve } = Promise.withResolvers<null>();
      gate = promise;
      return () => {
        gate = undefined;
        resolve(null);
      };
    },
  };
};

describe("live queries", { timeout: 120_000 }, () => {
  it("follows a query once for every reader, and shows a change saved in another tab without asking", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const counted = countingTransport(pageTransport(opened, opened.screens));
    const client = new GraspClient(counted.transport);
    const args = { pagination: { pageSize: 10 } };
    const first = reading(client, api.list, args);
    const second = reading(client, api.list, args);
    await eventually(() => {
      expect(shown(first.now())).toStrictEqual([]);
    });
    // A component that renders again lets go and subscribes in one go,
    // as React does: the subscription stays.
    first.stop();
    const again = reading(client, api.list, args);

    // Another tab of the same session: its own connection to core.
    const { core } = await openRpc(opened.cookie);
    const otherScreens = core.authenticate().screens;
    const other = clientFor(opened, otherScreens).client;
    await other.mutation(api.create, { title: "From the other tab" });

    await eventually(() => {
      expect(shown(second.now())).toStrictEqual(["From the other tab"]);
    });
    expect({
      again: shown(again.now()),
      follows: counted.follows(),
    }).toStrictEqual({
      again: ["From the other tab"],
      follows: 1,
    });
  });

  it("never shows one person's records to another, and pushes each their own", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const owner = clientFor(opened).client;
    const theirs = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    ).client;
    const args = { pagination: { pageSize: 10 } };
    const ownerList = reading(owner, api.list, args);
    const memberList = reading(theirs, api.list, args);
    await eventually(() => {
      expect(shown(memberList.now())).toStrictEqual([]);
    });

    await owner.mutation(api.create, { title: "The owner's" });
    await theirs.mutation(api.create, { title: "The member's" });

    await eventually(() => {
      expect({
        owner: shown(ownerList.now()),
        member: shown(memberList.now()),
      }).toStrictEqual({ owner: ["The owner's"], member: ["The member's"] });
    });
  });

  it("never lets a late answer of a read replace a newer push, followed or no longer", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const counted = countingTransport(pageTransport(opened, opened.screens));
    const client = new GraspClient(counted.transport);
    const id = await client.mutation(api.create, { title: "First" });
    const note = reading(client, api.get, { id });
    await eventually(() => {
      expect(note.now().value).toMatchObject({ _rev: 1 });
    });

    // A read whose answer is held back while the note moves on.
    const open = counted.hold();
    const late = client.query(api.get, { id });
    const other = clientFor(opened).client;
    await other.mutation(api.update, {
      id,
      expectedRevision: 1,
      title: "Second",
      body: "",
    });
    await eventually(() => {
      expect(note.now().value).toMatchObject({ _rev: 2, title: "Second" });
    });
    // Nobody follows the note now: the read sent before the push is still
    // older than what it shows.
    note.stop();
    await scheduler.wait(0);
    open();
    await late;

    expect(note.now().value).toMatchObject({ _rev: 2, title: "Second" });
  });

  it("clears what a screen shows once the person loses access, before anything more reaches it", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const theirs = clientFor(
      { ...opened, lease, cookie: member.session, userId: member.userId },
      member.api.screens
    ).client;
    await theirs.mutation(api.create, { title: "Mine" });
    const list = reading(theirs, api.list, { pagination: {} });
    await eventually(() => {
      expect(shown(list.now())).toStrictEqual(["Mine"]);
    });

    await opened.builder.api.apps.members.remove(opened.app, them);
    const owner = clientFor(opened).client;
    // Any commit to what the query read has it read again, as them.
    await pastAccessRecheck(async () => {
      await vi.waitFor(
        async () => {
          await owner.mutation(api.create, { title: "Elsewhere" });
          expect(list.now().error).toBeDefined();
        },
        { timeout: 10_000, interval: 250 }
      );
    });

    expect({
      value: list.now().value,
      code: list.now().error?.code,
    }).toStrictEqual({ value: undefined, code: "app.not_found" });
  });

  it("ends a screen's live queries once its App is unpublished or archived, with nothing written to set them off", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const member = await personApi("builder");
    await opened.builder.api.apps.members.add(opened.app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const theirs = reading(
      clientFor(
        { ...opened, lease, cookie: member.session, userId: member.userId },
        member.api.screens
      ).client,
      api.list,
      { pagination: {} }
    );
    const builders = reading(clientFor(opened).client, api.list, {
      pagination: {},
    });
    await eventually(() => {
      expect([shown(theirs.now()), shown(builders.now())]).toStrictEqual([
        [],
        [],
      ]);
    });

    // A draft is its builders' alone: its users' screens stop.
    await opened.builder.api.apps.unpublish(opened.app);
    await vi.waitFor(
      () => {
        expect(theirs.now().error).toBeDefined();
      },
      { timeout: 10_000, interval: 250 }
    );
    const draftForBuilder = builders.now().error?.code;
    // Nobody uses an archived App, its builders included.
    await opened.builder.api.apps.archive(opened.app);
    await vi.waitFor(
      () => {
        expect(builders.now().error).toBeDefined();
      },
      { timeout: 10_000, interval: 250 }
    );

    expect({
      user: { value: theirs.now().value, code: theirs.now().error?.code },
      draftForBuilder,
      builder: {
        value: builders.now().value,
        code: builders.now().error?.code,
      },
    }).toStrictEqual({
      user: { value: undefined, code: "app.not_found" },
      draftForBuilder: undefined,
      // Cleared as for anyone who lost the App, before anything more reaches it.
      builder: { value: undefined, code: "app.not_found" },
    });
  });

  it("lets the store drop a watch core let go of, even when telling it so failed", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const store = storeObjectOf(opened);
    // The store stays up, but core's word that it let go of a watch never
    // arrives.
    let undo: (() => void) | undefined;
    await runInDurableObject(store, (instance) => {
      // SAFETY: a store's object's prototype holds its methods.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const methods = Object.getPrototypeOf(instance) as Record<
        string,
        unknown
      >;
      const original = methods.unwatch;
      methods.unwatch = () => {
        throw new Error("Lost on the way.");
      };
      undo = () => {
        methods.unwatch = original;
      };
    });
    try {
      const { client } = clientFor(opened);
      const list = reading(client, api.list, { pagination: {} });
      await eventually(() => {
        expect(shown(list.now())).toStrictEqual([]);
      });
      list.stop();
      await scheduler.wait(500);

      // The store's sweep asks each watcher whether it is still there:
      // one core let go of says no, so the next sweep finds none left to
      // keep its alarm for.
      await runDurableObjectAlarm(store);
      await runDurableObjectAlarm(store);
      const alarm = await runInDurableObject(
        store,
        async (_instance, state) => await state.storage.getAlarm()
      );
      expect(alarm).toBeNull();
    } finally {
      undo?.();
    }
  });

  it("follows again after the store restarts, and shows a change saved just before", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const list = reading(client, api.list, { pagination: {} });
    await eventually(() => {
      expect(shown(list.now())).toStrictEqual([]);
    });

    const other = clientFor(opened).client;
    await other.mutation(api.create, { title: "Before the restart" });
    // Restarted, as a deploy restarts it, right after the commit: what
    // it held of the screen's watch is gone with it.
    await runInDurableObject(storeObjectOf(opened), (_store, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    await eventually(() => {
      expect(shown(list.now())).toStrictEqual(["Before the restart"]);
    });
    await other.mutation(api.create, { title: "After the restart" });

    await eventually(() => {
      expect(shown(list.now())).toStrictEqual([
        "After the restart",
        "Before the restart",
      ]);
    });
  });

  it("keeps one replacement for a page that doesn't take its pushes, and sends the latest once it does", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const received: { revision: number; titles: string[] }[] = [];
    const taken = Promise.withResolvers<null>();
    let first = true;
    const pushed = z.object({
      revision: z.number(),
      result: z.object({
        ok: z.literal(true),
        value: z.object({ items: z.array(z.object({ title: z.string() })) }),
      }),
    });
    // The page takes the first push only once the test lets it.
    const callback = async (push: unknown): Promise<void> => {
      const { revision, result } = pushed.parse(push);
      received.push({
        revision,
        titles: result.value.items.map(({ title }) => title),
      });
      if (first) {
        first = false;
        await taken.promise;
      }
    };
    await opened.screens.frame(opened.app, opened.lease).watchQuery(
      requestOf(api.list, { pagination: { pageSize: 50 } }),
      // Core waits for what a page's callback answers: that is the point.
      // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- see above
      callback
    );
    await eventually(() => {
      expect(received).toHaveLength(1);
    });

    const { client } = clientFor(opened);
    const saves = 8;
    for (let note = 1; note <= saves; note += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one save after the other
      await client.mutation(api.create, { title: `Note ${note}` });
    }
    // Room for the reads those saves cause, while the page holds the first.
    await scheduler.wait(1000);
    taken.resolve(null);
    await eventually(() => {
      expect(received.at(-1)?.titles).toHaveLength(saves);
    });

    const revisions = received.map(({ revision }) => revision);
    expect({
      inOrder: revisions.every(
        (revision, at) => at === 0 || revision > (revisions[at - 1] ?? 0)
      ),
      fewerThanSaves: received.length < 1 + saves,
    }).toStrictEqual({ inOrder: true, fewerThanSaves: true });
  });

  it("holds a page to its live queries at once", async () => {
    const opened = await openedApp();
    const follow = async (n: number) =>
      await outcome(
        opened.screens
          .frame(opened.app, opened.lease)
          .watchQuery(JSON.stringify({ n }), () => {
            // Each is refused as a call it can't read, and stays followed.
          })
      );
    const answers: string[] = [];
    // Following counts as a request: twenty a moment, as a screen would.
    for (let minute = 0; minute < 6; minute += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one minute after the other
      const batch = await later(
        minute + 1,
        async () =>
          await Promise.all(
            Array.from(
              { length: 17 },
              async (_, at) => await follow(minute * 17 + at)
            )
          )
      );
      answers.push(...batch);
    }

    expect({
      followed: answers.filter((answer) => answer === "ok").length,
      refused: [...new Set(answers.filter((answer) => answer !== "ok"))],
    }).toStrictEqual({ followed: 100, refused: ["screen.too_many_queries"] });
  });
});
describe("live queries: what goes out, and when", { timeout: 180_000 }, () => {
  it("checks access again before a result that waited goes out, with no write to set it off", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { them, lease, member } = await memberOf(opened);
    const received: Push[] = [];
    const first = Promise.withResolvers<null>();
    // The page holds its first push back while a newer result waits.
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
    const callback: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      received.push(read);
      if (read.revision === 1) {
        await first.promise;
      }
    };
    await member.api.screens
      .frame(opened.app, lease)
      .watchQuery(requestOf(api.list, { pagination: {} }), callback);
    await eventually(() => {
      expect(received).toHaveLength(1);
    });
    await clientFor(opened).client.mutation(api.create, { title: "Theirs" });
    // Room for the read that commit causes: its result waits behind the first.
    await scheduler.wait(1500);

    await opened.builder.api.apps.members.remove(opened.app, them);
    await pastAccessRecheck(async () => {
      first.resolve(null);
      await eventually(() => {
        expect(received.length).toBeGreaterThan(1);
      });
    });

    expect(received.slice(1).map(({ result }) => result.ok)).toStrictEqual([
      false,
    ]);
  });

  it("reads again when the store told of a write before its watch was in place", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const store = storeObjectOf(opened);
    const storeId = storeIdSchema.parse(opened.release.store?.storeId);
    // The owner's screens gone without a word, at the person's bound: the
    // next watch waits while the store asks them whether they're there.
    const asked = Promise.withResolvers<null>();
    await Promise.all(
      Array.from(
        { length: querySubscriptionLimits.perPerson },
        async () =>
          await store.watch(
            storeId,
            opened.builder.userId,
            {},
            // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- a dead screen never answers
            async (tables: string[]) => {
              if (tables.length === 0) {
                asked.resolve(null);
              }
              await Promise.withResolvers<never>().promise;
            }
          )
      )
    );
    const list = reading(clientFor(opened).client, api.list, {
      pagination: {},
    });
    // The query is read, and its watch waits on the sweep: a write now
    // is one the store tells the watch of the moment it is in place,
    // before core heard its ID.
    await asked.promise;
    await clientFor(opened).client.mutation(api.create, {
      title: "Landed meanwhile",
    });
    // With no alarm set, the store sets one before it answers the watch,
    // so its word of the write reaches core first.
    await runInDurableObject(store, async (_store, state) => {
      await state.storage.deleteAlarm();
    });

    await vi.waitFor(
      () => {
        expect(shown(list.now())).toStrictEqual(["Landed meanwhile"]);
      },
      { timeout: 15_000, interval: 100 }
    );
  });

  it("keeps reading other queries while pages hold refusals back", async () => {
    const opened = await openedApp();
    const other = await openedApp();
    const api = apiOf(opened.release);
    const otherApi = apiOf(other.release);
    const { them, lease, member } = await memberOf(opened);
    await other.builder.api.apps.members.add(other.app, {
      ...them,
      role: "user",
    });
    const { lease: otherLease } = await member.api.screens.open(
      other.app,
      "notes"
    );
    const refusals: Push[] = [];
    // A page that never takes the last result of what it follows.
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
    const holding: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      if (!read.result.ok) {
        refusals.push(read);
        await Promise.withResolvers<never>().promise;
      }
    };
    for (let size = 1; size <= 4; size += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await member.api.screens
        .frame(opened.app, lease)
        .watchQuery(
          requestOf(api.list, { pagination: { pageSize: size } }),
          holding
        );
    }
    await scheduler.wait(1000);
    await opened.builder.api.apps.members.remove(opened.app, them);
    const owner = clientFor(opened).client;
    await pastAccessRecheck(async () => {
      await vi.waitFor(
        async () => {
          await owner.mutation(api.create, { title: "Again" });
          expect(refusals).toHaveLength(4);
        },
        { timeout: 15_000, interval: 300 }
      );
    });

    const elsewhere = pageFollower();
    await member.api.screens
      .frame(other.app, otherLease)
      .watchQuery(
        requestOf(otherApi.list, { pagination: {} }),
        elsewhere.callback
      );
    await eventually(() => {
      expect(titlesOf(elsewhere.received[0])).toStrictEqual([]);
    });
  });

  it("reads afresh for a page that fell behind, rather than keep its result while it catches up", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    // Two notes near a body's bound: a list of them near an answer's.
    for (const title of ["One", "Two"]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await client.mutation(api.create, { title, body: "x".repeat(100_000) });
    }
    const pushes: Push[][] = [[], []];
    const first = Promise.withResolvers<null>();
    const followerOf = (index: number): ((push: unknown) => void) => {
      // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
      const callback: (push: unknown) => void = async (push) => {
        const read = pushSchema.parse(push);
        pushes[index]?.push(read);
        if (read.revision === 1) {
          await first.promise;
        }
      };
      return callback;
    };
    const followers = [followerOf(0), followerOf(1)];
    for (const [index, callback] of followers.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await opened.screens
        .frame(opened.app, opened.lease)
        .watchQuery(
          requestOf(api.list, { pagination: { pageSize: 10 + index } }),
          callback
        );
    }
    await eventually(() => {
      expect(pushes.map((list) => list.length)).toStrictEqual([1, 1]);
    });
    // A write both read again: past what the page may have waiting.
    await client.mutation(api.create, { title: "Three" });
    await scheduler.wait(1500);
    await silentlyRetitle(opened, "Since then");
    first.resolve(null);

    await eventually(() => {
      for (const list of pushes) {
        expect(titlesOf(list.at(-1))).toStrictEqual([
          "Since then",
          "Since then",
          "Since then",
        ]);
      }
    });
  });
});
describe("live queries and a person's roles", { timeout: 180_000 }, () => {
  it("never pushes what was read for a builder once the person is only a user, even a result that waited", async () => {
    const opened = await openedApp(withSecrets());
    const member = await personApi("builder");
    const them = { type: "person", id: member.userId } as const;
    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "builder",
    });
    const { lease } = await member.api.screens.open(opened.app, "notes");
    const secrets = referenceTo<Record<never, never>, unknown, "query">(
      opened.release,
      "notes.secrets"
    );
    const tell = referenceTo<{ text: string }, unknown, "mutation">(
      opened.release,
      "notes.tell"
    );
    const received: Push[] = [];
    const first = Promise.withResolvers<null>();
    // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- core waits for what a page's callback answers
    const callback: (push: unknown) => void = async (push) => {
      const read = pushSchema.parse(push);
      received.push(read);
      if (read.revision === 1) {
        await first.promise;
      }
    };
    await member.api.screens
      .frame(opened.app, lease)
      .watchQuery(requestOf(secrets, {}), callback);
    await eventually(() => {
      expect(received).toHaveLength(1);
    });
    // A builders' record, read for them while they are one: it waits.
    await clientFor(opened).client.mutation(tell, { text: "Builders only" });
    await scheduler.wait(1500);

    await opened.builder.api.apps.members.add(opened.app, {
      ...them,
      role: "user",
    });
    await pastAccessRecheck(async () => {
      first.resolve(null);
      await eventually(() => {
        expect(received.length).toBeGreaterThan(1);
      });
    });
    await scheduler.wait(500);

    expect(
      received.some(({ result }) =>
        JSON.stringify(result).includes("Builders only")
      )
    ).toBeFalsy();
  });
});
describe(
  "live queries and a failure to try again",
  { timeout: 120_000 },
  () => {
    it("follows again after a read that failed before it read anything, rather than push it as final", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      // A core where no sandbox bounds App code: every read is refused as
      // unavailable, to try again, before it reads the store.
      const { core } = await openRpc(opened.cookie, {
        coreEnv: {
          ...env,
          RUNTIME_PROFILE: "workerd",
          SANDBOX_HOST: undefined,
          SANDBOX_IN_PROCESS: undefined,
        },
      });
      const follower = pageFollower();
      await core
        .authenticate()
        .screens.frame(opened.app, opened.lease)
        .watchQuery(requestOf(api.list, { pagination: {} }), follower.callback);

      await eventually(() => {
        expect(follower.state.released).toBeTruthy();
      });
      expect(follower.received).toStrictEqual([]);
    });
  }
);
