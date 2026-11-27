import type {
  ChatListUpdate,
  ChatMessage,
  ChatSummary,
} from "@grasp-os/shared/chat";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { RpcStub } from "capnweb";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { ChatListWatch } from "../src/chat-list-watch.ts";
import { ChatsRpc, personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { sessionRecheckMs } from "../src/session-check.ts";
import { model, pausedReply, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { callAuth, openRpc, signedInApi } from "./sign-in.ts";

// A person's list of chats, pushed as it changes (`chats.watchList`), as
// the sidebar and the chats window follow it. The ways it can fail come
// first: someone sees another person's list, or keeps getting theirs once
// signed out; a change is missed, or comes twice, after a dropped
// connection; a chat asked in moves up only once its answer starts; a
// streaming answer floods the page with updates nothing in the list shows.

const idp = mockIdp();

/** A member signed in on a connection of their own. */
const person = async () => await signedInApi(idp, "user");
type Person = Awaited<ReturnType<typeof person>>;

/** Another connection of `someone`'s, as a second tab or device opens one. */
const deviceOf = async (someone: Person) => {
  const { core, socket } = await openRpc(someone.session);
  return { chats: core.authenticate().chats, socket };
};

/**
 * Follows the person's list, keeping every update and the list as a page
 * puts it together from them.
 */
const followList = async (chats: Person["api"]["chats"]) => {
  const updates: ChatListUpdate[] = [];
  let list: ChatSummary[] = [];
  const subscription = await chats.watchList((update) => {
    updates.push(update);
    const changed = new Set(update.chats.map(({ id }) => id));
    const kept = update.full
      ? []
      : list.filter(
          ({ id }) => !changed.has(id) && !update.removed.includes(id)
        );
    list = [...kept, ...update.chats].toSorted(
      (a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt)
    );
  });
  return {
    updates,
    subscription,
    /** The list as the updates so far make it, by what a row shows. */
    rows: () =>
      list.map(({ title, running, unread }) => ({ title, running, unread })),
    archived: () => updates.at(-1)?.archived,
  };
};

/**
 * `someone`'s chats as their connection reaches them, its session read by
 * `check` (the connection's own reads it from the session store): a
 * follower of their list over it, and how to fail its next readings, as
 * the store failing a moment (a network error, a deploy) fails them.
 */
const listOverFlakySession = async (someone: Person) => {
  const identity = await someone.api.whoami();
  let failing = 0;
  const chats = new ChatsRpc(env, async () => {
    if (failing > 0) {
      failing -= 1;
      throw new Error("D1_ERROR: Network connection lost.");
    }
    return await Promise.resolve(identity);
  });
  const titles: string[][] = [];
  // The page's callback as core gets it, a stub, whose calls core never
  // waits on.
  // oxlint-disable-next-line typescript/no-misused-promises, typescript/strict-void-return -- see above
  const onUpdate: (update: ChatListUpdate) => void = new RpcStub(
    (update: ChatListUpdate) => {
      const before = update.full ? [] : (titles.at(-1) ?? []);
      titles.push([...before, ...update.chats.map(({ title }) => title)]);
    }
  );
  await chats.watchList(onUpdate);
  return {
    /** The titles the follower has now. */
    titles: () => titles.at(-1) ?? [],
    /** Fails the session's next `times` readings. */
    fail: (times: number) => {
      failing = times;
    },
  };
};

/** Waits until `check` holds of what the follower has. */
const until = async (check: () => void) => {
  await vi.waitFor(check, { timeout: 10_000 });
};

describe("a person's list of chats", () => {
  it("comes whole, then with each change: made, asked in (first at once), working, answered and unread, read, renamed, archived and deleted", async () => {
    const ann = await person();
    const { reply, release } = pausedReply(says("Here it is."), 1);
    await fakeProvider(reply);
    const invoices = await ann.api.chats.create("Invoices");
    const follower = await followList(ann.api.chats);
    await until(() => {
      expect(follower.rows()).toStrictEqual([
        { title: "Invoices", running: false, unread: false },
      ]);
    });
    expect(follower.updates[0]?.full).toBeTruthy();

    const travel = await ann.api.chats.create("Travel");
    await until(() => {
      expect(follower.rows().map(({ title }) => title)).toStrictEqual([
        "Travel",
        "Invoices",
      ]);
    });

    // Asked in: first, and working, before its question or answer shows.
    await ann.api.chats.send(invoices.id, { text: "Any news?", model });
    await until(() => {
      expect(follower.rows()).toStrictEqual([
        { title: "Invoices", running: true, unread: false },
        { title: "Travel", running: false, unread: false },
      ]);
    });
    release();
    await until(() => {
      expect(follower.rows()[0]).toStrictEqual({
        title: "Invoices",
        running: false,
        unread: true,
      });
    });

    await ann.api.chats.markRead(invoices.id);
    await until(() => {
      expect(follower.rows()[0]?.unread).toBeFalsy();
    });
    await ann.api.chats.rename(travel.id, "Trips");
    await ann.api.chats.archive(invoices.id);
    await until(() => {
      expect(follower.rows()).toStrictEqual([
        { title: "Trips", running: false, unread: false },
      ]);
      expect(follower.archived()).toBe(1);
    });
    await ann.api.chats.remove(travel.id);
    await until(() => {
      expect(follower.rows()).toStrictEqual([]);
    });
    // Each update carried only what changed: never the whole list again.
    expect(follower.updates.slice(1).every(({ full }) => !full)).toBeTruthy();
  });

  it("goes out once for what changed together, and not at all while an answer streams", async () => {
    const ann = await person();
    const { reply, release } = pausedReply(
      says("One two three four five six seven eight nine ten."),
      2
    );
    await fakeProvider(reply);
    const chat = await ann.api.chats.create("Streaming");
    const follower = await followList(ann.api.chats);
    await until(() => {
      expect(follower.updates).toHaveLength(1);
    });
    await ann.api.chats.send(chat.id, { text: "Count.", model });
    await until(() => {
      expect(follower.rows()[0]?.running).toBeTruthy();
    });
    release();
    await until(() => {
      expect(follower.rows()[0]?.unread).toBeTruthy();
    });
    // Asked in and working, then its question and answer kept, then done:
    // a few updates, each with that chat alone, however many words came.
    expect(follower.updates.length).toBeLessThanOrEqual(5);
    expect(
      follower.updates
        .slice(1)
        .every(
          ({ chats, removed }) => chats.length === 1 && removed.length === 0
        )
    ).toBeTruthy();
  });

  it("shows a read on another device at once, and a chat asked in there", async () => {
    const ann = await person();
    await fakeProvider(says("Done."), says("Again."));
    const chat = await ann.api.chats.create("Shared between devices");
    const follower = await followList(ann.api.chats);
    const phone = await deviceOf(ann);
    await phone.chats.send(chat.id, { text: "From the phone.", model });
    await until(() => {
      expect(follower.rows()[0]).toMatchObject({
        running: false,
        unread: true,
      });
    });
    await phone.chats.markRead(chat.id);
    await until(() => {
      expect(follower.rows()[0]?.unread).toBeFalsy();
    });
  });

  it("starts whole again after a dropped connection, with what changed meanwhile, nothing missed or twice", async () => {
    const ann = await person();
    const laptop = await deviceOf(ann);
    const first = await laptop.chats.create("First");
    const away = await followList(laptop.chats);
    await until(() => {
      expect(away.rows()).toHaveLength(1);
    });
    laptop.socket.close();

    // Three changes while the laptop is away.
    await ann.api.chats.create("Second");
    await ann.api.chats.rename(first.id, "First, renamed");
    await ann.api.chats.create("Third");

    const back = await deviceOf(ann);
    const resumed = await followList(back.chats);
    await until(() => {
      expect(resumed.rows().map(({ title }) => title)).toStrictEqual([
        "Third",
        "Second",
        "First, renamed",
      ]);
    });
    expect(resumed.updates[0]?.full).toBeTruthy();
  });

  it("is its person's alone: another person's chats never reach it, and a signed-out page gets nothing more", async () => {
    const ann = await person();
    const bob = await person();
    const follower = await followList(ann.api.chats);
    await until(() => {
      expect(follower.updates).toHaveLength(1);
    });
    await bob.api.chats.create("Bob's own");
    const own = await ann.api.chats.create("Ann's own");
    await until(() => {
      expect(follower.rows().map(({ title }) => title)).toStrictEqual([
        "Ann's own",
      ]);
    });

    await callAuth("/sign-out", ann.session, {});
    // Past the few seconds one reading of the session holds.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + sessionRecheckMs);
      const seen = follower.updates.length;
      // Its agent starts working, which the list would show.
      await runInDurableObject(
        workspace(env, personalWorkspaceId(ann.userId)),
        (instance) => {
          instance.turnRunning(chatIdSchema.parse(own.id), true);
        }
      );
      // What the page would have had by now, had it been pushed.
      await vi.waitFor(
        async () => {
          await expect(
            runInDurableObject(
              workspace(env, personalWorkspaceId(ann.userId)),
              (instance) => instance.chats(ann.userId)
            )
          ).resolves.toMatchObject([{ id: own.id, running: true }]);
        },
        { timeout: 10_000 }
      );
      expect(follower.updates).toHaveLength(seen);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is taken up again when its person's object resets mid-watch, as a deploy resets it, the chat's watch too, with nothing missed", async () => {
    const ann = await person();
    await fakeProvider(says("Still here."));
    const chat = await ann.api.chats.create("Before the reset");
    const list = await followList(ann.api.chats);
    const messages: ChatMessage[] = [];
    await ann.api.chats.watch(chat.id, null, (update) => {
      messages.push(...update.messages);
    });
    await until(() => {
      expect(list.rows()).toHaveLength(1);
    });
    await runInDurableObject(
      workspace(env, personalWorkspaceId(ann.userId)),
      (_instance, state) => {
        state.abort("Reset by the test");
      }
    ).catch(() => {
      // Aborting fails the call that aborted: that is the reset.
    });

    // After the reset, the browser's connection still open.
    await ann.api.chats.create("After the reset");
    await ann.api.chats.send(chat.id, { text: "Still there?", model });
    await vi.waitFor(
      () => {
        expect(list.rows().map(({ title }) => title)).toStrictEqual([
          "Before the reset",
          "After the reset",
        ]);
        expect(
          messages
            .filter(({ role }) => role === "user" || role === "assistant")
            .map(({ text }) => text)
            .filter((text) => text !== "")
        ).toStrictEqual(["Still there?", "Still here."]);
      },
      { timeout: 20_000 }
    );
  }, 30_000);

  it("keeps coming when the session can't be read a moment, as a push goes out or as it is taken up again after a reset", async () => {
    const ann = await person();
    const follower = await listOverFlakySession(ann);
    await until(() => {
      expect(follower.titles()).toStrictEqual([]);
    });
    // The session store fails as a chat made on another device goes out.
    follower.fail(1);
    await ann.api.chats.create("Made meanwhile");
    await until(() => {
      expect(follower.titles()).toContain("Made meanwhile");
    });
    // And as the watch is taken up again after the object reset.
    follower.fail(1);
    await runInDurableObject(
      workspace(env, personalWorkspaceId(ann.userId)),
      (_instance, state) => {
        state.abort("Reset by the test");
      }
    ).catch(() => {
      // Aborting fails the call that aborted: that is the reset.
    });
    await ann.api.chats.create("Made after the reset");
    await vi.waitFor(
      () => {
        expect(follower.titles()).toContain("Made after the reset");
      },
      { timeout: 20_000 }
    );
  }, 30_000);

  it("drops a watcher whose push failed and lets go of its listener, which core then watches again with (as after a reset)", async () => {
    let calls = 0;
    let letGo = 0;
    const listener = Object.assign(
      async (): Promise<void> => {
        calls += 1;
        await Promise.reject(new Error("The push didn't reach core"));
      },
      {
        [Symbol.dispose]: () => {
          letGo += 1;
        },
      }
    );
    const dropped = Promise.withResolvers<boolean>();
    // As the Workspace object keeps it: dropped means let go of.
    const watch: ChatListWatch = new ChatListWatch(listener, "person-1", () => {
      watch[Symbol.dispose]();
      dropped.resolve(true);
    });
    watch.push({ chats: [], archived: 0 });
    await dropped.promise;

    expect({ calls, letGo }).toStrictEqual({ calls: 1, letGo: 1 });
  });
});
