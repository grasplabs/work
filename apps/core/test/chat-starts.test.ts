import type {
  ChatListUpdate,
  ChatMessage,
  ChatStart,
  ChatUpdate,
} from "@grasp-os/shared/chat";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { maxChatsPerPerson } from "../src/workspace.ts";
import { model, pausedReply, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { openRpc, outcome, signedInApi } from "./sign-in.ts";
import { startedChat } from "./started-chats.ts";

// A chat the page names itself, which the question that starts it makes
// (`ChatQuestion.start`), as T3 Code and the AI SDK's chat template name
// a new thread in the browser. The ways it can fail come first: a start
// takes over a chat already there (someone else's, or the person's own),
// says whether an ID is anyone's, makes a chat twice (a retry, two tabs at
// once, a restart in between), makes one past the person's most, or a
// read of the new chat on the same connection finds none yet.

const idp = mockIdp();

/** A member signed in on a connection of their own. */
const person = async () => await signedInApi(idp, "user");
type Person = Awaited<ReturnType<typeof person>>;

/** Another connection of `someone`'s, as a second tab opens one. */
const tabOf = async (someone: Person) => {
  const { core } = await openRpc(someone.session);
  return await core.authenticate().chats;
};

/** The object that holds `someone`'s chats. */
const objectOf = ({ userId }: { userId: string }) =>
  workspace(env, personalWorkspaceId(userId));

/** A start, as a page makes one, its key the question's. */
const startOf = (title: string, key = crypto.randomUUID()): ChatStart => ({
  key,
  title,
});

/** The question that starts a chat with `start`. */
const startingWith = (start: ChatStart, text = "Where are we?") => ({
  key: start.key,
  text,
  model,
  start,
});

/** Follows a chat, keeping its messages as they come. */
const follow = async (chats: Person["api"]["chats"], chatId: string) => {
  const updates: ChatUpdate[] = [];
  await chats.watch(chatId, null, (update) => {
    updates.push(update);
  });
  return {
    updates,
    messages: (): ChatMessage[] => updates.flatMap(({ messages }) => messages),
  };
};

/** What the person reads: each question's and answer's words. */
const said = (messages: readonly ChatMessage[]) =>
  messages.flatMap((message) =>
    (message.role === "user" || message.role === "assistant") &&
    message.text !== ""
      ? [{ role: message.role, text: message.text }]
      : []
  );

/** The titles of the person's chats in their list, in order of title. */
const titlesOf = async (chats: Person["api"]["chats"]): Promise<string[]> => {
  const listed = await chats.list();
  return listed.map(({ title }) => title).toSorted();
};

/** Waits until `check` holds. */
const until = async (check: () => void | Promise<void>) => {
  await vi.waitFor(check, { timeout: 10_000 });
};

describe("a chat a page starts", () => {
  it("is made by its first question, in the same call, and its page follows it at once on the same connection", async () => {
    const ann = await person();
    await fakeProvider(says("We are on track."));
    const lists: ChatListUpdate[] = [];
    await ann.api.chats.watchList((update) => {
      lists.push(update);
    });
    const chatId = crypto.randomUUID();
    const start = startOf("Where are we?");
    // As the page does: the question goes, then the chat's page reads and
    // follows it at once, before core answered the question.
    const sent = ann.api.chats.send(chatId, startingWith(start));
    const [summary, follower] = await Promise.all([
      ann.api.chats.summary(chatId),
      follow(ann.api.chats, chatId),
    ]);
    await sent;
    await until(() => {
      expect(said(follower.messages())).toStrictEqual([
        { role: "user", text: "Where are we?" },
        { role: "assistant", text: "We are on track." },
      ]);
    });
    const listed = await ann.api.chats.list();
    expect({
      summary: { id: summary.id, title: summary.title },
      listed: listed.map(({ id, title }) => ({ id, title })),
      // Never twice in the list, however its updates came.
      rows: lists.every(
        (update) => update.chats.filter(({ id }) => id === chatId).length <= 1
      ),
      key: follower
        .messages()
        .find((message) => message.role === "user" && message.key === start.key)
        ?.text,
    }).toStrictEqual({
      summary: { id: chatId, title: "Where are we?" },
      listed: [{ id: chatId, title: "Where are we?" }],
      rows: true,
      key: "Where are we?",
    });
  });

  it("is made once, its question asked once, however often the page sends it and from however many tabs at once", async () => {
    const ann = await person();
    const { reply, release } = pausedReply(says("Once."), 1);
    await fakeProvider(reply);
    const tab = await tabOf(ann);
    const chatId = crypto.randomUUID();
    const question = startingWith(startOf("Twice at once"));
    // Two tabs at once, then again once it was taken, as a page that never
    // heard the answer sends it.
    await Promise.all([
      ann.api.chats.send(chatId, question),
      tab.send(chatId, question),
    ]);
    await ann.api.chats.send(chatId, question);
    const follower = await follow(ann.api.chats, chatId);
    release();
    await until(() => {
      expect(said(follower.messages()).at(-1)?.text).toBe("Once.");
    });
    // What a repeat names isn't checked again: gone since, it would refuse
    // only a new chat.
    await ann.api.chats.send(chatId, {
      ...question,
      start: { ...question.start, agentId: crypto.randomUUID() },
    });
    expect({
      said: said(follower.messages()),
      listed: await titlesOf(ann.api.chats),
    }).toStrictEqual({
      said: [
        { role: "user", text: "Where are we?" },
        { role: "assistant", text: "Once." },
      ],
      listed: ["Twice at once"],
    });
  });

  it("takes over no chat already there, the person's own or deleted ones included, and refuses another start of the same ID", async () => {
    const ann = await person();
    await fakeProvider(says("Noted."), says("Noted again."));
    const tab = await tabOf(ann);
    // Two tabs name the same chat with starts of their own: one makes it.
    const chatId = crypto.randomUUID();
    const outcomes = await Promise.all([
      outcome(ann.api.chats.send(chatId, startingWith(startOf("First")))),
      outcome(tab.send(chatId, startingWith(startOf("Second")))),
    ]);
    const own = await startedChat(ann, "Own");
    const deleted = await startedChat(ann, "Deleted");
    const deletedStart = startOf("Deleted again");
    await ann.api.chats.remove(deleted.id);
    expect({
      outcomes: outcomes.toSorted(),
      // Their own chat, named as new: neither asked in nor renamed.
      own: await outcome(
        ann.api.chats.send(own.id, startingWith(startOf("Taken over")))
      ),
      ownNow: await ann.api.chats.summary(own.id),
      // A deleted chat's ID stays taken, for its person too.
      deleted: await outcome(
        ann.api.chats.send(deleted.id, startingWith(deletedStart))
      ),
      // Nor is a file attached to one under a start.
      attached: await outcome(
        ann.api.chats.attachFile(
          own.id,
          { name: "notes.txt", bytes: new TextEncoder().encode("Notes") },
          crypto.randomUUID(),
          startOf("Taken over")
        )
      ),
    }).toMatchObject({
      outcomes: ["agent.chat_not_found", "ok"],
      own: "agent.chat_not_found",
      ownNow: { id: own.id, title: "Own", agentId: chatAgentId },
      deleted: "agent.chat_not_found",
      attached: "agent.chat_not_found",
    });
    // The start that made it named it: the other made nothing.
    const { title } = await ann.api.chats.summary(chatId);
    expect({
      title: ["First", "Second"].includes(title),
      listed: await titlesOf(ann.api.chats),
    }).toStrictEqual({ title: true, listed: [title, "Own"].toSorted() });
  });

  it("makes one chat for a start's key, however many IDs it is sent with at once", async () => {
    const ann = await person();
    const tab = await tabOf(ann);
    const start = startOf("One key");
    const outcomes = await Promise.all([
      outcome(
        ann.api.chats.attachFile(
          crypto.randomUUID(),
          { name: "a.txt", bytes: new TextEncoder().encode("A") },
          crypto.randomUUID(),
          start
        )
      ),
      outcome(
        tab.attachFile(
          crypto.randomUUID(),
          { name: "b.txt", bytes: new TextEncoder().encode("B") },
          crypto.randomUUID(),
          start
        )
      ),
    ]);

    expect({
      outcomes: outcomes.toSorted(),
      listed: await titlesOf(ann.api.chats),
    }).toStrictEqual({
      outcomes: ["agent.chat_not_found", "ok"],
      listed: ["One key"],
    });
  });

  it("refuses an ID someone else's chat has as it refuses one that isn't an ID, saying nothing of theirs and leaving it be", async () => {
    const ann = await person();
    const ben = await person();
    await fakeProvider(says("Ben's answer."));
    const bens = crypto.randomUUID();
    const benStart = startOf("Ben's");
    await ben.api.chats.send(bens, startingWith(benStart));
    const deleted = await startedChat(ben, "Ben's deleted");
    await ben.api.chats.remove(deleted.id);
    // A chat core named itself (a chat app's conversation, a wake-up's).
    const corenamed = await objectOf(ben).createChat(
      "Ben in Teams",
      ben.userId,
      chatAgentId,
      undefined,
      "teams"
    );
    const benFollows = await follow(ben.api.chats, bens);
    await until(() => {
      expect(said(benFollows.messages()).at(-1)?.text).toBe("Ben's answer.");
    });
    expect({
      taken: await outcome(
        ann.api.chats.send(bens, startingWith(startOf("Mine now")))
      ),
      deleted: await outcome(
        ann.api.chats.send(deleted.id, startingWith(startOf("Mine now")))
      ),
      corenamed: await outcome(
        ann.api.chats.send(corenamed.id, startingWith(startOf("Mine now")))
      ),
      // With Ben's own start key too, as if Ann had seen it.
      key: await outcome(
        ann.api.chats.send(
          bens,
          startingWith({ ...startOf("Mine now"), key: benStart.key })
        )
      ),
      notAnId: await outcome(
        ann.api.chats.send("not-a-uuid", startingWith(startOf("Mine now")))
      ),
      unknown: await outcome(ann.api.chats.summary(bens)),
      annListed: await ann.api.chats.list(),
      bensNow: await titlesOf(ben.api.chats),
    }).toStrictEqual({
      taken: "agent.chat_not_found",
      deleted: "agent.chat_not_found",
      corenamed: "agent.chat_not_found",
      key: "agent.chat_not_found",
      notAnId: "agent.chat_not_found",
      unknown: "agent.chat_not_found",
      annListed: [],
      bensNow: ["Ben's"],
    });
    expect(said(benFollows.messages())).toStrictEqual([
      { role: "user", text: "Where are we?" },
      { role: "assistant", text: "Ben's answer." },
    ]);
  });

  it("is made once its object restarted between making it and taking its first question", async () => {
    const ann = await person();
    await fakeProvider(says("After the restart."));
    const chatId = crypto.randomUUID();
    const start = startOf("Restarted");
    // Its first file's call makes it; then the object restarts, before the
    // question went.
    const file = await ann.api.chats.attachFile(
      chatId,
      { name: "plan.txt", bytes: new TextEncoder().encode("The plan.") },
      crypto.randomUUID(),
      start
    );
    await runInDurableObject(objectOf(ann), (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    await ann.api.chats.send(chatId, {
      ...startingWith(start, "What's the plan?"),
      files: [file.id],
    });
    // A start whose ID was taken just before the object restarted, the
    // chat not made yet: its repeat makes it.
    const cut = crypto.randomUUID();
    const cutStart = startOf("Cut short");
    await env.DB.prepare(
      "INSERT INTO chat_ids (id, person_id, request_key, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(cut, ann.userId, cutStart.key, Date.now())
      .run();
    await ann.api.chats.attachFile(
      cut,
      { name: "notes.txt", bytes: new TextEncoder().encode("Notes.") },
      crypto.randomUUID(),
      cutStart
    );
    const follower = await follow(ann.api.chats, chatId);
    await until(() => {
      expect(said(follower.messages()).at(-1)?.text).toBe("After the restart.");
    });
    expect({
      said: said(follower.messages()),
      listed: await titlesOf(ann.api.chats),
    }).toStrictEqual({
      said: [
        { role: "user", text: "What's the plan?" },
        { role: "assistant", text: "After the restart." },
      ],
      listed: ["Cut short", "Restarted"],
    });
  });

  it("is checked as a new chat is, and refused past the person's most, making nothing", async () => {
    const ann = await person();
    // Only an agent the person may talk to, and only an admin sets one up.
    const unknownAgent = crypto.randomUUID();
    const agentSetup = crypto.randomUUID();
    expect({
      agent: await outcome(
        ann.api.chats.send(
          unknownAgent,
          startingWith({ ...startOf("Hello"), agentId: crypto.randomUUID() })
        )
      ),
      setup: await outcome(
        ann.api.chats.send(
          agentSetup,
          startingWith({ ...startOf("An agent"), make: { kind: "agent" } })
        )
      ),
      listed: await ann.api.chats.list(),
    }).toStrictEqual({
      agent: "agent.unknown",
      setup: "role.forbidden",
      listed: [],
    });
    const kept = objectOf(ann);
    for (let batch = 0; batch < maxChatsPerPerson / 50; batch += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a batch at a time
      await Promise.all(
        Array.from(
          { length: 50 },
          async () => await kept.createChat("Old", ann.userId, chatAgentId)
        )
      );
    }
    await expect(
      outcome(
        ann.api.chats.send(
          crypto.randomUUID(),
          startingWith(startOf("One more"))
        )
      )
    ).resolves.toBe("agent.too_many_chats");
  });
});
