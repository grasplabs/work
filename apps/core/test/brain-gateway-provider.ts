/**
 * A real model behind the Brain baseline (GRA-676), for the opt-in run
 * only (brain-real-model.test.ts). The harness keeps its stand-in AI
 * Gateway, so it still sees every request core's model gateway sends; this
 * provider sends each one on to the real AI Gateway over the real AI
 * binding, as the model gateway built it, and hands the answer back for
 * the stand-in to stream to core. Core's gateway and ledger run as they
 * always do: the allowlist, the budget, the price and the charge are
 * theirs. Nothing here is a model client of its own.
 *
 * Only chat completions, the wire format of Workers AI's models, which a
 * deployment's gateway allows by default. The request goes without a
 * stream and the answer comes back whole: the stand-in streams it on.
 */
import { z } from "zod";

import type { GatewayReply, GatewayRequest } from "./ai-gateway.ts";
import type { BrainProvider } from "./brain-harness.ts";
import type { StubTurn } from "./brain-stub-model.ts";

/** What the provider needs of the AI binding: its fetch passthrough. */
export interface AiFetch {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}

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

/** The request as sent on: whole, without a stream. */
const unstreamed = (request: GatewayRequest): string => {
  if (
    !new URL(request.url).pathname.endsWith("/chat/completions") ||
    typeof request.body !== "object" ||
    request.body === null
  ) {
    throw new TypeError(
      `The real-model provider speaks chat completions only, not ${request.url}`
    );
  }
  const { stream_options: _streamOptions, ...body } = argumentsSchema.parse(
    request.body
  );
  return JSON.stringify({ ...body, stream: false });
};

const replyOf = async (
  response: Response
): Promise<{
  reply: GatewayReply;
  text: string;
  calls: ModelExchange["calls"];
}> => {
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      reply: { status: response.status, body: raw },
      text: JSON.stringify(raw),
      calls: [],
    };
  }
  const parsed = completionSchema.parse(raw);
  const [choice] = parsed.choices;
  const text = choice?.message.content ?? "";
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
      ...(choice?.finish_reason === "length" ? { truncated: true } : {}),
    },
    text,
    calls: toolCalls.map((call) => ({
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    })),
  };
};

/**
 * The provider: each request the model gateway sends goes to the real AI
 * Gateway over `ai`, and what the model said to it goes to `log`.
 */
export const gatewayProvider =
  (ai: AiFetch, log: (exchange: ModelExchange) => void): BrainProvider =>
  (turn) =>
  async (requests) => {
    const request = requests.at(-1);
    if (request === undefined) {
      throw new RangeError("No request to answer");
    }
    const started = performance.now();
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    const response = await ai.fetch(request.url, {
      method: "POST",
      headers,
      body: unstreamed(request),
      signal: request.signal,
    });
    const { reply, text, calls } = await replyOf(response);
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
