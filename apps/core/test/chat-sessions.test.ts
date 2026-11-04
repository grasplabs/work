import { chatIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { personOf } from "../src/connections.ts";
import { chatSession, workspace } from "../src/durable-objects.ts";
import {
  chatOf,
  model,
  personalChatsOf,
  says,
  setObjectEnv,
} from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider, fakeProviderFor } from "./model-provider.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";

// A chat's own object (chat-session.ts), through its Workspace: pi-durable
// keeps the chat's transcript there, on the object's SQLite in tables of
// its own, compacts it through the model gateway as the chat's, and goes
// with the chat, or with its person.

const idp = mockIdp();

/** The tables `chatId`'s object holds, by name. */
const tablesOf = async (
  id: Parameters<typeof chatSession>[1],
  chatId: string
): Promise<string[]> =>
  await runInDurableObject(
    chatSession(env, id, chatIdSchema.parse(chatId)),
    (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
        )
        .toArray()
        .map(({ name }) => name)
  );

/** A model of a 32,768-token window, as pi's catalog has it. */
const smallModel = "mistral/voxtral-small-latest";

describe("a chat's ChatSession", () => {
  it("keeps the chat's transcript on its own SQLite, in pi's tables alone", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { id, chat, ask } = await chatOf(userId, says("Hi."));
    await ask("Hello?");
    const tables = await tablesOf(id, chat.id);
    expect({
      some: tables.length > 0,
      all: tables.every((name) => name.startsWith("pi_")),
    }).toStrictEqual({ some: true, all: true });
  });

  it("compacts a long chat on a small window and goes on, every request the summary's included a model call of the chat's", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { stub, chat } = await chatOf(userId);
    const provider = await fakeProviderFor(
      [model, smallModel],
      ...Array.from({ length: 12 }, () => says("Noted."))
    );
    const answers: string[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one turn after another
      const reply = await stub.ask(chat.id, {
        text: `Turn ${turn}: ${"long words ".repeat(2600)}`,
        model: smallModel,
      });
      answers.push(reply.outcome);
    }
    const summaries = provider.requests.filter(({ body }) =>
      JSON.stringify(body).includes("context summarization assistant")
    );
    const calls = await vi.waitFor(
      async () => {
        const all = await allEvents();
        const events = all.filter(
          ({ action, actor }) =>
            action === "model.call" &&
            actor.type === "agent" &&
            actor.onBehalfOf === userId
        );
        expect(events).toHaveLength(provider.requests.length);
        return events;
      },
      { timeout: 10_000, interval: 50 }
    );
    expect({
      answers,
      compacted: summaries.length > 0,
      // The summary's spend is the chat's, as its turns' is.
      calls: [
        ...new Set(
          calls.map(
            ({ detail }) => `${String(detail.purpose)} ${String(detail.chat)}`
          )
        ),
      ],
    }).toStrictEqual({
      answers: Array.from({ length: 6 }, () => "answered"),
      compacted: true,
      calls: [`chat.turn ${chat.id}`],
    });
  });

  it("records how long a response thought, for the chat to show", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const thought = Promise.withResolvers<boolean>();
    const { stub, chat, ask } = await chatOf(userId, {
      ...says("Seven."),
      thinking: {
        text: "Count the days.",
        tokens: 10,
        pause: { until: thought.promise },
      },
    });
    const reply = ask("How many days?");
    await scheduler.wait(1500);
    thought.resolve(true);
    await reply;
    const [kept] = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ thinking_ms: number | null }>(
          "SELECT thinking_ms FROM chat_messages WHERE chat_id = ? AND thinking_ms IS NOT NULL",
          chat.id
        )
        .toArray()
    );
    // The pause, to the grain of pi's commits of the stream (100 ms).
    expect(kept?.thinking_ms ?? 0).toBeGreaterThanOrEqual(1000);
  });

  it("keeps no alarm for an idle chat once a note reaches it, nor once an alarm finds nothing to do", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { id, stub, chat, ask } = await chatOf(userId, says("Hi."));
    await ask("Hello?");
    await stub.connectionDecided(chat.id, userId, {
      binding: "MAIL",
      decision: "granted",
    });
    const session = chatSession(env, id, chatIdSchema.parse(chat.id));
    const alarmOf = async () =>
      await runInDurableObject(
        session,
        async (_instance, state) => await state.storage.getAlarm()
      );
    const afterNote = await alarmOf();
    await runInDurableObject(session, async (_instance, state) => {
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(session);
    expect({ afterNote, afterAlarm: await alarmOf() }).toStrictEqual({
      afterNote: null,
      afterAlarm: null,
    });
  });

  it("ends a turn whose step pi parked after restarts cut it off, so the chat can be deleted and its person erased", async () => {
    const { userId, person: signedIn } = await signedInWithRole(idp, "user");
    const never = Promise.withResolvers<boolean>();
    const stuck = { ...says("Never."), pause: { at: 0, until: never.promise } };
    // The person's own Workspace, which their erasure erases.
    const { id, stub, provider, newChat } = await personalChatsOf(
      userId,
      stuck,
      stuck
    );
    const { chat } = await newChat();
    const session = () => chatSession(env, id, chatIdSchema.parse(chat.id));
    // pi parks a task a restart cut off this many times without progress.
    const restore = await setObjectEnv(stub, { CHAT_RESTART_LIMIT: "1" });
    try {
      const asked = stub.ask(chat.id, { text: "Hello?", model }).then(
        ({ outcome }) => outcome,
        () => "refused"
      );
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      // The model's answer is cut off mid-stream; the object wakes again.
      await runInDurableObject(session(), (_instance, state) => {
        state.abort("Cut off by the test");
      }).catch(() => {
        // Aborting fails the call that aborted: that is the restart.
      });
      await runDurableObjectAlarm(session());
      const outcome = await asked;
      const person = await personOf(env, {
        userId,
        role: "user",
        staff: false,
        email: String(signedIn.email),
      });
      await stub.deleteChat(chat.id, userId, person, {
        type: "person",
        userId,
      });
      await stub.erasePerson(userId);
      expect({ outcome, tables: await tablesOf(id, chat.id) }).toStrictEqual({
        outcome: "failed",
        tables: [],
      });
    } finally {
      never.resolve(true);
      await restore();
    }
  });

  it("is erased with its chat", async () => {
    const { userId, person: signedIn } = await signedInWithRole(idp, "user");
    const { id, stub, chat, ask } = await chatOf(userId, says("Hi."));
    await ask("Hello?");
    const person = await personOf(env, {
      userId,
      role: "user",
      staff: false,
      email: String(signedIn.email),
    });
    await stub.deleteChat(chat.id, userId, person, {
      type: "person",
      userId,
    });
    await expect(tablesOf(id, chat.id)).resolves.toStrictEqual([]);
  });

  it("is erased with its person, every chat's", async () => {
    const { userId, api } = await signedInApi(idp, "user");
    const id = personalWorkspaceId(userId);
    const stub = workspace(env, id);
    await fakeProvider(says("One."), says("Two."));
    const chats = [
      await api.chats.create("One"),
      await api.chats.create("Two"),
    ];
    for (const chat of chats) {
      // oxlint-disable-next-line no-await-in-loop -- one chat after another
      await stub.ask(chat.id, { text: "Hello?", model });
    }
    const before = await Promise.all(
      chats.map(async (chat) => {
        const tables = await tablesOf(id, chat.id);
        return tables.length > 0;
      })
    );
    await stub.erasePerson(userId);
    const after = await Promise.all(
      chats.map(async (chat) => await tablesOf(id, chat.id))
    );
    expect({ before, after }).toStrictEqual({
      before: [true, true],
      after: [[], []],
    });
  });
});
