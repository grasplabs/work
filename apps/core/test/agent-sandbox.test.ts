import { agentErrors } from "@grasp-os/shared/agent";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { codeLimits, cutMarker, utf8Bytes } from "../src/code-mode.ts";
import {
  codeResults,
  codeStatuses,
  codeStep,
  says,
  setObjectEnv,
  transcript,
} from "./agent-chat.ts";
import { chatsWith, refusalsIn } from "./agent-code-runs.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";

// A chat's agent, through the Workspace object: the loop, the code it runs
// in isolates of their own, and the model gateway, all real (agent-chat.ts).

const idp = mockIdp();

const { newChat, runStep, runEnded } = chatsWith(idp);

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

/** The one warning a call from an ended run logs. */
const runEndedSchema = z.object({
  event: z.literal("agent.run_ended"),
  runId: z.string(),
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
      text: `Returned:\n${JSON.stringify({ given: ["chat", "knowledge", "connections", "apps", "build", "workflows", "workflowBuild", "memory", "skills", "dashboard"], imported: [], exports: [] })}`,
    });
  });

  it("names the API it doesn't have, and the ones it does", async () => {
    const result = await runStep(
      "export default async (self, env) => await env.mailbox.send('hi');"
    );

    expect(result?.isError).toBeTruthy();
    expect(result?.text).toContain(
      "This chat has no API named env.mailbox. It has: env.chat, env.knowledge, env.connections, env.apps, env.build, env.workflows, env.workflowBuild, env.memory, env.skills, env.dashboard."
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
