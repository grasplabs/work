import piAgentCore from "@earendil-works/pi-agent-core/package.json" with { type: "json" };
import { agentErrors } from "@grasp-os/shared/agent";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { applyOutput } from "@grasp-os/shared/chat";
import type { ChatOutput, ChatUpdate } from "@grasp-os/shared/chat";
import type { WorkspaceId } from "@grasp-os/shared/ids";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { memoryMaxLimit } from "@grasp-os/shared/memory";
import { modelErrors } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  maxRunsPerResponse,
  maxRunsPerTurn,
  maxSteps,
  requestChars,
} from "../src/agent.ts";
import {
  codeLimits,
  codeRuntime,
  cutMarker,
  cutToBytes,
  redact,
  sourceHash,
  utf8Bytes,
} from "../src/code-mode.ts";
import { workspace } from "../src/durable-objects.ts";
import {
  chatOf,
  codeResults,
  codeStatuses,
  codeStep,
  gatewayConfig,
  model,
  pausedReply,
  pointAtGateway,
  says,
  setObjectEnv,
  testRunOpening,
  transcript,
} from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";

// A chat's agent, through the Workspace object: the loop, the code it runs
// in isolates of their own, and the model gateway, all real (agent-chat.ts).

const idp = mockIdp();

/**
 * Models of different context windows, as pi's catalog gives them: the
 * tests' own, of 1,000,000 tokens, one of 200,000 and one of 24,000. Each
 * request keeps 16,384 of them for the answer, or a quarter of a window
 * too small for that (6,000 of the 24,000).
 */
const smallModel = "anthropic/claude-haiku-4-5";
const tinyModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const answerTokens = 16_384;
const inputTokens = {
  large: 1_000_000 - answerTokens,
  small: 200_000 - answerTokens,
};

/** A deployment that allows them all. */
const bothModels = {
  ...gatewayConfig,
  models: [model, smallModel, tinyModel],
};

/**
 * Adds `count` turns to the chat as the object keeps them: questions of
 * `chars` characters (30,000 unless given), each answered.
 */
const addTurns = async (
  stub: WorkspaceStub,
  chatId: string,
  count: number,
  chars = 30_000
): Promise<void> => {
  const question = JSON.stringify({
    role: "user",
    content: "q".repeat(chars),
    timestamp: 1,
  });
  const answer = JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "Answered." }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  });
  await runInDurableObject(stub, (_instance, state) => {
    for (let i = 0; i < count; i += 1) {
      for (const message of [question, answer]) {
        state.storage.sql.exec(
          "INSERT INTO chat_messages (chat_id, message, created_at) VALUES (?, ?, ?)",
          chatId,
          message,
          Date.now()
        );
      }
    }
  });
};

/** A new chat for a person no other test uses, answered by `replies`. */
const newChat = async (...replies: GatewayReply[]) => {
  // A member of the organization, whom no other test uses.
  const { userId } = await signedInWithRole(idp, "user");
  return await chatOf(userId, ...replies);
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

/** The one warning a call from an ended run logs. */
const runEndedSchema = z.object({
  event: z.literal("agent.run_ended"),
  runId: z.string(),
});

describe("chat agent", () => {
  it("answers a question with a code step against the chat's API", async () => {
    const { stub, chat, personId, gateway, ask } = await newChat(
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
    });
    // The code ran with the API core gave it, which knows whom it acts for.
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      { isError: false, text: `Returned:\n${personId}` },
    ]);
    // The model saw the API declared, then the step's result.
    const [first, second] = gateway.requests.map(({ body }) =>
      JSON.stringify(body)
    );
    expect(first).toContain(
      "info(): Promise<{ chatId: string; personId: string; now: string }>"
    );
    expect(second).toContain(personId);
    const messages = await transcript(stub, chat.id);
    expect(messages.map(({ role }) => role)).toStrictEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
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

  it("stops at the most steps a turn may take", async () => {
    const { stub, chat, gateway, ask } = await newChat(
      ...Array.from({ length: maxSteps }, () =>
        codeStep("export default async () => 'again';")
      )
    );

    const reply = await ask("Keep going.");

    expect(reply.outcome).toBe("max_steps");
    expect(gateway.requests).toHaveLength(maxSteps);
    // The last step's code isn't run: nobody would read its result.
    const results = await codeResults(stub, chat.id);
    expect(results.at(-1)).toStrictEqual({
      isError: true,
      text: "Not run: this turn has reached its last step. Answer with what you have.",
    });
    expect(results.filter(({ isError }) => !isError)).toHaveLength(
      maxSteps - 1
    );
  });

  it("runs code at most 5 times per response", async () => {
    const { stub, chat, ask } = await newChat(
      codeStep("export default async () => 'ran';", 30),
      says("Done.")
    );

    await ask("Run it all.");

    const results = await codeResults(stub, chat.id);
    expect(results.filter(({ isError }) => !isError)).toHaveLength(
      maxRunsPerResponse
    );
    expect(results.filter(({ isError }) => isError)).toHaveLength(
      30 - maxRunsPerResponse
    );
    expect(results.at(-1)?.text).toMatch(/at most 5 times/u);
  });

  it("runs code at most 30 times per turn", async () => {
    const { stub, chat, ask } = await newChat(
      ...Array.from({ length: 7 }, () =>
        codeStep("export default async () => 'ran';", maxRunsPerResponse)
      ),
      says("Done.")
    );

    await ask("Run it all.");

    const results = await codeResults(stub, chat.id);
    expect(results.filter(({ isError }) => !isError)).toHaveLength(
      maxRunsPerTurn
    );
    expect(results.at(-1)?.text).toMatch(/30 times, the most it may/u);
  });

  it("stops the turn when the person leaves during it", async () => {
    // The model is still answering, with code to run, when they leave.
    const { reply, release } = pausedReply(
      { ...codeStep("export default async () => 'done';"), text: "Running." },
      1
    );
    const { personId, gateway, ask } = await newChat(
      reply,
      says("Never asked.")
    );

    const turn = codeOf(ask("Wait."));
    await vi.waitFor(
      () => {
        expect(gateway.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(personId)
      .run();
    release();

    await expect(turn).resolves.toBe("permission.person_inactive");
    // No request for them after they left.
    expect(gateway.requests).toHaveLength(1);
  });

  it("stops the turn when its person leaves during it", async () => {
    const { reply, release } = pausedReply(
      { ...codeStep("export default async () => 'done';"), text: "Running." },
      1
    );
    const { personId, gateway, ask } = await newChat(
      reply,
      says("Never asked.")
    );

    const turn = codeOf(ask("Wait."));
    await vi.waitFor(
      () => {
        expect(gateway.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(personId)
      .run();
    release();

    await expect(turn).resolves.toBe("permission.person_inactive");
    expect(gateway.requests).toHaveLength(1);
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

    expect(result).toStrictEqual({
      isError: false,
      text: `Returned:\n${JSON.stringify({ given: ["chat", "knowledge", "connections", "apps", "build", "workflows", "memory"], imported: [], exports: [] })}`,
    });
  });

  it("names the API it doesn't have, and the ones it does", async () => {
    const result = await runStep(
      "export default async (self, env) => await env.mailbox.send('hi');"
    );

    expect(result?.isError).toBeTruthy();
    expect(result?.text).toContain(
      "This chat has no API named env.mailbox. It has: env.chat, env.knowledge, env.connections, env.apps, env.build, env.workflows, env.memory."
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
        "export default async (self, env, ctx) => { ctx.waitUntil((async () => { await scheduler.wait(500); await env.chat.attachments(); })()); return 'returned'; };"
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
            detail.method === "chat.attachments"
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
        await expect(transcript(stub, chat.id)).resolves.toHaveLength(3);
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
    const { stub, chat, personId, gateway, ask } = await newChat(
      codeStep(
        "export default async () => { await scheduler.wait(10_000); return 'late'; };"
      )
    );

    const reply = ask("Wait a minute.");
    await vi.waitFor(
      async () => {
        expect(gateway.requests).toHaveLength(1);
        // The step has started once its call is kept.
        await expect(transcript(stub, chat.id)).resolves.toHaveLength(3);
      },
      { timeout: 10_000 }
    );
    await stub.cancel(chat.id, personId);

    await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      { isError: true, text: "Error (cancelled):\nThe run was cancelled." },
    ]);
    // No request after the cancelled step.
    expect(gateway.requests).toHaveLength(1);
  });

  it("can be cancelled while the model answers", async () => {
    const { stub, chat, personId, gateway, ask } = await newChat({
      hang: true,
    });

    const reply = ask("Take your time.");
    await vi.waitFor(
      () => {
        expect(gateway.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    await expect(stub.cancel(chat.id, personId)).resolves.toBeTruthy();

    await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });
    const [event] = await modelCallsBy(personId, 1);
    expect(event?.detail).toMatchObject({ outcome: "cancelled" });
  });

  it("takes one question at a time per chat", async () => {
    const { stub, chat, personId, gateway, ask } = await newChat({
      hang: true,
    });

    const first = ask("First.");
    await vi.waitFor(
      () => {
        expect(gateway.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );

    await expect(codeOf(ask("Second."))).resolves.toBe("agent.busy");
    await stub.cancel(chat.id, personId);
    await expect(first).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("refuses a model the deployment doesn't allow, before anything is kept", async () => {
    const { stub, chat } = await newChat();

    await expect(
      codeOf(stub.ask(chat.id, { text: "Hi.", model: "openai/gpt-5.4" }))
    ).resolves.toBe("model.not_allowed");
    await expect(transcript(stub, chat.id)).resolves.toStrictEqual([]);
  });

  it("keeps a chat in restricted mode to the models the client's data rule allows", async () => {
    const { stub, chat, personId, gateway, ask } = await newChat(says("Hi."));
    const euModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    await pointAtGateway(stub, gateway, {
      config: {
        gateway: gatewayConfig.gateway,
        models: [model, euModel],
        sensitive: { models: [euModel] },
      },
    });
    // The chat has read restricted data: everything it sends is sensitive.
    await stub.restrictChat(chat.id);

    await expect(codeOf(ask("Hi."))).resolves.toBe("model.sensitive_data");
    expect(gateway.requests).toStrictEqual([]);
    await expect(transcript(stub, chat.id)).resolves.toStrictEqual([]);
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        expect(
          events.filter(
            ({ action, actor }) =>
              action === "model.refused" &&
              actor.type === "agent" &&
              actor.onBehalfOf === personId
          )
        ).toMatchObject([
          { detail: { reason: "model.sensitive_data", because: "restricted" } },
        ]);
      },
      { timeout: 10_000, interval: 50 }
    );
  });

  it("stops acting for a person who has left", async () => {
    const { personId, gateway, ask } = await newChat(says("Hi."));
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(personId)
      .run();

    await expect(codeOf(ask("Hi."))).resolves.toBe(
      "permission.person_inactive"
    );
    expect(gateway.requests).toStrictEqual([]);
  });

  it("shortens a long turn's oldest code results to fit the model's window, keeping its latest and every call's result", async () => {
    const { stub, chat, gateway } = await newChat(
      // 30 code runs of a result the model reads cut to 32 KiB each: more
      // than the small model takes.
      ...Array.from({ length: maxRunsPerTurn / maxRunsPerResponse }, () =>
        codeStep(
          "export default async () => 'r'.repeat(40_000);",
          maxRunsPerResponse
        )
      ),
      says("Done.")
    );
    await pointAtGateway(stub, gateway, { config: bothModels });

    await expect(
      stub.ask(chat.id, { text: "Run it all.", model: smallModel })
    ).resolves.toMatchObject({ outcome: "answered" });

    // What the last request sent, in Anthropic's wire format.
    const blockSchema = z.looseObject({
      type: z.string(),
      id: z.string().optional(),
      tool_use_id: z.string().optional(),
    });
    const bodySchema = z.looseObject({
      messages: z.array(
        z.looseObject({
          content: z.union([z.string(), z.array(blockSchema)]),
        })
      ),
    });
    const last = gateway.requests.at(-1)?.body;
    const blocks = bodySchema
      .parse(last)
      .messages.flatMap(({ content }) =>
        typeof content === "string" ? [] : content
      );
    const calls = blocks.flatMap(({ type, id }) =>
      type === "tool_use" ? [id] : []
    );
    const results = blocks.filter(({ type }) => type === "tool_result");
    const stored = await codeResults(stub, chat.id);
    const shortened = results.filter((result) =>
      JSON.stringify(result).includes("(output left out to fit;")
    );
    const latest = results.at(-1);
    expect({
      calls: calls.length,
      withinWindow:
        JSON.stringify(last).length < requestChars(inputTokens.small),
      // Every call still has its result, in the same order.
      pairs: results.map(({ tool_use_id: id }) => id),
      someShortened: shortened.length > 0,
      latestWhole:
        latest !== undefined &&
        !shortened.includes(latest) &&
        JSON.stringify(latest).includes(
          JSON.stringify(stored.at(-1)?.text ?? "missing").slice(1, -1)
        ),
    }).toStrictEqual({
      calls: maxRunsPerTurn,
      withinWindow: true,
      pairs: calls,
      someShortened: true,
      latestWhole: true,
    });
  });

  it("sends as much of a long chat as the model's window takes, and stops a chat that is too long", async () => {
    const { stub, chat, gateway, ask } = await newChat(
      codeStep("export default async () => 'early' + '-result';"),
      says("Noted."),
      says("Still here."),
      says("All here.")
    );
    await pointAtGateway(stub, gateway, { config: bothModels });
    await ask("Remember this.");
    // A long chat since, of 1.2 million characters: more than the small
    // model takes, and well within the large one's window.
    await addTurns(stub, chat.id, 40);
    /** What the request for `question` sent of the chat, to `to`. */
    const sentTo = async (to: string, question: string, answered: string) => {
      await expect(
        stub.ask(chat.id, { text: question, model: to })
      ).resolves.toMatchObject({ outcome: "answered", answer: answered });
      const sent = JSON.stringify(gateway.requests.at(-1)?.body);
      return {
        // The first turn: its question, and what its code returned.
        early: [sent.includes("Remember this."), sent.includes("early-result")],
        note: sent.includes("Earlier messages of this chat are left out"),
        question: sent.includes(question),
        // The instructions always go along.
        instructions: sent.includes("You are the Grasp assistant"),
        chars: sent.length,
      };
    };

    const small = await sentTo(smallModel, "And now?", "Still here.");
    const large = await sentTo(model, "And again?", "All here.");

    expect({
      small: { ...small, chars: undefined },
      smallWithinWindow: small.chars < requestChars(inputTokens.small),
      large: { ...large, chars: undefined },
      largeWithinWindow: large.chars < requestChars(inputTokens.large),
    }).toStrictEqual({
      small: {
        early: [false, false],
        note: true,
        question: true,
        instructions: true,
        chars: undefined,
      },
      smallWithinWindow: true,
      // The same chat, whole: the first turn and all since.
      large: {
        early: [true, true],
        note: false,
        question: true,
        instructions: true,
        chars: undefined,
      },
      largeWithinWindow: true,
    });

    await addTurns(stub, chat.id, 100);
    await expect(codeOf(ask("More?"))).resolves.toBe("agent.chat_full");
  });

  it("leaves a long chat's turns only the room the memory it carries doesn't take", async () => {
    const admin = await signedInApi(idp, "admin");
    const { memory } = await admin.api.memory.collections();
    if (memory === null) {
      throw new Error("An admin gets the Memory collection");
    }
    const { stub, chat, gateway } = await newChat(says("Still here."));
    /** Saves the company's AGENTS.md, over what is there. */
    const saveRules = async (text: string) => {
      const { documents } = await admin.api.knowledge.listDocuments(memory);
      const current = documents.find(({ path }) => path === "AGENTS.md");
      await admin.api.knowledge.saveDocument({
        collectionId: memory,
        path: "AGENTS.md",
        text,
        ifVersion: current?.currentVersion ?? 0,
      });
    };
    // The largest a deployment may let a memory file be: 128,000
    // characters, which every request of the chat carries.
    const limits = env.MEMORY_LIMITS;
    const raised = { "AGENTS.md": memoryMaxLimit };
    const rules = `# Rules\n\n${"m".repeat(127_000)} the last rule`;
    let sent = "";
    try {
      Reflect.set(env, "MEMORY_LIMITS", raised);
      await pointAtGateway(stub, gateway, {
        config: bothModels,
        memoryLimits: raised,
      });
      await saveRules(rules);
      await addTurns(stub, chat.id, 40);

      await expect(
        stub.ask(chat.id, { text: "And now?", model: smallModel })
      ).resolves.toMatchObject({ outcome: "answered" });
      sent = JSON.stringify(gateway.requests.at(-1)?.body);
    } finally {
      Reflect.set(env, "MEMORY_LIMITS", limits);
      // The company's memory is every later chat's too.
      await saveRules("# Rules");
    }

    expect({
      // The memory whole, the recent turns, and no more than the model
      // takes of both together.
      memory: sent.includes("the last rule"),
      note: sent.includes("Earlier messages of this chat are left out"),
      question: sent.includes("And now?"),
      withinWindow: sent.length < requestChars(inputTokens.small),
      // Most of the room that is left is used: ten turns and more.
      turns: sent.split("q".repeat(30_000)).length > 10,
    }).toStrictEqual({
      memory: true,
      note: true,
      question: true,
      withinWindow: true,
      turns: true,
    });
  });

  it("keeps a request that nearly fills the model's window within it, its note and tool declaration included", async () => {
    const { stub, chat, gateway } = await newChat(says("Still here."));
    await pointAtGateway(stub, gateway, { config: bothModels });
    // Turns of 5,000 characters, more than twice what the small model
    // takes: those sent fill its window to within one of them.
    await addTurns(stub, chat.id, 250, 5000);

    await expect(
      stub.ask(chat.id, { text: "And now?", model: smallModel })
    ).resolves.toMatchObject({ outcome: "answered" });

    // The whole request as the provider got it: instructions, the tool's
    // declaration, the note and the turns.
    const sent = JSON.stringify(gateway.requests.at(-1)?.body);
    const windowChars = requestChars(inputTokens.small);
    expect({
      tool: sent.includes('"name":"executeCode"'),
      note: sent.includes("Earlier messages of this chat are left out"),
      question: sent.includes("And now?"),
      nearlyFull: sent.length > windowChars * 0.9,
      withinWindow: sent.length <= windowChars,
    }).toStrictEqual({
      tool: true,
      note: true,
      question: true,
      nearlyFull: true,
      withinWindow: true,
    });
  });

  it("refuses a question too long for the model, before anything is kept or sent", async () => {
    const { stub, chat, gateway } = await newChat(says("Hi."));
    await pointAtGateway(stub, gateway, { config: bothModels });

    // 50,000 characters, to a model that takes 18,000 tokens: its window
    // of 24,000 less a quarter kept for the answer.
    await expect(
      codeOf(stub.ask(chat.id, { text: "q".repeat(50_000), model: tinyModel }))
    ).resolves.toBe("agent.question_too_long");
    expect(gateway.requests).toStrictEqual([]);
    await expect(transcript(stub, chat.id)).resolves.toStrictEqual([]);

    // The same question to a model that takes it.
    await expect(
      stub.ask(chat.id, { text: "q".repeat(50_000), model })
    ).resolves.toMatchObject({ outcome: "answered", answer: "Hi." });
  });

  it("answers a short question on a model with a small window", async () => {
    const { stub, chat, gateway } = await newChat(says("Hi."));
    await pointAtGateway(stub, gateway, { config: bothModels });

    await expect(
      stub.ask(chat.id, { text: "Hi.", model: tinyModel })
    ).resolves.toMatchObject({ outcome: "answered", answer: "Hi." });
    // Instructions, tool and question all within the 18,000 tokens left.
    const sent = JSON.stringify(gateway.requests.at(-1)?.body);
    expect(sent.length).toBeLessThanOrEqual(requestChars(18_000));
  });

  it("sizes a chat to a fixed number of characters when the model's window is unknown", () => {
    expect([
      requestChars(),
      requestChars(0),
      requestChars(inputTokens.small) < requestChars(inputTokens.large),
    ]).toStrictEqual([300_000, 0, true]);
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

/** What the chat's agent said in the chat, oldest first. */
const saidIn = async (stub: WorkspaceStub, chatId: string) => {
  const messages = await transcript(stub, chatId);
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? [
          message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join(""),
        ]
      : []
  );
};

/** Whether the agent's message is the one a cut-short turn leaves. */
const saysInterrupted = (text: string): boolean =>
  text.startsWith("I was interrupted before I finished");

describe("chat agent after a restart", () => {
  it("says nothing of a turn that ended before the restart: answered, stopped by the person, or failed", async () => {
    const answered = await newChat(says("Done."));
    await answered.ask("Do it.");

    const stopped = await newChat({ hang: true });
    const cancelled = stopped.ask("Take your time.");
    await vi.waitFor(
      () => {
        expect(stopped.gateway.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    await stopped.stub.cancel(stopped.chat.id, stopped.personId);
    await cancelled;

    // The person leaves while the model answers: the turn throws.
    const { reply, release } = pausedReply(
      { ...codeStep("export default async () => 'done';"), text: "Running." },
      1
    );
    const failed = await newChat(reply);
    const failing = codeOf(failed.ask("Wait."));
    await vi.waitFor(
      () => {
        expect(failed.gateway.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(failed.personId)
      .run();
    release();
    await expect(failing).resolves.toBe("permission.person_inactive");

    const said: boolean[] = [];
    for (const { id, chat } of [answered, stopped, failed]) {
      // oxlint-disable-next-line no-await-in-loop -- one chat after the other
      const woken = await restart(id);
      // oxlint-disable-next-line no-await-in-loop -- one chat after the other
      const texts = await saidIn(woken, chat.id);
      said.push(texts.some(saysInterrupted));
    }
    expect(said).toStrictEqual([false, false, false]);
  });

  it("says nothing when the restart came before the turn's question was kept, or after its answer was", async () => {
    const { id, stub, chat, ask } = await newChat(says("Done."));
    await ask("Do it.");
    // The mark of a turn taken when the chat's last message had ID
    // `before`, left as the object leaves it when it dies before the turn
    // clears it.
    const markedAt = async (before: number) => {
      await runInDurableObject(workspace(env, id), (_instance, state) => {
        state.storage.kv.put(`turn:${chat.id}`, before);
      });
    };
    const lastId = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ last: number }>("SELECT max(id) AS last FROM chat_messages")
          .one().last
    );

    // A second turn died before its question reached the chat: nothing of
    // it was stored.
    await markedAt(lastId);
    const beforeQuestion = await saidIn(await restart(id), chat.id);
    // The first turn died after its answer was stored, before it cleared
    // its mark.
    await markedAt(0);
    const afterAnswer = await saidIn(await restart(id), chat.id);

    expect({ beforeQuestion, afterAnswer }).toStrictEqual({
      beforeQuestion: ["Done."],
      afterAnswer: ["Done."],
    });
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
    const gateway = fakeGateway(says("You asked which chat this is."));
    await pointAtGateway(stub, gateway);
    const reply = await ask("What did I ask before?");

    expect(reply.answer).toBe("You asked which chat this is.");
    const sent = JSON.stringify(gateway.requests[0]?.body);
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

  it("goes on from a turn a restart cut short", async () => {
    const { stub, ask } = await newChat(
      codeStep("export default async () => 6 * 7;"),
      says("42.")
    );
    await ask("What is 6 * 7?");
    // The object died while the step ran: the step's call was kept, as the
    // loop keeps each message it finishes, but its result and the answer
    // weren't.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM chat_messages WHERE id IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 2)"
      );
    });

    await evictDurableObject(stub);
    const after = fakeGateway(says("It was 42."));
    await pointAtGateway(stub, after);
    const reply = await ask("So?");

    const sent = JSON.stringify(after.requests[0]?.body);
    expect({
      answer: reply.answer,
      // The first question, its step's call (closed as having no result)
      // and the new question.
      sent: ["What is 6 * 7?", "6 * 7;", "No result provided", "So?"].map(
        (text) => sent.includes(text)
      ),
    }).toStrictEqual({
      answer: "It was 42.",
      sent: [true, true, true, true],
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
        "export default async (self, env) => { const reports = await env.chat.attachments(); await scheduler.wait(3_000); console.log('leaked', reports.length); return 'read before the revoke'; };"
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
              detail.method === "chat.attachments" &&
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
    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.run_revoked")
        ).resolves.toStrictEqual([
          {
            method: "executeCode",
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
    await expect(
      runInDurableObject(stub, (instance) =>
        instance.admitFromCodeRun(
          chatIdSchema.parse(chat.id),
          String(record?.id)
        )
      )
    ).resolves.toStrictEqual({ call: "ended" });
  });

  it("admits nothing a run does while its end reads revocations", async () => {
    // The run ends at its wall clock while its code still waits; the code
    // calls during the slow read of revocations that follows.
    const { stub, chat, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { await scheduler.wait(1_300); await env.chat.attachments(); };"
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
            method: "chat.attachments",
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

  it("ends a run a restart cuts short: its lease closes, its record says interrupted, and nothing runs again", async () => {
    const { id, stub, chat, gateway, ask } = await newChat(
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
    ).resolves.toStrictEqual({ call: "ended", first: false });
    // Not run again: one step asked for, no result, no second request.
    await scheduler.wait(6000);
    const [calls, results, runs] = await Promise.all([
      toolCallIds(woken, chat.id),
      codeResults(woken, chat.id),
      runRecords(woken, chat.id),
    ]);
    expect({
      calls: calls.length,
      results: results.length,
      runs: runs.length,
      requests: gateway.requests.length,
    }).toStrictEqual({ calls: 1, results: 0, runs: 1, requests: 1 });
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
      ].map(redact)
    ).toStrictEqual([
      "authorization: [redacted]",
      "Authorization: [redacted]",
      'password: "[redacted]"',
      "secret='[redacted]' and more",
      '{"password":"[redacted]","user":"ann"}',
      'token: "[redacted]',
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
      'password: "',
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
  it("leaves nothing held after many runs, whether they complete, throw or fail to load", async () => {
    const kinds = [
      "export default async () => { console.log('ran'); return 1; };",
      "export default async () => { throw new Error('nope'); };",
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

    // Measured in the object: what its runs hold now, not what their
    // cleanup is meant to do.
    await expect(
      runInDurableObject(stub, (instance) => instance.codeRunRetention())
    ).resolves.toStrictEqual({
      handles: 0,
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
