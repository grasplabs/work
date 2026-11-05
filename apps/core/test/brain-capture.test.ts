import { outcomesFor, outcomesOf } from "@grasp-os/brain/outcomes";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { chatSession, workspace } from "../src/durable-objects.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { Workspace } from "../src/workspace.ts";
import { model, pausedReply, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi } from "./sign-in.ts";

// Settled tasks' outcomes, captured for the Brain with no learning step in
// any task (brain-capture.ts): workflow runs as their row ends, chat turns
// as they settle. The ways capture could fail, tried below:
// 1. A settled task is lost: the process dies, or the Brain is out of
//    reach, between the settle and the delivery.
// 2. A delivery made again becomes a second event.
// 3. Evaluation or test work trains production behaviour.
// 4. A person who was removed, or a record that was erased, stays
//    learnable: delivered after the revocation, or kept after the erasure.
// 5. An event copies what the task read, wrote or said.
// The outside failure is the Brain's database out of reach: a binding
// whose writes fail, as an outage or a crash before delivery leaves it.

const idp = mockIdp();

/** The Brain's database, as the tests' env binds it. */
const knowledge = env.KNOWLEDGE;

/** The Brain's database, with every batch failing: out of reach. */
const unreachable = new Proxy(knowledge, {
  get: (target, property) => {
    if (property === "batch") {
      return async () => {
        await Promise.resolve();
        throw new Error("D1_ERROR: Network connection lost.");
      };
    }
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function"
      ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
      : value;
  },
});

/** The Brain's events of the run or chat `id`. */
const eventsOf = async (id: string) => await outcomesOf(brainOf(env), id);

/** How each of the Brain's events of `id` says its execution ended. */
const executionsOf = async (id: string): Promise<string[]> => {
  const events = await eventsOf(id);
  return events.map(({ execution }) => execution);
};

/** A member with their own chats, answered by `replies`. */
const chatter = async (...replies: ProviderReply[]) => {
  const person = await signedInApi(idp, "user");
  const stub = workspace(env, personalWorkspaceId(person.userId));
  const provider = await fakeProvider(...replies);
  const chat = await person.api.chats.create("Questions");
  const id = chatIdSchema.parse(chat.id);
  const ask = async () => await stub.ask(id, { text: "Hello?", model });
  return { person, stub, id, ask, provider };
};

/** The object's capture intents of chat `chatId`. */
const turnIntents = async (
  stub: ReturnType<typeof workspace>,
  chatId: string
) =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ state: string; attempts: number }>(
        "SELECT state, attempts FROM brain_capture_intents WHERE evidence_id = ?",
        chatId
      )
      .toArray()
  );

/** Sets the object's Brain database binding, as its env has it. */
const objectKnowledge = async (
  stub: ReturnType<typeof workspace>,
  binding: D1Database
): Promise<void> => {
  await runInDurableObject(stub, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The Workspace object has no env");
    }
    Object.assign(objectEnv, { KNOWLEDGE: binding });
  });
};

describe("a chat turn's outcome", () => {
  it("is captured once the turn settles, and goes when its chat is deleted", async () => {
    const { person, id, ask } = await chatter(says("Floor 3."));
    await ask();

    const [event] = await vi.waitFor(
      async () => {
        const events = await eventsOf(id);
        expect(events).toHaveLength(1);
        return events;
      },
      { timeout: 10_000, interval: 100 }
    );
    await person.api.chats.remove(id);

    expect({ event, after: await eventsOf(id) }).toMatchObject({
      event: {
        source: `chat.turn:${personalWorkspaceId(person.userId)}`,
        ownerId: person.userId,
        scope: "person",
        taskType: "chat.turn",
        execution: "completed",
        result: "unknown",
        evidenceId: id,
      },
      after: [],
    });
    // Identifiers only: nothing of the question or the answer.
    expect(JSON.stringify(event)).not.toMatch(/Floor 3|Hello/u);
  });

  it("is captured once when the turn settles after its Workspace restarted, nobody waiting on it", async () => {
    // It thinks, then writes, each paused until the test goes on.
    const thought = Promise.withResolvers<boolean>();
    const answer = pausedReply(
      {
        ...says("Floor 3."),
        thinking: {
          text: "Count.",
          tokens: 10,
          pause: { until: thought.promise },
        },
      },
      1
    );
    const { person, stub, id, ask, provider } = await chatter(answer.reply);
    void ask().catch(() => "cut short");
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    // The turn goes on in the chat's own object; its asker is gone.
    await runInDurableObject(stub, (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    const woken = workspace(env, personalWorkspaceId(person.userId));
    // The Workspace takes no call for a moment while the answer ends: what
    // the chat's object tells it meanwhile waits, the answer behind it.
    // Waited on by flags: workerd won't let one request wait on another's
    // promise.
    const hold = { reached: false, released: false };
    const held = runInDurableObject(woken, async (_instance, state) => {
      await state.blockConcurrencyWhile(async () => {
        hold.reached = true;
        while (!hold.released) {
          // oxlint-disable-next-line no-await-in-loop -- until the test says
          await scheduler.wait(20);
        }
      });
    });
    await vi.waitFor(() => {
      expect(hold.reached).toBeTruthy();
    });
    // It writes: what it shows of that waits on the Workspace, and the
    // answer ends behind it.
    thought.resolve(true);
    await scheduler.wait(500);
    answer.release();
    await scheduler.wait(1000);
    hold.released = true;
    await held;
    const [event] = await vi.waitFor(
      async () => {
        const events = await eventsOf(id);
        expect(events.map(({ execution }) => execution)).toStrictEqual([
          "completed",
        ]);
        return events;
      },
      { timeout: 15_000, interval: 100 }
    );
    // The answer it records is the turn's last, as the chat keeps it.
    const [answered] = await runInDurableObject(woken, (_instance, state) =>
      state.storage.sql
        .exec<{ id: number }>(
          "SELECT id FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1",
          id
        )
        .toArray()
    );
    expect({
      answer: event?.evidenceRefs.some(
        ({ kind, id: ref }) =>
          kind === "chat_message" && ref === String(answered?.id)
      ),
      intents: await turnIntents(woken, id),
      summary: await woken.chatSummary(id, person.userId),
    }).toMatchObject({
      answer: true,
      intents: [],
      summary: { running: false },
    });
  });

  it("goes with its chat when its delivery is under way as the chat is deleted", async () => {
    const { person, stub, id, ask } = await chatter(says("Floor 3."));
    // The Brain takes the first batch, the outcome's record, only once the
    // test says; and the chat's object takes nothing until the test says,
    // so the deletion stops there, after it erased what the Brain held.
    // Waited on by flags: workerd won't let one request wait on another's
    // promise.
    const brain = { reached: false, released: false, used: false };
    await objectKnowledge(
      stub,
      new Proxy(knowledge, {
        get: (target, property) => {
          const value: unknown = Reflect.get(target, property);
          if (property === "batch" && typeof value === "function") {
            return async (...args: unknown[]): Promise<unknown> => {
              if (!brain.used) {
                brain.used = true;
                brain.reached = true;
                while (!brain.released) {
                  // oxlint-disable-next-line no-await-in-loop -- until the test says
                  await scheduler.wait(20);
                }
              }
              return await Reflect.apply(value, target, args);
            };
          }
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      })
    );
    const session = { reached: false, released: false };
    try {
      await ask();
      await vi.waitFor(() => {
        expect(brain.reached).toBeTruthy();
      });
      const held = runInDurableObject(
        chatSession(env, personalWorkspaceId(person.userId), id),
        async (_instance, state) => {
          await state.blockConcurrencyWhile(async () => {
            session.reached = true;
            while (!session.released) {
              // oxlint-disable-next-line no-await-in-loop -- until the test says
              await scheduler.wait(20);
            }
          });
        }
      );
      await vi.waitFor(() => {
        expect(session.reached).toBeTruthy();
      });
      const removed = person.api.chats.remove(id);
      await scheduler.wait(500);
      // The outcome lands, the chat being deleted meanwhile.
      brain.released = true;
      await scheduler.wait(500);
      session.released = true;
      await held;
      await removed;
    } finally {
      brain.released = true;
      session.released = true;
      await objectKnowledge(stub, knowledge);
    }
    await scheduler.wait(500);
    await expect(eventsOf(id)).resolves.toStrictEqual([]);
  });

  it("is captured once its Workspace takes it again, when the next question came before, and the turn answers all the same", async () => {
    const { stub, id, ask } = await chatter(says("Floor 3."), says("Floor 4."));
    // The Workspace takes no capture twice, as an outage of its store
    // would: the chat's object asks it for each again.
    // oxlint-disable-next-line typescript/unbound-method -- put back as it was, and called with its `this`
    const kept = Workspace.prototype.captureTurn;
    let refused = 0;
    Workspace.prototype.captureTurn = function captureTurn(
      this: Workspace,
      ...args: Parameters<Workspace["captureTurn"]>
    ): void {
      if (refused < 2) {
        refused += 1;
        throw new Error("Capture store out of reach");
      }
      kept.apply(this, args);
    };
    const outcomeOfAsk = async () =>
      await ask().then(
        ({ outcome }) => outcome,
        (error: unknown) =>
          z.object({ message: z.string() }).parse(error).message
      );
    const first = await outcomeOfAsk();
    const second = await outcomeOfAsk();
    const executions = await vi.waitFor(
      async () => {
        const all = await executionsOf(id);
        expect(all).toHaveLength(2);
        return all;
      },
      { timeout: 15_000, interval: 100 }
    );
    // The Workspace as it was, for the tests after.
    Workspace.prototype.captureTurn = kept;
    // Each names its own turn's answer, as the chat keeps it: the first
    // too, delivered once the next question replaced its turn's record.
    const answers = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ id: number; message: string }>(
          "SELECT id, message FROM chat_messages WHERE chat_id = ? ORDER BY id",
          id
        )
        .toArray()
        .filter(({ message }) => message.includes('"role":"assistant"'))
        .map((row) => String(row.id))
    );
    const events = await eventsOf(id);
    const named = events
      .map(({ evidenceRefs }) =>
        evidenceRefs
          .filter(({ kind }) => kind === "chat_message")
          .map(({ id: ref }) => ref)
      )
      .toSorted((a, b) => Number(a[0]) - Number(b[0]));
    expect({ first, second, executions, named }).toStrictEqual({
      first: "answered",
      second: "answered",
      executions: ["completed", "completed"],
      named: answers.map((answer) => [answer]),
    });
  });

  it("survives the Brain being out of reach as the turn settles, through the object's alarm", async () => {
    const { stub, id, ask } = await chatter(says("Floor 3."));
    await objectKnowledge(stub, unreachable);
    try {
      await ask();
      await vi.waitFor(
        async () => {
          await expect(turnIntents(stub, id)).resolves.toStrictEqual([
            { state: "pending", attempts: 1 },
          ]);
        },
        { timeout: 10_000, interval: 100 }
      );
    } finally {
      // Objects may share the tests' env: the binding as it was.
      await objectKnowledge(stub, knowledge);
    }
    const lost = await eventsOf(id);

    await runDurableObjectAlarm(stub);

    expect({
      lost,
      repaired: await executionsOf(id),
      intents: await turnIntents(stub, id),
    }).toStrictEqual({ lost: [], repaired: ["completed"], intents: [] });
  });

  it("is never captured in a chat in restricted mode", async () => {
    const { stub, id, ask } = await chatter(says("Floor 3."));
    await runInDurableObject(stub, (instance) => instance.restrictChat(id));

    await ask();
    await runDurableObjectAlarm(stub);

    expect({
      events: await eventsOf(id),
      intents: await turnIntents(stub, id),
    }).toStrictEqual({ events: [], intents: [] });
  });

  it("is one experience for exactly a shared chat's members, reached only while they stay", async () => {
    const ann = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const cas = await signedInApi(idp, "user");
    const dee = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const stub = workspace(env, personalWorkspaceId(ann.userId));
    await fakeProvider(says("Floor 3."), says("Floor 4."));
    const agentId = crypto.randomUUID();
    /** Ann asks in the group, as its door does, with who is in it now. */
    const askInGroup = async (members: string[]) =>
      await stub.askThrough(ann.userId, agentId, "slack", "Hello?", undefined, {
        thread: "C1",
        kind: "group",
        audience: { members, outsiders: false },
      });
    /** The shared events of the chat each person reaches now. */
    const reached = async (chatId: string) =>
      await Promise.all(
        [ann, ben, cas, dee].map(async (someone) => {
          const events = await outcomesFor(brainOf(env), {
            type: "person",
            person: await someone.api.whoami(),
          });
          return events.filter(({ evidenceId }) => evidenceId === chatId)
            .length;
        })
      );

    const { chatId } = await askInGroup([ann.userId, ben.userId, cas.userId]);
    const [event] = await vi.waitFor(
      async () => {
        const events = await eventsOf(chatId);
        expect(events).toHaveLength(1);
        return events;
      },
      { timeout: 10_000, interval: 100 }
    );
    const atFirst = await reached(chatId);
    // Ben leaves the group (the next turn's roster), and Cas the company.
    await askInGroup([ann.userId, cas.userId]);
    await vi.waitFor(
      async () => {
        await expect(eventsOf(chatId)).resolves.toHaveLength(2);
      },
      { timeout: 10_000, interval: 100 }
    );
    await admin.api.members.remove(cas.userId);

    expect({
      event: { scope: event?.scope, audience: event?.audience },
      // Ann, Ben, Cas; never Dee, who was never in it.
      atFirst,
      // Ann reaches both; Ben neither, having left; Cas none, gone.
      after: await reached(chatId),
    }).toStrictEqual({
      event: { scope: "session", audience: chatId },
      atFirst: [1, 1, 1, 0],
      after: [2, 0, 0, 0],
    });
  });
});
