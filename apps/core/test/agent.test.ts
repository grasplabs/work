import { agentErrors } from "@grasp-os/shared/agent";
import type { AuditEvent } from "@grasp-os/shared/audit";
import type { WorkspaceId } from "@grasp-os/shared/ids";
import { chatIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import { modelErrors } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { z } from "zod";

import { chatSession, workspace } from "../src/durable-objects.ts";
import { endedRunsKept } from "../src/workspace.ts";
import {
  codeResults,
  codeStep,
  model,
  pausedReply,
  readApiStep,
  says,
  testRunOpening,
  transcript,
} from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
import { chatsWith, runRecords } from "./agent-code-runs.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { signedInWithRole } from "./sign-in.ts";

// A chat's agent, through the Workspace object: the loop, the code it runs
// in isolates of their own, and the model gateway, all real (agent-chat.ts).

const idp = mockIdp();

const { newChat, newChatOn } = chatsWith(idp);

/** The agent's model.call events for `userId`, once `count` have arrived. */
const modelCallsBy = async (
  userId: string,
  count: number
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ action, actor }) =>
        action === "model.call" &&
        actor.type === "agent" &&
        actor.onBehalfOf === userId
    );
  };
  await vi.waitFor(
    async () => {
      await expect(mine()).resolves.toHaveLength(count);
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

const codeOf = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (error) {
    return (
      agentErrors.codeOf(error) ??
      modelErrors.codeOf(error) ??
      permissionErrors.codeOf(error) ??
      "failed"
    );
  }
  return "answered";
};

/** What a turn logs of its prompt cache as it ends. */
const turnCacheSchema = z.object({
  event: z.literal("chat.turn_cache"),
  chatId: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  share: z.unknown(),
});

/**
 * Restarts the workspace's object where it is, as a deploy does: a stub to
 * reach it by from then on, as the one it was restarted through is broken.
 */
const restart = async (id: WorkspaceId): Promise<WorkspaceStub> => {
  await runInDurableObject(workspace(env, id), (_instance, state) => {
    state.abort("Restarted by the test");
  }).catch(() => {
    // Aborting fails the call that aborted: that is the restart.
  });
  return workspace(env, id);
};

/** Orders text alphabetically. */
const byText = (a: string, b: string): number => a.localeCompare(b, "en");

describe("chat agent", () => {
  it("answers a question with a code step against the chat's API, its declaration read first", async () => {
    const { stub, chat, personId, provider, ask } = await newChat(
      readApiStep("chat"),
      codeStep(
        "export default async (self, env) => (await env.chat.info()).personId;"
      ),
      says("You are the person this chat belongs to.")
    );

    const reply = await ask("Who am I?");

    expect(reply).toStrictEqual({
      outcome: "answered",
      answer: "You are the person this chat belongs to.",
      // It read nothing: nothing to label it with.
      provenance: { sources: [], restricted: false },
      cited: [],
      // In Grasp's own app: no chat app's check line, nor its text.
      check: null,
      channelText: null,
    });
    // The code ran with the API core gave it, which knows whom it acts for.
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      { isError: false, text: `Returned:\n${personId}` },
    ]);
    // The model saw the API listed, read its declaration, then the step's
    // result.
    const [first, second, third] = provider.requests.map(({ body }) =>
      JSON.stringify(body)
    );
    const info =
      "info(): Promise<{ chatId: string; personId: string; now: string }>";
    expect({
      listed: first?.includes("- env.chat: "),
      declaredUpFront: first?.includes(info),
      declaredOnRead: second?.includes(info),
      result: third?.includes(personId),
    }).toStrictEqual({
      listed: true,
      declaredUpFront: false,
      declaredOnRead: true,
      result: true,
    });
    const messages = await transcript(stub, chat.id);
    expect(messages.map(({ role }) => role)).toStrictEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });

  it("hands a thinking model its own reasoning back on each later request, at the effort asked, after a restart too", async () => {
    // Anthropic's thinking models refuse a request whose earlier assistant
    // messages lack the signed thinking they gave with them.
    const planned = "Work out six times seven in code.";
    const read = "The code returned 42.";
    const { stub, chat, provider } = await newChat(
      {
        ...codeStep("export default async () => 6 * 7;"),
        thinking: { text: planned, tokens: 20 },
      },
      { ...says("42."), thinking: { text: read, tokens: 10 } }
    );
    await stub.ask(chat.id, {
      text: "What is six times seven?",
      model,
      effort: "max",
    });
    await evictDurableObject(stub);
    const later = await fakeProvider(says("What six times seven is."));
    await stub.ask(chat.id, { text: "What did I ask?", model });

    // What each request sent, in Anthropic's wire format.
    const requestSchema = z.object({
      thinking: z.looseObject({ type: z.string(), budget_tokens: z.number() }),
      messages: z.array(
        z.looseObject({
          role: z.string(),
          content: z.union([
            z.string(),
            z.array(
              z.looseObject({
                type: z.string(),
                thinking: z.string().optional(),
                signature: z.string().optional(),
              })
            ),
          ]),
        })
      ),
    });
    expect(
      [...provider.requests, ...later.requests].map(({ body }) => {
        const sent = requestSchema.parse(body);
        return {
          thinking: sent.thinking.type,
          budget: sent.thinking.budget_tokens,
          reasoning: sent.messages
            .filter(({ role }) => role === "assistant")
            .flatMap(({ content }) =>
              typeof content === "string"
                ? []
                : content.flatMap((block) =>
                    block.type === "thinking"
                      ? [{ thinking: block.thinking, signed: block.signature }]
                      : []
                  )
            ),
        };
      })
    ).toStrictEqual([
      { thinking: "enabled", budget: 16_384, reasoning: [] },
      {
        thinking: "enabled",
        budget: 16_384,
        reasoning: [{ thinking: planned, signed: "signed" }],
      },
      // A question that names no effort: medium, a smaller budget.
      {
        thinking: "enabled",
        budget: 8192,
        reasoning: [
          { thinking: planned, signed: "signed" },
          { thinking: read, signed: "signed" },
        ],
      },
    ]);
  });

  it("audits every model request as the workspace's agent, acting for the chat's person, in the chat", async () => {
    const { id, chat, personId, ask } = await newChat(
      codeStep("export default async () => 1 + 1;"),
      says("Two.")
    );

    await ask("What is 1 + 1?");

    const events = await modelCallsBy(personId, 2);
    expect(events.map(({ actor }) => actor)).toStrictEqual([
      { type: "agent", agentId: id, onBehalfOf: personId },
      { type: "agent", agentId: id, onBehalfOf: personId },
    ]);
    expect(events.map(({ detail }) => detail)).toStrictEqual([
      expect.objectContaining({
        purpose: "chat.turn",
        outcome: "answered",
        chat: chat.id,
      }),
      expect.objectContaining({
        purpose: "chat.turn",
        outcome: "answered",
        chat: chat.id,
      }),
    ]);
    // Metadata only: never the question or the code.
    expect(JSON.stringify(events)).not.toContain("1 + 1");
  });

  it("names the chat platform a chat came through in the audit of its turns", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const id = workspaceIdSchema.parse(crypto.randomUUID());
    const stub = workspace(env, id);
    const chat = await stub.createChat(
      "Questions",
      userId,
      id,
      undefined,
      "teams"
    );
    await fakeProvider(says("Hello."));

    await stub.ask(chat.id, { text: "Hi.", model });

    const [event] = await modelCallsBy(userId, 1);
    expect(chat.via).toBe("teams");
    expect(event?.actor).toStrictEqual({
      type: "agent",
      agentId: id,
      onBehalfOf: userId,
      via: "teams",
    });
  });

  it("hands what the code throws back to the model, which goes on", async () => {
    const { stub, chat, ask } = await newChat(
      codeStep(
        'export default async () => { console.log("Looking."); throw new Error("No such invoice"); };'
      ),
      says("I couldn't find that invoice.")
    );

    const reply = await ask("Find invoice 42.");

    expect(reply.answer).toBe("I couldn't find that invoice.");
    const [result] = await codeResults(stub, chat.id);
    expect(result).toMatchObject({ isError: true });
    expect(result?.text).toMatch(/Looking\.[\s\S]*Error: No such invoice/u);
  });

  it("stops the turn when the person leaves during it", async () => {
    // The model is still answering, with code to run, when they leave.
    const { reply, release } = pausedReply(
      { ...codeStep("export default async () => 'done';"), text: "Running." },
      1
    );
    const { personId, provider, ask } = await newChat(
      reply,
      says("Never asked.")
    );

    const turn = codeOf(ask("Wait."));
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(personId)
      .run();
    release();

    await expect(turn).resolves.toBe("permission.person_inactive");
    // No request for them after they left.
    expect(provider.requests).toHaveLength(1);
  });
});

describe("chat agent turns", () => {
  it("can be cancelled while its code runs", async () => {
    const { stub, chat, personId, provider, ask } = await newChat(
      codeStep(
        "export default async () => { await scheduler.wait(10_000); return 'late'; };"
      )
    );

    const reply = ask("Wait a minute.");
    await vi.waitFor(
      async () => {
        expect(provider.requests).toHaveLength(1);
        // The step has started once its call is kept.
        await expect(transcript(stub, chat.id)).resolves.toHaveLength(2);
      },
      { timeout: 10_000 }
    );
    await stub.cancel(chat.id, personId);

    await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });
    // pi ends the aborted call with its own result; the run's record says
    // how the run itself ended.
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      { isError: true, text: "Tool executeCode was aborted" },
    ]);
    await vi.waitFor(async () => {
      await expect(
        runInDurableObject(stub, (_instance, state) =>
          state.storage.sql
            .exec<{ status: string }>(
              "SELECT status FROM chat_code_runs WHERE chat_id = ?",
              chat.id
            )
            .toArray()
            .map(({ status }) => status)
        )
      ).resolves.toStrictEqual(["cancelled"]);
    });
    // No request after the cancelled step.
    expect(provider.requests).toHaveLength(1);
  });

  it("can be cancelled while the model answers", async () => {
    const { stub, chat, personId, provider, ask } = await newChat({
      hang: true,
    });

    const reply = ask("Take your time.");
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    await expect(stub.cancel(chat.id, personId)).resolves.toBeTruthy();

    await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });
    const [event] = await modelCallsBy(personId, 1);
    expect(event?.detail).toMatchObject({ outcome: "cancelled" });
  });

  it("takes one question at a time per chat", async () => {
    const { stub, chat, personId, provider, ask } = await newChat({
      hang: true,
    });

    const first = ask("First.");
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );

    await expect(codeOf(ask("Second."))).resolves.toBe("agent.busy");
    await stub.cancel(chat.id, personId);
    await expect(first).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("refuses a model the organization didn't choose, before anything is kept", async () => {
    const { stub, chat } = await newChat();

    await expect(
      codeOf(stub.ask(chat.id, { text: "Hi.", model: "openai/gpt-5.4" }))
    ).resolves.toBe("model.not_allowed");
    await expect(transcript(stub, chat.id)).resolves.toStrictEqual([]);
  });

  it("keys a chat's requests to its prompt cache, and records what each request and turn read from it", async () => {
    const logged = vi.spyOn(console, "info");
    const openai = "openai/gpt-5.4";
    const { stub, chat, personId, provider } = await newChatOn(
      [model, openai],
      { ...says("Hi."), cache: { read: 900, write: 100 } },
      says("Hi again."),
      says("Hi once more.")
    );
    await stub.ask(chat.id, { text: "Hi.", model });
    await stub.ask(chat.id, { text: "Hi again.", model: openai });
    await stub.ask(chat.id, { text: "Hi once more.", model: openai });

    // OpenAI's responses carry the chat's conversation as their cache key,
    // the same on every turn (pi's session). (Anthropic's cache markers are
    // pi's default either way; its session headers stop at connect.)
    const responses = provider.requests.at(-2);
    const [key, next] = provider.requests
      .slice(-2)
      .map(
        ({ body }) =>
          z.looseObject({ prompt_cache_key: z.string() }).parse(body)
            .prompt_cache_key
      );
    expect({
      responses:
        responses && new URL(responses.url).pathname.endsWith("/responses"),
      stable: key === next,
      keyed: (key ?? "").length > 0,
    }).toStrictEqual({ responses: true, stable: true, keyed: true });
    const calls = await modelCallsBy(personId, 3);
    expect(
      calls.map(({ model: used, detail }) => ({
        inputTokens: used?.inputTokens,
        cacheReadTokens: detail.cacheReadTokens,
        cacheWriteTokens: detail.cacheWriteTokens,
      }))
    ).toStrictEqual([
      // The cache's tokens are among the prompt's.
      { inputTokens: 1200, cacheReadTokens: 900, cacheWriteTokens: 100 },
      { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);

    // A turn cancelled before the provider counted anything adds no
    // request to the turn's record, so it records none.
    const cancelled = await newChat({ hang: true });
    const reply = cancelled.ask("Take your time.");
    await vi.waitFor(
      () => {
        expect(cancelled.provider.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    await cancelled.stub.cancel(cancelled.chat.id, cancelled.personId);
    await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });
    const turnsOf = (chatId: string) =>
      logged.mock.calls
        .map(([entry]: unknown[]) => turnCacheSchema.safeParse(entry))
        .flatMap((parsed) =>
          parsed.success && parsed.data.chatId === chatId ? [parsed.data] : []
        )
        .map(({ event: _event, chatId: _chat, ...turn }) => turn);
    expect({
      cached: turnsOf(chat.id),
      cancelled: turnsOf(cancelled.chat.id),
    }).toStrictEqual({
      cached: [
        { requests: 1, inputTokens: 1200, cacheReadTokens: 900, share: 0.75 },
        { requests: 1, inputTokens: 200, cacheReadTokens: 0, share: 0 },
        { requests: 1, inputTokens: 200, cacheReadTokens: 0, share: 0 },
      ],
      cancelled: [],
    });
  });

  it("stops acting for a person who has left", async () => {
    const { personId, provider, ask } = await newChat(says("Hi."));
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(personId)
      .run();

    await expect(codeOf(ask("Hi."))).resolves.toBe(
      "permission.person_inactive"
    );
    expect(provider.requests).toStrictEqual([]);
  });

  it.each([
    ["a chat that doesn't exist", "missing", "Hi.", "agent.chat_not_found"],
    ["an empty question", undefined, "   ", "agent.invalid_question"],
  ])("refuses %s", async (_, chatId, text, code) => {
    const { stub, chat } = await newChat();

    await expect(
      codeOf(stub.ask(chatId ?? chat.id, { text, model }))
    ).resolves.toBe(code);
  });
});

describe("chat agent after a restart", () => {
  it("stops the turn when its person leaves during it and a restart of its chat's object cuts it short, and says why", async () => {
    const { reply, release } = pausedReply(
      { ...codeStep("export default async () => 'done';"), text: "Running." },
      1
    );
    const { id, chat, personId, provider, ask } = await newChat(
      reply,
      says("Never asked.")
    );

    const turn = codeOf(ask("Wait."));
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(personId)
      .run();
    // The turn is set up again as the object wakes, for a person who left.
    await runInDurableObject(chatSession(env, id, chat.id), (_, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });

    await expect(turn).resolves.toBe("permission.person_inactive");
    release();
    expect(provider.requests).toHaveLength(1);
  });

  it("continues the conversation with everything before it", async () => {
    const { stub, chat, ask } = await newChat(
      codeStep(
        "export default async (self, env) => (await env.chat.info()).chatId;"
      ),
      says("This chat's ID is known.")
    );
    await ask("Which chat is this?");

    await evictDurableObject(stub);
    const provider = await fakeProvider(says("You asked which chat this is."));
    const reply = await ask("What did I ask before?");

    expect(reply.answer).toBe("You asked which chat this is.");
    const sent = JSON.stringify(provider.requests[0]?.body);
    for (const earlier of [
      "Which chat is this?",
      "env.chat.info()",
      chat.id,
      "This chat's ID is known.",
      "What did I ask before?",
    ]) {
      expect(sent).toContain(earlier);
    }
  });

  it("goes on from a turn a restart of its ChatSession cut short, the chat shown running throughout", async () => {
    // The answer after the restart pauses, so the turn is still under way
    // when the chat is read.
    const answer = pausedReply(says("42."), 1);
    const { id, stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async () => { await scheduler.wait(2_000); return 6 * 7; };"
      ),
      answer.reply
    );
    // The question's call breaks with the restarts: the turn goes on.
    const reply = ask("What is 6 * 7?").then(
      () => "settled",
      () => "settled"
    );
    await vi.waitFor(
      async () => {
        await expect(transcript(stub, chat.id)).resolves.toHaveLength(2);
      },
      { timeout: 10_000 }
    );
    // The chat's object restarts mid-step, as a crash would cut it short.
    const session = chatSession(env, id, chat.id);
    await runInDurableObject(session, (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    // The Workspace restarts too: the chat still shows its turn running,
    // as the ChatSession says.
    const woken = await restart(id);
    const { running } = await woken.chatSummary(chat.id, personId);
    // Its heartbeat alarm picks the turn up again, if it hasn't yet.
    await runDurableObjectAlarm(chatSession(env, id, chat.id));
    answer.release();
    await vi.waitFor(
      async () => {
        await expect(transcript(woken, chat.id)).resolves.toHaveLength(4);
      },
      { timeout: 15_000 }
    );
    const results = await codeResults(woken, chat.id);
    const messages = await transcript(woken, chat.id);
    expect({
      running,
      answered: messages.at(-1)?.role,
      results: results.length,
      settled: await reply,
    }).toStrictEqual({
      running: true,
      answered: "assistant",
      results: 1,
      settled: "settled",
    });
    await vi.waitFor(async () => {
      await expect(woken.chatSummary(chat.id, personId)).resolves.toMatchObject(
        {
          running: false,
        }
      );
    });
  });

  it("goes on from a turn a restart of both objects cut short once a note is the first call to reach its ChatSession, the note told though that call is reset too", async () => {
    const answer = pausedReply(says("42."), 1);
    const { id, stub, chat, personId, provider, ask } = await newChat(
      codeStep(
        "export default async () => { await scheduler.wait(2_000); return 6 * 7; };"
      ),
      answer.reply
    );
    // The question's call breaks with the restarts: the turn goes on.
    void ask("What is 6 * 7?").catch(() => "settled");
    await vi.waitFor(
      async () => {
        await expect(transcript(stub, chat.id)).resolves.toHaveLength(2);
      },
      { timeout: 10_000 }
    );
    // The Workspace first, so nothing asks for the turn again, then the
    // chat's object, mid-step.
    const woken = await restart(id);
    await runInDurableObject(chatSession(env, id, chat.id), (_, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    // The chat's object resets under the note's own call too, as one that
    // opens cold under load can: the note is made again, and told.
    await runInDurableObject(
      chatSession(env, id, chat.id),
      (instance, state) => {
        // On the class, as a call reaches its methods there, and only once:
        // the object that starts again has the method as it is.
        const methods = Reflect.getPrototypeOf(instance) ?? instance;
        const note: unknown = Reflect.get(methods, "note");
        // Back as it was however the test ends: the class is the isolate's.
        onTestFinished(() => {
          Reflect.set(methods, "note", note);
        });
        Reflect.set(methods, "note", async () => {
          Reflect.set(methods, "note", note);
          state.abort("Reset under the note by the test");
          await Promise.resolve();
        });
      }
    );
    // A connection decided meanwhile: its note wakes the chat's object.
    await woken.connectionDecided(chat.id, personId, {
      binding: "MAIL",
      decision: "denied",
    });
    answer.release();
    const messages = await vi.waitFor(
      async () => {
        const kept = await transcript(woken, chat.id);
        expect(kept).toHaveLength(4);
        return kept;
      },
      { timeout: 15_000 }
    );
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "42." }],
    });
    expect(
      provider.requests.some(({ body }) =>
        JSON.stringify(body).includes(
          'The connection you asked for as \\"MAIL\\" was denied'
        )
      )
    ).toBeTruthy();
  });
});

describe("chat agent code run retention", () => {
  it("keeps no more closed leases than it may, however many runs end", async () => {
    const { stub, chat } = await newChat();
    const chatId = chatIdSchema.parse(chat.id);
    const runs = endedRunsKept + 50;

    // Leases opened and closed as runs do, past the most it keeps.
    const kept = await runInDurableObject(stub, (instance) => {
      const ids: string[] = [];
      for (let run = 0; run < runs; run += 1) {
        const id = instance.openCodeRun(
          chatId,
          crypto.randomUUID(),
          testRunOpening
        );
        instance.closeCodeRun(chatId, id, "completed");
        ids.push(id);
      }
      return {
        retention: instance.codeRunRetention(),
        // The oldest are forgotten, and answer as ended, unlogged.
        oldest: instance.callFromCodeRun(chatId, ids[0] ?? ""),
        newest: instance.callFromCodeRun(chatId, ids.at(-1) ?? ""),
      };
    });

    expect(kept).toStrictEqual({
      retention: { open: 0, closed: endedRunsKept, outputs: 0 },
      oldest: { call: "ended", first: false },
      newest: { call: "ended", first: true },
    });
  });

  it("keeps no open lease or output after many runs, whether they complete, throw or fail to load", async () => {
    const kinds = [
      "export default async (self, env) => { console.log((await env.chat.info()).chatId); return 1; };",
      "export default async (self, env) => { await env.chat.info(); throw new Error('nope'); };",
      "export default async () => {",
    ];
    const turns = 4;
    const replies = Array.from({ length: turns }, (_, turn) => [
      codeStep(kinds[0] ?? "", 5),
      codeStep(kinds[1 + (turn % 2)] ?? "", 5),
      says("Done."),
    ]).flat();
    const { stub, chat, ask } = await newChat(...replies);

    for (let turn = 0; turn < turns; turn += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one turn at a time per chat
      await ask("Run them.");
    }

    // Read from the object's own state after the runs, not inferred from
    // their cleanup. What the runtime holds for them can't be read.
    await expect(
      runInDurableObject(stub, (instance) => instance.codeRunRetention())
    ).resolves.toStrictEqual({
      open: 0,
      closed: turns * 10,
      outputs: 0,
    });
    const records = await runRecords(stub, chat.id);
    expect(
      records.map(({ status }) => String(status)).toSorted(byText)
    ).toStrictEqual(
      [
        ...Array.from({ length: 20 }, () => "completed"),
        ...Array.from({ length: 10 }, () => "load_failed"),
        ...Array.from({ length: 10 }, () => "threw"),
      ].toSorted(byText)
    );
  });
});
