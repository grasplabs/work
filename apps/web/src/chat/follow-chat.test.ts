import { setImmediate as nextTurn } from "node:timers/promises";

import type { ChatMessage, ChatUpdate } from "@grasp-os/shared/chat";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deadline, unlessAborted } from "../core.ts";
import { applyUpdate, emptyView, followChat } from "./follow-chat.ts";

// How the chat page puts a chat together from the updates core streams:
// pure logic, so tested on its own. And following a chat across a dropped
// connection, on a stand-in for the tab's connection that keeps its
// contract (a call waits for the connection as long as its signal allows,
// a few seconds unless given) and a real Cap'n Web stub for the watch,
// which breaks as the socket under it does.

const at = "2026-09-29T00:00:00.000Z";

const question = (id: number, text: string): ChatMessage => ({
  id,
  role: "user",
  text,
  at,
});

const update = (changes: Partial<ChatUpdate> = {}): ChatUpdate => ({
  messages: [],
  partial: null,
  running: false,
  stopped: null,
  held: 0,
  worked: 0,
  ...changes,
});

describe("a chat as the page shows it", () => {
  it("drops why the last question stopped once the next one runs", () => {
    const stopped = applyUpdate(
      emptyView,
      update({ stopped: "You're no longer a member of this organization." })
    );
    const next = applyUpdate(stopped, update({ running: true }));

    expect([stopped.stopped, next.stopped]).toStrictEqual([
      "You're no longer a member of this organization.",
      null,
    ]);
  });

  it("follows core's count of held writes, which the page reads again on", () => {
    const once = applyUpdate(emptyView, update({ held: 1 }));
    const twice = applyUpdate(once, update({ held: 2 }));

    expect([emptyView.held, once.held, twice.held]).toStrictEqual([0, 1, 2]);
  });

  it("adds each message once, in order, and keeps provenance until it changes", () => {
    const first = applyUpdate(
      emptyView,
      update({
        messages: [question(1, "One")],
        provenance: { sources: ["handbook"], restricted: false },
      })
    );
    // A reconnect may send a message the page has already.
    const again = applyUpdate(
      first,
      update({ messages: [question(1, "One"), question(2, "Two")] })
    );

    expect({
      texts: again.messages.map(({ text }) => text),
      provenance: again.provenance,
    }).toStrictEqual({
      texts: ["One", "Two"],
      provenance: { sources: ["handbook"], restricted: false },
    });
  });

  it("shows a running step's output as it grows, starts afresh for another step, and drops it once none runs", () => {
    const first = applyUpdate(
      emptyView,
      update({ output: { callId: "a", from: 0, text: "one" } })
    );
    const grown = applyUpdate(
      first,
      update({ output: { callId: "a", from: 3, text: "\ntwo" } })
    );
    const other = applyUpdate(
      grown,
      update({ output: { callId: "b", from: 0, text: "three" } })
    );
    const kept = applyUpdate(other, update({ output: undefined }));
    const done = applyUpdate(kept, update({ output: null }));

    expect([
      first.output,
      grown.output,
      other.output,
      kept.output,
      done.output,
    ]).toStrictEqual([
      { callId: "a", text: "one" },
      { callId: "a", text: "one\ntwo" },
      { callId: "b", text: "three" },
      // An update that leaves it out leaves it as it was.
      { callId: "b", text: "three" },
      null,
    ]);
  });
});

/** What core keeps for a watch, until the page lets go of it. */
class Watching extends RpcTarget {
  released = false;

  release(): void {
    this.released = true;
  }
}

/** A watch's subscription as core hands it out: a stub that breaks with its connection. */
const subscription = () => {
  const { port1, port2 } = new MessageChannel();
  newMessagePortRpcSession(port1, new Watching());
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

describe("following a chat across a dropped connection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows it again from its last message once core is back, however long the connection was gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let connected = Promise.withResolvers<boolean>();
    connected.resolve(true);
    const watched: (number | null)[] = [];
    const subscriptions: ReturnType<typeof subscription>[] = [];
    const chats = {
      watch: async (
        _chatId: string,
        after: number | null,
        onUpdate: (update: ChatUpdate) => void
      ) => {
        watched.push(after);
        onUpdate(update({ messages: [question(watched.length, "Hi?")] }));
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
    const stop = followChat(
      // SAFETY: a stand-in for the parts of the session following a chat uses.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      core as never,
      "chat-1",
      () => {
        // Each update is seen in `watched`.
      },
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
    const whileGone = [...watched];
    connected.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await delivered();
    stop();

    expect({ whileGone, watched, failed }).toStrictEqual({
      whileGone: [null],
      watched: [null, 1],
      failed: [],
    });
  });
});
