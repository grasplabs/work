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
// takes over a chat already there (the person's own, or a deleted one),
// touches or shows another person's chat with the same ID, says whether
// an ID is anyone's, makes a chat twice (a retry, two tabs at once, a
// restart in between), makes one past the person's most, or a read of the
// new chat on the same connection finds none yet.

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

  it("makes the person a chat of their own under an ID another person's chat has, which neither sees nor changes, and refuses a read of one they have not as it refuses one that isn't an ID", async () => {
    const ann = await person();
    const ben = await person();
    await fakeProvider(says("Ben's answer."), says("Ann's answer."));
    const shared = crypto.randomUUID();
    await ben.api.chats.send(shared, startingWith(startOf("Ben's")));
    const benFollows = await follow(ben.api.chats, shared);
    await until(() => {
      expect(said(benFollows.messages()).at(-1)?.text).toBe("Ben's answer.");
    });
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
    // Ann reads none of them: each as an ID nobody has, or no ID at all.
    const reads = {
      bens: await outcome(ann.api.chats.summary(shared)),
      deleted: await outcome(ann.api.chats.summary(deleted.id)),
      corenamed: await outcome(ann.api.chats.summary(corenamed.id)),
      nobodys: await outcome(ann.api.chats.summary(crypto.randomUUID())),
      notAnId: await outcome(ann.api.chats.summary("not-a-uuid")),
    };
    // Ann names chats of her own under the same IDs, Ben's deleted one's
    // included: hers, in her own object.
    await ann.api.chats.send(shared, startingWith(startOf("Ann's")));
    await ann.api.chats.attachFile(
      deleted.id,
      { name: "a.txt", bytes: new TextEncoder().encode("A") },
      crypto.randomUUID(),
      startOf("Ann's second")
    );
    const annFollows = await follow(ann.api.chats, shared);
    await until(() => {
      expect(said(annFollows.messages()).at(-1)?.text).toBe("Ann's answer.");
    });

    expect({
      reads,
      notAnId: await outcome(
        ann.api.chats.send("not-a-uuid", startingWith(startOf("Odd")))
      ),
      anns: await titlesOf(ann.api.chats),
      annSays: said(annFollows.messages()),
      bens: await titlesOf(ben.api.chats),
      benSays: said(benFollows.messages()),
      bensDeleted: await outcome(ben.api.chats.summary(deleted.id)),
    }).toStrictEqual({
      reads: {
        bens: "agent.chat_not_found",
        deleted: "agent.chat_not_found",
        corenamed: "agent.chat_not_found",
        nobodys: "agent.chat_not_found",
        notAnId: "agent.chat_not_found",
      },
      notAnId: "agent.chat_not_found",
      anns: ["Ann's", "Ann's second"],
      annSays: [
        { role: "user", text: "Where are we?" },
        { role: "assistant", text: "Ann's answer." },
      ],
      bens: ["Ben's"],
      benSays: [
        { role: "user", text: "Where are we?" },
        { role: "assistant", text: "Ben's answer." },
      ],
      bensDeleted: "agent.chat_not_found",
    });
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
      listed: ["Restarted"],
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
    const old: string[] = [];
    for (let batch = 0; batch < maxChatsPerPerson / 50; batch += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a batch at a time
      const made = await Promise.all(
        Array.from(
          { length: 50 },
          async () => await kept.createChat("Old", ann.userId, chatAgentId)
        )
      );
      old.push(...made.map(({ id }) => id));
    }
    const oneMore = crypto.randomUUID();
    const start = startOf("One more");
    const refused = await outcome(
      ann.api.chats.attachFile(
        oneMore,
        { name: "a.txt", bytes: new TextEncoder().encode("A") },
        crypto.randomUUID(),
        start
      )
    );
    // Refused before anything is kept of it: once there is room, the same
    // start makes it.
    await ann.api.chats.remove(old[0] ?? "");
    const again = await outcome(
      ann.api.chats.attachFile(
        oneMore,
        { name: "a.txt", bytes: new TextEncoder().encode("A") },
        crypto.randomUUID(),
        start
      )
    );
    expect({ refused, again }).toStrictEqual({
      refused: "agent.too_many_chats",
      again: "ok",
    });
  });

  it("is named by a lower-case UUID of a version, never by the nil or the max UUID, nor another spelling of one", async () => {
    const ann = await person();
    const upper = crypto.randomUUID().toUpperCase();
    const ids = [
      upper,
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      `{${crypto.randomUUID()}}`,
    ];
    const outcomes = await Promise.all(
      ids.map(
        async (id) =>
          await outcome(ann.api.chats.send(id, startingWith(startOf("Odd"))))
      )
    );

    expect({
      outcomes,
      listed: await ann.api.chats.list(),
    }).toStrictEqual({
      outcomes: ids.map(() => "agent.chat_not_found"),
      listed: [],
    });
  });

  it("stays made when its first question is refused, and takes the same question again, sent right, in the same chat", async () => {
    const ann = await person();
    await fakeProvider(says("Now it goes."));
    const chatId = crypto.randomUUID();
    const start = startOf("Refused first");
    // A model the company doesn't offer refuses the question, not the chat.
    const refused = await outcome(
      ann.api.chats.send(chatId, {
        ...startingWith(start),
        model: "openai/not-a-model",
      })
    );
    const between = await titlesOf(ann.api.chats);
    await ann.api.chats.send(chatId, startingWith(start));
    const follower = await follow(ann.api.chats, chatId);
    await until(() => {
      expect(said(follower.messages()).at(-1)?.text).toBe("Now it goes.");
    });

    expect({
      refused,
      between,
      said: said(follower.messages()),
      listed: await titlesOf(ann.api.chats),
    }).toStrictEqual({
      refused: "model.not_allowed",
      between: ["Refused first"],
      said: [
        { role: "user", text: "Where are we?" },
        { role: "assistant", text: "Now it goes." },
      ],
      listed: ["Refused first"],
    });
  });
});
