/**
 * The model provider behind connect, as core's tests script it: the
 * organization connects a provider with a key of the test's own, and
 * chooses its models (`answeringProvider`); every request core's gateway
 * sends through connect with that key reaches the providers fake
 * (test/ai-providers-fake.ts), which hands it to the test (its bridge).
 * The test answers each with the next scripted reply, in the wire format
 * of the provider's API the request went to, and keeps every request it
 * got. Core, connect, the ledger and the audit log are real; only the
 * provider is faked.
 */
import { aiProviderIdSchema } from "@grasp-os/shared/ai-providers";
import type { AiProviderId } from "@grasp-os/shared/ai-providers";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { aiModelsKind } from "../src/ai-model-choice.ts";
import { orgSettings } from "../src/db/core/schema.ts";
import { bridgeUrl, compatibleHost } from "./ai-providers-fake.ts";
import type { BridgeCommand, BridgedRequest } from "./ai-providers-fake.ts";
import { relabelled } from "./drawing-labels.ts";
import { testBinding } from "./test-env.ts";

/** A tool call the model makes in a scripted answer. */
export interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A scripted answer; a refusal with an HTTP status and the provider's error
 * type; or no answer at all until the request is aborted.
 */
export type ProviderReply =
  | {
      text: string;
      /** Tool calls after the text; the answer then stops for them. */
      toolCalls?: ScriptedToolCall[];
      inputTokens: number;
      /** The answer's tokens, its thinking's among them. */
      outputTokens: number;
      /**
       * What the model thought before it answered, streamed first, and how
       * many of `outputTokens` it took: providers count thinking as output.
       */
      thinking?: {
        text: string;
        tokens: number;
        /** Anthropic's signature of the thinking, `signed` if not given. */
        signature?: string;
        /**
         * Streams the thinking, then waits for `until` before it ends
         * (Anthropic): a model caught thinking.
         */
        pause?: { until: Promise<unknown> };
      };
      /** The model hit its output limit (Anthropic and chat completions). */
      truncated?: boolean;
      /**
       * Streams the text's first `at` characters, then waits for `until`
       * before the rest (Anthropic and chat completions): an answer caught
       * mid-stream. `reached` is called when the stream gets there, its
       * first characters delivered.
       */
      pause?: { at: number; until: Promise<unknown>; reached?: () => void };
      /**
       * Streams the text's first `cut` characters, then closes the stream
       * with nothing after them, neither an end nor a count (Anthropic and
       * chat completions): an answer that breaks off.
       */
      cut?: number;
      /**
       * Ends whole, but with no usage chunk (chat completions): a provider
       * that never sent its count.
       */
      noUsage?: boolean;
      /** Prompt tokens written to a one-hour cache (Anthropic). */
      cacheWrite1h?: number;
      /** The model declined to answer (Anthropic's `refusal` stop). */
      refused?: true;
      /**
       * Prompt tokens read from and written to the cache (Anthropic),
       * besides `inputTokens`; with `cacheWrite1h`, `write` counts both
       * lifetimes.
       */
      cache?: { read: number; write: number };
    }
  | {
      status: number;
      errorType?: string;
      /** The refusal's body, when not the provider's usual error. */
      body?: unknown;
      /** Headers of the refusal, such as a rate limit's `retry-after`. */
      headers?: Record<string, string>;
    }
  | { hang: true };

/** One request that reached the provider, as the test read it. */
export interface SentRequest {
  url: string;
  headers: Headers;
  body: unknown;
  /** Its signal: aborted once its caller went away. */
  signal: AbortSignal;
}

const encoder = new TextEncoder();

/** One server-sent event, with its SSE event name. */
interface StreamEvent {
  event?: string;
  data: unknown;
}

/** Where a stream stops until the promise settles (`pause`). */
interface StreamPause {
  until: Promise<unknown>;
  reached?: () => void;
}

const sse = ({ event, data }: StreamEvent): Uint8Array =>
  encoder.encode(
    [
      ...(event === undefined ? [] : [`event: ${event}`]),
      `data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
      "",
      "",
    ].join("\n")
  );

/** A scripted answer, as opposed to a refusal or a hang. */
export type Answer = Extract<ProviderReply, { text: string }>;

/** How the answer stopped, as `[end_turn, max_tokens, tool_use]` name it. */
const stopOf = (
  { toolCalls, truncated }: Answer,
  [stop, length, toolUse]: readonly [string, string, string]
): string => {
  if (truncated === true) {
    return length;
  }
  return (toolCalls ?? []).length > 0 ? toolUse : stop;
};

/** A text block's deltas: the text, or its two parts either side of a pause. */
const textDeltas = (
  index: number,
  text: string,
  pause: Answer["pause"]
): (StreamEvent | StreamPause)[] => {
  const delta = (part: string): StreamEvent => ({
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: part },
    },
  });
  return pause === undefined
    ? [delta(text)]
    : [delta(text.slice(0, pause.at)), pause, delta(text.slice(pause.at))];
};

/** A content block of Anthropic's, as its stream opens it. */
type AnthropicBlock =
  | {
      type: "thinking";
      text: string;
      signature: string;
      pause?: StreamPause;
    }
  | { type: "text"; text: string }
  | ({ type: "tool_use" } & ScriptedToolCall);

const blockStart = (block: AnthropicBlock): object => {
  if (block.type === "thinking") {
    return { type: "thinking", thinking: "" };
  }
  return block.type === "text"
    ? { type: "text", text: "" }
    : { type: "tool_use", id: block.id, name: block.name, input: {} };
};

const anthropicEvents = (answer: Answer): (StreamEvent | StreamPause)[] => {
  const { text, inputTokens, outputTokens, thinking } = answer;
  const blocks = [
    ...(thinking === undefined
      ? []
      : [
          {
            type: "thinking" as const,
            text: thinking.text,
            signature: thinking.signature ?? "signed",
            pause: thinking.pause,
          },
        ]),
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...(answer.toolCalls ?? []).map((call) => ({
      type: "tool_use" as const,
      ...call,
    })),
  ];
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: 0,
            ...(answer.cache === undefined
              ? {}
              : {
                  cache_read_input_tokens: answer.cache.read,
                  cache_creation_input_tokens: answer.cache.write,
                }),
            ...(answer.cacheWrite1h === undefined
              ? {}
              : {
                  cache_creation_input_tokens:
                    answer.cache?.write ?? answer.cacheWrite1h,
                  cache_creation: {
                    ephemeral_1h_input_tokens: answer.cacheWrite1h,
                  },
                }),
          },
        },
      },
    },
    ...blocks.flatMap((block, index) => [
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: blockStart(block),
        },
      },
      ...(block.type === "text"
        ? textDeltas(index, block.text, answer.pause)
        : []),
      ...(block.type === "thinking"
        ? [
            {
              event: "content_block_delta",
              data: {
                type: "content_block_delta",
                index,
                delta: { type: "thinking_delta", thinking: block.text },
              },
            },
            ...(block.pause === undefined ? [] : [block.pause]),
            {
              event: "content_block_delta",
              data: {
                type: "content_block_delta",
                index,
                delta: {
                  type: "signature_delta",
                  signature: block.signature,
                },
              },
            },
          ]
        : []),
      ...(block.type === "tool_use"
        ? [
            {
              event: "content_block_delta",
              data: {
                type: "content_block_delta",
                index,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.arguments),
                },
              },
            },
          ]
        : []),
      {
        event: "content_block_stop",
        data: { type: "content_block_stop", index },
      },
    ]),
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason:
            answer.refused === true
              ? "refusal"
              : stopOf(answer, ["end_turn", "max_tokens", "tool_use"]),
          stop_sequence: null,
        },
        usage: { output_tokens: outputTokens },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
};

const chunk = (fields: object) => ({
  data: {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "model",
    ...fields,
  },
});

const chatCompletionEvents = (
  answer: Answer
): (StreamEvent | StreamPause)[] => {
  const { text, inputTokens, outputTokens, pause, thinking, noUsage } = answer;
  const content = (part: string): StreamEvent =>
    chunk({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: part },
          finish_reason: null,
        },
      ],
    });
  return [
    ...(thinking === undefined
      ? []
      : [
          chunk({
            choices: [
              {
                index: 0,
                delta: { role: "assistant", reasoning_content: thinking.text },
                finish_reason: null,
              },
            ],
          }),
        ]),
    ...(pause === undefined
      ? [content(text)]
      : [
          content(text.slice(0, pause.at)),
          pause,
          content(text.slice(pause.at)),
        ]),
    ...(answer.toolCalls ?? []).map((call, index) =>
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    ),
    chunk({
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: stopOf(answer, ["stop", "length", "tool_calls"]),
        },
      ],
    }),
    ...(noUsage === true
      ? []
      : [
          chunk({
            choices: [],
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
              completion_tokens_details: {
                reasoning_tokens: thinking?.tokens ?? 0,
              },
            },
          }),
        ]),
    { data: "[DONE]" },
  ];
};

const responsesEvents = ({
  text,
  toolCalls,
  inputTokens,
  outputTokens,
  thinking,
}: Answer) => {
  const message = { type: "message", id: "msg_1", role: "assistant" };
  const reasoning = { type: "reasoning", id: "rs_1" };
  const items = [
    ...(thinking === undefined
      ? []
      : [
          {
            added: { ...reasoning, summary: [] },
            deltas: [
              {
                type: "response.reasoning_summary_text.delta",
                summary_index: 0,
                delta: thinking.text,
              },
            ],
            done: {
              ...reasoning,
              summary: [{ type: "summary_text", text: thinking.text }],
            },
          },
        ]),
    ...(text === ""
      ? []
      : [
          {
            added: { ...message, content: [] },
            deltas: [
              {
                type: "response.output_text.delta",
                content_index: 0,
                delta: text,
              },
            ],
            done: {
              ...message,
              content: [{ type: "output_text", text, annotations: [] }],
            },
          },
        ]),
    ...(toolCalls ?? []).map((call, index) => {
      const item = {
        type: "function_call",
        id: `fc_${index}`,
        call_id: call.id,
        name: call.name,
      };
      const args = JSON.stringify(call.arguments);
      return {
        added: { ...item, arguments: "" },
        deltas: [
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            delta: args,
          },
        ],
        done: { ...item, arguments: args },
      };
    }),
  ];
  return [
    {
      data: {
        type: "response.created",
        response: { id: "resp_1", status: "in_progress" },
      },
    },
    ...items.flatMap(({ added, deltas, done }, index) => [
      {
        data: {
          type: "response.output_item.added",
          output_index: index,
          item: added,
        },
      },
      ...deltas.map((delta) => ({ data: { ...delta, output_index: index } })),
      {
        data: {
          type: "response.output_item.done",
          output_index: index,
          item: done,
        },
      },
    ]),
    {
      data: {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            output_tokens_details: { reasoning_tokens: thinking?.tokens ?? 0 },
          },
        },
      },
    },
  ];
};

/**
 * The whole stream `api` sends for `answer`, as text, its pauses left out,
 * or only its beginning for one that breaks off (`cut`): what a provider's
 * own API answers (test/ai-providers-fake.ts).
 */
export const streamText = (
  api: "anthropic-messages" | "openai-completions" | "openai-responses",
  answer: Answer
): string => {
  const { cut } = answer;
  // An answer that breaks off: only the events up to its first text.
  const begun = { ...answer, text: answer.text.slice(0, cut), toolCalls: [] };
  let events: (StreamEvent | StreamPause)[] = [];
  if (api === "anthropic-messages") {
    events =
      cut === undefined
        ? anthropicEvents(answer)
        : anthropicEvents(begun).slice(0, 3);
  } else if (api === "openai-completions") {
    events =
      cut === undefined
        ? chatCompletionEvents(answer)
        : chatCompletionEvents(begun).slice(0, 1);
  } else {
    const all: (StreamEvent | StreamPause)[] = responsesEvents(
      cut === undefined ? answer : begun
    );
    const firstText = all.findIndex(
      (item) =>
        "data" in item &&
        JSON.stringify(item.data).includes("response.output_text.delta")
    );
    events = cut === undefined ? all : all.slice(0, firstText + 1);
  }
  const decoder = new TextDecoder();
  return events
    .filter((item): item is StreamEvent => !("until" in item))
    .map((item) => decoder.decode(sse(item)))
    .join("");
};

/** The events `answer` streams as, by the API the request's path names. */
const eventsFor = (
  path: string,
  answer: Answer
): (StreamEvent | StreamPause)[] | undefined => {
  const { cut } = answer;
  // An answer that breaks off: only the events up to its first text.
  const begun = { ...answer, text: answer.text.slice(0, cut), toolCalls: [] };
  const { pathname } = new URL(path, "https://provider.test");
  if (pathname.endsWith("/messages")) {
    return cut === undefined
      ? anthropicEvents(answer)
      : anthropicEvents(begun).slice(0, 3);
  }
  if (pathname.endsWith("/chat/completions")) {
    return cut === undefined
      ? chatCompletionEvents(answer)
      : chatCompletionEvents(begun).slice(0, 1);
  }
  if (pathname.endsWith("/responses")) {
    return responsesEvents(answer);
  }
  return undefined;
};

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The Worker standing in for the internet behind connect. */
const internet = (): Fetcher => {
  const binding = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(binding)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return binding;
};

/** Tells the fake how to answer the bridged request `id`. */
const command = async (
  id: string,
  commands: BridgeCommand[]
): Promise<void> => {
  const response = await internet().fetch(bridgeUrl, {
    method: "POST",
    body: JSON.stringify({ id, commands }),
  });
  await response.body?.cancel();
};

/** Answers the bridged request `id`, which asked at `path`, with `reply`. */
const answerWith = async (
  id: string,
  path: string,
  reply: ProviderReply
): Promise<void> => {
  if ("hang" in reply) {
    // No answer: the request waits until its caller goes away.
    return;
  }
  if ("status" in reply) {
    // As Anthropic words it; pi quotes OpenAI's inner `error` the same way.
    await command(id, [
      {
        status: reply.status,
        headers: reply.headers ?? {},
        body: reply.body ?? {
          type: "error",
          error: {
            type: reply.errorType ?? "api_error",
            message: "Refused by the fake provider",
          },
        },
      },
    ]);
    return;
  }
  const events = eventsFor(path, reply);
  if (events === undefined) {
    await command(id, [{ status: 404, body: { error: "No such route" } }]);
    return;
  }
  const decoder = new TextDecoder();
  let pending: BridgeCommand[] = [{ open: {} }];
  let text = "";
  const flush = async () => {
    if (text !== "") {
      pending.push({ write: text });
      text = "";
    }
    if (pending.length > 0) {
      await command(id, pending);
      pending = [];
    }
  };
  for (const item of events) {
    if ("until" in item) {
      // oxlint-disable-next-line no-await-in-loop -- what came before is sent first
      await flush();
      item.reached?.();
      // oxlint-disable-next-line no-await-in-loop -- paused where told
      await item.until;
    } else {
      text += decoder.decode(sse(item));
    }
  }
  pending.push(...(text === "" ? [] : [{ write: text }]), { end: true });
  text = "";
  await flush();
};

/** What a look at the bridge finds: new requests, and those gone. */
const lookSchema = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      host: z.string(),
      method: z.string(),
      path: z.string(),
      headers: z.record(z.string(), z.string()),
      body: z.string(),
    })
  ),
  gone: z.array(z.string()),
});

/** How often the test looks for requests that reached the provider. */
const pollMs = 10;

/** The bridges still looking, stopped when the next starts or the file ends. */
const running = new Set<() => void>();

/** Stops every bridge still looking (test/start-each-file.ts, at a file's end). */
export const stopModelProviders = (): void => {
  for (const stop of running) {
    stop();
  }
  running.clear();
};

/** The model the tests use unless they choose others. */
export const testModel = "anthropic/claude-sonnet-4-5";

/** The organization's admin the tests name as changing its keys in connect. */
export const keyChanger = { type: "person", userId: "test-admin" } as const;

/** Where an organization's OpenAI-compatible endpoint is in the tests. */
export const compatibleBaseUrl = `https://${compatibleHost}/v1`;

/**
 * Connects every provider of `models` with `key`, as an organization's
 * admin adds its keys (connect seals them), and chooses `models`: the
 * first the default, the rest its fallbacks, in order.
 */
export const connectModels = async (
  key: string,
  models: readonly string[]
): Promise<void> => {
  const providers = new Set<AiProviderId>(
    models.map((model) =>
      aiProviderIdSchema.parse(model.slice(0, model.indexOf("/")))
    )
  );
  for (const provider of providers) {
    // oxlint-disable-next-line no-await-in-loop -- one key at a time, as an admin adds them
    await env.CONNECT.saveAiProviderKey(
      provider === "openai-compatible"
        ? { provider, key, baseUrl: compatibleBaseUrl }
        : { provider, key },
      keyChanger
    );
  }
  const [defaultModel, ...fallbacks] = models;
  if (defaultModel === undefined) {
    return;
  }
  const value = JSON.stringify({ defaultModel, fallbacks });
  await drizzle(env.DB)
    .insert(orgSettings)
    .values({ kind: aiModelsKind, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: orgSettings.kind,
      set: { value, updatedAt: new Date() },
    });
};

/**
 * Replies to core's own calls about Stephen's requests (sorting one,
 * proposing a fix: src/channels/request-sorting.ts, src/stephen-requests.ts),
 * in the order a test queued them, apart from every provider's script;
 * once none is left, a sorting that sorts nothing.
 */
export const stephenRequestReplies: ProviderReply[] = [];

const sortsNothing: ProviderReply = {
  text: JSON.stringify({
    topic: null,
    newTopic: null,
    question: null,
    newQuestion: null,
    role: null,
    answered: true,
  }),
  inputTokens: 10,
  outputTokens: 10,
};

/**
 * How core's calls about Stephen's requests begin their instructions: the
 * provider sees no purpose, only the request, so the fake knows them by
 * what they ask.
 */
const stephenRequestsOpenings = [
  "You sort one message a person sent to Stephen",
  "You help the owner of a company's Grasp workspace improve Stephen",
];

/** Whether a request's body is one of core's own about Stephen's requests. */
const isStephenRequests = (body: unknown): boolean => {
  const text = JSON.stringify(body) ?? "";
  return stephenRequestsOpenings.some((opening) => text.includes(opening));
};

/** A provider the tests answer for, and what reached it. */
export interface FakeProvider {
  /** The key the organization connected it with. */
  key: string;
  /** The models the organization chose, the default first. */
  models: readonly string[];
  /** Every request that reached it, oldest first, as they come. */
  requests: SentRequest[];
}

/**
 * Connects a provider for `models` (`connectModels`), with a key no other
 * test uses, and answers each request that reaches it with what `respond`
 * makes of it, given the requests so far, this one last: at once, or once
 * whatever it waits for has come. Answers until another starts, or the
 * test file ends.
 */
export const answeringProvider = async (
  respond: (
    requests: readonly SentRequest[]
  ) => ProviderReply | undefined | Promise<ProviderReply | undefined>,
  { models = [testModel] }: { models?: readonly string[] } = {}
): Promise<FakeProvider> => {
  stopModelProviders();
  const key = `test-model-key-${crypto.randomUUID()}`;
  const bridged = await internet().fetch(bridgeUrl, {
    method: "POST",
    body: JSON.stringify({ key }),
  });
  await bridged.body?.cancel();
  await connectModels(key, models);
  const requests: SentRequest[] = [];
  const cutOff = new Map<string, AbortController>();
  const state = { stopped: false };
  const stop = () => {
    state.stopped = true;
  };
  running.add(stop);
  const answer = async (taken: BridgedRequest): Promise<void> => {
    let body: unknown = undefined;
    try {
      body = JSON.parse(taken.body);
    } catch {
      ({ body } = taken);
    }
    // Stephen's request sorting answers apart from the test's script, as
    // it isn't part of the turn the script is written for.
    if (isStephenRequests(body)) {
      await answerWith(
        taken.id,
        taken.path,
        stephenRequestReplies.shift() ?? sortsNothing
      );
      return;
    }
    const controller = new AbortController();
    cutOff.set(taken.id, controller);
    requests.push({
      url: `https://${taken.host}${taken.path}`,
      headers: new Headers(taken.headers),
      body,
      signal: controller.signal,
    });
    const reply = await relabelled(await respond(requests), body);
    // None left: refused, as a provider that failed (the call fails).
    await answerWith(
      taken.id,
      taken.path,
      reply ?? {
        status: 500,
        body: { error: "The fake provider has no reply left" },
      }
    );
  };
  /** Answers `taken`, or refuses it when its scripted reply failed to come. */
  const answerOrRefuse = async (taken: BridgedRequest): Promise<void> => {
    try {
      await answer(taken);
    } catch {
      try {
        await command(taken.id, [{ status: 500 }]);
      } catch {
        // The request is gone already.
      }
    }
  };
  const look = async (): Promise<void> => {
    while (!state.stopped) {
      // oxlint-disable-next-line no-await-in-loop -- one look at a time
      const response = await internet().fetch(
        `${bridgeUrl}?key=${encodeURIComponent(key)}`
      );
      const { requests: fresh, gone } = lookSchema.parse(
        // oxlint-disable-next-line no-await-in-loop -- one look at a time
        await response.json()
      );
      for (const id of gone) {
        cutOff.get(id)?.abort(new Error("The request was aborted"));
      }
      // In order, each answered on its own: a paused answer holds up no other.
      for (const taken of fresh) {
        void answerOrRefuse(taken);
      }
      // oxlint-disable-next-line no-await-in-loop -- between looks
      await scheduler.wait(pollMs);
    }
  };
  void look();
  return { key, models, requests };
};

/**
 * A provider for `models` (`answeringProvider`) that answers with
 * `replies`, in order.
 */
export const fakeProvider = async (
  ...replies: ProviderReply[]
): Promise<FakeProvider> => await answeringProvider(() => replies.shift());

/**
 * A provider for `models` that answers with `replies`, in order: the
 * models chosen first.
 */
export const fakeProviderFor = async (
  models: readonly string[],
  ...replies: ProviderReply[]
): Promise<FakeProvider> =>
  await answeringProvider(() => replies.shift(), { models });
