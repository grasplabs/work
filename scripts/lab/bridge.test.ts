/**
 * The lab's bridge to a Claude subscription (bridge.ts): what it asks
 * Claude Code for a Messages API request, how it reads what Claude Code
 * printed, and how it answers as the API would, whole or as a stream. The
 * server itself is run once against a stand-in for `claude`, so no test
 * reaches a model.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  BridgeFailureError,
  answeredFrom,
  askedSchema,
  claudeCallOf,
  isForAnthropic,
  promptOf,
  streamOf,
} from "./bridge.ts";

const asked = askedSchema.parse({
  model: "claude-sonnet-4-6",
  system: [{ type: "text", text: "You are Stephen.", cache_control: {} }],
  messages: [{ role: "user", content: "The brief.\n\nOnly the line." }],
  max_tokens: 400,
  stream: true,
  thinking: { type: "disabled" },
});

describe("what the bridge asks Claude Code", () => {
  it("gives Stephen's own text in place of Claude Code's, with no tools, settings or MCP servers, and keeps nothing", () => {
    const { args } = claudeCallOf(asked, {});

    expect(args).toStrictEqual([
      "-p",
      "--system-prompt",
      "You are Stephen.",
      "--model",
      "claude-sonnet-4-6",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--output-format",
      "json",
    ]);
  });

  it("runs on the subscription, never on a key the environment holds", () => {
    const { env } = claudeCallOf(asked, {
      ANTHROPIC_API_KEY: "sk-ant-real",
      ANTHROPIC_BASE_URL: "https://elsewhere.example",
      HOME: "/home/lab",
    });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.HOME).toBe("/home/lab");
  });

  it("thinks only when asked to, and passes the effort asked for", () => {
    const quiet = claudeCallOf(asked, {});
    const thinking = claudeCallOf(
      {
        ...asked,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
      },
      {}
    );

    expect(quiet.env.MAX_THINKING_TOKENS).toBe("0");
    expect(thinking.env.MAX_THINKING_TOKENS).toBeUndefined();
    expect(thinking.args).toContain("--effort");
    expect(thinking.args[thinking.args.indexOf("--effort") + 1]).toBe("low");
  });

  it("keeps the token limit, but answers a request that thinks whole, as Claude Code would fail it rather than cut it short", () => {
    const quiet = claudeCallOf(asked, {});
    const thinking = claudeCallOf(
      { ...asked, thinking: { type: "adaptive" } },
      {}
    );

    expect(quiet.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("400");
    expect(thinking.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  it("gives one user message as it is, and a conversation with who said what", () => {
    expect(promptOf(asked.messages)).toBe("The brief.\n\nOnly the line.");
    expect(
      promptOf([
        { role: "user", content: "Hi" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        { role: "user", content: "Go on" },
      ])
    ).toBe("User: Hi\n\nAssistant: Hello\n\nUser: Go on");
  });

  it("stands in for Anthropic alone: a request relayed for another provider is not answered", () => {
    expect(isForAnthropic("api.anthropic.com")).toBeTruthy();
    expect(isForAnthropic()).toBeTruthy();
    expect(isForAnthropic("api.openai.com")).toBeFalsy();
  });
});

/** The failure Claude Code's error `result` is read as. */
const failureOf = (result: Record<string, unknown>): BridgeFailureError => {
  try {
    answeredFrom(JSON.stringify({ is_error: true, ...result }), "");
  } catch (error) {
    if (error instanceof BridgeFailureError) {
      return error;
    }
  }
  throw new Error("no failure");
};

const eventSchema = z.looseObject({ type: z.string() });
const statsSchema = z.looseObject({ calls: z.int() });

describe("what Claude Code printed, read", () => {
  it("reads an answer with what it took and what it would have cost on the API", () => {
    const answered = answeredFrom(
      JSON.stringify({
        is_error: false,
        result: "What did you do this morning?",
        total_cost_usd: 0.012,
        usage: { input_tokens: 900, output_tokens: 9 },
      }),
      ""
    );

    expect(answered).toStrictEqual({
      text: "What did you do this morning?",
      usage: {
        input_tokens: 900,
        output_tokens: 9,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      worth: 0.012,
    });
  });

  it("tells the account's usage limit (429, not asked again) from a busy moment (529, asked again) and a lost login", () => {
    const spent = failureOf({ result: "You've hit your limit · resets 3pm" });
    const busy = failureOf({ result: "Overloaded", api_error_status: 529 });
    const login = failureOf({ result: "Not logged in · Please run /login" });

    expect([spent.kind, spent.status]).toStrictEqual(["spent", 429]);
    expect([busy.kind, busy.status]).toStrictEqual(["busy", 529]);
    expect([login.kind, login.status]).toStrictEqual(["login", 401]);
    expect(() => answeredFrom("not json", "crashed")).toThrow(/no answer/u);
  });
});

describe("the answer, as the Messages API streams it", () => {
  it("streams the whole text as one delta between start and stop", () => {
    const events = streamOf("msg_1", "claude-sonnet-4-6", {
      text: "Tell me about yesterday.",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    })
      .trim()
      .split("\n\n")
      .map((block) => {
        const data = block.split("\n")[1] ?? "";
        return eventSchema.parse(JSON.parse(data.slice("data: ".length)));
      });

    expect(events.map((event) => event.type)).toStrictEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[2]).toStrictEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Tell me about yesterday." },
    });
  });
});

describe("the bridge, running", () => {
  const port = 18_799 + Math.floor(Math.random() * 500);
  const origin = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;

  beforeAll(async () => {
    // A stand-in for `claude` that answers with what it was given.
    const bin = mkdtempSync(path.join(tmpdir(), "lab-bridge-"));
    const fake = path.join(bin, "claude");
    writeFileSync(
      fake,
      `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (piece) => { input += piece; });
process.stdin.on("end", () => {
  const system = process.argv[process.argv.indexOf("--system-prompt") + 1];
  process.stdout.write(JSON.stringify({
    is_error: false,
    result: system + " | " + input + " | " + (process.env.ANTHROPIC_API_KEY ?? "no key"),
    total_cost_usd: 0.001,
    usage: { input_tokens: 3, output_tokens: 2 },
  }));
});
`
    );
    chmodSync(fake, 0o755);
    server = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "bridge.ts")],
      {
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          LAB_BRIDGE_PORT: String(port),
          ANTHROPIC_API_KEY: "sk-ant-real",
        },
        stdio: "ignore",
      }
    );
    for (let tries = 0; tries < 100; tries += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- waits for it to listen
        await fetch(`${origin}/stats`);
        return;
      } catch {
        // oxlint-disable-next-line no-await-in-loop -- waits for it to listen
        await sleep(50);
      }
    }
  });

  afterAll(() => {
    server?.kill("SIGTERM");
  });

  it("answers a relayed request as the Messages API, on the subscription, and counts it", async () => {
    const response = await fetch(`${origin}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": "api.anthropic.com",
        "x-api-key": "not-a-real-key",
      },
      body: JSON.stringify({ ...asked, stream: false }),
    });
    const counted = await fetch(`${origin}/stats`);
    const stats = statsSchema.parse(await counted.json());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "You are Stephen. | The brief.\n\nOnly the line. | no key",
        },
      ],
      stop_reason: "end_turn",
    });
    expect(stats.calls).toBe(1);
  });

  it("refuses a request relayed for another provider", async () => {
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "x-forwarded-host": "api.openai.com" },
      body: "{}",
    });
    const relayedElsewhere = await fetch(`${origin}/v1/messages`, {
      method: "POST",
      headers: { "x-forwarded-host": "api.openai.com" },
      body: JSON.stringify(asked),
    });

    expect(response.status).toBe(404);
    expect(relayedElsewhere.status).toBe(502);
  });
});
