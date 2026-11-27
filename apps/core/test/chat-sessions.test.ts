import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { agentErrors } from "@grasp-os/shared/agent";
import type { ChatUpdate } from "@grasp-os/shared/chat";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { WorkspaceId } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { questionDataOf } from "../src/chat-harness.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { personOf } from "../src/connections.ts";
import { chatSession, workspace } from "../src/durable-objects.ts";
import { analysisPurpose } from "../src/turn-recall.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  model,
  pausedReply,
  personalChatsOf,
  says,
  setObjectEnv,
} from "./agent-chat.ts";
import { runRecords } from "./agent-code-runs.ts";
import { allEvents } from "./audit-events.ts";
import midRequestOnPi14 from "./fixtures/pi-1.4/mid-request.json" with { type: "json" };
import settledOnPi14 from "./fixtures/pi-1.4/settled.json" with { type: "json" };
import { mockIdp } from "./idp.ts";
import { fakeProvider, fakeProviderFor } from "./model-provider.ts";
import { turnRecordsOf } from "./model-usage.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";
import { startedThrough } from "./started-chats.ts";

// A chat's own object (chat-session.ts), through its Workspace: pi-durable
// keeps the chat's transcript there, on the object's SQLite in tables of
// its own, compacts it through the model gateway as the chat's, and goes
// with the chat, or with its person.

const idp = mockIdp();

/** The tables `chatId`'s object holds, by name. */
const tablesOf = async (id: WorkspaceId, chatId: string): Promise<string[]> =>
  await runInDurableObject(
    chatSession(env, { workspaceId: id, chatId: chatIdSchema.parse(chatId) }),
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
  session: () =>
    chatSession(env, { workspaceId: id, chatId: chatIdSchema.parse(chat.id) }),
  request: (turnId: string, text: string, asked = model) => ({
    turnId,
    sentAt: Date.now(),
    scope: {
      workspaceId: id,
      agentId: chat.agentId,
      chatId: chat.id,
      personId,
      via: chat.via,
    },
    question: { text, model: asked, files: [] },
    shared: false,
    personal: true,
    context: { skills: [] },
    capture: { attended: true },
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
      says("First.")
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
    }).toStrictEqual({
      refused: agentErrors.create("agent.busy").message,
      cutShort: true,
      again: "First.",
      sentTo: Array.from({ length: 2 }, () => "claude-sonnet-4-5"),
    });
  });

  it("takes the next question when both objects restarted before the chat's own object took the last", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { id, stub, chat } = await chatOf(userId, says("Hi."));
    const session = () =>
      chatSession(env, {
        workspaceId: id,
        chatId: chatIdSchema.parse(chat.id),
      });
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
        // The question, the recall before it (its call and result), and the
        // stopped answer.
        kept: ["user", "assistant:toolUse", "toolResult", "assistant:aborted"],
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
        // Never the recall's analysis of a question, a call of its own.
        const events = all.filter(
          ({ action, actor, detail }) =>
            action === "model.call" &&
            actor.type === "agent" &&
            actor.onBehalfOf === userId &&
            detail.purpose !== analysisPurpose
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
    // Held from when the chat shows the thought: by then its object timed
    // the thinking's start. How long the turn took to get there is no part
    // of it.
    const shown = Promise.withResolvers<number>();
    await stub.watch(chat.id, userId, null, async (update: ChatUpdate) => {
      if ((update.partial?.reasoning.text ?? "") !== "") {
        shown.resolve(Date.now());
      }
      await Promise.resolve();
    });
    const reply = ask("How many days?");
    const since = await shown.promise;
    const heldMs = 1000;
    await scheduler.wait(heldMs);
    const held = Date.now() - since;
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
    // At least the hold: the thinking ended only once it was let go.
    expect(kept?.thinking_ms ?? 0).toBeGreaterThanOrEqual(held);
  });

  it("keeps no alarm for an idle chat once a note reaches it, nor once an alarm finds nothing to do", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const { id, stub, chat, ask } = await chatOf(userId, says("Hi."));
    await ask("Hello?");
    await stub.connectionDecided(chat.id, userId, {
      binding: "MAIL",
      decision: "granted",
    });
    const session = chatSession(env, {
      workspaceId: id,
      chatId: chatIdSchema.parse(chat.id),
    });
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
    const session = () =>
      chatSession(env, {
        workspaceId: id,
        chatId: chatIdSchema.parse(chat.id),
      });
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
    const session = () =>
      chatSession(env, {
        workspaceId: id,
        chatId: chatIdSchema.parse(chat.id),
      });
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

  it("answers once however often its alarm fires while a turn runs", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const held = pausedReply(says("Once."), 1);
    const provider = await fakeProviderFor([model], held.reply);
    const { session, request } = sessionOf(asking, userId);
    try {
      const asked = session().run(request("turn-a", "Once?"));
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      // Early and twice: each re-arms the heartbeat the next one runs.
      const fired = [
        await runDurableObjectAlarm(session()),
        await runDurableObjectAlarm(session()),
      ];
      held.release();
      const { answer } = await asked;
      expect({
        fired,
        answer,
        requests: provider.requests.length,
        kept: await keptOf(asking.stub, asking.chat.id),
      }).toStrictEqual({
        fired: [true, true],
        answer: "Once.",
        requests: 1,
        kept: ["user", "assistant:toolUse", "toolResult", "assistant:stop"],
      });
    } finally {
      held.release();
    }
  });

  it("opens pi again when its storage fails under a turn, and the turn answers, its caller none the wiser", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const provider = await fakeProviderFor(
      [model],
      says("Never stored."),
      says("Stored.")
    );
    const { session, request } = sessionOf(asking, userId);
    // pi's tables, then a fault in them: the storage refuses the first
    // answer's entry, which fails pi as a storage error does.
    await session().activeTurn();
    await runInDurableObject(session(), (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER test_fault BEFORE INSERT ON pi_entries WHEN NEW.record LIKE '%Never stored.%' AND NEW.record LIKE '%"stopReason":"stop"%' BEGIN SELECT RAISE(ABORT, 'Refused by the test'); END`
      );
    });
    const end = await session().run(request("turn-a", "Stored?"));
    expect({
      outcome: end.outcome,
      answer: end.answer,
      requests: provider.requests.length,
      // Open still: the next call needs no restart.
      next: await session().activeTurn(),
    }).toStrictEqual({
      outcome: "answered",
      answer: "Stored.",
      requests: 2,
      next: undefined,
    });
  });

  it("opens pi again each time its storage fails under a turn, also after an open that worked", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const provider = await fakeProviderFor(
      [model],
      says("Never stored."),
      says("Never stored either."),
      says("Stored.")
    );
    const { session, request } = sessionOf(asking, userId);
    await session().activeTurn();
    await runInDurableObject(session(), (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER test_fault BEFORE INSERT ON pi_entries WHEN NEW.record LIKE '%Never stored%' AND NEW.record LIKE '%"stopReason":"stop"%' BEGIN SELECT RAISE(ABORT, 'Refused by the test'); END`
      );
    });
    const end = await session().run(request("turn-a", "Stored?"));
    expect({
      answer: end.answer,
      requests: provider.requests.length,
    }).toStrictEqual({ answer: "Stored.", requests: 3 });
  });

  it("stops sending a turn's requests again once its storage keeps failing after opens that work, and ends the turn", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const provider = await fakeProviderFor(
      [model],
      ...Array.from({ length: 10 }, () => says("Never stored."))
    );
    const { session, request } = sessionOf(asking, userId);
    await session().activeTurn();
    await runInDurableObject(session(), (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER test_fault BEFORE INSERT ON pi_entries WHEN NEW.record LIKE '%Never stored%' AND NEW.record LIKE '%"stopReason":"stop"%' BEGIN SELECT RAISE(ABORT, 'Refused by the test'); END`
      );
    });
    const ended = await session()
      .run(request("turn-a", "Stored?"))
      .then(
        (end) => end.stopped ?? end.outcome,
        (error: unknown) =>
          z.object({ message: z.string() }).parse(error).message
      );
    // Woken by its alarm meanwhile, as nothing else calls it.
    await runDurableObjectAlarm(session());
    const sent = provider.requests.length;
    await runDurableObjectAlarm(session());
    expect({
      // Lost, or failed for restarts cutting it off: either way it ends.
      ended: [
        "lost",
        "failed",
        agentErrors.create("agent.turn_lost").message,
      ].includes(ended),
      bounded: sent <= 6,
      noMore: provider.requests.length === sent,
    }).toStrictEqual({ ended: true, bounded: true, noMore: true });
  });

  it("opens pi again when its storage fails under a turn nothing waits on, and the turn answers", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const cut = pausedReply(says("Cut."), 1);
    const { id, stub, provider, newChat } = await personalChatsOf(
      userId,
      cut.reply,
      says("Never stored."),
      says("Stored.")
    );
    const { chat, ask } = await newChat();
    const session = () =>
      chatSession(env, {
        workspaceId: id,
        chatId: chatIdSchema.parse(chat.id),
      });
    try {
      void ask("Stored?").catch(() => "cut short");
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      // Both objects restart mid-answer, so no call waits on the turn: only
      // the chat's alarm takes it up again. Then a fault in pi's tables: the
      // storage refuses the answer the request sent again brings.
      for (const stopped of [stub, session()]) {
        // oxlint-disable-next-line no-await-in-loop -- one, then the other
        await runInDurableObject(stopped, (_instance, state) => {
          state.abort("Restarted by the test");
        }).catch(() => {
          // Aborting fails the call that aborted: that is the restart.
        });
      }
      await runInDurableObject(session(), (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TRIGGER test_fault BEFORE INSERT ON pi_entries WHEN NEW.record LIKE '%Never stored.%' AND NEW.record LIKE '%"stopReason":"stop"%' BEGIN SELECT RAISE(ABORT, 'Refused by the test'); END`
        );
      });
      await runDurableObjectAlarm(session());
      // The failure arms the alarm for now, which opens pi again: no sooner
      // than the heartbeat, a minute on, without it.
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(3);
        },
        { timeout: 15_000 }
      );
      const woken = workspace(env, id);
      await vi.waitFor(
        async () => {
          await expect(
            woken.chatSummary(chat.id, userId)
          ).resolves.toMatchObject({ running: false });
        },
        { timeout: 15_000 }
      );
      const kept = await keptOf(woken, chat.id);
      expect(kept.at(-1)).toBe("assistant:stop");
      // Its record, once, as the object that took it up saw it: answered,
      // its times unknown, what came after the restart counted.
      const turns = await turnRecordsOf(chat.id, 1);
      expect(
        turns.map((turn) => ({
          outcome: turn.outcome,
          resumed: turn.resumed,
          times: [turn.firstRequestMs, turn.firstTokenMs, turn.firstTextMs],
          answered: turn.outputTokens > 0,
        }))
      ).toStrictEqual([
        {
          outcome: "answered",
          resumed: true,
          times: [null, null, null],
          answered: true,
        },
      ]);
    } finally {
      cut.release();
    }
  });

  it("tries a pi that fails to open again later and later, then gives the turn up as failed, and takes the next question once storage recovers", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const never = Promise.withResolvers<boolean>();
    const stuck = { ...says("Never."), pause: { at: 0, until: never.promise } };
    const { id, stub, provider, newChat } = await personalChatsOf(
      userId,
      stuck,
      says("Answered now.")
    );
    const { chat, ask } = await newChat();
    const session = () =>
      chatSession(env, {
        workspaceId: id,
        chatId: chatIdSchema.parse(chat.id),
      });
    try {
      void ask("Hello?").catch(() => "settled");
      await vi.waitFor(
        async () => {
          expect(provider.requests).toHaveLength(1);
          await expect(
            stub.chatSummary(chat.id, userId)
          ).resolves.toMatchObject({ running: true });
        },
        { timeout: 10_000 }
      );
      // The Workspace first, so nothing asks for the turn again, then the
      // chat's object, whose pi then can't open: its storage is of a newer
      // pi, as after a rollback.
      for (const stopped of [stub, session()]) {
        // oxlint-disable-next-line no-await-in-loop -- one, then the other
        await runInDurableObject(stopped, (_instance, state) => {
          state.abort("Restarted by the test");
        }).catch(() => {
          // Aborting fails the call that aborted: that is the restart.
        });
      }
      await runInDurableObject(session(), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE pi_durable_schema SET version = version + 100"
        );
      });
      // How long after each alarm the next is, or none.
      const after: (number | null)[] = [];
      for (let alarm = 1; alarm <= 6; alarm += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one alarm after another
        await runDurableObjectAlarm(session());
        const now = Date.now();
        // oxlint-disable-next-line no-await-in-loop -- see above
        const next = await runInDurableObject(
          session(),
          async (_instance, state) => await state.storage.getAlarm()
        );
        after.push(next === null ? null : next - now);
      }
      const waits = after.filter((wait) => wait !== null);
      const { running } = await workspace(env, id).chatSummary(chat.id, userId);
      // Storage recovers: the turn given up on stays given up, and the
      // next question is taken, not refused as busy.
      await runInDurableObject(session(), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE pi_durable_schema SET version = version - 100"
        );
      });
      const next = await workspace(env, id).ask(chat.id, {
        text: "Again?",
        model,
      });
      expect({
        tried: waits.length,
        longerEachTime: waits.every(
          (wait, index) => index === 0 || wait > (waits[index - 1] ?? 0)
        ),
        thenNone: after.at(-1),
        running,
        next: next.answer,
        requests: provider.requests.length,
      }).toStrictEqual({
        tried: 5,
        longerEachTime: true,
        thenNone: null,
        running: false,
        next: "Answered now.",
        requests: 2,
      });
    } finally {
      never.resolve(true);
    }
  });

  it("stops waking a chat whose opens reset the object as often as it gives up after, and settles its turn as lost once a call opens it", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const never = Promise.withResolvers<boolean>();
    const stuck = { ...says("Never."), pause: { at: 0, until: never.promise } };
    const { id, stub, provider, newChat } = await personalChatsOf(
      userId,
      stuck,
      says("Answered after all.")
    );
    const { chat, ask } = await newChat();
    const session = () =>
      chatSession(env, {
        workspaceId: id,
        chatId: chatIdSchema.parse(chat.id),
      });
    try {
      void ask("Hello?").catch(() => "settled");
      await vi.waitFor(
        async () => {
          expect(provider.requests).toHaveLength(1);
          await expect(
            stub.chatSummary(chat.id, userId)
          ).resolves.toMatchObject({ running: true });
        },
        { timeout: 10_000 }
      );
      for (const stopped of [stub, session()]) {
        // oxlint-disable-next-line no-await-in-loop -- one, then the other
        await runInDurableObject(stopped, (_instance, state) => {
          state.abort("Restarted by the test");
        }).catch(() => {
          // Aborting fails the call that aborted: that is the restart.
        });
      }
      // What six opens a reset cut short leave: each counted before it
      // was tried, none reaching its end.
      await runInDurableObject(session(), (_instance, state) => {
        state.storage.kv.put("failedOpens", 6);
      });
      await runDurableObjectAlarm(session());
      const { running } = await workspace(env, id).chatSummary(chat.id, userId);
      const afterAlarm = {
        alarm: await runInDurableObject(
          session(),
          async (_instance, state) => await state.storage.getAlarm()
        ),
        requests: provider.requests.length,
        running,
      };
      // A call still opens it: the turn given up on is settled, and the
      // next question answered.
      const active = await session().activeTurn();
      const next = await workspace(env, id).ask(chat.id, {
        text: "Again?",
        model,
      });
      expect({ ...afterAlarm, active, next: next.answer }).toStrictEqual({
        alarm: null,
        requests: 1,
        running: false,
        active: undefined,
        next: "Answered after all.",
      });
    } finally {
      never.resolve(true);
    }
  });

  it("never stops a turn that keeps going, however long it runs", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const steps = [6, 12, 18].map(() => Promise.withResolvers<boolean>());
    const provider = await fakeProviderFor([model], {
      ...says("Slowly but surely, the answer."),
      pause: steps.map(({ promise }, index) => ({
        at: 6 * (index + 1),
        until: promise,
      })),
    });
    const { session, request } = sessionOf(asking, userId);
    const restore = await setObjectEnv(session(), {
      CHAT_TURN_IDLE_MS: "1500",
    });
    try {
      const startedAt = Date.now();
      const asked = session().run(request("turn-a", "Slowly?"));
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      for (const step of steps) {
        // oxlint-disable-next-line no-await-in-loop -- a word a second
        await scheduler.wait(1000);
        step.resolve(true);
        // oxlint-disable-next-line no-await-in-loop -- the heartbeat checks
        await scheduler.wait(200);
        // oxlint-disable-next-line no-await-in-loop -- see above
        await runDurableObjectAlarm(session());
      }
      const end = await asked;
      expect({
        outcome: end.outcome,
        answer: end.answer,
        pastTheLimit: Date.now() - startedAt > 1500,
      }).toStrictEqual({
        outcome: "answered",
        answer: "Slowly but surely, the answer.",
        pastTheLimit: true,
      });
    } finally {
      for (const step of steps) {
        step.resolve(true);
      }
      await restore();
    }
  });

  it("stops a turn pi makes no progress in, as overdue", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const never = Promise.withResolvers<boolean>();
    const provider = await fakeProviderFor([model], {
      ...says("Never."),
      pause: { at: 0, until: never.promise },
    });
    const { session, request } = sessionOf(asking, userId);
    const restore = await setObjectEnv(session(), { CHAT_TURN_IDLE_MS: "1" });
    try {
      const asked = session().run(request("turn-a", "Forever?"));
      await vi.waitFor(
        () => {
          expect(provider.requests).toHaveLength(1);
        },
        { timeout: 10_000 }
      );
      // The heartbeat's alarm finds it overdue.
      await runDurableObjectAlarm(session());
      await expect(asked).resolves.toMatchObject({
        outcome: "failed",
        stopped: "overdue",
      });
    } finally {
      never.resolve(true);
      await restore();
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
    const late = await chatSession(env, {
      workspaceId: id,
      chatId: chatIdSchema.parse(chat.id),
    })
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
      await startedThrough(api.chats, "One"),
      await startedThrough(api.chats, "Two"),
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

/** Restarts the chat's object, as an eviction or a deploy does, mid-call. */
const restart = async (
  stub: ReturnType<typeof chatSession> | ReturnType<typeof workspace>
): Promise<void> => {
  await runInDurableObject(stub, (_instance, state) => {
    state.abort("Restarted by the test");
  }).catch(() => {
    // Aborting fails the call that aborted: that is the restart.
  });
};

describe("a turn a restart cuts off", () => {
  it.each([
    ["before its first word", 0, false],
    ["after its first words, stored", 5, true],
  ])(
    "asks the model again when the cut came %s, and the chat shows the answer once",
    async (_when, at, stored) => {
      const { userId } = await signedInWithRole(idp, "user");
      const asking = await chatOf(userId);
      const cut = pausedReply(says("Zebra crossings ahead."), at);
      const provider = await fakeProviderFor(
        [model],
        cut.reply,
        says("Zebra crossings ahead.")
      );
      const { session, request } = sessionOf(asking, userId);
      /** How many of pi's records hold `text`. */
      const piHolds = async (text: string): Promise<number> =>
        await runInDurableObject(session(), (_instance, state) =>
          ["pi_document_revisions", "pi_entries"]
            .map(
              (table) =>
                state.storage.sql
                  .exec<{ count: number }>(
                    `SELECT count(*) AS count FROM ${table} WHERE ${table === "pi_entries" ? "record" : "content"} LIKE ?`,
                    `%${text}%`
                  )
                  .one().count
            )
            .reduce((sum, count) => sum + count, 0)
        );
      try {
        void session()
          .run(request("turn-a", "Answer?"))
          .catch(() => "cut short");
        await vi.waitFor(
          async () => {
            expect(provider.requests).toHaveLength(1);
            // pi stores the words streamed so far within a second.
            expect((await piHolds("Zebra")) > 0 || !stored).toBeTruthy();
          },
          { timeout: 10_000 }
        );
        await restart(session());
        // As its Workspace asks again once its call broke.
        const end = await session().run(request("turn-a", "Answer?"));
        expect({
          answer: end.answer,
          requests: provider.requests.length,
          // The words the cut answer got to, kept by pi as aborted.
          cutKept: (await piHolds('"stopReason":"aborted"')) > 0,
          kept: await keptOf(asking.stub, asking.chat.id),
        }).toStrictEqual({
          answer: "Zebra crossings ahead.",
          requests: 2,
          cutKept: stored,
          kept: ["user", "assistant:toolUse", "toolResult", "assistant:stop"],
        });
      } finally {
        cut.release();
      }
    }
  );

  it("ends a code step a restart cut off as failed, never runs it again, and asks the model on", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const provider = await fakeProviderFor(
      [model],
      codeStep(
        "export default async (self, env) => { await env.chat.info(); await scheduler.wait(5_000); return 1; };"
      ),
      says("Done.")
    );
    const { session, request } = sessionOf(asking, userId);
    void session()
      .run(request("turn-a", "Run it."))
      .catch(() => "cut short");
    await vi.waitFor(
      async () => {
        await expect(
          runRecords(asking.stub, asking.chat.id).then(
            (records) => records.length
          )
        ).resolves.toBe(1);
      },
      { timeout: 10_000 }
    );
    await restart(session());
    const end = await session().run(request("turn-a", "Run it."));
    const [results, runs] = await Promise.all([
      codeResults(asking.stub, asking.chat.id),
      runRecords(asking.stub, asking.chat.id),
    ]);
    expect({
      answer: end.answer,
      requests: provider.requests.length,
      failed: results.map(({ isError }) => isError),
      runs: runs.length,
    }).toStrictEqual({
      answer: "Done.",
      requests: 2,
      failed: [true],
      runs: 1,
    });
  });

  it("asks again at most four times in a row, then ends the turn as cut off too often", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId);
    const never = Promise.withResolvers<boolean>();
    const stuck = { ...says("Never."), pause: { at: 0, until: never.promise } };
    const provider = await fakeProviderFor(
      [model],
      ...Array.from({ length: 6 }, () => stuck)
    );
    const { session, request } = sessionOf(asking, userId);
    try {
      void session()
        .run(request("turn-a", "Again?"))
        .catch(() => "cut short");
      for (let sent = 1; sent <= 5; sent += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one cut after another
        await vi.waitFor(
          async () => {
            // Woken by its alarm, as nothing calls it.
            await runDurableObjectAlarm(session());
            expect(provider.requests).toHaveLength(sent);
          },
          { timeout: 15_000 }
        );
        // oxlint-disable-next-line no-await-in-loop -- see above
        await restart(session());
      }
      const end = await session().run(request("turn-a", "Again?"));
      expect({
        outcome: end.outcome,
        error: end.error,
        requests: provider.requests.length,
      }).toStrictEqual({
        outcome: "failed",
        error: "Restarts cut the turn off too often for it to go on.",
        requests: 5,
      });
    } finally {
      never.resolve(true);
    }
  });

  it.each([
    // A failure pi's own classifier wouldn't retry anyway, and two it would.
    ["fails", { status: 500 } as const, {}, false],
    [
      "sends nothing for too long",
      { hang: true } as const,
      { MODEL_STREAM_IDLE_MS: "400" },
      true,
    ],
    [
      "limits requests for longer than the call may wait",
      { status: 429, headers: { "retry-after": "3600" } } as const,
      {},
      true,
    ],
  ])(
    "sends nothing again when the provider %s: the gateway's failure is final",
    async (_case, reply, vars, retryable) => {
      const { userId } = await signedInWithRole(idp, "user");
      const asking = await chatOf(userId);
      const provider = await fakeProviderFor(
        [model],
        reply,
        says("Never sent.")
      );
      const { session, request } = sessionOf(asking, userId);
      const restore = await setObjectEnv(session(), vars);
      try {
        const end = await session().run(request("turn-a", "Fail?"));
        const failed = await runInDurableObject(
          asking.stub,
          (_instance, state) =>
            state.storage.sql
              .exec<{ message: string }>(
                "SELECT message FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1",
                asking.chat.id
              )
              .one().message
        );
        const answer = z
          .object({ errorMessage: z.string() })
          .parse(JSON.parse(failed));
        expect({
          outcome: end.outcome,
          requests: provider.requests.length,
          // Whether pi would send it again, were its retry on.
          retryable: isRetryableAssistantError({
            role: "assistant",
            content: [],
            api: "openai-responses",
            provider: "grasp",
            model,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "error",
            errorMessage: answer.errorMessage,
            timestamp: 0,
          }),
        }).toStrictEqual({ outcome: "failed", requests: 1, retryable });
      } finally {
        await restore();
      }
    }
  );
});

/** A ChatSession's storage as Pi 1.4 wrote it (test/fixtures/pi-1.4). */
const piFixtureSchema = z.object({
  ids: z.object({
    workspaceId: z.string(),
    chatId: z.string(),
    personId: z.string(),
    agentId: z.string(),
  }),
  objects: z.array(
    z.object({
      type: z.string(),
      name: z.string(),
      sql: z.string(),
      rows: z.array(
        z.record(z.string(), z.union([z.string(), z.number(), z.null()]))
      ),
    })
  ),
});

/**
 * Puts `fixture`'s tables into `chat`'s own object, before it opens pi,
 * each ID of the chat it was taken from replaced with `chat`'s.
 */
const restoreFixture = async (
  fixture: unknown,
  { id, chat, personId }: Awaited<ReturnType<typeof chatOf>>
): Promise<void> => {
  const { ids, objects } = piFixtureSchema.parse(fixture);
  // The workspace and its agent by what names them first: a fixture may
  // have one ID for both, as a test's workspace once was its agent's.
  // (in JSON kept inside a JSON string, its quotes escaped).
  const named: Record<string, string> = {
    [String.raw`workspaceId\":\"${ids.workspaceId}`]: String.raw`workspaceId\":\"${id}`,
    [String.raw`agentId\":\"${ids.agentId}`]: String.raw`agentId\":\"${chat.agentId}`,
  };
  const now: Record<string, string> = {
    [ids.chatId]: chat.id,
    [ids.personId]: personId,
    [ids.workspaceId]: id,
    [ids.agentId]: chat.agentId,
  };
  const swapped = (value: string | number | null) => {
    if (typeof value !== "string") {
      return value;
    }
    let text = value;
    for (const [was, is] of [
      ...Object.entries(named),
      ...Object.entries(now),
    ]) {
      text = text.replaceAll(was, is);
    }
    return text;
  };
  await runInDurableObject(
    chatSession(env, { workspaceId: id, chatId: chatIdSchema.parse(chat.id) }),
    (_instance, state) => {
      for (const { sql } of objects) {
        state.storage.sql.exec(sql);
      }
      for (const { name, rows } of objects) {
        for (const row of rows) {
          const columns = Object.keys(row);
          state.storage.sql.exec(
            `INSERT INTO ${name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            ...columns.map((column) => swapped(row[column] ?? null))
          );
        }
      }
    }
  );
};

// Captured on Pi 1.4.0 (before the 1.6.1 upgrade) from a chat of two
// answered turns, a code step in the second; `mid-request` again as a third
// turn's request was in flight and the object was evicted. Its turn record
// as the release before writes it, without `startedAt`.
describe("a chat Pi 1.4 wrote", () => {
  it("opens on this Pi and goes on, its model reading the chat so far", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId, says("Again, on this Pi."));
    await restoreFixture(settledOnPi14, asking);
    const { answer } = await asking.ask("Still there?");
    const sent = JSON.stringify(asking.provider.requests[0]?.body);
    expect({
      answer,
      read: ["Hello from Pi 1.4.", "It is 42.", "Still there?"].map((said) =>
        sent.includes(said)
      ),
    }).toStrictEqual({
      answer: "Again, on this Pi.",
      read: [true, true, true],
    });
  });

  it("is left as Pi 1.4 wrote it by an open alone: only a turn writes this Pi's versions", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId, says("Again, on this Pi."));
    await restoreFixture(settledOnPi14, asking);
    const session = chatSession(env, {
      workspaceId: asking.id,
      chatId: chatIdSchema.parse(asking.chat.id),
    });
    /** The newest version each of pi's own documents is stored at. */
    const versions = async () =>
      await runInDurableObject(session, (_instance, state) =>
        Object.fromEntries(
          state.storage.sql
            .exec<{ kind: string; version: number }>(
              `SELECT d.kind AS kind, max(r.version) AS version FROM pi_documents d JOIN pi_document_revisions r ON r.document_id = d.id WHERE d.kind LIKE '"pi.%' GROUP BY d.kind`
            )
            .toArray()
            .map(({ kind, version }) => [kind, version])
        )
      );
    const before = await versions();
    // As the Workspace asks before a question: opens pi on this version.
    await session.activeTurn();
    const opened = await versions();
    await asking.ask("Still there?");
    const answered = await versions();
    expect({
      opened: opened['"pi.live"'],
      unchanged: opened,
      answered: answered['"pi.live"'],
    }).toStrictEqual({ opened: 1, unchanged: before, answered: 3 });
  });

  it("answers the turn whose request an eviction cut off on Pi 1.4", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const asking = await chatOf(userId, says("Answered on this Pi."));
    await restoreFixture(midRequestOnPi14, asking);
    const session = chatSession(env, {
      workspaceId: asking.id,
      chatId: chatIdSchema.parse(asking.chat.id),
    });
    // Opened as the object next serves a call: the turn its record holds
    // is the one under way, and goes on, its alarms waking it.
    const active = await session.activeTurn();
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(session);
        expect(asking.provider.requests).toHaveLength(1);
      },
      { timeout: 15_000 }
    );
    await vi.waitFor(
      async () => {
        await expect(session.activeTurn()).resolves.toBeUndefined();
      },
      { timeout: 15_000 }
    );
    const kept = await keptOf(asking.stub, asking.chat.id);
    expect({
      active: active !== undefined,
      sent: JSON.stringify(asking.provider.requests[0]?.body).includes(
        "And now?"
      ),
      last: kept.at(-1),
    }).toStrictEqual({ active: true, sent: true, last: "assistant:stop" });
  });
});

describe("what a question's entry keeps", () => {
  it("shows its files and what it built though its recall's call is of a shape this code doesn't write", () => {
    const built = { plan: "call_plan", app: { id: "app-1", name: "Depot" } };

    expect({
      unknownRecall: questionDataOf({
        files: ["file-1", "file-2"],
        built,
        recall: { code: "await env.brain.recall({ query })" },
      }),
      unknownBuilt: questionDataOf({
        files: ["file-1"],
        built: { plan: 7 },
        recall: {
          runId: "run-1",
          callId: "call-1",
          query: "q",
          status: "completed",
        },
      }),
      none: questionDataOf("not an object"),
    }).toStrictEqual({
      unknownRecall: { files: ["file-1", "file-2"], built },
      unknownBuilt: {
        files: ["file-1"],
        recall: {
          runId: "run-1",
          callId: "call-1",
          query: "q",
          status: "completed",
        },
      },
      none: { files: [] },
    });
  });
});
