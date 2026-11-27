import { chatHistoryPage } from "@grasp-os/shared/chat";
import type { ChatMessage, ChatUpdate } from "@grasp-os/shared/chat";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { model, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { startedChat } from "./started-chats.ts";

// A long chat read newest page first (`ChatsApi.watch` from the start,
// then `ChatsApi.history` a page at a time), as T3 Code opens a thread on
// its newest turns and loads earlier ones on request. The ways it can
// fail come first: a page skips or repeats a message, starts in the
// middle of an answer, or misses one stored while it was read; a watch
// taken up again sends the whole chat again; the New line lies in a page
// the person never got; someone reads a chat that isn't theirs.

const idp = mockIdp();

/** A member signed in on a connection of their own. */
const person = async () => await signedInApi(idp, "user");
type Person = Awaited<ReturnType<typeof person>>;

/** The object that holds `someone`'s chats. */
const objectOf = ({ userId }: { userId: string }) =>
  workspace(env, personalWorkspaceId(userId));

/** What an answer kept without a model call keeps of one (scripts/seed/chats.ts). */
const noModel = {
  api: "grasp",
  provider: "grasp",
  model: "grasp",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
} as const;

/**
 * Keeps `turns` questions in `someone`'s chat, each answered after
 * `steps` steps (a code step and its result), as its object stores
 * them: a long chat with nothing to ask a model for.
 */
const kept = async (
  someone: Person,
  chatId: string,
  turns: number,
  { steps = 0, from = 1 }: { steps?: number; from?: number } = {}
) => {
  await runInDurableObject(objectOf(someone), (_instance, state) => {
    const insert = (message: object) => {
      state.storage.sql.exec(
        "INSERT INTO chat_messages (chat_id, message, created_at) VALUES (?, ?, ?)",
        chatId,
        JSON.stringify(message),
        Date.now()
      );
    };
    for (let turn = from; turn < from + turns; turn += 1) {
      insert({
        role: "user",
        content: [{ type: "text", text: `Question ${turn}` }],
        timestamp: Date.now(),
      });
      for (let step = 0; step < steps; step += 1) {
        const callId = `call-${turn}-${step}`;
        insert({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: callId,
              name: "code",
              arguments: { code: "1" },
            },
          ],
          ...noModel,
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
        insert({
          role: "toolResult",
          toolCallId: callId,
          toolName: "code",
          content: [{ type: "text", text: "1" }],
          isError: false,
          timestamp: Date.now(),
        });
      }
      insert({
        role: "assistant",
        content: [{ type: "text", text: `Answer ${turn}` }],
        ...noModel,
        timestamp: Date.now(),
      });
    }
  });
};

/** Follows `chatId` from `after`, keeping each update. */
const follow = async (
  chats: Person["api"]["chats"],
  chatId: string,
  after: number | null = null
) => {
  const updates: ChatUpdate[] = [];
  await chats.watch(chatId, after, (update) => {
    updates.push(update);
  });
  await vi.waitFor(() => {
    expect(updates).not.toHaveLength(0);
  });
  return {
    updates,
    messages: (): ChatMessage[] => updates.flatMap(({ messages }) => messages),
  };
};

/** The words of each question and answer, in order. */
const said = (messages: readonly ChatMessage[]): string[] =>
  messages.flatMap((message) =>
    (message.role === "user" || message.role === "assistant") &&
    message.text !== ""
      ? [message.text]
      : []
  );

/**
 * Reads `chatId` back to its first message from `first`, a page at a
 * time, as the page does while its person scrolls up: every page, oldest
 * last.
 */
const readBack = async (
  chats: Person["api"]["chats"],
  chatId: string,
  first: readonly ChatMessage[]
) => {
  const pages: ChatMessage[][] = [];
  let before = first[0]?.id;
  for (let older = true; older && before !== undefined;) {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time, as the page reads them
    const page = await chats.history(chatId, before);
    pages.push(page.messages);
    ({ older } = page);
    before = page.messages[0]?.id;
  }
  return pages;
};

/** Every turn's words from `from` to `to`. */
const turnsSaid = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, index) => [
    `Question ${from + index}`,
    `Answer ${from + index}`,
  ]).flat();

describe("a long chat read newest page first", () => {
  it("opens on its newest page, from a question, and reads back a page at a time to its first message, none skipped or twice", async () => {
    const ann = await person();
    const chat = await startedChat(ann, "Long");
    await kept(ann, chat.id, 60, { steps: 1 });
    // Read as it was written, as a chat its person asks in is.
    await ann.api.chats.markRead(chat.id);
    const opened = await follow(ann.api.chats, chat.id);
    const first = opened.messages();
    const pages = await readBack(ann.api.chats, chat.id, first);
    const all = [...pages.toReversed().flat(), ...first];

    expect({
      older: opened.updates[0]?.older,
      // At most a page, give or take the rest of a turn, from a question.
      size: first.length <= chatHistoryPage + 2,
      startsAt: [first[0]?.role, ...pages.map((page) => page[0]?.role)],
      ordered: all.every(
        (message, index) =>
          index === 0 || message.id > (all[index - 1]?.id ?? 0)
      ),
      said: said(all),
    }).toStrictEqual({
      older: true,
      size: true,
      startsAt: Array.from({ length: pages.length + 1 }, () => "user"),
      ordered: true,
      said: turnsSaid(1, 60),
    });
  });

  it("is one page while it is short, with nothing older to read", async () => {
    const ann = await person();
    const chat = await startedChat(ann, "Short");
    await kept(ann, chat.id, 5);
    const opened = await follow(ann.api.chats, chat.id);
    const before = opened.messages()[0]?.id ?? 1;

    expect({
      older: opened.updates[0]?.older,
      said: said(opened.messages()),
      history: await ann.api.chats.history(chat.id, before),
    }).toStrictEqual({
      older: false,
      said: turnsSaid(1, 5),
      history: { messages: [], older: false },
    });
  });

  it("keeps what is stored while it is read back out of the pages, and follows it live", async () => {
    const ann = await person();
    await fakeProvider(says("Answer 61"));
    const chat = await startedChat(ann, "Growing");
    await kept(ann, chat.id, 60);
    // Read as it was written, as a chat its person asks in is.
    await ann.api.chats.markRead(chat.id);
    const opened = await follow(ann.api.chats, chat.id);
    const first = opened.messages();
    // Asked and answered while the person reads back.
    const asked = ann.api.chats.send(chat.id, { text: "Question 61", model });
    const pages = await readBack(ann.api.chats, chat.id, first);
    await asked;
    await vi.waitFor(() => {
      expect(said(opened.messages()).at(-1)).toBe("Answer 61");
    });

    expect(
      said([...pages.toReversed().flat(), ...opened.messages()])
    ).toStrictEqual(turnsSaid(1, 61));
  });

  it("sends only what came since when it is followed again from the last message the page had", async () => {
    const ann = await person();
    const chat = await startedChat(ann, "Resumed");
    await kept(ann, chat.id, 60);
    // Read as it was written, as a chat its person asks in is.
    await ann.api.chats.markRead(chat.id);
    const opened = await follow(ann.api.chats, chat.id);
    const last = opened.messages().at(-1)?.id ?? 0;
    await kept(ann, chat.id, 1, { from: 61 });
    const resumed = await follow(ann.api.chats, chat.id, last);

    expect({
      older: resumed.updates[0]?.older,
      said: said(resumed.messages()),
    }).toStrictEqual({ older: undefined, said: turnsSaid(61, 61) });
  });

  it("opens with everything its person hadn't seen when that goes back further than a page, from the question of the first", async () => {
    const ann = await person();
    const chat = await startedChat(ann, "Away");
    await kept(ann, chat.id, 10);
    const opened = await follow(ann.api.chats, chat.id);
    // Read up to the tenth answer; then sixty turns came while away.
    await ann.api.chats.markRead(chat.id);
    await kept(ann, chat.id, 60, { from: 11 });
    const back = await follow(ann.api.chats, chat.id);

    expect({
      first: said(opened.messages()).length,
      seenUpTo: back.updates[0]?.seenUpTo,
      lastSeen: opened.messages().at(-1)?.id,
      older: back.updates[0]?.older,
      said: said(back.messages()),
    }).toStrictEqual({
      first: 20,
      seenUpTo: opened.messages().at(-1)?.id,
      lastSeen: opened.messages().at(-1)?.id,
      older: true,
      said: turnsSaid(11, 70),
    });
  });

  it("is read by its person alone, and only before a message that is one", async () => {
    const ann = await person();
    const ben = await person();
    const chat = await startedChat(ann, "Mine");
    await kept(ann, chat.id, 30);
    // Read as it was written, as a chat its person asks in is.
    await ann.api.chats.markRead(chat.id);
    const opened = await follow(ann.api.chats, chat.id);
    const before = opened.messages()[0]?.id ?? 1;

    expect({
      ben: await outcome(ben.api.chats.history(chat.id, before)),
      unknown: await outcome(
        ann.api.chats.history(crypto.randomUUID(), before)
      ),
      bounds: await Promise.all(
        [0, -1, 1.5, Number.NaN, "10"].map(
          async (bad) =>
            // @ts-expect-error -- what a page must not send
            await outcome(ann.api.chats.history(chat.id, bad))
        )
      ),
    }).toStrictEqual({
      ben: "agent.chat_not_found",
      unknown: "agent.chat_not_found",
      bounds: Array.from({ length: 5 }, () => "agent.invalid_request"),
    });
  });

  it("keeps a turn longer than a page whole on one page, from its question", async () => {
    const ann = await person();
    const chat = await startedChat(ann, "Long turn");
    await kept(ann, chat.id, 5);
    // One turn of 30 steps: 62 messages, more than a page.
    await kept(ann, chat.id, 1, { steps: 30, from: 6 });
    await kept(ann, chat.id, 2, { from: 7 });
    await ann.api.chats.markRead(chat.id);
    const opened = await follow(ann.api.chats, chat.id);
    const pages = await readBack(ann.api.chats, chat.id, opened.messages());

    expect({
      startsAt: opened.messages()[0]?.role,
      opened: said(opened.messages()),
      readBack: said(pages.toReversed().flat()),
    }).toStrictEqual({
      startsAt: "user",
      opened: turnsSaid(6, 8),
      readBack: turnsSaid(1, 5),
    });
  });

  it("reads nothing of another chat before a message of its, nor past the chat's last", async () => {
    const ann = await person();
    const mine = await startedChat(ann, "Mine");
    const other = await startedChat(ann, "Other");
    await kept(ann, mine.id, 3);
    await kept(ann, other.id, 3);
    const elsewhere = await follow(ann.api.chats, other.id);
    const otherLast = elsewhere.messages().at(-1)?.id ?? 1;
    const mineOpened = await follow(ann.api.chats, mine.id);
    const saidBefore = async (before: number) => {
      const page = await ann.api.chats.history(mine.id, before);
      return said(page.messages);
    };

    expect({
      // Another chat's message names a place, never what is there.
      beforeOther: await saidBefore(otherLast),
      // Past the chat's last message: its newest page, as the watch's.
      aboveAll: await saidBefore(Number.MAX_SAFE_INTEGER),
    }).toStrictEqual({
      beforeOther: said(mineOpened.messages()),
      aboveAll: said(mineOpened.messages()),
    });
  });

  it("says what each answered Build it made as it opens, however far back that Build it lies", async () => {
    const ann = await person();
    const chat = await startedChat(ann, "Built");
    await runInDurableObject(objectOf(ann), (_instance, state) => {
      const insert = (message: object, built: object | null) => {
        state.storage.sql.exec(
          "INSERT INTO chat_messages (chat_id, message, created_at, built) VALUES (?, ?, ?, ?)",
          chat.id,
          JSON.stringify(message),
          Date.now(),
          built === null ? null : JSON.stringify(built)
        );
      };
      insert(
        {
          role: "user",
          content: [{ type: "text", text: "Build it" }],
          timestamp: Date.now(),
        },
        { plan: "plan-1", workflow: { id: "late-reminder", name: "Reminder" } }
      );
      insert(
        {
          role: "assistant",
          content: [{ type: "text", text: "It didn't pass its test." }],
          ...noModel,
          timestamp: Date.now(),
        },
        null
      );
    });
    // Then more than a page of other turns.
    await kept(ann, chat.id, 30);
    await ann.api.chats.markRead(chat.id);
    const opened = await follow(ann.api.chats, chat.id);

    expect({
      older: opened.updates[0]?.older,
      onPage: opened.messages().some(({ text }) => text === "Build it"),
      answeredBuilds: opened.updates[0]?.answeredBuilds,
    }).toStrictEqual({
      older: true,
      onPage: false,
      answeredBuilds: [{ kind: "workflow", id: "late-reminder" }],
    });
  });
});
