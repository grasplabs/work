import type { BrainTask } from "./fixtures/brain-tasks.ts";
/**
 * How a stand-in model reads what reached it: the turn a harness asks for
 * (`StubTurn`), a request's strings and transcript, and what came back
 * since the question, for Stephen's stub and experiment E02. The Brain
 * baseline's stand-in model, which searched Knowledge, went with that
 * reach (GRA-1735).
 */

/** What the harness is asking the agent for right now. */
export type StubTurn =
  | {
      phase: "prior";
      /**
       * Searches Knowledge for this first, as the agent arm does, then
       * notes what was said: an earlier turn that reads.
       */
      reads?: string;
    }
  | {
      phase: "question";
      task: BrainTask;
      /** The agent arm: no sources given, so it searches for them. */
      searches: boolean;
      /** The trial's arm or control, for a provider that reports by arm. */
      arm?: string;
    };

/** Sections each search reads, in the agent arm as in the full-text arm. */
export const searchedSections = 5;

/** The code result's prefix, as the agent hands it back to the model. */
const returned = "Returned:\n";

/** A code result's value, when it returned a string: as the model reads it. */
const returnedText = (text: string): string => {
  if (!text.startsWith(returned)) {
    return text;
  }
  try {
    const value: unknown = JSON.parse(text.slice(returned.length));
    return typeof value === "string" ? value : text;
  } catch {
    return text;
  }
};

/** Every string in a request's body: all the model was sent. */
export const modelStrings = (body: unknown): string[] => {
  if (typeof body === "string") {
    return [returnedText(body)];
  }
  if (Array.isArray(body)) {
    return body.flatMap((item: unknown) => modelStrings(item));
  }
  if (typeof body === "object" && body !== null) {
    return Object.values(body).flatMap((value: unknown) => modelStrings(value));
  }
  return [];
};

interface Block {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  tool_use_id?: unknown;
}

/**
 * A message of a request, in either wire format it reads: Anthropic's,
 * where tool results are blocks of a person's message, or chat
 * completions' (Mistral's and OpenRouter's), where each is a
 * message of its own that names its call, the model's calls ride beside
 * its text, and the system prompt is the first message.
 */
interface WireMessage {
  role: unknown;
  content: unknown;
  /** Chat completions: the call a tool message answers. */
  call?: string;
  /** Chat completions: the calls the model made in this message. */
  calls?: unknown;
}

/** The roles chat completions give the system prompt. */
const systemRoles: ReadonlySet<unknown> = new Set(["system", "developer"]);

const messagesOf = (body: unknown): WireMessage[] => {
  if (typeof body !== "object" || body === null || !("messages" in body)) {
    return [];
  }
  const { messages } = body;
  return Array.isArray(messages)
    ? messages.flatMap((message: unknown): WireMessage[] =>
        typeof message === "object" && message !== null && "role" in message
          ? [
              {
                role: message.role,
                content: "content" in message ? message.content : undefined,
                ...("tool_call_id" in message &&
                typeof message.tool_call_id === "string"
                  ? { call: message.tool_call_id }
                  : {}),
                ...("tool_calls" in message &&
                message.tool_calls !== undefined &&
                message.tool_calls !== null
                  ? { calls: message.tool_calls }
                  : {}),
              },
            ]
          : []
      )
    : [];
};

/**
 * What the model's calls in a chat completions message say: each call's
 * arguments, which come as a JSON string, read as the object they encode.
 */
const callsText = (calls: unknown): string =>
  modelStrings(
    Array.isArray(calls)
      ? calls.map((call: unknown) => {
          if (
            typeof call !== "object" ||
            call === null ||
            !("function" in call) ||
            typeof call.function !== "object" ||
            call.function === null ||
            !("arguments" in call.function) ||
            typeof call.function.arguments !== "string"
          ) {
            return call;
          }
          try {
            const decoded: unknown = JSON.parse(call.function.arguments);
            return decoded;
          } catch {
            return call.function.arguments;
          }
        })
      : calls
  ).join("\n");

/**
 * The request's system prompt: Anthropic's `system`, or the system
 * messages of chat completions.
 */
const systemTextOf = (body: unknown): string =>
  [
    ...modelStrings(
      typeof body === "object" && body !== null && "system" in body
        ? body.system
        : undefined
    ),
    ...messagesOf(body)
      .filter(({ role }) => systemRoles.has(role))
      .flatMap(({ content }) => modelStrings(content)),
  ].join("\n");

const blocksOf = (content: unknown): Block[] => {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content)
    ? content.filter(
        (block: unknown): block is Block =>
          typeof block === "object" && block !== null
      )
    : [];
};

/** A part of what the model was sent, and who wrote it. */
export interface TranscriptPart {
  /**
   * `model` for its own earlier answers and code; `tool` for what its code
   * returned, which holds whatever the code made; `source` for the rest:
   * the system prompt, what the person said and the sources given.
   */
  by: "source" | "tool" | "model";
  text: string;
  /** For a tool result: the call that returned it. */
  call?: string;
  /**
   * For a tool result: what the Knowledge reads made while its call's
   * step ran returned, the only text that can back evidence in it.
   */
  backing?: readonly string[];
}

/**
 * A request as the model read it, in order: the system prompt, then each
 * message, the model's own apart from what the person said, the sources
 * given and what tools returned.
 */
export const transcriptOf = (body: unknown): TranscriptPart[] => [
  { by: "source", text: systemTextOf(body) },
  ...messagesOf(body).flatMap(
    ({ role, content, call, calls }): TranscriptPart[] => {
      if (systemRoles.has(role)) {
        return [];
      }
      if (role === "tool") {
        const text = modelStrings(content).join("\n");
        return [
          call === undefined
            ? { by: "tool", text }
            : { by: "tool", text, call },
        ];
      }
      const parts = blocksOf(content).map((block): TranscriptPart => {
        const text = modelStrings(block).join("\n");
        if (role === "assistant") {
          return { by: "model", text };
        }
        if (block.type !== "tool_result") {
          return { by: "source", text };
        }
        return typeof block.tool_use_id === "string"
          ? { by: "tool", text, call: block.tool_use_id }
          : { by: "tool", text };
      });
      return calls === undefined
        ? parts
        : [...parts, { by: "model", text: callsText(calls) }];
    }
  ),
];

/** The tool results the model got since the person last wrote. */
export const resultsSinceQuestion = (body: unknown): string[] => {
  const messages = messagesOf(body);
  const asked = messages.findLastIndex(
    ({ role, content }) =>
      role === "user" && blocksOf(content).some(({ type }) => type === "text")
  );
  return messages
    .slice(asked + 1)
    .flatMap(({ role, content }) =>
      role === "tool"
        ? [content]
        : blocksOf(content)
            .filter(({ type }) => type === "tool_result")
            .map((block) => block.content)
    )
    .flatMap((content) => modelStrings(content));
};
