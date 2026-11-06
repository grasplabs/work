/**
 * The lab's bridge to a Claude subscription: `vp run lab:bridge`. It stands
 * where the Anthropic API stands for a local stack that the lab started
 * with `vp run lab:dev` (connect-config.ts), and answers each request with
 * Claude Code (`claude -p`) on the one account this machine is signed in
 * with. So the Stephen Lab runs on that subscription and spends nothing on
 * the API, while every call still goes through core's model gateway and
 * connect, as an interview's does: only where connect's request lands
 * changes. The real API is used once, at the end of a climb, to confirm
 * (`--api`).
 *
 * It speaks as much of the Messages API as core's gateway asks of it:
 * `POST /v1/messages`, whole or as a stream, with a system text, the
 * messages, a token limit and an effort. Each call is one `claude -p` with
 * that system text in place of Claude Code's own, no tools, no settings, no
 * MCP servers and nothing kept, run in an empty folder. Claude Code still
 * tells the model a little of its own (about 700 tokens), so a result run
 * here is marked as such (`through: "subscription"`) and never set beside
 * one on the API unmarked.
 *
 * One account means its limits are the lab's: few calls at once
 * (`LAB_BRIDGE_AT_ONCE`, 4), a busy moment asked again after a while, and
 * once the account's usage limit is reached every call is refused at once
 * (429) until a call gets through again, tried every few minutes. `GET
 * /stats` says how many calls it answered (the lab checks that its calls
 * really came here) and whether the limit is reached.
 *
 * Never for people: an interview a person holds always runs on the API.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

/** Where the bridge listens: the origin connect's relay is pointed at. */
export const bridgePort = Number(process.env.LAB_BRIDGE_PORT ?? 8799);
export const bridgeOrigin = `http://localhost:${bridgePort}`;

/** The one provider host the bridge stands in for. */
const anthropicHost = "api.anthropic.com";

const textBlockSchema = z.looseObject({
  type: z.string().optional(),
  text: z.string().optional(),
});
const contentSchema = z.union([z.string(), z.array(textBlockSchema)]);

/** What the bridge reads of a Messages API request: anything else is ignored. */
export const askedSchema = z.looseObject({
  model: z.string(),
  system: contentSchema.optional(),
  messages: z.array(
    z.looseObject({ role: z.string(), content: contentSchema })
  ),
  max_tokens: z.int().positive().optional(),
  stream: z.boolean().optional(),
  thinking: z.looseObject({ type: z.string() }).optional(),
  output_config: z.looseObject({ effort: z.string().optional() }).optional(),
});
export type Asked = z.output<typeof askedSchema>;

/** The text of a system prompt or a message, its blocks joined. */
export const textOf = (content: Asked["system"]): string =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .map((block) => block.text ?? "")
        .filter((text) => text !== "")
        .join("\n\n");

/**
 * What Claude Code is given to answer: the one user message as it is, or,
 * for a conversation, each message under who said it. Stephen's turns and
 * the lab's own calls are one user message each.
 */
export const promptOf = (messages: Asked["messages"]): string => {
  const [only] = messages;
  if (messages.length === 1 && only?.role === "user") {
    return textOf(only.content);
  }
  return messages
    .map(
      (message) =>
        `${message.role === "assistant" ? "Assistant" : "User"}: ${textOf(message.content)}`
    )
    .join("\n\n");
};

/** What would make Claude Code spend from a key, or somewhere else, instead of the subscription. */
const keyNames: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]);

/** The efforts Claude Code takes. */
const efforts = new Set(["low", "medium", "high", "xhigh", "max"]);

/** The command line and environment of one `claude -p` for `asked`. */
export const claudeCallOf = (
  asked: Asked,
  env: NodeJS.ProcessEnv
): { args: string[]; env: NodeJS.ProcessEnv } => {
  const effort = asked.output_config?.effort;
  const args = [
    "-p",
    "--system-prompt",
    textOf(asked.system),
    "--model",
    asked.model,
    ...(effort !== undefined && efforts.has(effort)
      ? ["--effort", effort]
      : []),
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "json",
  ];
  // The subscription this machine is signed in with, never a key: a key in
  // the environment would be spent from instead.
  const own: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => !keyNames.has(name))
  );
  // A request that asks for no thinking gets none, as the API would give.
  const thinks =
    asked.thinking !== undefined && asked.thinking.type !== "disabled";
  if (!thinks) {
    own.MAX_THINKING_TOKENS = "0";
  }
  // Claude Code counts thinking against its output limit and, where the
  // API would cut the answer short, fails the whole call ("exceeded the
  // 400 output token maximum"). So a request that thinks is answered
  // whole: a turn that fails measures nothing.
  if (asked.max_tokens !== undefined && !thinks) {
    own.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(asked.max_tokens);
  }
  return { args, env: own };
};

/** What one call answered, as the Messages API counts it. */
export interface Answered {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  /** What it would have cost on the API, at list price, as Claude Code says. */
  worth: number;
}

/** Why a call got no answer, and the status the Messages API would say it with. */
export class BridgeFailureError extends Error {
  override name = "BridgeFailureError";
  readonly status: number;
  /** `spent`: the account's usage limit is reached; `busy`: worth asking again soon. */
  readonly kind: "spent" | "busy" | "login" | "failed";
  constructor(
    message: string,
    status: number,
    kind: BridgeFailureError["kind"]
  ) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

const resultSchema = z.looseObject({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  api_error_status: z.int().nullable().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
});

const spentWords =
  /usage limit|hit your limit|limit reached|out of (?:extra )?usage|resets? (?:at|in)/iu;
const busyWords = /overloaded|rate.?limit|too many requests/iu;
const loginWords = /log ?in|not authenticated|invalid api key|\/login/iu;

/** Why Claude Code said it could not answer, as a failure of the bridge. */
const failureOf = (said: string, status: number | null): BridgeFailureError => {
  if (spentWords.test(said)) {
    return new BridgeFailureError(said, 429, "spent");
  }
  if (status === 429 || status === 529 || busyWords.test(said)) {
    return new BridgeFailureError(said || "Busy.", 529, "busy");
  }
  if (loginWords.test(said)) {
    return new BridgeFailureError(said, 401, "login");
  }
  return new BridgeFailureError(
    said || "Claude Code could not answer.",
    status ?? 500,
    "failed"
  );
};

/** What `claude -p --output-format json` printed, read as an answer or a failure. */
export const answeredFrom = (out: string, err: string): Answered => {
  let parsed: z.output<typeof resultSchema>;
  try {
    parsed = resultSchema.parse(JSON.parse(out));
  } catch {
    throw new BridgeFailureError(
      `Claude Code gave no answer: ${(err || out).slice(0, 300)}`,
      500,
      "failed"
    );
  }
  if (parsed.is_error === true) {
    throw failureOf(
      (parsed.result ?? "").slice(0, 300),
      parsed.api_error_status ?? null
    );
  }
  const usage = parsed.usage ?? {};
  return {
    text: parsed.result ?? "",
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    },
    worth: parsed.total_cost_usd ?? 0,
  };
};

/** An answer as the Messages API's message. */
export const messageOf = (
  id: string,
  model: string,
  answered: Pick<Answered, "text" | "usage">
): Record<string, unknown> => ({
  id,
  type: "message",
  role: "assistant",
  model,
  content: answered.text === "" ? [] : [{ type: "text", text: answered.text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: answered.usage,
});

/** One event of a stream, as the Messages API sends it. */
const event = (type: string, data: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** An answer as the Messages API's stream: the whole text in one piece. */
export const streamOf = (
  id: string,
  model: string,
  answered: Pick<Answered, "text" | "usage">
): string => {
  const started = messageOf(id, model, {
    text: "",
    usage: { ...answered.usage, output_tokens: 0 },
  });
  return [
    event("message_start", {
      message: { ...started, stop_reason: null },
    }),
    event("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: answered.text },
    }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: answered.usage.output_tokens },
    }),
    event("message_stop", {}),
  ].join("");
};

/** The Messages API's name for each way a call can fail. */
const errorTypes: Readonly<Record<BridgeFailureError["kind"], string>> = {
  spent: "rate_limit_error",
  busy: "overloaded_error",
  login: "authentication_error",
  failed: "api_error",
};

/** A refusal as the Messages API says one. */
export const errorOf = (
  failure: BridgeFailureError
): { type: "error"; error: { type: string; message: string } } => ({
  type: "error",
  error: { type: errorTypes[failure.kind], message: failure.message },
});

/** Whether a relayed request is for Anthropic: the provider's host in `x-forwarded-host`. */
export const isForAnthropic = (forwardedHost?: string): boolean =>
  forwardedHost === undefined || forwardedHost === anthropicHost;

// ---------------------------------------------------------------------------
// The server

/** How many calls run at once: one account, shared with whoever uses it meanwhile. */
const atOnce = Math.max(1, Number(process.env.LAB_BRIDGE_AT_ONCE ?? 4));
/** A call that takes longer is stopped: core's gateway gives up before this anyway. */
const patienceMs = 180_000;
/** How long after the usage limit was reached the next call is tried. */
const spentRetryMs = 5 * 60_000;
/** How often, and how long apart, a busy moment is asked again. */
const busyTries = 3;
const busyWaitMs = 5000;

/** What was asked through the bridge since it started. */
interface Stats {
  since: string;
  calls: number;
  failed: number;
  busy: number;
  /** What the answered calls would have cost on the API, at list price. */
  worth: number;
  models: Record<string, number>;
  /** Set while the account's usage limit is reached: when, and what Claude Code said. */
  spent: { at: string; said: string } | null;
}

const stats: Stats = {
  since: new Date().toISOString(),
  calls: 0,
  failed: 0,
  busy: 0,
  worth: 0,
  models: {},
  spent: null,
};

/** An empty folder to run in, so Claude Code finds no project and no one's instructions. */
const nowhere = path.join(tmpdir(), "grasp-lab-bridge");

let running = 0;
const waiting: (() => void)[] = [];

/** Runs `work` once fewer than `atOnce` calls run. */
const inTurn = async <T>(work: () => Promise<T>): Promise<T> => {
  if (running >= atOnce) {
    // Its turn comes when a running call ends and lets the first waiting one go.
    const { promise, resolve } = Promise.withResolvers<boolean>();
    waiting.push(() => {
      resolve(true);
    });
    await promise;
  }
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
};

/** One `claude -p`; `gone` says whoever asked has left. */
const claude = async (asked: Asked, gone: AbortSignal): Promise<Answered> => {
  if (gone.aborted) {
    throw new BridgeFailureError("Whoever asked has left.", 499, "failed");
  }
  const call = claudeCallOf(asked, process.env);
  const child = spawn("claude", call.args, {
    cwd: nowhere,
    env: call.env,
    stdio: ["pipe", "pipe", "pipe"],
    signal: AbortSignal.any([gone, AbortSignal.timeout(patienceMs)]),
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (piece: Buffer) => {
    out += piece.toString();
  });
  child.stderr.on("data", (piece: Buffer) => {
    err += piece.toString();
  });
  child.stdin.end(promptOf(asked.messages));
  try {
    await once(child, "close");
  } catch (error) {
    if (gone.aborted) {
      throw new BridgeFailureError("Whoever asked has left.", 499, "failed");
    }
    throw new BridgeFailureError(
      `Claude Code could not answer: ${error instanceof Error ? error.message : "it stopped"}`,
      500,
      "failed"
    );
  }
  return answeredFrom(out, err);
};

/** Whether the account's usage limit was reached only a little while ago. */
const stillSpent = (): boolean =>
  stats.spent !== null &&
  Date.now() - Date.parse(stats.spent.at) < spentRetryMs;

/** One call, in its turn, asked again while busy; refused at once while the limit is reached. */
const answer = async (asked: Asked, gone: AbortSignal): Promise<Answered> => {
  if (stillSpent()) {
    throw new BridgeFailureError(stats.spent?.said ?? "", 429, "spent");
  }
  return await inTurn(async () => {
    for (let tries = 1; ; tries += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one try at a time
        const answered = await claude(asked, gone);
        stats.spent = null;
        return answered;
      } catch (error) {
        if (error instanceof BridgeFailureError && error.kind === "spent") {
          stats.spent = { at: new Date().toISOString(), said: error.message };
        }
        const busy =
          error instanceof BridgeFailureError && error.kind === "busy";
        if (!busy || tries >= busyTries) {
          throw error;
        }
        stats.busy += 1;
        // oxlint-disable-next-line no-await-in-loop -- waits before the next try
        await sleep(busyWaitMs * 3 ** (tries - 1));
      }
    }
  });
};

const json = (
  response: ServerResponse,
  status: number,
  body: unknown
): void => {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const bodyOf = async (request: IncomingMessage): Promise<unknown> => {
  const pieces: Buffer[] = [];
  for await (const piece of request) {
    pieces.push(Buffer.isBuffer(piece) ? piece : Buffer.from(String(piece)));
  }
  return JSON.parse(Buffer.concat(pieces).toString() || "{}");
};

/** Says `failure` to whoever asked, and counts it. */
const failed = (response: ServerResponse, failure: unknown): void => {
  stats.failed += 1;
  const known =
    failure instanceof BridgeFailureError
      ? failure
      : new BridgeFailureError("The bridge failed.", 500, "failed");
  json(response, known.status, errorOf(known));
};

/** `POST /v1/messages`, as the Messages API answers it. */
const messages = async (
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const forwarded = request.headers["x-forwarded-host"];
  if (!isForAnthropic(typeof forwarded === "string" ? forwarded : undefined)) {
    failed(
      response,
      new BridgeFailureError(
        `The lab's bridge answers Anthropic's API only, not ${String(forwarded)}.`,
        502,
        "failed"
      )
    );
    return;
  }
  const parsed = askedSchema.safeParse(await bodyOf(request));
  if (!parsed.success) {
    failed(
      response,
      new BridgeFailureError(
        "The bridge could not read that request.",
        400,
        "failed"
      )
    );
    return;
  }
  const asked = parsed.data;
  const gone = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) {
      gone.abort();
    }
  });
  const answered = await answer(asked, gone.signal);
  stats.calls += 1;
  stats.worth += answered.worth;
  stats.models[asked.model] = (stats.models[asked.model] ?? 0) + 1;
  const id = `msg_bridge_${stats.calls}`;
  if (asked.stream === true) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.end(streamOf(id, asked.model, answered));
    return;
  }
  json(response, 200, messageOf(id, asked.model, answered));
};

/** Every request the bridge takes. */
const handle = async (
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const [where] = (request.url ?? "").split("?");
  if (request.method === "POST" && where === "/v1/messages") {
    try {
      await messages(request, response);
    } catch (error) {
      failed(response, error);
    }
    return;
  }
  if (request.method === "GET" && (where === "/stats" || where === "/")) {
    json(response, 200, { ...stats, running, waiting: waiting.length });
    return;
  }
  json(response, 404, {
    type: "error",
    error: {
      type: "not_found_error",
      message: "The bridge answers POST /v1/messages only.",
    },
  });
};

if (import.meta.main) {
  mkdirSync(nowhere, { recursive: true });
  const listener = (
    request: IncomingMessage,
    response: ServerResponse
  ): void => {
    void handle(request, response);
  };
  // `localhost` is either address, so it listens on both, as connect may
  // reach it at either (e2e/model-fake.ts does the same).
  createServer(listener).listen(bridgePort, "127.0.0.1", () => {
    console.log(
      `The lab's bridge listens on ${bridgeOrigin}: model calls go to Claude Code on this machine's subscription, ${atOnce} at once.`
    );
  });
  createServer(listener)
    .on("error", () => {
      // No IPv6 on this machine: 127.0.0.1 is enough.
    })
    .listen(bridgePort, "::1");
}
