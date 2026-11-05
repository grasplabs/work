import piAgentCore from "@earendil-works/pi-agent-core/package.json" with { type: "json" };
import { agentErrors } from "@grasp-os/shared/agent";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { applyOutput } from "@grasp-os/shared/chat";
import type { ChatOutput, ChatUpdate } from "@grasp-os/shared/chat";
import type { WorkspaceId } from "@grasp-os/shared/ids";
import { chatIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import { modelErrors } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { redact } from "@grasp-os/shared/redact";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  codeLimits,
  codeRuntime,
  cutMarker,
  cutToBytes,
  sourceHash,
  utf8Bytes,
} from "../src/code-mode.ts";
import { chatSession, workspace } from "../src/durable-objects.ts";
import { endedRunsKept } from "../src/workspace.ts";
import {
  chatOf,
  codeResults,
  codeStatuses,
  codeStep,
  readApiStep,
  model,
  pausedReply,
  says,
  setObjectEnv,
  testRunOpening,
  transcript,
} from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import { fakeProvider, fakeProviderFor } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";

// A chat's agent, through the Workspace object: the loop, the code it runs
// in isolates of their own, and the model gateway, all real (agent-chat.ts).

const idp = mockIdp();

/** A new chat for a person no other test uses, answered by `replies`. */
const newChat = async (...replies: ProviderReply[]) => {
  // A member of the organization, whom no other test uses.
  const { userId } = await signedInWithRole(idp, "user");
  return await chatOf(userId, ...replies);
};

/**
 * {@link newChat}, the organization having chosen `models` (the first its
 * default), which answer with `replies`.
 */
const newChatOn = async (models: string[], ...replies: ProviderReply[]) => {
  const chat = await newChat();
  const provider = await fakeProviderFor(models, ...replies);
  return { ...chat, provider };
};

/** Runs `code` as the chat's only code step, and returns what it gave. */
const runStep = async (code: string) => {
  const { stub, chat, ask } = await newChat(codeStep(code), says("Done."));
  await ask("Run it.");
  const [result] = await codeResults(stub, chat.id);
  return result;
};

/** The runtime's own messages for a run out of CPU time, and a hung one. */
const cpuMessage = "Worker exceeded CPU time limit.";
const hangMessage =
  "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.";

/**
 * Code that makes the next value set at index 0 of any array a getter
 * throwing `message`: an array the harness filled through [[Set]], then
 * sent, would reject with the code's own message.
 */
const arrayTrap = (message: string): string =>
  `Object.defineProperty(Array.prototype, "0", { configurable: true, set(value) { Object.defineProperty(this, "0", { enumerable: true, configurable: true, get() { throw new Error(${JSON.stringify(message)}); } }); } });`;

/** Runs `code` as the chat's only code step: what it gave, and how it ended. */
const runEnded = async (code: string) => {
  const { stub, chat, ask } = await newChat(codeStep(code), says("Done."));
  await ask("Run it.");
  const [result] = await codeResults(stub, chat.id);
  const [status] = await codeStatuses(stub, chat.id);
  return { ...result, status };
};

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

/**
 * The `agent.call` events of chat `chatId` refused for `reason`, once the
 * outboxes are drained: all of them, however many there should be.
 */
const refusalsIn = async (chatId: string, reason: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, detail }) =>
        action === "agent.call" &&
        detail.chat === chatId &&
        detail.reason === reason
    )
    .map(({ detail }) => ({
      method: detail.method,
      outcome: detail.outcome,
      reason: detail.reason,
    }));
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

/** The one warning a call from an ended run logs. */
const runEndedSchema = z.object({
  event: z.literal("agent.run_ended"),
  runId: z.string(),
});

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
      "info(): Promise<{ chatId: string; personId: string; app: string | null; now: string }>";
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

describe("chat agent sandbox", () => {
  it.each([
    [
      "fetch",
      "export default async () => (await fetch('https://example.com')).status;",
    ],
    [
      "a raw socket",
      "import { connect } from 'cloudflare:sockets'; export default async () => { const socket = connect('example.com:443'); await socket.opened; return 'open'; };",
    ],
  ])("can't reach the network through %s", async (_, code) => {
    const result = await runStep(code);

    expect(result?.isError).toBeTruthy();
    expect(result?.text).toContain(
      "This worker is not permitted to access the internet"
    );
  });

  it("gets only its APIs in env, and can't import core's env or entrypoints", async () => {
    const result = await runStep(
      "import { env as imported, exports } from 'cloudflare:workers'; export default async (self, env) => ({ given: Object.keys(env), imported: Object.keys(imported ?? {}), exports: Object.keys(exports ?? {}) });"
    );

    // No `env.brain`: its agent doesn't hold the brain permission.
    expect(result).toStrictEqual({
      isError: false,
      text: `Returned:\n${JSON.stringify({ given: ["chat", "knowledge", "connections", "apps", "build", "workflows", "workflowBuild", "memory", "dashboard"], imported: [], exports: [] })}`,
    });
  });

  it("names the API it doesn't have, and the ones it does", async () => {
    const result = await runStep(
      "export default async (self, env) => await env.mailbox.send('hi');"
    );

    expect(result?.isError).toBeTruthy();
    expect(result?.text).toContain(
      "This chat has no API named env.mailbox. It has: env.chat, env.knowledge, env.connections, env.apps, env.build, env.workflows, env.workflowBuild, env.memory, env.dashboard."
    );
  });

  it("ends code that waits on what can never settle as past its wall-clock time", async () => {
    const result = await runEnded(
      "export default async () => { await new Promise(() => {}); return 'never'; };"
    );

    expect(result).toStrictEqual({
      isError: true,
      text: "Error (wall_expired):\nThe run waits for something that can never come, so it was stopped.",
      status: "wall_expired",
    });
  });

  it("ends code still waiting at its wall-clock limit", async () => {
    const { stub, chat, ask } = await newChat(
      codeStep(
        "export default async () => { await scheduler.wait(60_000); return 'late'; };"
      ),
      says("Done.")
    );
    // Objects share their env: set back however the test ends.
    await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "1000" });
    const started = Date.now();
    try {
      await ask("Wait.");
    } finally {
      await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "" });
    }

    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: true,
        text: "Error (wall_expired):\nThe run took longer than 1 seconds, so it was stopped.",
      },
    ]);
    await expect(codeStatuses(stub, chat.id)).resolves.toStrictEqual([
      "wall_expired",
    ]);
    // At its limit, long before its wait would end.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("runs a complete module: helpers, null self, its own ctx and parallel calls", async () => {
    const result = await runEnded(
      "const keys = (value) => Object.keys(value ?? {}); export default async (self, env, ctx) => { const [first, second] = await Promise.all([env.chat.info(), env.chat.info()]); return { self, ctx: keys(ctx), same: first.chatId === second.chatId }; };"
    );

    expect(result).toStrictEqual({
      isError: false,
      text: `Returned:\n${JSON.stringify({ self: null, ctx: ["waitUntil"], same: true })}`,
      status: "completed",
    });
  });

  it("refuses a module over the source limit before it loads", async () => {
    // A module that would log as it loads: refused, it never does.
    const code = `console.log("loaded"); export default async () => 1; // ${"x".repeat(codeLimits.sourceChars)}`;
    const result = await runEnded(code);

    expect(result).toStrictEqual({
      isError: true,
      text: `Error (refused):\nThe module is ${code.length} characters long; a run takes at most ${codeLimits.sourceChars}.`,
      status: "refused",
    });
  });

  it("runs a module of exactly the source limit, and refuses one character more", async () => {
    const lead = "export default async () => 'ran'; // ";
    const exact = `${lead}${"x".repeat(codeLimits.sourceChars - lead.length)}`;
    const { stub, chat, ask } = await newChat(
      codeStep(exact),
      codeStep(`${exact}x`),
      says("Done.")
    );

    await ask("Run both.");

    expect(exact).toHaveLength(codeLimits.sourceChars);
    await expect(codeStatuses(stub, chat.id)).resolves.toStrictEqual([
      "completed",
      "refused",
    ]);
  });

  it.each([
    [
      "a thrown Proxy whose traps throw the runtime's message",
      "const forged = () => { throw new Error('Worker exceeded CPU time limit.'); }; export default async () => { throw new Proxy({}, { get: forged, getPrototypeOf: forged, has: forged, ownKeys: forged }); };",
      "threw",
    ],
    [
      "an error that says the runtime's message",
      "export default async () => { throw new Error('Worker exceeded CPU time limit.'); };",
      "threw",
    ],
    [
      "the harness's built-ins replaced as the module loads",
      "const forged = () => { throw new Error('Worker exceeded CPU time limit.'); }; Object.keys = forged; Array.prototype.map = forged; Array.prototype.join = forged; String.prototype.slice = forged; JSON.stringify = forged; Reflect.get = forged; Reflect.has = forged; globalThis.String = forged; export default async (self, env) => { await env.nothing; };",
      "threw",
    ],
    [
      "the harness's methods replaced through an import of it",
      "import Harness from 'harness.js'; const forged = async () => { throw new Error('Worker exceeded CPU time limit.'); }; try { Harness.prototype.run = forged; } catch {} try { Object.defineProperty(Harness.prototype, 'run', { value: forged }); } catch {} export default async () => 'mine';",
      "completed",
    ],
    [
      "a setter on Array.prototype[0] set up as the module loads, throwing the CPU message",
      `${arrayTrap(cpuMessage)} console.log('x'); export default async () => { console.log('y'); return 'mine'; };`,
      "completed",
    ],
    [
      "a setter on Array.prototype[0] set up as the module loads, throwing the hang message",
      `${arrayTrap(hangMessage)} console.log('x'); export default async () => { console.log('y'); return 'mine'; };`,
      "completed",
    ],
    [
      "a setter on Array.prototype[0] set up in the function, throwing the CPU message",
      `export default async () => { ${arrayTrap(cpuMessage)} console.log('x'); throw new Error('then this'); };`,
      "threw",
    ],
    [
      "a setter on Array.prototype[0] set up in the function, throwing the hang message",
      `export default async () => { ${arrayTrap(hangMessage)} console.log('x'); return 'mine'; };`,
      "completed",
    ],
    [
      "a Proxy thrown as the module loads",
      "const forged = () => { throw new Error('Worker exceeded CPU time limit.'); }; throw new Proxy({}, { get: forged, getPrototypeOf: forged }); export default async () => 1;",
      "load_failed",
    ],
    [
      "the runtime's hang message thrown as the module loads",
      'throw new Error("The Workers runtime canceled this request because it detected that your Worker\'s code had hung and would never generate a response."); export default async () => 1;',
      "load_failed",
    ],
  ])("can't forge how its run ended, with %s", async (_, code, status) => {
    const result = await runEnded(code);

    expect(result.status).toBe(status);
  });

  it("lets no ctx.waitUntil work act through env after its run returned", async () => {
    const { stub, chat, ask } = await newChat(
      codeStep(
        "export default async (self, env, ctx) => { ctx.waitUntil((async () => { await scheduler.wait(500); await env.chat.files(); })()); return 'returned'; };"
      ),
      says("Done.")
    );

    await ask("Return early.");
    // Past when the work would call: refused at the lease, or never let
    // reach core at all, and never answered.
    await scheduler.wait(2000);

    await expect(codeStatuses(stub, chat.id)).resolves.toStrictEqual([
      "completed",
    ]);
    const events = await allEvents();
    expect(
      events
        .filter(
          ({ action, detail }) =>
            action === "agent.call" &&
            detail.chat === chat.id &&
            detail.method === "chat.files"
        )
        .map(({ detail }) => detail.outcome)
        .filter((outcome) => outcome !== "refused")
    ).toStrictEqual([]);
  });

  it.each([
    [
      "no default export",
      "export const run = async () => 1;",
      /default export must be an async function/u,
    ],
    [
      "a default export that isn't a function",
      "export default 42;",
      /default export must be an async function/u,
    ],
    [
      "a module that throws as it loads",
      "console.log('before'); throw new Error('broken module'); export default async () => 1;",
      /^Logs:\nbefore\n\nError \(load_failed\):\nError: broken module/u,
    ],
    [
      "a syntax error",
      "export default async () => {",
      /^Error \(load_failed\):\n.*Syntax/isu,
    ],
  ])(
    "reports %s as a module that didn't load, without running it",
    async (_, code, text) => {
      const result = await runEnded(code);

      expect(result.status).toBe("load_failed");
      expect(result.isError).toBeTruthy();
      expect(result.text).toMatch(text);
    }
  );

  it("reports what the function throws as thrown, after what the module logged as it loaded", async () => {
    const result = await runEnded(
      "console.log('loaded'); export default async () => { throw new Error('nope'); };"
    );

    expect(result.status).toBe("threw");
    expect(result.text).toMatch(
      /^Logs:\nloaded\n\nError \(threw\):\nError: nope/u
    );
  });

  it("refuses input with fields besides code, without running it or repeating it back", async () => {
    const { stub, chat, ask } = await newChat(
      {
        text: "",
        toolCalls: [
          {
            id: `call_${crypto.randomUUID()}`,
            name: "executeCode",
            arguments: {
              code: "export default async () => 'ran';",
              timeoutMs: 1,
            },
          },
        ],
        inputTokens: 200,
        outputTokens: 40,
      },
      says("Done.")
    );

    await ask("Run it.");

    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: true,
        text: "executeCode takes one field, `code`: the module as a string. Nothing else is accepted.",
      },
    ]);
  });

  it("keeps what the code logs and returns to what the model can read", async () => {
    const result = await runStep(
      "export default async () => { for (let i = 0; i < 100_000; i++) console.log('x'.repeat(100)); return 'y'.repeat(1_000_000); };"
    );

    expect(result?.isError).toBeFalsy();
    expect(utf8Bytes(result?.text ?? "")).toBeLessThanOrEqual(
      codeLimits.outputBytes
    );
    expect(result?.text.endsWith(cutMarker)).toBeTruthy();
  });

  it("keeps a run whose output is all characters JSON must escape, within its limits", async () => {
    // Each \u0001 is six characters as JSON: the most a character grows.
    const result = await runEnded(
      "export default async () => { console.log('\\x01'.repeat(65_535)); return '\\x01'.repeat(65_536); };"
    );

    expect(result.status).toBe("completed");
    expect(
      (result.text ?? "").startsWith(`Logs:\n${"\u0001".repeat(100)}`)
    ).toBeTruthy();
  });

  it("shows a value too large to read as such, without building it all", async () => {
    const result = await runStep(
      "export default async () => Array.from({ length: 1_000_000 }, (_, i) => ({ i }));"
    );

    expect(result).toStrictEqual({
      isError: false,
      text: "Returned:\n(a value too large to show, over 65536 characters)",
    });
  });

  it("gets APIs that stop answering once its run was cancelled", async () => {
    const warned = vi.spyOn(console, "warn");
    // Long enough that the cancel always comes first, however slow the
    // runner: the cancel ends the run, not the wait.
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { await scheduler.wait(5_000); await env.chat.info(); await env.chat.info(); };"
      )
    );

    const reply = ask("Wait, then look.");
    await vi.waitFor(
      async () => {
        await expect(transcript(stub, chat.id)).resolves.toHaveLength(2);
      },
      { timeout: 10_000 }
    );
    await stub.cancel(chat.id, personId);
    await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });

    // The code goes on after its run was cancelled; its API refuses it,
    // and the call after its end is logged once, not for every call.
    await vi.waitFor(
      () => {
        expect(warned).toHaveBeenCalledWith(
          expect.objectContaining({ event: "agent.run_ended", chatId: chat.id })
        );
      },
      { timeout: 15_000, interval: 100 }
    );
    await expect(
      runInDurableObject(stub, (instance) =>
        instance.callFromCodeRun(chat.id, "not-a-run")
      )
    ).resolves.toStrictEqual({ call: "ended", first: false });
    const { runId } = runEndedSchema.parse(
      warned.mock.calls
        .map(([entry]: unknown[]) => entry)
        .find((entry) => runEndedSchema.safeParse(entry).success)
    );
    // More calls from the same ended run: still refused, not logged again.
    await expect(
      Promise.all(
        [1, 2].map(
          async () =>
            await runInDurableObject(stub, (instance) =>
              instance.callFromCodeRun(chat.id, runId)
            )
        )
      )
    ).resolves.toStrictEqual([
      { call: "ended", first: false },
      { call: "ended", first: false },
    ]);
    expect(
      warned.mock.calls.filter(([entry]) =>
        JSON.stringify(entry).includes(chat.id)
      )
    ).toHaveLength(1);
    warned.mockRestore();
    // And audited once, as a refused call of the chat's: the code's second
    // call after the end, and the two above, add nothing.
    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.run_ended")
        ).resolves.toStrictEqual([
          {
            method: "chat.info",
            outcome: "refused",
            reason: "agent.run_ended",
          },
        ]);
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("stops a run's API calls at the most one run may make, and audits that once", async () => {
    const { stub, chat, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { let answered = 0; let refused = 0; let message; for (let i = 0; i < 150; i++) { try { await env.chat.info(); answered += 1; } catch (error) { refused += 1; message = String(error.message); } } return { answered, refused, message }; };"
      ),
      says("Done.")
    );

    await ask("Run it.");

    const [result] = await codeResults(stub, chat.id);
    expect(result?.isError).toBeFalsy();
    expect(
      JSON.parse(result?.text.replace("Returned:\n", "") ?? "")
    ).toStrictEqual({
      answered: codeLimits.subRequests,
      refused: 150 - codeLimits.subRequests,
      message: agentErrors.create("agent.run_calls_spent").message,
    });
    // Fifty refusals, one audit event.
    await expect(
      refusalsIn(chat.id, "agent.run_calls_spent")
    ).resolves.toStrictEqual([
      {
        method: "chat.info",
        outcome: "refused",
        reason: "agent.run_calls_spent",
      },
    ]);
  });

  it("has no Cache API to hand data to another chat", async () => {
    await expect(
      runStep("export default async () => typeof caches;")
    ).resolves.toStrictEqual({ isError: false, text: "Returned:\nundefined" });
  });

  it.each([
    [
      "patched string and array methods",
      "String.prototype.slice = function () { return String(this); }; Array.prototype.push = function (...items) { for (const item of items) this[this.length] = item; return this.length; }; export default async () => { for (let i = 0; i < 5000; i++) console.log('x'.repeat(1000)); return 'y'.repeat(5_000_000); };",
      /^Logs:\nx+/u,
    ],
    [
      "a value that makes itself huge text",
      "export default async () => { const value = () => {}; value.toString = () => 'z'.repeat(30_000_000); return value; };",
      /^Returned:\nz{60000,}\n… \(cut: over 65536 bytes of output\)$/u,
    ],
    [
      "a forged result through Object.prototype.then",
      "Object.prototype.then = function (resolve) { delete Object.prototype.then; resolve({ ok: true, logs: Array.from({ length: 1000 }, () => 'q'.repeat(31_000)), result: 'forged' }); }; export default async () => 'mine';",
      /^Returned:\nmine$/u,
    ],
  ])(
    "can't store more than the model reads, even with %s",
    async (_, code, read) => {
      const { stub, chat, ask } = await newChat(codeStep(code), says("Done."));

      await ask("Flood it.");

      // What the model read is the run's own output, cut to what it reads.
      const [result] = await codeResults(stub, chat.id);
      expect(result?.text).toMatch(read);
      const [row] = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ longest: number }>(
            "SELECT max(length(message)) AS longest FROM chat_messages WHERE chat_id = ?",
            chat.id
          )
          .toArray()
      );
      expect(row?.longest).toBeLessThan(codeLimits.outputBytes + 2000);
    }
  );
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

  it("goes on from a turn a restart of both objects cut short once a note is the first call to reach its ChatSession", async () => {
    const answer = pausedReply(says("42."), 1);
    const { id, stub, chat, personId, ask } = await newChat(
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
  });
});

/**
 * A revoked permission of `agentId`, stored as a revocation leaves one:
 * granted before, or (`granted: false`) a request declined before anyone
 * granted it; held everywhere, or in one chat.
 */
const revokedRow = async (
  agentId: string,
  { granted, chatId }: { granted: boolean; chatId: string | null }
) => {
  await env.DB.prepare(
    `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
      actions, binding, status, requested_by, requested_at, granted_by, granted_at,
      revoked_by, revoked_at, chat_id)
     VALUES (?, 'agent', ?, 'collection', ?, '["read"]', ?, 'revoked', 'test', 0, ?, ?, 'test', ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      agentId,
      crypto.randomUUID(),
      `R${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`.toUpperCase(),
      granted ? "test" : null,
      granted ? 0 : null,
      Date.now(),
      chatId
    )
    .run();
};

/** Points the object's database at `db` (objects may share their env). */
const setObjectDb = async (stub: WorkspaceStub, db: D1Database) => {
  await runInDurableObject(stub, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv === "object" && objectEnv !== null) {
      Reflect.set(objectEnv, "DB", db);
    }
  });
};

/**
 * Runs `during` with every read of revocations the object makes (the
 * permissions query `revokedSince` sends) first going through `before`:
 * a wait, or a throw. The rest of its database is untouched. Set back
 * however it ends.
 */
const withRevocationReads = async (
  stub: WorkspaceStub,
  before: () => Promise<void>,
  during: () => Promise<void>
): Promise<void> => {
  const real = env.DB;
  const slowed = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        if (property === "bind") {
          return (...args: unknown[]) => slowed(target.bind(...args));
        }
        return async (...args: unknown[]): Promise<unknown> => {
          await before();
          return await Reflect.apply(value, target, args);
        };
      },
    });
  const db = new Proxy(real, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          // Only `revokedSince`'s read: revocations since a run opened.
          return query.includes('"permissions"."revoked_at" >=')
            ? slowed(statement)
            : statement;
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  await setObjectDb(stub, db);
  try {
    await during();
  } finally {
    await setObjectDb(stub, real);
  }
};

/** `statement`, answering two seconds late, as its bound copies do. */
const lateStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
  new Proxy(statement, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      if (property === "bind") {
        return (...args: unknown[]) => lateStatement(target.bind(...args));
      }
      return async (...args: unknown[]): Promise<unknown> => {
        await scheduler.wait(2000);
        return await Reflect.apply(value, target, args);
      };
    },
  });

/** The chat's code run records, oldest first, as the object keeps them. */
const runRecords = async (stub: WorkspaceStub, chatId: string) =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<Record<string, string | number | null>>(
        "SELECT id, tool_call_id, source_hash, source_chars, agent, compatibility_date, runtime, cpu_limit, status FROM chat_code_runs WHERE chat_id = ? ORDER BY started_at",
        chatId
      )
      .toArray()
  );

/** The call ID of each code step the chat's agent asked for. */
const toolCallIds = async (stub: WorkspaceStub, chatId: string) => {
  const messages = await transcript(stub, chatId);
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((block) =>
          block.type === "toolCall" ? [block.id] : []
        )
      : []
  );
};

/** Whether `call` threw `code`, the way the object's RPC hands it on. */
const refusedWith = async (call: () => unknown) => {
  try {
    await call();
  } catch (error) {
    return agentErrors.codeOf(error) ?? "failed";
  }
  return "admitted";
};

describe("chat agent code run leases", () => {
  it("keeps a record of every run: its call, its module's hash, the agent and runtime it ran on, and how it ended", async () => {
    const code = "export default async () => 6 * 7;";
    const { stub, chat, ask } = await newChat(codeStep(code), says("42."));

    await ask("What is 6 * 7?");

    const [record] = await runRecords(stub, chat.id);
    const [toolCallId] = await toolCallIds(stub, chat.id);
    expect({ ...record, id: typeof record?.id }).toStrictEqual({
      id: "string",
      tool_call_id: toolCallId,
      source_hash: await sourceHash(code),
      source_chars: code.length,
      agent: `@earendil-works/pi-agent-core@${piAgentCore.version}`,
      compatibility_date: "2026-09-15",
      // Plain workerd doesn't enforce the isolate's CPU limit, and the
      // record says so rather than claim it.
      runtime: "workerd",
      cpu_limit: "cpu_limit_unsupported",
      status: "completed",
    });
  });

  it("refuses every write of a run whose lease closed, in the write's own transaction", async () => {
    const { stub, chat } = await newChat();
    const chatId = chatIdSchema.parse(chat.id);
    const write = (runId: string, revision: number) => async () =>
      await stub.saveDraft(
        chatId,
        "app-1",
        null,
        { "a.md": "a" },
        [],
        revision,
        runId
      );

    // Open: written. Ended (completed, cancelled, timed out): refused.
    const ended = await stub.openCodeRun(chatId, testRunOpening);
    const first = await refusedWith(write(ended, 0));
    await stub.closeCodeRun(chatId, ended, "wall_expired");
    // Revoked while open: refused as revoked, however it then ends.
    const revoked = await stub.openCodeRun(chatId, testRunOpening);
    await stub.revokeCodeRun(chatId, revoked);

    expect({
      first,
      afterEnd: await refusedWith(write(ended, 1)),
      discardAfterEnd: await refusedWith(
        async () => await stub.dropDraft(chatId, "app-1", { runId: ended })
      ),
      afterRevoke: await refusedWith(write(revoked, 1)),
      createAfterRevoke: await refusedWith(
        async () => await stub.takeCreate(chatId, 3, revoked)
      ),
      unknownRun: await refusedWith(write(crypto.randomUUID(), 1)),
      ending: await stub.closeCodeRun(chatId, revoked, "completed"),
      draft: await stub.draft(chatId, "app-1"),
    }).toStrictEqual({
      first: "admitted",
      afterEnd: "agent.run_ended",
      discardAfterEnd: "agent.run_ended",
      afterRevoke: "agent.run_revoked",
      createAfterRevoke: "agent.run_revoked",
      unknownRun: "agent.run_ended",
      ending: "revoked",
      draft: { base: null, changes: { "a.md": "a" }, revision: 1 },
    });
    await expect(
      runRecords(stub, chat.id).then((records) =>
        records.map(({ status }) => status)
      )
    ).resolves.toStrictEqual(["wall_expired", "revoked"]);
  });

  it("closes a run's lease when a permission of its agent is revoked while it runs, and admits nothing after", async () => {
    const admin = await signedInApi(idp, "admin");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Handbook ${crypto.randomUUID()}`,
      access: "everyone",
    });
    // Long enough that the revoke always comes first, however slow the
    // runner: the revoke closes the run, not the wait.
    const { stub, chat, agent, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { await env.chat.info(); await scheduler.wait(5_000); try { await env.chat.info(); return 'answered'; } catch (error) { return String(error.message); } };"
      ),
      says("Done.")
    );
    const permission = await requestGranted(
      idp,
      admin,
      readCollection(agent, collectionId, "HANDBOOK")
    );

    const reply = ask("Look twice.");
    await vi.waitFor(
      async () => {
        await expect(
          runRecords(stub, chat.id).then((records) => records.length)
        ).resolves.toBe(1);
      },
      { timeout: 10_000 }
    );
    await admin.api.permissions.revoke(permission);
    await reply;

    // What the code returned rests on what was revoked: not handed on.
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: true,
        text: `Error (revoked):\n${agentErrors.create("agent.run_revoked").message}`,
      },
    ]);
    await expect(
      runRecords(stub, chat.id).then((records) =>
        records.map(({ status }) => status)
      )
    ).resolves.toStrictEqual(["revoked"]);
    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.run_revoked")
        ).resolves.toStrictEqual([
          {
            method: "chat.info",
            outcome: "refused",
            reason: "agent.run_revoked",
          },
        ]);
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("notices a revocation the code never called after: it ends revoked, and hands on neither its result nor its logs", async () => {
    const admin = await signedInApi(idp, "admin");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Handbook ${crypto.randomUUID()}`,
      access: "everyone",
    });
    const { stub, chat, agent, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { const files = await env.chat.files(); await scheduler.wait(3_000); console.log('leaked', files.length); return 'read before the revoke'; };"
      ),
      says("Done.")
    );
    const permission = await requestGranted(
      idp,
      admin,
      readCollection(agent, collectionId, "HANDBOOK")
    );

    const reply = ask("Look once.");
    // Revoked once the code's one call was answered, so it calls nothing
    // after: the run notices the revocation as it ends, not at a call.
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        expect(
          events.some(
            ({ action, detail }) =>
              action === "agent.call" &&
              detail.chat === chat.id &&
              detail.method === "chat.files" &&
              detail.outcome === "ok"
          )
        ).toBeTruthy();
      },
      { timeout: 10_000, interval: 50 }
    );
    await admin.api.permissions.revoke(permission);
    await reply;

    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: true,
        text: `Error (revoked):\n${agentErrors.create("agent.run_revoked").message}`,
      },
    ]);
    await expect(
      runRecords(stub, chat.id).then((records) =>
        records.map(({ status }) => status)
      )
    ).resolves.toStrictEqual(["revoked"]);
    // Noticed at the line it logged, which comes before its end and is
    // checked before the run closes: once, there.
    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.run_revoked")
        ).resolves.toStrictEqual([
          {
            method: "output",
            outcome: "refused",
            reason: "agent.run_revoked",
          },
        ]);
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("leaves a run alone when what was revoked never gave it authority: a request never granted, or another chat's permission", async () => {
    const { stub, chat, agent, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { await env.chat.info(); await scheduler.wait(1_500); return (await env.chat.info()).chatId; };"
      ),
      says("Done.")
    );

    const reply = ask("Look twice.");
    await vi.waitFor(
      async () => {
        await expect(
          runRecords(stub, chat.id).then((records) => records.length)
        ).resolves.toBe(1);
      },
      { timeout: 10_000 }
    );
    // As a person declining the chat's request stores it, and as a
    // revocation in another of the agent's chats does.
    await revokedRow(agent.agentId, { granted: false, chatId: chat.id });
    await revokedRow(agent.agentId, {
      granted: true,
      chatId: crypto.randomUUID(),
    });
    await reply;

    await expect(codeStatuses(stub, chat.id)).resolves.toStrictEqual([
      "completed",
    ]);
    await expect(
      refusalsIn(chat.id, "agent.run_revoked")
    ).resolves.toStrictEqual([]);
  });

  it("takes a CPU limit as enforced only where the deployment says it runs on Cloudflare", () => {
    expect(
      [undefined, "workerd", "Cloudflare", "cloudflare"].map(
        (profile) =>
          codeRuntime(profile === undefined ? {} : { RUNTIME_PROFILE: profile })
            .cpuLimit
      )
    ).toStrictEqual([
      "cpu_limit_unsupported",
      "cpu_limit_unsupported",
      "cpu_limit_unsupported",
      "enforced",
    ]);
  });

  it("closes a run's lease as it ends whatever the revocation read does, and withholds its result when the read fails", async () => {
    const { stub, chat, ask } = await newChat(
      codeStep(
        "export default async () => { console.log('read'); return 'secret'; };"
      ),
      says("Done.")
    );

    await withRevocationReads(
      stub,
      async () => {
        await Promise.resolve();
        throw new Error("D1 is down for a moment");
      },
      async () => {
        await ask("Return it.");
      }
    );

    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: true,
        text: `Error (revoked):\n${agentErrors.create("agent.run_revoked").message}`,
      },
    ]);
    const [record] = await runRecords(stub, chat.id);
    expect(record?.status).toBe("revoked");
    const { call } = await runInDurableObject(stub, (instance) =>
      instance.admitFromCodeRun(chatIdSchema.parse(chat.id), String(record?.id))
    );
    // Closed, as ended or, once the chat's guard withheld it first, as
    // revoked: nothing more of it is admitted either way.
    expect(["ended", "revoked"]).toContain(call);
  });

  it("admits nothing a run does while its end reads revocations", async () => {
    // The run ends at its wall clock while its code still waits; the code
    // calls during the slow read of revocations that follows.
    const { stub, chat, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { await scheduler.wait(1_300); await env.chat.files(); };"
      ),
      says("Done.")
    );
    await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "1000" });
    try {
      await withRevocationReads(
        stub,
        async () => {
          await scheduler.wait(2000);
        },
        async () => {
          await ask("Wait, then look.");
        }
      );
    } finally {
      await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "" });
    }

    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.run_ended")
        ).resolves.toStrictEqual([
          {
            method: "chat.files",
            outcome: "refused",
            reason: "agent.run_ended",
          },
        ]);
      },
      { timeout: 10_000, interval: 100 }
    );
    await expect(codeStatuses(stub, chat.id)).resolves.toStrictEqual([
      "wall_expired",
    ]);
  });

  it("saves no USER.md for a run that ran out of time while the save was prepared", async () => {
    const { stub, chat, agent, ask } = await newChat(
      codeStep(
        "export default async (self, env) => await env.memory.saveUser({ text: 'Prefers short answers.', ifVersion: 0 });"
      ),
      says("It ran out of time.")
    );
    // Knowledge answers two seconds late; the run has a second. The save
    // is let in as it starts, then prepared past the run's end.
    const { KNOWLEDGE: knowledge } = env;
    const slow = new Proxy(knowledge, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "prepare") {
          return (query: string) => lateStatement(target.prepare(query));
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "1000" });
    env.KNOWLEDGE = slow;
    try {
      await ask("Remember it.");
    } finally {
      env.KNOWLEDGE = knowledge;
      await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "" });
    }

    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.run_ended")
        ).resolves.toStrictEqual([
          {
            method: "memory.saveUser",
            outcome: "refused",
            reason: "agent.run_ended",
          },
        ]);
      },
      { timeout: 30_000, interval: 200 }
    );
    const events = await allEvents();
    expect(
      events.filter(
        ({ action, actor }) =>
          action === "knowledge.document.saved" &&
          actor.type === "agent" &&
          actor.agentId === agent.agentId
      )
    ).toStrictEqual([]);
  });

  it("ends a run's lease a Workspace restart cuts short: its record says interrupted, its later calls are refused, and the turn goes on in its ChatSession", async () => {
    const { id, stub, chat, provider, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { await env.chat.info(); await scheduler.wait(5_000); return (await env.chat.info()).chatId; };"
      ),
      says("Done.")
    );

    const reply = ask("Look twice.").catch(() => "cut short");
    await vi.waitFor(
      async () => {
        await expect(
          runRecords(stub, chat.id).then((records) => records.length)
        ).resolves.toBe(1);
      },
      { timeout: 10_000 }
    );
    // The object dies, as a restart ends it: everything in flight fails.
    await runInDurableObject(stub, (_instance, state) => {
      state.abort("restart");
    }).catch(() => "aborted");
    await expect(reply).resolves.toBe("cut short");
    // The object as it wakes again.
    const woken = workspace(env, id);

    const [record] = await runRecords(woken, chat.id);
    expect(record?.status).toBe("interrupted");
    // Its lease went with the object: its stubs answer as ended.
    await expect(
      runInDurableObject(woken, (instance) =>
        instance.callFromCodeRun(
          chatIdSchema.parse(chat.id),
          String(record?.id)
        )
      )
    ).resolves.toMatchObject({ call: "ended" });
    // The turn goes on in the chat's ChatSession at once, not at its
    // heartbeat alarm a minute on: the run's call fails with the object it
    // went to, its step fails, and the model answers. Not run again.
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(2);
      },
      { timeout: 15_000 }
    );
    const [calls, results, runs] = await Promise.all([
      toolCallIds(woken, chat.id),
      codeResults(woken, chat.id),
      runRecords(woken, chat.id),
    ]);
    expect({
      calls: calls.length,
      failed: results.map(({ isError }) => isError),
      runs: runs.length,
    }).toStrictEqual({ calls: 1, failed: [true], runs: 1 });
  });
});

/**
 * Follows a chat's running step output as the page does: every update's
 * output so far, whether it carried a step's result, and the latest.
 */
const watchOutput = async (
  stub: WorkspaceStub,
  chatId: string,
  personId: string
) => {
  let output: ChatOutput | null = null;
  const seen: { output: ChatOutput | null; result: boolean }[] = [];
  await stub.watch(chatId, personId, null, async (update: ChatUpdate) => {
    output = applyOutput(output, update.output);
    seen.push({
      output,
      result: update.messages.some(({ role }) => role === "result"),
    });
    await Promise.resolve();
  });
  return { seen, latest: () => seen.at(-1)?.output ?? null };
};

/**
 * A chat whose agent an admin granted something, running `code` once,
 * and `revoke`, which revokes it.
 */
const grantedChat = async (code: string) => {
  const admin = await signedInApi(idp, "admin");
  const { collectionId } = await collectionWithNote(admin.api, {
    name: `Handbook ${crypto.randomUUID()}`,
    access: "everyone",
  });
  const chat = await newChat(codeStep(code), says("Done."));
  const permission = await requestGranted(
    idp,
    admin,
    readCollection(chat.agent, collectionId, "HANDBOOK")
  );
  return {
    ...chat,
    revoke: async () => {
      await admin.api.permissions.revoke(permission);
    },
  };
};

describe("chat agent code output", () => {
  it("streams what the code logs to the chat before its step ends, redacted, and drops it once the step's result is stored", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async () => { console.log('first'); console.log('key Bearer abcdefghijklmnopqrstuvwxyz0123'); await scheduler.wait(1_500); console.log('after the wait'); return 'done'; };"
      ),
      says("Done.")
    );
    // Put together as the page does, noting what showed before the result.
    let output: ChatOutput | null = null;
    const seen: { output: ChatOutput | null; result: boolean }[] = [];
    await stub.watch(chat.id, personId, null, async (update: ChatUpdate) => {
      output = applyOutput(output, update.output);
      seen.push({
        output,
        result: update.messages.some(({ role }) => role === "result"),
      });
      await Promise.resolve();
    });

    await ask("Log it.");

    const [callId] = await toolCallIds(stub, chat.id);
    await vi.waitFor(() => {
      expect(seen.at(-1)?.output).toBeNull();
    });
    const firstResult = seen.findIndex(({ result }) => result);
    const before = seen.slice(0, firstResult).map((step) => step.output);
    expect(before).toContainEqual({
      callId,
      text: "first\nkey [redacted]",
    });
    // What the model reads is redacted the same way.
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: false,
        text: "Logs:\nfirst\nkey [redacted]\nafter the wait\n\nReturned:\ndone",
      },
    ]);

    // A line that comes after the run closed shows nowhere.
    const [record] = await runRecords(stub, chat.id);
    const shown = seen.length;
    await stub.codeRunOutput(
      chatIdSchema.parse(chat.id),
      String(record?.id),
      callId ?? "",
      "late"
    );
    await scheduler.wait(200);
    expect(seen.slice(shown).some((step) => step.output !== null)).toBeFalsy();
  });

  it("streams nothing a run logs after a revocation, even with no call to notice it", async () => {
    const { stub, chat, personId, ask, revoke } = await grantedChat(
      "export default async () => { console.log('before'); await scheduler.wait(2_500); console.log('after the revoke'); await scheduler.wait(2_500); return 'done'; };"
    );
    const { seen, latest } = await watchOutput(stub, chat.id, personId);

    const reply = ask("Log it.");
    await vi.waitFor(
      () => {
        expect(latest()?.text).toBe("before");
      },
      { timeout: 10_000, interval: 50 }
    );
    await revoke();
    await reply;

    expect(
      seen.some(
        ({ output }) => output?.text.includes("after the revoke") === true
      )
    ).toBeFalsy();
    await expect(codeStatuses(stub, chat.id)).resolves.toStrictEqual([
      "revoked",
    ]);
    expect(seen.at(-1)?.output ?? null).toBeNull();
  });

  it("drops what a run showed once a call of its finds a revocation", async () => {
    const { stub, chat, personId, ask, revoke } = await grantedChat(
      "export default async (self, env) => { console.log('shown'); await scheduler.wait(2_500); try { await env.chat.info(); } catch {} await scheduler.wait(1_000); return 'done'; };"
    );
    const { seen, latest } = await watchOutput(stub, chat.id, personId);

    const reply = ask("Log, then look.");
    await vi.waitFor(
      () => {
        expect(latest()?.text).toBe("shown");
      },
      { timeout: 10_000, interval: 50 }
    );
    await revoke();
    await reply;

    // Gone before the step's result came: with the refused call, not after.
    const shownAt = seen.findIndex(({ output }) => output?.text === "shown");
    const resultAt = seen.findIndex(({ result }) => result);
    expect(
      seen.slice(shownAt, resultAt).some(({ output }) => output === null)
    ).toBeTruthy();
  });

  it("redacts a private key the code logs line by line, in the chat and for the model", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async () => { for (const line of ['-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj', '-----END PRIVATE KEY-----', 'done']) { console.log(line); await scheduler.wait(1_100); } };"
      ),
      says("Done.")
    );
    const { seen } = await watchOutput(stub, chat.id, personId);

    await ask("Log it.");

    const streamed = seen.flatMap(({ output }) =>
      output === null ? [] : [output.text]
    );
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.some((text) => /MIIE|BKcw/u.test(text))).toBeFalsy();
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      { isError: false, text: "Logs:\n[redacted]\ndone" },
    ]);
  });

  it("shows nothing of a run whose revocation read fails, and records why", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async () => { console.log('read'); await scheduler.wait(1_500); return 'secret'; };"
      ),
      says("Done.")
    );
    const { seen } = await watchOutput(stub, chat.id, personId);

    await withRevocationReads(
      stub,
      async () => {
        await Promise.resolve();
        throw new Error("D1 is down for a moment");
      },
      async () => {
        await ask("Log it.");
      }
    );

    expect(seen.some(({ output }) => output !== null)).toBeFalsy();
    await expect(codeStatuses(stub, chat.id)).resolves.toStrictEqual([
      "revoked",
    ]);
    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.revocation_read_failed")
        ).resolves.toStrictEqual([
          {
            method: "output",
            outcome: "refused",
            reason: "agent.revocation_read_failed",
          },
        ]);
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("names the chat platform a chat came through in the record of a run's output it withheld", async () => {
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
    await fakeProvider(
      codeStep(
        "export default async () => { console.log('read'); await scheduler.wait(1_500); return 'secret'; };"
      ),
      says("Done.")
    );

    await withRevocationReads(
      stub,
      async () => {
        await Promise.resolve();
        throw new Error("D1 is down for a moment");
      },
      async () => {
        await stub.ask(chat.id, { text: "Log it.", model });
      }
    );

    await vi.waitFor(
      async () => {
        const events = await allEvents();
        expect(
          events
            .filter(
              ({ action, detail }) =>
                action === "agent.call" &&
                detail.chat === chat.id &&
                detail.method === "output"
            )
            .map(({ actor }) => actor)
        ).toStrictEqual([
          { type: "agent", agentId: id, onBehalfOf: userId, via: "teams" },
        ]);
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("holds a line until a revocation read begun after it finds none, however slow", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async () => { console.log('held'); await scheduler.wait(1_000); return 'done'; };"
      ),
      says("Done.")
    );
    const { seen } = await watchOutput(stub, chat.id, personId);

    // Every read takes longer than the run: the line is never shown before
    // the step's result, which shows it.
    await withRevocationReads(
      stub,
      async () => {
        await scheduler.wait(3000);
      },
      async () => {
        await ask("Log it.");
      }
    );

    expect(seen.some(({ output }) => output !== null)).toBeFalsy();
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      { isError: false, text: "Logs:\nheld\n\nReturned:\ndone" },
    ]);
  });

  it("redacts whole credential values in what streams and in what is kept", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        `export default async () => { console.log("authorization: Basic dXNlcjpwYXNz"); console.log('password: "correct horse battery staple"'); await scheduler.wait(1_500); return 'done'; };`
      ),
      says("Done.")
    );
    const { seen } = await watchOutput(stub, chat.id, personId);

    await ask("Log it.");

    const streamed = seen.flatMap(({ output }) =>
      output === null ? [] : [output.text]
    );
    expect(streamed).toContain(
      'authorization: [redacted]\npassword: "[redacted]"'
    );
    expect(
      streamed.some((text) => /dXNlcjpwYXNz|horse|battery/u.test(text))
    ).toBeFalsy();
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: false,
        text: 'Logs:\nauthorization: [redacted]\npassword: "[redacted]"\n\nReturned:\ndone',
      },
    ]);
  });

  it("tells a new watch what output there is in its first update, none included", async () => {
    const { stub, chat, personId } = await newChat();
    const first = Promise.withResolvers<ChatUpdate>();
    await stub.watch(chat.id, personId, null, async (update: ChatUpdate) => {
      first.resolve(update);
      await Promise.resolve();
    });

    // Explicitly none, so a page that had output from an earlier watch
    // (before a reconnect) drops it, rather than keep it as unchanged.
    const update = await first.promise;
    expect(Object.hasOwn(update, "output")).toBeTruthy();
    expect(update.output).toBeNull();
  });

  it("takes no more lines of a run than one may log, whatever is sent", async () => {
    const { stub, chat, personId } = await newChat();
    const chatId = chatIdSchema.parse(chat.id);
    const run = await stub.openCodeRun(chatId, testRunOpening);
    const { latest } = await watchOutput(stub, chat.id, personId);

    for (let line = 0; line < codeLimits.logLines + 500; line += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order, as a run sends them
      await stub.codeRunOutput(chatId, run, "call_test", `line ${line}`);
    }

    // Every line it may log, then the marker that more was cut.
    await vi.waitFor(
      () => {
        const text = latest()?.text ?? "";
        expect(text.endsWith(cutMarker)).toBeTruthy();
        expect(text.slice(0, -cutMarker.length).split("\n")).toHaveLength(
          codeLimits.logLines
        );
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it.each([
    ["a character of three bytes", "漢".repeat(65_536)],
    ["a character of four bytes", "😀".repeat(40_000)],
  ])(
    "shows what fits of a line too large for its bytes, %s, never half a character, and says it was cut",
    async (_, line) => {
      const { stub, chat, personId } = await newChat();
      const chatId = chatIdSchema.parse(chat.id);
      const run = await stub.openCodeRun(chatId, testRunOpening);
      const { latest } = await watchOutput(stub, chat.id, personId);

      await stub.codeRunOutput(chatId, run, "call_test", line);
      await stub.codeRunOutput(chatId, run, "call_test", "after the cut");

      await vi.waitFor(
        () => {
          expect(latest()?.text.endsWith(cutMarker)).toBeTruthy();
        },
        { timeout: 10_000, interval: 100 }
      );
      const text = latest()?.text ?? "";
      const shown = text.slice(0, -cutMarker.length);
      expect({
        prefix: line.startsWith(shown),
        some: shown.length > 1000,
        loneSurrogate:
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
            shown
          ),
        within:
          utf8Bytes(text) <=
          codeLimits.outputBytes - codeLimits.diagnosticBytes,
        after: text.includes("after the cut"),
      }).toStrictEqual({
        prefix: true,
        some: true,
        loneSurrogate: false,
        within: true,
        after: false,
      });
    }
  );

  it("shares one output budget between logs and result, and keeps room for how the run ended", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async () => { for (let i = 0; i < 5_000; i++) console.log('é'.repeat(200)); await scheduler.wait(1_500); throw new Error('the end'); };"
      ),
      says("Done.")
    );
    let output: ChatOutput | null = null;
    let longest = 0;
    await stub.watch(chat.id, personId, null, async (update: ChatUpdate) => {
      output = applyOutput(output, update.output);
      longest = Math.max(longest, utf8Bytes(output?.text ?? ""));
      await Promise.resolve();
    });

    await ask("Flood it.");

    const [result] = await codeResults(stub, chat.id);
    const text = result?.text ?? "";
    expect({
      within: utf8Bytes(text) <= codeLimits.outputBytes,
      cut: text.includes(cutMarker),
      ending: /\n\nError \(threw\):\nError: the end/u.test(text),
      streamed:
        longest > 0 &&
        longest <= codeLimits.outputBytes - codeLimits.diagnosticBytes,
    }).toStrictEqual({ within: true, cut: true, ending: true, streamed: true });
  });

  it("redacts a whole credential value: a short Basic one, and a quoted one with spaces", () => {
    expect(
      [
        "authorization: Basic dXNlcjpwYXNz",
        "Authorization: Basic YQ==",
        'password: "correct horse battery staple"',
        "secret='two words' and more",
        '{"password":"a b c","user":"ann"}',
        'token: "never closed',
        '{"access_token":"ya29.abc","client_secret":"shh"}',
        String.raw`"{\"password\":\"hunter2\",\"user\":\"ann\"}"`,
        String.raw`"{\"refresh_token\":\"1//abc def\"}"`,
        String.raw`password=abc\def next`,
      ].map(redact)
    ).toStrictEqual([
      "authorization: [redacted]",
      "Authorization: [redacted]",
      'password: "[redacted]"',
      "secret='[redacted]' and more",
      '{"password":"[redacted]","user":"ann"}',
      'token: "[redacted]',
      '{"access_token":"[redacted]","client_secret":"[redacted]"}',
      String.raw`"{\"password\":\"[redacted]\",\"user\":\"ann\"}"`,
      String.raw`"{\"refresh_token\":\"[redacted]\"}"`,
      "password=[redacted] next",
    ]);
  });

  it("redacts adversarial floods of every credential shape in linear time", () => {
    const units = [
      "eyJ-",
      "eyJ--",
      "eyJ.",
      "bearer ",
      ["sk_", "live_"].join(""),
      "sk-",
      "ghp_",
      ["github", "_pat_"].join(""),
      ["xo", "xb-"].join(""),
      "AIza-",
      "AKIA",
      "token:",
      "access_token:",
      'password: "',
      String.raw`password\":\"`,
      String.raw`password=abc\def`,
      "secret='\\",
      "authorization: Basic ",
      "-----BEGIN PRIVATE KEY-----",
    ];
    const slowest = Math.max(
      ...units.flatMap((unit) =>
        ["", "x", "-", "."].map((tail) => {
          const flood = `${unit}${tail}`.repeat(
            Math.ceil(
              (2 * codeLimits.outputBytes) / (unit.length + tail.length)
            )
          );
          const started = performance.now();
          redact(flood);
          return performance.now() - started;
        })
      )
    );

    // About 128K characters each: a quadratic pattern takes seconds.
    expect(slowest).toBeLessThan(250);
  });

  it("cuts text by UTF-8 bytes, never inside a character, and redacts credentials", () => {
    expect({
      cut: cutToBytes("é".repeat(10), 5),
      short: cutToBytes("abc", 10),
      emoji: cutToBytes("😀😀", 5),
      redacted: redact(
        "Authorization: Bearer abcdefghijklmnop1234 key sk-abcdefghijklmnop1234 jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q aws AKIAABCDEFGHIJKLMNOP plain words"
      ),
      // Put together here, so the repository holds no token-shaped text.
      more: [
        ["sk_", "live_abcdefghij1234"].join(""),
        ["rk_", "test_abcdefghij1234"].join(""),
        ["ghp", "_abcdefghijklmnopqrstuvwxyz0123"].join(""),
        ["github", "_pat_abcdefghijklmnopqrstuv_0123"].join(""),
        ["xo", "xb-1234567890-abcdefghij"].join(""),
        ["AI", "zaSyA1234567890abcdefghijklmnopqrstuv"].join(""),
        "api_key=abc123",
        'password: "hunter2"',
        "token=xyz",
        "the secret is safe",
      ].map(redact),
    }).toStrictEqual({
      cut: "éé",
      short: "abc",
      emoji: "😀",
      redacted:
        "Authorization: [redacted] key [redacted] jwt [redacted] aws [redacted] plain words",
      more: [
        "[redacted]",
        "[redacted]",
        "[redacted]",
        "[redacted]",
        "[redacted]",
        "[redacted]",
        "api_key=[redacted]",
        'password: "[redacted]"',
        "token=[redacted]",
        "the secret is safe",
      ],
    });
  });
});

/** Orders text alphabetically. */
const byText = (a: string, b: string): number => a.localeCompare(b, "en");

describe("chat agent code run retention", () => {
  it("keeps no more closed leases than it may, however many runs end", async () => {
    const { stub, chat } = await newChat();
    const chatId = chatIdSchema.parse(chat.id);
    const runs = endedRunsKept + 50;

    // Leases opened and closed as runs do, past the most it keeps.
    const kept = await runInDurableObject(stub, (instance) => {
      const ids: string[] = [];
      for (let run = 0; run < runs; run += 1) {
        const id = instance.openCodeRun(chatId, testRunOpening);
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
