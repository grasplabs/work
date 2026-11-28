import { setImmediate as nextTurn } from "node:timers/promises";

import { agentErrors } from "@grasp-os/shared/agent";
import type { ChatListUpdate, ChatSummary } from "@grasp-os/shared/chat";
import { authErrors, internalErrors } from "@grasp-os/shared/errors";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deadline, unlessAborted } from "../core.ts";
import { applyListUpdate } from "./chat-list.ts";
import type { ChatList } from "./chat-list.ts";
import { follow } from "./follow-chat.ts";

// The person's list as the tab puts it together from what core pushes:
// pure logic, so tested on its own. And following it across a dropped
// connection, on a stand-in for the tab's connection that keeps its
// contract (a call waits for the connection as long as its signal allows,
// a few seconds unless given) and a real Cap'n Web stub for the watch,
// which breaks as the socket under it does.

const chat = (id: string, lastAt: string): ChatSummary => ({
  id,
  title: `Chat ${id}`,
  agentId: "organization",
  createdAt: "2026-11-26T08:00:00.000Z",
  lastAt,
  running: false,
  unread: false,
  make: null,
  archived: false,
});

const empty: ChatList = { chats: [], archived: 0, loaded: false };

const ids = (list: ChatList) => list.chats.map(({ id }) => id);

describe("the person's list as the tab puts it together", () => {
  it("takes the whole list first, then each change in core's order, and drops what left it", () => {
    const whole = applyListUpdate(empty, {
      chats: [
        chat("b", "2026-11-26T09:00:00.000Z"),
        chat("a", "2026-11-26T08:00:00.000Z"),
      ],
      removed: [],
      full: true,
      archived: 2,
    });
    // Chat a asked in: first now.
    const asked = applyListUpdate(whole, {
      chats: [chat("a", "2026-11-26T10:00:00.000Z")],
      removed: [],
      full: false,
      archived: 2,
    });
    const dropped = applyListUpdate(asked, {
      chats: [],
      removed: ["b"],
      full: false,
      archived: 3,
    });
    // A watch started again: its whole list replaces what was there.
    const again = applyListUpdate(dropped, {
      chats: [chat("c", "2026-11-26T11:00:00.000Z")],
      removed: [],
      full: true,
      archived: 3,
    });

    expect({
      whole: ids(whole),
      asked: ids(asked),
      dropped: [ids(dropped), dropped.archived],
      again: ids(again),
    }).toStrictEqual({
      whole: ["b", "a"],
      asked: ["a", "b"],
      dropped: [["a"], 3],
      again: ["c"],
    });
  });
});

/** What core keeps for a watch, until the page lets go of it. */
class Watching extends RpcTarget {
  released = false;
  readonly #endedBy: "displaced" | null;

  constructor(endedBy: "displaced" | null = null) {
    super();
    this.#endedBy = endedBy;
  }

  release(): void {
    this.released = true;
  }

  endedBy(): "displaced" | null {
    return this.#endedBy;
  }
}

/** A watch's subscription as core hands it out: a stub that breaks with its connection. */
const subscription = (endedBy: "displaced" | null = null) => {
  const { port1, port2 } = new MessageChannel();
  newMessagePortRpcSession(port1, new Watching(endedBy));
  return {
    stub: newMessagePortRpcSession(port2),
    /** Breaks it, as the socket under it dropping does. */
    drop: () => {
      port1.postMessage(null);
    },
  };
};

/** Lets the stubs' messages through, which no fake timer holds. */
const delivered = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await nextTurn();
  }
};

describe("following the person's list across a dropped connection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows it again, whole, once core is back, however long the connection was gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let connected = Promise.withResolvers<boolean>();
    connected.resolve(true);
    const updates: ChatListUpdate[] = [];
    const subscriptions: ReturnType<typeof subscription>[] = [];
    const chats = {
      watchList: async (onUpdate: (update: ChatListUpdate) => void) => {
        onUpdate({
          chats: [chat(`chat-${subscriptions.length}`, "2026-11-26T09:00:00Z")],
          removed: [],
          full: true,
          archived: 0,
        });
        const made = subscription();
        subscriptions.push(made);
        return await Promise.resolve(made.stub);
      },
    };
    const core = {
      withSession: async <T>(
        run: (session: { chats: typeof chats }) => Promise<T>,
        signal = deadline()
      ): Promise<T> => {
        await unlessAborted(connected.promise, signal);
        return await run({ chats });
      },
    };
    const failed: string[] = [];
    const stop = follow(
      // SAFETY: a stand-in for the parts of the connection following uses.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      core as never,
      async (session) =>
        await session.chats.watchList((update) => {
          updates.push(update);
        }),
      (reason) => {
        failed.push(reason);
      }
    );
    await delivered();

    // The socket drops, and core stays out of reach for a minute.
    connected = Promise.withResolvers<boolean>();
    subscriptions[0]?.drop();
    await delivered();
    await vi.advanceTimersByTimeAsync(60_000);
    const whileGone = updates.length;
    connected.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await delivered();
    stop();

    expect({
      whileGone,
      lists: updates.map(({ chats: listed, full }) => [
        ids({ ...empty, chats: listed }),
        full,
      ]),
      failed,
    }).toStrictEqual({
      whileGone: 1,
      lists: [
        [["chat-0"], true],
        [["chat-1"], true],
      ],
      failed: [],
    });
  });
});

/**
 * Following the list on a stand-in connection whose watch fails as
 * `failures` say, in turn, then takes: how many tries it took, what the
 * page heard, and why it stopped, if it did.
 */
const followedThrough = (
  failures: (() => Error)[],
  connected: Promise<boolean> = Promise.resolve(true)
) => {
  const updates: ChatListUpdate[] = [];
  const failed: string[] = [];
  let tries = 0;
  const chats = {
    watchList: async (onUpdate: (update: ChatListUpdate) => void) => {
      const failure = failures[tries];
      tries += 1;
      if (failure !== undefined) {
        throw failure();
      }
      onUpdate({ chats: [], removed: [], full: true, archived: 0 });
      return await Promise.resolve(subscription().stub);
    },
  };
  const core = {
    withSession: async <T>(
      run: (session: { chats: typeof chats }) => Promise<T>,
      signal = deadline()
    ): Promise<T> => {
      await unlessAborted(connected, signal);
      return await run({ chats });
    },
  };
  const stop = follow(
    // SAFETY: a stand-in for the parts of the connection following uses.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    core as never,
    async (session) =>
      await session.chats.watchList((update) => {
        updates.push(update);
      }),
    (reason) => {
      failed.push(reason);
    },
    { untilSignedOut: true }
  );
  return {
    stop,
    read: () => ({ tries, heard: updates.length, failed: failed.length }),
  };
};

/** Core refusing another watch, and core mid-deploy. */
const busy = () => agentErrors.create("agent.too_many_watches");
const down = () => internalErrors.create("internal.unexpected");

describe("following the person's list whatever fails, until they sign out", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps trying while core refuses another watch, and through a deploy's failures, and follows once it takes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const refused = followedThrough([busy, busy]);
    const deploying = followedThrough([down, down, down, down, down]);
    await vi.advanceTimersByTimeAsync(60_000);
    await delivered();
    refused.stop();
    deploying.stop();

    expect({
      refused: refused.read(),
      deploying: deploying.read(),
    }).toStrictEqual({
      refused: { tries: 3, heard: 1, failed: 0 },
      deploying: { tries: 6, heard: 1, failed: 0 },
    });
  });

  it("waits for a connection however long it takes, never past a few seconds' failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const connected = Promise.withResolvers<boolean>();
    const followed = followedThrough([], connected.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    const whileGone = followed.read();
    connected.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await delivered();
    followed.stop();

    expect({ whileGone, back: followed.read() }).toStrictEqual({
      whileGone: { tries: 0, heard: 0, failed: 0 },
      back: { tries: 1, heard: 1, failed: 0 },
    });
  });

  it("stops once the person's session ended, and says so", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const followed = followedThrough([
      () => authErrors.create("auth.unauthenticated"),
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    followed.stop();

    expect(followed.read()).toStrictEqual({ tries: 1, heard: 0, failed: 1 });
  });
});

/**
 * Following the list on a stand-in connection whose core lets go of every
 * follow, saying why (`endedBy`): as soon as it is made, or, for a follow
 * `lasting` gives a time for (by its number, from 1), once that long has
 * passed. When each follow was made, from the start, by the faked clock.
 */
const followedLetGo = (
  endedBy: "displaced" | null,
  lasting: (made: number) => number | null = () => null
) => {
  const startedAt = Date.now();
  const madeAt: number[] = [];
  const chats = {
    watchList: async (
      onUpdate: ((update: ChatListUpdate) => void) & Partial<Disposable>
    ) => {
      madeAt.push(Date.now() - startedAt);
      const made = subscription(endedBy);
      const lasts = lasting(madeAt.length);
      if (lasts === null) {
        // Core lets go of it at once, as one pushed out or gone does.
        queueMicrotask(() => {
          onUpdate[Symbol.dispose]?.();
        });
      } else {
        setTimeout(() => {
          onUpdate[Symbol.dispose]?.();
        }, lasts);
      }
      return await Promise.resolve(made.stub);
    },
  };
  const core = {
    withSession: async <T>(
      run: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await run({ chats }),
  };
  const stop = follow(
    // SAFETY: a stand-in for the parts of the connection following uses.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    core as never,
    async (session, ended) =>
      await session.chats.watchList(
        Object.assign(
          (update: ChatListUpdate) => {
            void update;
          },
          { [Symbol.dispose]: ended }
        )
      ),
    () => {
      // Never refused here.
    }
  );
  return { stop, follows: () => madeAt.length, madeAt };
};

/**
 * Lets `ms` of faked time pass, a tenth of a second at a time, the stubs'
 * messages all through before each step: so whatever they start waiting
 * for starts at the time they were sent, never a step late.
 */
const passed = async (ms: number): Promise<void> => {
  for (let at = 0; at < ms; at += 100) {
    // oxlint-disable-next-line no-await-in-loop -- one step after the messages before it
    await delivered();
    // oxlint-disable-next-line no-await-in-loop -- see above
    await delivered();
    // oxlint-disable-next-line no-await-in-loop -- see above
    await vi.advanceTimersByTimeAsync(100);
  }
  await delivered();
};

describe("following again once core let go of a follow", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("waits longer each time a follow ends soon after it began, so no end ever makes a tight loop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // The jitter's draw, fixed: each pause half its ceiling.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const letGo = followedLetGo(null);

    await passed(31_000);
    letGo.stop();

    // At once, then after half of 1, 2, 4, 8 and 15 seconds, and 15 again.
    expect(letGo.madeAt).toStrictEqual([
      0, 500, 1500, 3500, 7500, 15_000, 22_500, 30_000,
    ]);
  });

  it("follows again at once after a follow that lasted, then waits longer again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // The third follow lasts the 30 s a steady one does; every other ends at once.
    const letGo = followedLetGo(null, (made) => (made === 3 ? 30_000 : null));

    await passed(32_500);
    letGo.stop();

    // At once after it: a timer of no time, which the faked clock runs a
    // millisecond on. Then half of 1 s again.
    expect(letGo.madeAt).toStrictEqual([0, 500, 1500, 31_501, 32_001]);
  });

  it("follows one pushed out by the person's other follows (displaced) again only once the page comes back to the front", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // The page, in front: what tells it to look again.
    const page = Object.assign(new EventTarget(), {
      visibilityState: "visible",
    });
    vi.stubGlobal("document", page);
    const letGo = followedLetGo("displaced");
    await vi.advanceTimersByTimeAsync(60_000);
    await delivered();
    const meanwhile = letGo.follows();

    page.dispatchEvent(new Event("visibilitychange"));
    await delivered();
    await vi.advanceTimersByTimeAsync(0);
    await delivered();
    letGo.stop();

    expect({ meanwhile, after: letGo.follows() }).toStrictEqual({
      meanwhile: 1,
      after: 2,
    });
  });
});
