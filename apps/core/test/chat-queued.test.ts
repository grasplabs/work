import { applyPartial } from "@grasp-os/shared/chat";
import type {
  ChatMessage,
  ChatPartial,
  ChatUpdate,
} from "@grasp-os/shared/chat";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { chatSession } from "../src/durable-objects.ts";
import { chatOf, model, pausedReply, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider, fakeProviderFor } from "./model-provider.ts";
import { turnRecordsOf } from "./model-usage.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";

// A question sent while the chat's agent works on another is queued into
// that turn (chat-harness.ts `queueQuestion`), in pi's own queue, as Claude Code,
// Codex and T3 Code take a message mid-turn. The ways it can fail: a
// question refused, lost or answered twice (an eviction with it queued, a
// call sent again); answered out of order; a watcher (another tab) not
// seeing it queued; Stop answering it anyway; Send now leaving it queued.

const idp = mockIdp();

const slow = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * Whether `message` is the recall before a question (turn-recall.ts): a
 * step every turn shows, which these tests leave aside.
 */
const ofRecall = (message: ChatMessage): boolean =>
  (message.role === "result" && message.callId.startsWith("recall_")) ||
  (message.role === "assistant" &&
    message.text === "" &&
    message.tools.length > 0 &&
    message.tools.every(({ callId }) => callId.startsWith("recall_")));

/** Follows a chat as a tab does, keeping every update. */
const follow = async (person: Person, chatId: string) => {
  const updates: ChatUpdate[] = [];
  // Put together as the page does.
  let partial: ChatPartial | null = null;
  await person.api.chats.watch(chatId, null, (update) => {
    updates.push(update);
    partial = applyPartial(partial, update.partial);
  });
  const last = () => updates.at(-1);
  return {
    /** What the person reads: each question and answer, by role and text. */
    shown: () =>
      updates
        .flatMap(({ messages }) => messages)
        .filter((message) => !ofRecall(message))
        .flatMap((message) =>
          message.role === "user" || message.role === "assistant"
            ? [{ role: message.role, text: message.text }]
            : []
        ),
    /** The questions it shows queued now, by their words. */
    queued: () => (last()?.queued ?? []).map(({ text }) => text),
    running: () => last()?.running ?? false,
    /** The answer being written, as far as it got. */
    writing: () => partial?.text,
  };
};
type Follower = Awaited<ReturnType<typeof follow>>;

/** Waits until the follower's chat has ended its turn with an answer. */
const settled = async (follower: Follower) => {
  await vi.waitFor(
    () => {
      expect(follower.running()).toBeFalsy();
      expect(follower.shown().at(-1)?.role).toBe("assistant");
    },
    { timeout: 20_000 }
  );
};

/** Restarts `stub`'s object, as an eviction or a deploy does, mid-call. */
const restart = async (stub: ReturnType<typeof chatSession>): Promise<void> => {
  await runInDurableObject(stub, (_instance, state) => {
    state.abort("Restarted by the test");
  }).catch(() => {
    // Aborting fails the call that aborted: that is the restart.
  });
};

/** The chat's messages as its Workspace keeps them: each role, and how it stopped. */
const keptOf = async (
  stub: Awaited<ReturnType<typeof chatOf>>["stub"],
  chatId: string
): Promise<string[]> =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ message: string }>(
        "SELECT message FROM chat_messages WHERE chat_id = ? ORDER BY id",
        chatId
      )
      .toArray()
      .map(({ message }) => {
        const { role, stopReason } = z
          .object({ role: z.string(), stopReason: z.string().optional() })
          .parse(JSON.parse(message));
        return stopReason === undefined ? role : `${role}:${stopReason}`;
      })
  );

describe("a question sent while the agent answers", slow, () => {
  it("is shown queued to every watcher, then answered after the answer under way, in the same turn", async () => {
    const ann = await signedInApi(idp, "user");
    const first = pausedReply(says("Paris."), 2);
    const provider = await fakeProvider(first.reply, says("Berlin."));
    const chat = await ann.api.chats.create("Capitals");
    const tab = await follow(ann, chat.id);
    const otherTab = await follow(ann, chat.id);
    try {
      await ann.api.chats.send(chat.id, { text: "France?", model });
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      // Taken at once, while the first answer is still being written.
      await ann.api.chats.send(chat.id, { text: "Germany?", model });
      await vi.waitFor(() => {
        expect([tab.queued(), otherTab.queued()]).toStrictEqual([
          ["Germany?"],
          ["Germany?"],
        ]);
      });
      first.release();
      await settled(tab);
      await settled(otherTab);
      const [record] = await turnRecordsOf(chat.id, 1);
      const inOrder = [
        { role: "user", text: "France?" },
        { role: "assistant", text: "Paris." },
        { role: "user", text: "Germany?" },
        { role: "assistant", text: "Berlin." },
      ];
      expect({
        tab: tab.shown(),
        otherTab: otherTab.shown(),
        queued: [tab.queued(), otherTab.queued()],
        // The second request reads the first answer, then the question.
        secondAsked: JSON.stringify(provider.requests[1]?.body).includes(
          "Germany?"
        ),
        requests: provider.requests.length,
        // One turn took both: its record says so.
        record: { outcome: record?.outcome, queued: record?.queued },
      }).toStrictEqual({
        tab: inOrder,
        otherTab: inOrder,
        queued: [[], []],
        secondAsked: true,
        requests: 2,
        record: { outcome: "answered", queued: 1 },
      });
    } finally {
      first.release();
    }
  });

  it("is dropped unanswered when the person stops the answer", async () => {
    const ann = await signedInApi(idp, "user");
    const provider = await fakeProvider({ hang: true }, says("Never."));
    const chat = await ann.api.chats.create("Stopped");
    const tab = await follow(ann, chat.id);
    await ann.api.chats.send(chat.id, { text: "First?", model });
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    await ann.api.chats.send(chat.id, { text: "Second?", model });
    await vi.waitFor(() => {
      expect(tab.queued()).toStrictEqual(["Second?"]);
    });

    await expect(ann.api.chats.cancel(chat.id)).resolves.toBeTruthy();
    await settled(tab);
    // Nothing is asked after the stop.
    await scheduler.wait(500);
    const [record] = await turnRecordsOf(chat.id, 1);
    expect({
      shown: tab.shown().map(({ role }) => role),
      queued: tab.queued(),
      requests: provider.requests.length,
      record: { outcome: record?.outcome, queued: record?.queued },
    }).toStrictEqual({
      shown: ["user", "assistant"],
      queued: [],
      requests: 1,
      record: { outcome: "cancelled", queued: 0 },
    });
  });

  it("is taken at once on Send now, the answer being written stopped where it was", async () => {
    const ann = await signedInApi(idp, "user");
    const first = pausedReply(says("A long answer."), 6);
    const provider = await fakeProvider(first.reply, says("Short."));
    const chat = await ann.api.chats.create("Now");
    const tab = await follow(ann, chat.id);
    try {
      await ann.api.chats.send(chat.id, { text: "Tell me all.", model });
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      await ann.api.chats.send(chat.id, { text: "Just the gist.", model });
      await vi.waitFor(() => {
        expect(tab.queued()).toStrictEqual(["Just the gist."]);
        expect(tab.writing()).toBe("A long");
      });

      await ann.api.chats.sendNow(chat.id);
      await settled(tab);
      const [record] = await turnRecordsOf(chat.id, 1);
      expect({
        shown: tab.shown(),
        queued: tab.queued(),
        requests: provider.requests.length,
        record: { outcome: record?.outcome, queued: record?.queued },
      }).toStrictEqual({
        shown: [
          { role: "user", text: "Tell me all." },
          // Stopped where it was, never finished.
          { role: "assistant", text: "A long" },
          { role: "user", text: "Just the gist." },
          { role: "assistant", text: "Short." },
        ],
        queued: [],
        requests: 2,
        record: { outcome: "answered", queued: 1 },
      });
    } finally {
      first.release();
    }
  });

  it("is answered once when the chat's object restarts with it queued, and it is sent again", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { id, stub, chat } = await chatOf(userId);
    const cut = pausedReply(says("Never."), 0);
    const again = pausedReply(says("First."), 2);
    const provider = await fakeProviderFor(
      [model],
      cut.reply,
      again.reply,
      says("Second.")
    );
    const session = () => chatSession(env, id, chatIdSchema.parse(chat.id));
    // As the chat's Workspace hands its turn over (`ChatSession.run`).
    const request = {
      turnId: "turn-a",
      sentAt: Date.now(),
      scope: {
        workspaceId: id,
        agentId: chat.agentId,
        chatId: chat.id,
        personId: userId,
        via: chat.via,
      },
      question: { text: "First?", model, files: [] },
      shared: false,
      personal: true,
      context: { skills: [] },
      capture: { attended: true },
    };
    const queued = { id: "question-b", text: "Second?", files: [] };
    try {
      void session()
        .run(request)
        .catch(() => "cut short");
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      await expect(
        session().queueQuestion("turn-a", queued)
      ).resolves.toBeTruthy();
      await restart(session());
      // As its Workspace asks again once its call broke: the turn, and the
      // question it queued, sent again until the turn takes it.
      const end = session().run(request);
      await vi.waitFor(
        async () => {
          await expect(
            session().queueQuestion("turn-a", queued)
          ).resolves.toBeTruthy();
        },
        { timeout: 10_000 }
      );
      again.release();
      await expect(end).resolves.toMatchObject({
        outcome: "answered",
        answer: "Second.",
      });
      expect({
        requests: provider.requests.length,
        // The question, its recall's step and the first answer; then the
        // queued question once, and its answer.
        kept: await keptOf(stub, chat.id),
      }).toStrictEqual({
        requests: 3,
        kept: [
          "user",
          "assistant:toolUse",
          "toolResult",
          "assistant:stop",
          "user",
          "assistant:stop",
        ],
      });
    } finally {
      cut.release();
      again.release();
    }
  });
});
