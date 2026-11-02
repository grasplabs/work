/**
 * A real model behind the Brain baseline (GRA-676) and Stephen's eval, for
 * their opt-in runs only (brain-real-model.test.ts and the others). The
 * harness connects the provider of the model under test with a test key
 * of its own and keeps its bridge (model-provider.ts), so it still sees
 * every request core's model gateway sends through connect; this provider
 * sends each one on, as the gateway built it, to the provider's own API
 * with the real key the run was given, and hands the answer back for the
 * bridge to stream to core. Core's gateway and ledger run as they always
 * do: the rules, the budget, the price and the charge are theirs. Nothing
 * here is a model client of its own.
 *
 * Chat completions (Mistral's, OpenRouter's) and Anthropic's Messages API;
 * not OpenAI's Responses API, whose items the bridge streams back under
 * ids of its own that OpenAI wouldn't take in the next request
 * (`realProviderTakes`). The request goes without a stream and the answer
 * comes back whole: the bridge streams it on. Anthropic's thinking goes
 * back with its real signature, which the next request of a tool loop
 * must return unchanged.
 */
import { aiProviderIdSchema } from "@grasp-os/shared/ai-providers";
import { z } from "zod";

import type { BrainProvider } from "./brain-harness.ts";
import type { StubTurn } from "./brain-stub-model.ts";
import type { ProviderReply, SentRequest } from "./model-provider.ts";

/** The providers whose API this sends on to. */
const takenProviders: ReadonlySet<string> = new Set([
  "anthropic",
  "mistral",
  "openrouter",
]);

/**
 * Whether a real run can reach `model` (`<provider>/<model>`): one of a
 * provider whose API this speaks, which a run checks before it sends
 * anything.
 */
export const realProviderTakes = (model: string): boolean => {
  const provider = aiProviderIdSchema.safeParse(
    model.slice(0, model.indexOf("/"))
  );
  return provider.success && takenProviders.has(provider.data);
};

/** What the model said to one request, for the run's log. */
export interface ModelExchange {
  /** The trial's task and arm, or the earlier turns before its question. */
  phase: StubTurn["phase"];
  taskId?: string;
  arm?: string;
  /** The model's text, or the provider's refusal. */
  text: string;
  /** The code it ran, by call. */
  calls: { name: string; arguments: string }[];
  status: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          // What a reasoning model thought, which some (DeepSeek's) must
          // be sent back on the assistant messages of later requests.
          reasoning_content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().nullish(),
                function: z.object({
                  name: z.string(),
                  arguments: z.union([
                    z.string(),
                    z.record(z.string(), z.unknown()),
                  ]),
                }),
              })
            )
            .nullish(),
        }),
        finish_reason: z.string().nullish(),
      })
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    completion_tokens_details: z
      .object({ reasoning_tokens: z.number().nullish() })
      .nullish(),
  }),
});

const anthropicSchema = z.object({
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("thinking"),
        thinking: z.string(),
        signature: z.string(),
      }),
      z.object({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string(),
        input: z.record(z.string(), z.unknown()),
      }),
      // Redacted thinking can't be handed on: the bridge has no block
      // for it. Refused below rather than dropped, which the next request
      // of a tool loop would be refused for.
      z.object({ type: z.literal("redacted_thinking") }).loose(),
    ])
  ),
  stop_reason: z.string().nullish(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
    cache_creation: z
      .object({ ephemeral_1h_input_tokens: z.number().nullish() })
      .nullish(),
  }),
});

/** A JSON object: a call's arguments, or a request's body. */
const argumentsSchema = z.record(z.string(), z.unknown());

/** A call's arguments as an object: the model may send malformed JSON. */
const argumentsOf = (
  raw: string | Record<string, unknown>
): Record<string, unknown> => {
  if (typeof raw !== "string") {
    return raw;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const object = argumentsSchema.safeParse(parsed);
    return object.success ? object.data : { value: parsed };
  } catch {
    // Handed on as the model wrote it, under a key no tool takes: core
    // then refuses the call as it would refuse the malformed original.
    return { unparsed: raw };
  }
};

/** The wire format of the route a request went to. */
type WireFormat = "chat-completions" | "anthropic-messages";

const formatOf = (url: string): WireFormat => {
  const { pathname } = new URL(url);
  if (pathname.endsWith("/chat/completions")) {
    return "chat-completions";
  }
  if (pathname.endsWith("/v1/messages")) {
    return "anthropic-messages";
  }
  throw new TypeError(
    `The real provider speaks chat completions and Anthropic's Messages API only, not ${url}`
  );
};

/** The request as sent on: whole, without a stream. */
const unstreamed = (request: SentRequest): string => {
  if (typeof request.body !== "object" || request.body === null) {
    throw new TypeError(`A request to ${request.url} without a JSON body`);
  }
  const { stream_options: _streamOptions, ...body } = argumentsSchema.parse(
    request.body
  );
  return JSON.stringify({ ...body, stream: false });
};

interface Replied {
  reply: ProviderReply;
  text: string;
  calls: ModelExchange["calls"];
}

/**
 * The request's headers with the real key where the test key was: in the
 * header the provider takes its key in, as connect put it there.
 */
const withRealKey = (request: SentRequest, key: string): Headers => {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("host");
  if (headers.has("x-api-key")) {
    headers.set("x-api-key", key);
  } else {
    headers.set("authorization", `Bearer ${key}`);
  }
  return headers;
};

const callsOf = (
  calls: readonly { name: string; arguments: Record<string, unknown> }[]
): ModelExchange["calls"] =>
  calls.map((call) => ({
    name: call.name,
    arguments: JSON.stringify(call.arguments),
  }));

const anthropicReply = (raw: unknown): Replied => {
  const parsed = anthropicSchema.parse(raw);
  const text = parsed.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const toolCalls = parsed.content.flatMap((block) =>
    block.type === "tool_use"
      ? [{ id: block.id, name: block.name, arguments: block.input }]
      : []
  );
  if (parsed.content.some(({ type }) => type === "redacted_thinking")) {
    throw new TypeError(
      "Anthropic redacted the model's thinking, which the bridge can't hand on"
    );
  }
  const thinking = parsed.content.flatMap((block) =>
    block.type === "thinking" ? [block] : []
  );
  // One block the bridge streams, under the one signature it carries.
  if (thinking.length > 1) {
    throw new TypeError(
      "The model thought in more than one block, which the bridge streams as one"
    );
  }
  const [signed] = thinking;
  const { usage } = parsed;
  const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    reply: {
      text,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(signed === undefined
        ? {}
        : {
            thinking: {
              text: signed.thinking,
              // Anthropic doesn't count thinking apart from the answer.
              tokens: 0,
              signature: signed.signature,
            },
          }),
      cache: {
        read: usage.cache_read_input_tokens ?? 0,
        write: usage.cache_creation_input_tokens ?? 0,
      },
      ...(cacheWrite1h === 0 ? {} : { cacheWrite1h }),
      ...(parsed.stop_reason === "max_tokens" ? { truncated: true } : {}),
    },
    text,
    calls: callsOf(toolCalls),
  };
};

const replyOf = async (
  response: Response,
  format: WireFormat
): Promise<Replied> => {
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      reply: { status: response.status, body: raw },
      text: JSON.stringify(raw),
      calls: [],
    };
  }
  if (format === "anthropic-messages") {
    return anthropicReply(raw);
  }
  const parsed = completionSchema.parse(raw);
  const [choice] = parsed.choices;
  const text = choice?.message.content ?? "";
  const reasoning = choice?.message.reasoning_content ?? "";
  const toolCalls = (choice?.message.tool_calls ?? []).map((call) => ({
    id: call.id ?? `call_${crypto.randomUUID()}`,
    name: call.function.name,
    arguments: argumentsOf(call.function.arguments),
  }));
  return {
    reply: {
      text,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      inputTokens: parsed.usage.prompt_tokens,
      outputTokens: parsed.usage.completion_tokens,
      ...(reasoning === ""
        ? {}
        : {
            thinking: {
              text: reasoning,
              tokens:
                parsed.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            },
          }),
      ...(choice?.finish_reason === "length" ? { truncated: true } : {}),
    },
    text,
    calls: callsOf(toolCalls),
  };
};

/**
 * The provider: each request the model gateway sends goes on to the
 * provider's own API with the real `key`, from the test's isolate, and
 * what the model said to it goes to `log`.
 */
export const realProvider =
  (key: string, log: (exchange: ModelExchange) => void): BrainProvider =>
  (turn) =>
  async (requests) => {
    const request = requests.at(-1);
    if (request === undefined) {
      throw new RangeError("No request to answer");
    }
    const format = formatOf(request.url);
    const started = performance.now();
    const response = await fetch(request.url, {
      method: "POST",
      headers: withRealKey(request, key),
      body: unstreamed(request),
      signal: request.signal,
    });
    const { reply, text, calls } = await replyOf(response, format);
    const current = turn();
    log({
      phase: current.phase,
      ...(current.phase === "question"
        ? {
            taskId: current.task.id,
            ...(current.arm === undefined ? {} : { arm: current.arm }),
          }
        : {}),
      text,
      calls,
      status: response.status,
      inputTokens: "inputTokens" in reply ? reply.inputTokens : 0,
      outputTokens: "outputTokens" in reply ? reply.outputTokens : 0,
      ms: performance.now() - started,
    });
    return reply;
  };
