import { agentErrors } from "@grasp-os/shared/agent";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { personOf } from "../src/connections.ts";
import { chatSession, workspace } from "../src/durable-objects.ts";
import {
  chatOf,
  model,
  pausedReply,
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

/**
 * Tells the agent of `chatId` how a connection it asked for was decided,
 * again and again, until `until` settles: decisions landing at every
 * point of what `until` does. Each told or refused.
 */
const decidingWhile = async (
  stub: ReturnType<typeof workspace>,
  chatId: string,
  personId: string,
  until: Promise<unknown>
): Promise<void> => {
  const state = { done: false };
  const ended = until.finally(() => {
    state.done = true;
  });
  const decided: Promise<unknown>[] = [];
  while (!state.done) {
    decided.push(
      stub
        .connectionDecided(chatId, personId, {
          binding: "MAIL",
          decision: "granted",
        })
        .catch(() => "refused")
    );
    // oxlint-disable-next-line no-await-in-loop -- one a millisecond
    await scheduler.wait(1);
  }
  await Promise.all([ended, ...decided]);
};

/** A turn's answer, or the message of the error it was refused with. */
const outcomeOf = async (turn: Promise<{ answer: string }>): Promise<string> =>
  await turn.then(
    ({ answer }) => answer,
    (error: unknown) => z.object({ message: z.string() }).parse(error).message
  );

/**
 * `chat`'s own object, and turn `turnId`'s request as its Workspace hands
 * it over (`ChatSession.run`).
 */
const sessionOf = (
  { id, chat }: Awaited<ReturnType<typeof chatOf>>,
  personId: string
) => ({
  session: () => chatSession(env, id, chatIdSchema.parse(chat.id)),
  request: (turnId: string, text: string, asked = model) => ({
    turnId,
    scope: {
      workspaceId: id,
      agentId: chat.agentId,
      chatId: chat.id,
      personId,
      via: chat.via,
    },
    question: { text, model: asked, files: [] },
    shared: false,
    readsBrain: false,
    context: { skills: [] },
    capture: { model: asked, audience: null },
  }),
});

/** The chat's messages as its Workspace keeps them: each role, and how it stopped. */
const keptOf = async (
  stub: ReturnType<typeof workspace>,
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

describe("a chat's ChatSession", () => {
  it("takes one question at a time: another turn's is refused before it is taken, and the same turn's joins it", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const first = pausedReply(says("First."), 1);
    const provider = await fakeProviderFor(
      [model, smallModel],
      first.reply,
      says("First."),
      says("The build ended.")
    );
    const { session, request } = sessionOf(asking, userId);
    const asked = outcomeOf(session().run(request("turn-a", "First?")));
    // Another turn, on another model, as the first is taken.
    const refused = await outcomeOf(
      session().run(request("turn-b", "Second?", smallModel))
    );
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    // The first turn asked again, as its Workspace does when a call breaks.
    const joined = outcomeOf(session().run(request("turn-a", "First?")));
    // A restart mid-answer: the turn is set up again as it was asked.
    await runInDurableObject(session(), (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    // The first call to reach it: how a build job of the first turn ended.
    const notice = `Build job ${crypto.randomUUID()} ended.`;
    await session().notify("turn-a", crypto.randomUUID(), notice);
    first.release();
    const again = await session().run(request("turn-a", "First?"));
    expect({
      refused,
      // Both calls of the first turn were the same turn's, cut short alike.
      cutShort: (await asked) === (await joined),
      again: again.answer,
      sentTo: provider.requests.map(
        ({ body }) => z.object({ model: z.string() }).parse(body).model
      ),
      noticed: JSON.stringify(provider.requests.at(-1)?.body).includes(notice),
    }).toStrictEqual({
      refused: agentErrors.create("agent.busy").message,
      cutShort: true,
      // The answer to the notice, the turn's last.
      again: "The build ended.",
      sentTo: Array.from({ length: 3 }, () => "claude-sonnet-4-5"),
      noticed: true,
    });
  });

  it("takes no notice for a turn a restart cut short once it ended on its own, and the next question goes through", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const first = pausedReply(says("First."), 1);
    const provider = await fakeProviderFor(
      [model],
      first.reply,
      says("First."),
      says("Second."),
      says("Never asked.")
    );
    const { session, request } = sessionOf(asking, userId);
    void outcomeOf(session().run(request("turn-a", "First?")));
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    // A restart mid-answer, nobody asking for the turn again: its alarm
    // resumes it, and it ends on its own.
    await runInDurableObject(session(), (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    await runDurableObjectAlarm(session());
    first.release();
    await vi.waitFor(
      async () => {
        await expect(
          asking.stub.chatSummary(asking.chat.id, userId)
        ).resolves.toMatchObject({ running: false });
        expect(provider.requests).toHaveLength(2);
      },
      { timeout: 15_000 }
    );
    // The next question, as a build job the first turn submitted ends.
    const notice = `Build job ${crypto.randomUUID()} ended.`;
    const asked = outcomeOf(session().run(request("turn-b", "Second?")));
    await session().notify("turn-a", crypto.randomUUID(), notice);
    expect({
      answer: await asked,
      noticed: provider.requests.some(({ body }) =>
        JSON.stringify(body).includes(notice)
      ),
    }).toStrictEqual({ answer: "Second.", noticed: false });
  });

  it("takes the next question when both objects restarted before the chat's own object took the last", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { id, stub, chat } = await chatOf(userId, says("Hi."));
    const session = () => chatSession(env, id, chatIdSchema.parse(chat.id));
    // The chat's object takes nothing until the test says, then restarts.
    // Waited on by flags: workerd won't let one request wait on another's
    // promise.
    const hold = { reached: false, restart: false };
    const held = runInDurableObject(session(), async (_instance, state) => {
      await state.blockConcurrencyWhile(async () => {
        hold.reached = true;
        while (!hold.restart) {
          // oxlint-disable-next-line no-await-in-loop -- until the test says
          await scheduler.wait(20);
        }
        state.abort("Restarted by the test");
      });
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    await vi.waitFor(() => {
      expect(hold.reached).toBeTruthy();
    });
    void stub.ask(chat.id, { text: "Hello?", model }).catch(() => "cut short");
    // Handed over, not taken: the Workspace restarts, then the chat's object.
    await vi.waitFor(
      async () => {
        await expect(stub.chatSummary(chat.id, userId)).resolves.toMatchObject({
          running: true,
        });
      },
      { timeout: 10_000, interval: 20 }
    );
    await scheduler.wait(200);
    await runInDurableObject(stub, (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    hold.restart = true;
    await held;
    await fakeProviderFor([model], says("Hi again."));
    const woken = workspace(env, id);
    await expect(
      woken.ask(chat.id, { text: "Hello again?", model })
    ).resolves.toMatchObject({ outcome: "answered", answer: "Hi again." });
  });

  it("keeps a stopped turn's end once, however often the turn is asked again", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const never = Promise.withResolvers<boolean>();
    const provider = await fakeProviderFor([model], {
      ...says("Never."),
      pause: { at: 0, until: never.promise },
    });
    const { session, request } = sessionOf(asking, userId);
    try {
      const asked = session().run(request("turn-a", "First?"));
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      await session().abort("turn-a");
      const first = await asked;
      // The same turn again, as its Workspace asks when the way back broke.
      const again = await session().run(request("turn-a", "First?"));
      expect({
        first: first.outcome,
        again: again.outcome,
        kept: await keptOf(asking.stub, asking.chat.id),
      }).toStrictEqual({
        first: "cancelled",
        again: "cancelled",
        kept: ["user", "assistant:aborted"],
      });
    } finally {
      never.resolve(true);
    }
  });

  it("stops only the turn a stop names: one that comes late, once the next question runs, leaves it to answer", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const second = pausedReply(says("Second."), 1);
    const provider = await fakeProviderFor(
      [model],
      says("First."),
      second.reply
    );
    const { session, request } = sessionOf(asking, userId);
    await session().run(request("turn-a", "First?"));
    try {
      const asked = session().run(request("turn-b", "Second?"));
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(2);
        },
        { timeout: 10_000 }
      );
      // The first turn's stop, sent again after the way back broke.
      await session().abort("turn-a");
      second.release();
      await expect(asked).resolves.toMatchObject({
        outcome: "answered",
        answer: "Second.",
      });
    } finally {
      second.release();
    }
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

  it("ends a turn pi parked that nobody waits on any more, and tells its Workspace it stopped", async () => {
    const { userId, person: signedIn } = await signedInWithRole(idp, "user");
    const never = Promise.withResolvers<boolean>();
    const stuck = { ...says("Never."), pause: { at: 0, until: never.promise } };
    const { id, stub, provider, newChat } = await personalChatsOf(
      userId,
      stuck,
      stuck
    );
    const { chat, ask } = await newChat();
    const session = () => chatSession(env, id, chatIdSchema.parse(chat.id));
    const woken = workspace(env, id);
    let restore: (() => Promise<void>) | undefined;
    try {
      void ask("Hello?").catch(() => "settled");
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      // The Workspace first, so nothing asks for the turn again, then the
      // chat's object, mid-answer: only its alarm wakes it.
      await runInDurableObject(stub, (_instance, state) => {
        state.abort("Restarted by the test");
      }).catch(() => {
        // Aborting fails the call that aborted: that is the restart.
      });
      // pi parks a task a restart cut off this many times without progress.
      restore = await setObjectEnv(woken, { CHAT_RESTART_LIMIT: "1" });
      await runInDurableObject(session(), (_instance, state) => {
        state.abort("Restarted by the test");
      }).catch(() => {
        // Aborting fails the call that aborted: that is the restart.
      });
      await runDurableObjectAlarm(session());
      await vi.waitFor(
        async () => {
          await expect(
            woken.chatSummary(chat.id, userId)
          ).resolves.toMatchObject({ running: false });
        },
        { timeout: 15_000 }
      );
      const person = await personOf(env, {
        userId,
        role: "user",
        staff: false,
        email: String(signedIn.email),
      });
      await woken.deleteChat(chat.id, userId, person, {
        type: "person",
        userId,
      });
      await woken.erasePerson(userId);
      await expect(tablesOf(id, chat.id)).resolves.toStrictEqual([]);
    } finally {
      never.resolve(true);
      await restore?.();
    }
  });

  it("is erased with its chat, a decision told meanwhile included, and takes nothing after", async () => {
    const { userId, person: signedIn } = await signedInWithRole(idp, "user");
    const { id, stub, chat, ask } = await chatOf(userId, says("Hi."));
    await ask("Hello?");
    const before = await tablesOf(id, chat.id);
    const person = await personOf(env, {
      userId,
      role: "user",
      staff: false,
      email: String(signedIn.email),
    });
    await decidingWhile(
      stub,
      chat.id,
      userId,
      stub.deleteChat(chat.id, userId, person, { type: "person", userId })
    );
    // Whatever still reaches the chat's object once it is erased.
    const late = await chatSession(env, id, chatIdSchema.parse(chat.id))
      .note("The connection you asked for was granted.")
      .then(
        () => "taken",
        () => "refused"
      );
    expect({
      before: before.length > 0,
      late,
      after: await tablesOf(id, chat.id),
    }).toStrictEqual({ before: true, late: "refused", after: [] });
  });

  it("is erased with its person, every chat's, a decision told meanwhile included", async () => {
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
    const [first] = chats;
    await decidingWhile(
      stub,
      first?.id ?? "",
      userId,
      stub.erasePerson(userId)
    );
    const after = await Promise.all(
      chats.map(async (chat) => await tablesOf(id, chat.id))
    );
    expect({ before, after }).toStrictEqual({
      before: [true, true],
      after: [[], []],
    });
  });
});
