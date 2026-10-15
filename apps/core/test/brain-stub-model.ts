/**
 * The model provider of the Brain baseline's CI run (GRA-295): a stand-in
 * behind AI Gateway, the one outside system the run mocks. It reads like a
 * careful model that can't reason past its context: it answers a task when
 * every piece of the task's evidence reached it, citing that evidence, and
 * abstains otherwise. In the agent arm it first runs code that searches
 * Knowledge, as a model would. It never follows instructions it reads in
 * a document, such as the supplier note's injection: whether a real model
 * does is what a real run's security gate measures.
 *
 * What it measures is therefore whether each arm got the right context to
 * the model, within the platform's permissions, and what that cost: not
 * how well a model answers. A real model's run replaces it.
 */
import type { GatewayReply, GatewayRequest } from "./ai-gateway.ts";
import { normalized } from "./brain-scoring.ts";
import type { BrainTask } from "./fixtures/brain-tasks.ts";

/** Identifies the stub in a run's identity, as a model ID would. */
export const brainStubModel = "brain-stub-reader/2026-10-15";

/** What the harness is asking the agent for right now. */
export type StubTurn =
  | { phase: "prior" }
  | {
      phase: "question";
      task: BrainTask;
      /** The agent arm: no sources given, so it searches for them. */
      searches: boolean;
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
}

const messagesOf = (body: unknown): { role: unknown; content: unknown }[] => {
  if (typeof body !== "object" || body === null || !("messages" in body)) {
    return [];
  }
  const { messages } = body;
  return Array.isArray(messages)
    ? messages.flatMap((message: unknown) =>
        typeof message === "object" && message !== null && "role" in message
          ? [
              {
                role: message.role,
                content: "content" in message ? message.content : undefined,
              },
            ]
          : []
      )
    : [];
};

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
}

/**
 * A request as the model read it, in order: the system prompt, then each
 * message, the model's own apart from what the person said, the sources
 * given and what tools returned.
 */
export const transcriptOf = (body: unknown): TranscriptPart[] => [
  {
    by: "source",
    text: modelStrings(
      typeof body === "object" && body !== null && "system" in body
        ? body.system
        : undefined
    ).join("\n"),
  },
  ...messagesOf(body).flatMap(({ role, content }) =>
    blocksOf(content).map((block): TranscriptPart => {
      const text = modelStrings(block).join("\n");
      if (role === "assistant") {
        return { by: "model", text };
      }
      return { by: block.type === "tool_result" ? "tool" : "source", text };
    })
  ),
];

/** The tool results the model got since the person last wrote. */
const resultsSinceQuestion = (body: unknown): string[] => {
  const messages = messagesOf(body);
  const asked = messages.findLastIndex(
    ({ role, content }) =>
      role === "user" && blocksOf(content).some(({ type }) => type === "text")
  );
  return messages
    .slice(asked + 1)
    .flatMap(({ content }) =>
      blocksOf(content).filter(({ type }) => type === "tool_result")
    )
    .flatMap(({ content }) => modelStrings(content));
};

const tokensOf = (text: string): number => Math.ceil(text.length / 4);

const codeStep = (code: string, input: string): GatewayReply => ({
  text: "",
  toolCalls: [
    {
      id: `call_${crypto.randomUUID()}`,
      name: "executeCode",
      arguments: { code },
    },
  ],
  inputTokens: tokensOf(input),
  outputTokens: tokensOf(code),
});

const says = (text: string, input: string): GatewayReply => ({
  text,
  inputTokens: tokensOf(input),
  outputTokens: tokensOf(text),
});

/** The agent arm's search: the best sections for `query`, read whole. */
const searchCode = (
  query: string
): string => `export default async (self, env) => {
  const { hits } = await env.knowledge.search(${JSON.stringify(query)}, { limit: ${searchedSections} });
  const units = [];
  for (const hit of hits) {
    const read = await env.knowledge.read(hit.documentId, { section: hit.section });
    units.push("[source: " + read.path + "#" + (read.section?.headings.at(-1) ?? "") + "]\\n" + read.text);
  }
  return units.join("\\n\\n");
};`;

const abstention = "ABSTAIN: the sources I can read don't answer this.";

/** The answer to `task` given what reached the model, `input`. */
const answerOf = (task: BrainTask, input: string): string => {
  const { expect } = task;
  if (expect.kind === "abstain") {
    return abstention;
  }
  const seen = normalized(input);
  const found = expect.evidence.every(({ marker }) =>
    seen.includes(normalized(marker))
  );
  if (!found) {
    return abstention;
  }
  const facts = expect.facts.map(([first = ""]) => first).join("; ");
  const cited = expect.evidence.map(({ source }) => `[${source}]`).join(" ");
  return `ANSWER: ${facts}\nFrom ${cited}`;
};

/**
 * The stub provider: answers each gateway request for the turn `current`
 * says the harness is in.
 */
export const stubReader =
  (current: () => StubTurn) =>
  (requests: readonly GatewayRequest[]): GatewayReply => {
    const body = requests.at(-1)?.body;
    const input = modelStrings(body).join("\n");
    const turn = current();
    if (turn.phase === "prior") {
      return says("Noted.", input);
    }
    const results = resultsSinceQuestion(body);
    if (turn.searches && results.length === 0) {
      return codeStep(searchCode(turn.task.query), input);
    }
    return says(answerOf(turn.task, input), input);
  };
