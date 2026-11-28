import type {
  ChatListUpdate,
  ChatMessage,
  ChatSummary,
} from "@grasp-os/shared/chat";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { RpcStub } from "capnweb";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";

import { ChatsRpc, personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { sessionEndedCloseCode } from "../src/rpc.ts";
import { sessionRecheckMs } from "../src/session-check.ts";
import { reopenJitter } from "../src/upstream.ts";
import { model, pausedReply, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { callAuth, openRpc, signedInApi } from "./sign-in.ts";
import { startedChat } from "./started-chats.ts";

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
  const chats = new ChatsRpc(
    env,
    async () => {
      if (failing > 0) {
        failing -= 1;
        throw new Error("D1_ERROR: Network connection lost.");
      }
      return await Promise.resolve(identity);
    },
    new AbortController().signal
  );
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

/** How many sockets follow the list in the person's object `object`. */
const listSockets = async (
  object: ReturnType<typeof workspace>
): Promise<number> =>
  await runInDurableObject(
    object,
    (_instance, state) => state.getWebSockets("list").length
  );

/** Waits until `check` holds of what the follower has. */
const until = async (check: () => void | Promise<void>) => {
  await vi.waitFor(check, { timeout: 10_000 });
};

describe("a person's list of chats", () => {
  // Every pause before the list's socket opens again (upstream.ts), its
  // jitter's draw fixed at none: no test waits on a draw, nor on how long
  // a pause runs.
  const { draw } = reopenJitter;
  beforeEach(() => {
    reopenJitter.draw = () => 0;
  });
  afterEach(() => {
    reopenJitter.draw = draw;
  });

  it("comes whole, then with each change: made, asked in (first at once), working, answered and unread, read, renamed, archived and deleted", async () => {
    const ann = await person();
    const { reply, release } = pausedReply(says("Here it is."), 1);
    await fakeProvider(reply);
    const invoices = await startedChat(ann, "Invoices");
    const follower = await followList(ann.api.chats);
    await until(() => {
      expect(follower.rows()).toStrictEqual([
        { title: "Invoices", running: false, unread: false },
      ]);
    });
    expect(follower.updates[0]?.full).toBeTruthy();

    const travel = await startedChat(ann, "Travel");
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
    const chat = await startedChat(ann, "Streaming");
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
    const chat = await startedChat(ann, "Shared between devices");
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
    const first = await startedChat(ann, "First");
    const away = await followList(laptop.chats);
    await until(() => {
      expect(away.rows()).toHaveLength(1);
    });
    laptop.socket.close();

    // Three changes while the laptop is away.
    await startedChat(ann, "Second");
    await ann.api.chats.rename(first.id, "First, renamed");
    await startedChat(ann, "Third");

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
    await startedChat(bob, "Bob's own");
    const own = await startedChat(ann, "Ann's own");
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
    const chat = await startedChat(ann, "Before the reset");
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
    await startedChat(ann, "After the reset");
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
    await startedChat(ann, "Made meanwhile");
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
    await startedChat(ann, "Made after the reset");
    await vi.waitFor(
      () => {
        expect(follower.titles()).toContain("Made after the reset");
      },
      { timeout: 20_000 }
    );
  }, 30_000);

  it("keeps coming after the person's object slept with the page following: whole again on the first change, then each change", async () => {
    const ann = await person();
    await startedChat(ann, "Before it slept");
    const follower = await followList(ann.api.chats);
    await until(() => {
      expect(follower.rows()).toHaveLength(1);
    });
    const object = workspace(env, personalWorkspaceId(ann.userId));

    // Hibernated: its memory gone (what each follower was sent among it),
    // the page's socket kept, so nothing is sent again until a change.
    await evictDurableObject(object);
    const seen = follower.updates.length;
    await expect(listSockets(object)).resolves.toBe(1);
    await startedChat(ann, "After it slept");
    await until(() => {
      expect(follower.rows().map(({ title }) => title)).toStrictEqual([
        "After it slept",
        "Before it slept",
      ]);
    });
    await startedChat(ann, "And after that");

    await until(() => {
      expect(follower.rows().map(({ title }) => title)).toStrictEqual([
        "And after that",
        "After it slept",
        "Before it slept",
      ]);
    });
    expect(
      follower.updates.slice(seen).map(({ full, chats }) => ({
        full,
        chats: chats.map(({ title }) => title),
      }))
    ).toStrictEqual([
      { full: true, chats: ["After it slept", "Before it slept"] },
      { full: false, chats: ["And after that"] },
    ]);
    // Let go of: its socket goes too, so the object holds nobody's.
    await follower.subscription.release();
    await until(async () => {
      await expect(listSockets(object)).resolves.toBe(0);
    });
  });

  it("is followed the old way by core's Worker of the release before, its callback kept in the object, while a deploy runs both", async () => {
    const ann = await person();
    await startedChat(ann, "Kept the old way");
    const titles: string[][] = [];
    const listener = Object.assign(
      async (update: ChatListUpdate): Promise<void> => {
        titles.push(update.chats.map(({ title }) => title));
        await Promise.resolve();
      },
      {
        [Symbol.dispose]: () => {
          // Let go of by the object.
        },
      }
    );

    await workspace(env, personalWorkspaceId(ann.userId)).watchChats(
      ann.userId,
      listener
    );
    await startedChat(ann, "And another");

    await until(() => {
      expect(titles.at(-1)).toStrictEqual(["And another"]);
    });
    expect(titles[0]).toStrictEqual(["Kept the old way"]);
  });

  it("is followed the old way while the person's object still runs the code of the release before, which takes no socket", async () => {
    const ann = await person();
    const object = workspace(env, personalWorkspaceId(ann.userId));
    // As the code before had it: no `fetch`, so opening a socket throws.
    await runInDurableObject(object, (instance) => {
      // SAFETY: an object's prototype holds its methods.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const methods = Object.getPrototypeOf(instance) as {
        fetch: (request: Request) => Response;
      };
      const original = methods.fetch;
      methods.fetch = () => {
        throw new TypeError("Handler does not export a fetch() function.");
      };
      onTestFinished(() => {
        methods.fetch = original;
      });
    });
    const tab = await deviceOf(ann);

    const follower = await followList(tab.chats);
    await startedChat(ann, "Heard all the same");

    await until(() => {
      expect(follower.rows().map(({ title }) => title)).toStrictEqual([
        "Heard all the same",
      ]);
    });
  });

  it("ends its follows when the person's chats are erased, letting go of the page's callback, which follows again", async () => {
    const ann = await person();
    const released = { now: false };
    const tab = await deviceOf(ann);
    await tab.chats.watchList(
      Object.assign(
        (update: ChatListUpdate) => {
          void update;
        },
        {
          [Symbol.dispose]: () => {
            released.now = true;
          },
        }
      )
    );
    const object = workspace(env, personalWorkspaceId(ann.userId));
    await until(async () => {
      await expect(listSockets(object)).resolves.toBe(1);
    });

    await object.erasePerson(ann.userId);

    await until(() => {
      expect(released.now).toBeTruthy();
    });
    await expect(listSockets(object)).resolves.toBe(0);
  });

  it("sends nothing more once the connection was told to read its session again and the session is gone", async () => {
    const ann = await person();
    const own = await startedChat(ann, "Ann's own");
    const follower = await followList(ann.api.chats);
    await until(() => {
      expect(follower.rows()).toHaveLength(1);
    });
    const object = workspace(env, personalWorkspaceId(ann.userId));
    // The reading stays fresh: only the telling makes the connection look.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
      .bind(ann.userId)
      .run();
    const seen = follower.updates.length;

    await object.identityChanged();
    await expect(ann.closed).resolves.toBe(sessionEndedCloseCode);
    // Its agent starts working, which the list would show.
    await runInDurableObject(object, (instance) => {
      instance.turnRunning(chatIdSchema.parse(own.id), true);
    });
    await scheduler.wait(200);

    expect(follower.updates).toHaveLength(seen);
  });

  it("pushes out a person's oldest follow of their list past the most, saying it was displaced, and nobody else's", async () => {
    const ann = await person();
    const released: boolean[] = [];
    const holds: Awaited<ReturnType<Person["api"]["chats"]["watchList"]>>[] =
      [];
    // Ten follows a connection, as core allows: six tabs of theirs.
    for (let tab = 0; tab < 6; tab += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tab after the other
      const { chats } = await deviceOf(ann);
      for (let follow = 0; follow < 10 && holds.length < 51; follow += 1) {
        const at = released.length;
        released.push(false);
        // oxlint-disable-next-line no-await-in-loop -- the oldest first
        const hold = await chats.watchList(
          Object.assign(
            (update: ChatListUpdate) => {
              void update;
            },
            {
              [Symbol.dispose]: () => {
                released[at] = true;
              },
            }
          )
        );
        holds.push(hold);
      }
    }

    await until(() => {
      expect(released.indexOf(true)).toBe(0);
    });
    expect({
      released: released.filter(Boolean).length,
      endedBy: await Promise.all(
        [holds[0], holds[1], holds[50]].map(
          async (hold) => await hold?.endedBy()
        )
      ),
    }).toStrictEqual({ released: 1, endedBy: ["displaced", null, null] });
  });

  it("lets go of a chat a page follows once it is deleted, quietly, never following it again", async () => {
    const ann = await person();
    const chat = await startedChat(ann, "To delete");
    const released = { now: false };
    const updates: unknown[] = [];
    await ann.api.chats.watch(
      chat.id,
      null,
      Object.assign(
        (update: unknown) => {
          updates.push(update);
        },
        {
          [Symbol.dispose]: () => {
            released.now = true;
          },
        }
      )
    );
    await until(() => {
      expect(updates.length).toBeGreaterThan(0);
    });
    const warned = vi.spyOn(console, "warn");
    onTestFinished(() => {
      warned.mockRestore();
    });

    await ann.api.chats.remove(chat.id);

    await until(() => {
      expect(released.now).toBeTruthy();
    });
    expect(
      warned.mock.calls.filter(
        ([line]) =>
          typeof line === "object" &&
          line !== null &&
          Reflect.get(line, "event") === "chat.rewatch_failed"
      )
    ).toStrictEqual([]);
  });
});
