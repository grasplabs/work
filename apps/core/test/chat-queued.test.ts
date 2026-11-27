import { applyPartial } from "@grasp-os/shared/chat";
import type {
  ChatMessage,
  ChatPartial,
  ChatUpdate,
} from "@grasp-os/shared/chat";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { ChatSession } from "../src/chat-session.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { chatSession, workspace } from "../src/durable-objects.ts";
import { chatOf, model, pausedReply, says } from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider, fakeProviderFor } from "./model-provider.ts";
import { turnRecordsOf } from "./model-usage.ts";
import { outcome, signedInApi, signedInWithRole } from "./sign-in.ts";
import { startedChat } from "./started-chats.ts";

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
    /** The keys of the questions it shows, in order. */
    ids: () => ({
      asked: updates
        .flatMap(({ messages }) => messages)
        .flatMap((message) => (message.role === "user" ? [message.key] : [])),
    }),
    running: () => last()?.running ?? false,
    /** The answer being written, as far as it got. */
    writing: () => partial?.text,
  };
};
type Follower = Awaited<ReturnType<typeof follow>>;

/** The questions a follower shows, by their words. */
const asked = (follower: Follower): string[] =>
  follower.shown().flatMap(({ role, text }) => (role === "user" ? [text] : []));

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

/** How many answers of `personId`'s chat `chatId` were noted for their Brain. */
const notedFor = async (personId: string, chatId: string): Promise<number> => {
  const logged = await allEvents();
  return logged.filter(
    ({ action, target }) =>
      action === "chat.turn_noted" &&
      target?.id.startsWith(`${personId}/${chatId}`) === true
  ).length;
};

/** Restarts `stub`'s object, as an eviction or a deploy does, mid-call. */
const restart = async (
  stub: ReturnType<typeof chatSession> | ReturnType<typeof workspace>
): Promise<void> => {
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
    const chat = await startedChat(ann, "Capitals");
    const tab = await follow(ann, chat.id);
    const otherTab = await follow(ann, chat.id);
    try {
      // Each sent with the page's key, which it knows each question by.
      const france = crypto.randomUUID();
      const germany = crypto.randomUUID();
      await ann.api.chats.send(chat.id, {
        key: france,
        text: "France?",
        model,
      });
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      // Taken at once, while the first answer is still being written.
      await ann.api.chats.send(chat.id, {
        key: germany,
        text: "Germany?",
        model,
      });
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
        // Each question kept with its own key, the queued one too.
        asked: tab.ids().asked,
      }).toStrictEqual({
        tab: inOrder,
        otherTab: inOrder,
        queued: [[], []],
        secondAsked: true,
        requests: 2,
        record: { outcome: "answered", queued: 1 },
        asked: [france, germany],
      });
      // Each question answered is noted for the person's Brain, as two
      // turns' would be.
      await vi.waitFor(
        async () => {
          await expect(notedFor(ann.userId, chat.id)).resolves.toBe(2);
        },
        { timeout: 10_000 }
      );
    } finally {
      first.release();
    }
  });

  it("keeps its own key when a question sent after it is queued first", async () => {
    const ann = await signedInApi(idp, "user");
    const first = pausedReply(says("Paris."), 2);
    const provider = await fakeProvider(
      first.reply,
      says("Madrid."),
      says("Berlin.")
    );
    const chat = await startedChat(ann, "Overtaken");
    const tab = await follow(ann, chat.id);
    // Germany's call to the chat's object is held on its way, so Spain,
    // sent after it from another tab, reaches the agent first. Told by
    // flags, never a promise: the chat's object runs in its own context.
    const germanyCall = { reached: false, held: true };
    // oxlint-disable-next-line typescript/unbound-method -- called with its object below
    const queueing = ChatSession.prototype.queueQuestion;
    const queueQuestion = vi
      .spyOn(ChatSession.prototype, "queueQuestion")
      .mockImplementation(async function queueQuestion(
        this: ChatSession,
        turnId,
        question
      ) {
        if (question.text === "Germany?") {
          germanyCall.reached = true;
          while (germanyCall.held) {
            // oxlint-disable-next-line no-await-in-loop -- until let go
            await scheduler.wait(10);
          }
        }
        return await queueing.call(this, turnId, question);
      });
    try {
      const [france, germany, spain] = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      await ann.api.chats.send(chat.id, {
        key: france,
        text: "France?",
        model,
      });
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      const second = ann.api.chats.send(chat.id, {
        key: germany,
        text: "Germany?",
        model,
      });
      await vi.waitFor(() => {
        expect(germanyCall.reached).toBeTruthy();
      });
      await ann.api.chats.send(chat.id, { key: spain, text: "Spain?", model });
      await vi.waitFor(() => {
        expect(tab.queued()).toStrictEqual(["Spain?"]);
      });
      germanyCall.held = false;
      await second;
      await vi.waitFor(() => {
        expect(tab.queued()).toStrictEqual(["Spain?", "Germany?"]);
      });
      first.release();
      await settled(tab);
      // Read again from what the chat keeps, as a reload does.
      const reloaded = await follow(ann, chat.id);
      await vi.waitFor(() => {
        expect(asked(reloaded)).toHaveLength(3);
      });
      expect({
        tab: { asked: asked(tab), keys: tab.ids().asked },
        reloaded: { asked: asked(reloaded), keys: reloaded.ids().asked },
      }).toStrictEqual({
        tab: {
          asked: ["France?", "Spain?", "Germany?"],
          keys: [france, spain, germany],
        },
        reloaded: {
          asked: ["France?", "Spain?", "Germany?"],
          keys: [france, spain, germany],
        },
      });
    } finally {
      germanyCall.held = false;
      first.release();
      queueQuestion.mockRestore();
    }
  });

  it("is queued when it comes while the first is still being prepared, and answered after it", async () => {
    const ann = await signedInApi(idp, "user");
    const provider = await fakeProvider(
      says("Hello."),
      says("Paris."),
      says("Berlin.")
    );
    const chat = await startedChat(ann, "Preparing");
    const tab = await follow(ann, chat.id);
    // A chat's first message has no analysis beside its recall: one first.
    await ann.api.chats.send(chat.id, { text: "Hi?", model });
    await settled(tab);
    // The next question's recall, before it reaches pi, waits on its
    // analysis, held until the second question has come.
    const recalling = Promise.withResolvers<boolean>();
    provider.analysisReplies.push({
      text: JSON.stringify({ query: null }),
      inputTokens: 10,
      outputTokens: 5,
      pause: { at: 1, until: recalling.promise },
    });
    try {
      await ann.api.chats.send(chat.id, { text: "France?", model });
      await vi.waitFor(
        () => {
          expect(provider.analyses).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      // Taken once the first is in pi.
      const second = ann.api.chats.send(chat.id, {
        text: "Germany?",
        model,
      });
      const askedMeanwhile = provider.requests.length;
      recalling.resolve(true);
      await second;
      await vi.waitFor(() => {
        expect(tab.shown()).toHaveLength(6);
      });
      await settled(tab);
      const records = await turnRecordsOf(chat.id, 2);
      expect({
        askedMeanwhile,
        shown: tab.shown(),
        records: records.map(({ queued }) => queued),
      }).toStrictEqual({
        askedMeanwhile: 1,
        shown: [
          { role: "user", text: "Hi?" },
          { role: "assistant", text: "Hello." },
          { role: "user", text: "France?" },
          { role: "assistant", text: "Paris." },
          { role: "user", text: "Germany?" },
          { role: "assistant", text: "Berlin." },
        ],
        // One turn took both.
        records: [0, 1],
      });
    } finally {
      recalling.resolve(true);
    }
  });

  it("is dropped unanswered when the person stops the answer", async () => {
    const ann = await signedInApi(idp, "user");
    const provider = await fakeProvider({ hang: true }, says("Never."));
    const chat = await startedChat(ann, "Stopped");
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
    const chat = await startedChat(ann, "Now");
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
    const session = () =>
      chatSession(env, {
        workspaceId: id,
        chatId: chatIdSchema.parse(chat.id),
      });
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

  it("is answered once when the chat's object restarts as Send now stops the answer, and the turn settles", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { id, stub, chat } = await chatOf(userId);
    const cut = pausedReply(says("Never."), 3);
    const provider = await fakeProviderFor(
      [model],
      cut.reply,
      says("Answered."),
      says("Answered.")
    );
    const session = () =>
      chatSession(env, {
        workspaceId: id,
        chatId: chatIdSchema.parse(chat.id),
      });
    const request = {
      turnId: "turn-now",
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
        session().queueQuestion("turn-now", {
          id: "question-now",
          text: "Second?",
          files: [],
        })
      ).resolves.toBeTruthy();
      // Send now, and a restart while it stops the answer and goes on.
      const sending = session()
        .sendNow("turn-now")
        .catch(() => "cut short");
      await scheduler.wait(5);
      await restart(session());
      await sending;
      const end = await session().run(request);
      const kept = await keptOf(stub, chat.id);
      expect({
        outcome: end.outcome,
        // The queued question once, answered last.
        asked: kept.filter((role) => role === "user").length,
        last: kept.at(-1),
      }).toStrictEqual({
        outcome: "answered",
        asked: 2,
        last: "assistant:stop",
      });
    } finally {
      cut.release();
    }
  });

  it("is refused while a turn nobody asked for runs, which only reads", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { id, chat } = await chatOf(userId);
    const provider = await fakeProviderFor([model], { hang: true });
    const session = () =>
      chatSession(env, {
        workspaceId: id,
        chatId: chatIdSchema.parse(chat.id),
      });
    const woken = session()
      .run({
        turnId: "turn-wake",
        sentAt: Date.now(),
        scope: {
          workspaceId: id,
          agentId: chat.agentId,
          chatId: chat.id,
          personId: userId,
          via: chat.via,
          unattended: true,
        },
        question: { text: "Anything due?", model, files: [] },
        shared: false,
        personal: true,
        context: { skills: [] },
        capture: { attended: false },
      })
      .catch(() => "stopped");
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );

    await expect(
      outcome(
        session().queueQuestion("turn-wake", {
          id: "question-wake",
          text: "And mine?",
          files: [],
        })
      )
    ).resolves.toBe("agent.busy");
    await session().abort("turn-wake");
    await woken;
  });

  it("is queued into the turn the person's object left running as it restarted", async () => {
    const ann = await signedInApi(idp, "user");
    const first = pausedReply(says("Paris."), 2);
    const provider = await fakeProvider(first.reply, says("Berlin."));
    const chat = await startedChat(ann, "Left running");
    const id = personalWorkspaceId(ann.userId);
    try {
      await ann.api.chats.send(chat.id, { text: "France?", model });
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      // Only the person's object restarts: the chat's goes on answering,
      // and nothing here holds the turn any more.
      await restart(workspace(env, id));
      const tab = await follow(ann, chat.id);
      await vi.waitFor(() => {
        expect(tab.running()).toBeTruthy();
      });

      await ann.api.chats.send(chat.id, { text: "Germany?", model });
      await vi.waitFor(() => {
        expect(tab.queued()).toStrictEqual(["Germany?"]);
      });
      first.release();
      await settled(tab);
      const [record] = await turnRecordsOf(chat.id, 1);
      expect({
        shown: tab.shown(),
        queued: tab.queued(),
        requests: provider.requests.length,
        record: { outcome: record?.outcome, queued: record?.queued },
      }).toStrictEqual({
        shown: [
          { role: "user", text: "France?" },
          { role: "assistant", text: "Paris." },
          { role: "user", text: "Germany?" },
          { role: "assistant", text: "Berlin." },
        ],
        queued: [],
        requests: 2,
        record: { outcome: "answered", queued: 1 },
      });
    } finally {
      first.release();
    }
  });

  it("is taken at once on Send now after both the person's object and the chat's restarted with it queued", async () => {
    const ann = await signedInApi(idp, "user");
    const cut = pausedReply(says("Never."), 2);
    const writing = pausedReply(says("A long answer."), 6);
    const provider = await fakeProvider(
      cut.reply,
      writing.reply,
      says("Short.")
    );
    const chat = await startedChat(ann, "Restarted");
    const id = personalWorkspaceId(ann.userId);
    try {
      await ann.api.chats.send(chat.id, { text: "Tell me all.", model });
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      await ann.api.chats.send(chat.id, { text: "Just the gist.", model });
      // Both objects restart: nothing waits on the turn any more, and the
      // chat's object takes it up again on its own.
      await restart(workspace(env, id));
      const session = chatSession(env, {
        workspaceId: id,
        chatId: chatIdSchema.parse(chat.id),
      });
      await restart(session);
      // Its heartbeat wakes it, as the platform's alarm does.
      await runDurableObjectAlarm(
        chatSession(env, {
          workspaceId: id,
          chatId: chatIdSchema.parse(chat.id),
        })
      );
      const tab = await follow(ann, chat.id);
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(2);
          expect(tab.queued()).toStrictEqual(["Just the gist."]);
        },
        { timeout: 20_000 }
      );

      await ann.api.chats.sendNow(chat.id);
      await settled(tab);
      expect({
        last: tab.shown().slice(-2),
        queued: tab.queued(),
      }).toStrictEqual({
        last: [
          { role: "user", text: "Just the gist." },
          { role: "assistant", text: "Short." },
        ],
        queued: [],
      });
    } finally {
      cut.release();
      writing.release();
    }
  });
});
