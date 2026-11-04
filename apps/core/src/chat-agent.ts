import type { Context } from "@earendil-works/chord";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { retryAssistantCall } from "@earendil-works/pi-ai/utils/retry";
import {
  AgentDoc,
  CompactionTask,
  DEFAULT_RETRY_POLICY,
  defineExtension,
  GenerationTask,
  hook,
  section,
} from "@earendil-works/pi-durable";
import type { Extension, HookApi } from "@earendil-works/pi-durable";
import { agentErrors } from "@grasp-os/shared/agent";

import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { dedicatedTools, durableTool } from "./agent-tools.ts";
import {
  askQuestions,
  executeCode,
  instructions,
  latestSections,
  readApi,
  readsUnderWay,
  resultRunId,
  sectionNames,
  sectionsOf,
  withheldAssistant,
  withheldResult,
  withholdRuns,
} from "./agent.ts";
import type { CodeRuns, TurnContext } from "./agent.ts";

// The chat agent as a pi-durable extension (GRA-1529): its tools, the
// sections of its system prompt and the hooks that keep what a chat can no
// longer read from the model. pi-durable runs the loop: the model answers
// or calls tools until it answers, the transcript is stored entry by entry,
// compacted when it grows, and a turn cut short resumes. The Workspace
// (GRA-1544) opens the Harness, installs a chat's extension for each turn,
// with what that turn runs with, and selects it for the chat's
// conversation only (`configure({ extensions: [chatAgent(...)] })`).
//
// Left out on purpose, as Claude Code and Codex do: no limit on the
// requests a turn makes, the code it runs, the dedicated tools it calls or
// the thinking it shows. A person stops a turn by cancelling it, and spend
// is recorded per request by the model gateway, not capped. Nor a request
// for an answer in words after a turn that only showed its thinking: a run
// on pi-durable never ends on such a call, as only a round whose every call
// asks to (`askQuestions`) ends a run without another request. Whether
// the person may still take a turn is the host's to check, as the gateway
// admits each request.

/** What a chat's turn runs with: the tools' APIs, whom they act for, and its guards. */
export interface ChatAgent {
  apis: readonly AgentApi[];
  /** What the model reads besides the instructions: memory, skills, channel, App. */
  context: TurnContext;
  /** Whom and where the code acts for; each run adds its own ID. */
  scope: Omit<AgentScope, "runId">;
  runs: CodeRuns;
  loader: WorkerLoader;
  /** Core's static assets, where Grasp's reference is (build-reference.ts). */
  assets: Fetcher;
  /** Where code runs on-prem, or nowhere but `loader` (`sessionHost`). */
  sandbox?: () => Fetcher | undefined;
  /** Each code run's wall-clock limit (`codeTimeoutMs`). */
  codeTimeoutMs: number;
  /**
   * The chat's transcript as the turn starts: the files it read or wrote,
   * which `editFile` may change.
   */
  history: readonly Message[];
  /** The tool that shows the turn's thinking in the brain (agent-thinking.ts), if it may. */
  thinking?: AgentTool;
  /**
   * The code runs whose results may not reach the model now (workspace.ts),
   * asked before every model request.
   */
  withheld: () => Promise<ReadonlySet<string>>;
  /** What the chat's summaries rest on, kept by the host (`SummaryRecords`). */
  summaries: SummaryRecords;
  /**
   * Stops the turn, for `reason`: a hook can't end a run itself, so the
   * host aborts the chat's conversation (`Conversation.abort`). The request
   * being prepared goes out withheld as the hook left it, or not at all.
   */
  stop: (reason: Error) => void;
}

/**
 * The code runs each of a chat's compaction summaries rests on, by the ID
 * its text names: kept by the host, as a hook can't write to pi's storage
 * and the model needn't read them. A summary whose record is missing rests
 * on everything.
 */
export interface SummaryRecords {
  keep: (id: string, runs: readonly string[]) => Promise<void>;
  runs: (id: string) => Promise<readonly string[] | undefined>;
}

/** The extension's name: one per chat, so each conversation selects only its own. */
export const chatAgentName = (chatId: string): string => `grasp.chat.${chatId}`;

/** Every code run whose result `messages` hold. */
const runsIn = (messages: readonly Message[]): Set<string> =>
  new Set(messages.flatMap((message) => resultRunId(message) ?? []));

/** The text of a user message. */
const userText = (message: Message): string => {
  if (message.role !== "user") {
    return "";
  }
  return typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
};

// A compaction's summary is the chat's own (`summarize`): it ends with an
// ID the host keeps the code runs it rests on by (`SummaryRecords`), so a
// later revocation of any of them withholds it whole. pi's summarizer can
// do neither: it reads the transcript as stored, results the chat can no
// longer read included, and says nothing of what it read.

const summaryMark = "[Summary ";

const summaryLine = (id: string): string => `${summaryMark}${id}]`;

const summaryPattern = /\[Summary (?<id>[0-9a-f-]{36})\]/gu;

/** The IDs of the summaries `message` holds: its own, and any it was folded from. */
const summaryIds = (message: Message): string[] =>
  [...userText(message).matchAll(summaryPattern)].flatMap(
    (line) => line.groups?.id ?? []
  );

/** What a summary rests on: those runs, or anything, when its record is missing. */
type RestsOn = ReadonlySet<string> | "everything";

/**
 * What each summary `messages` hold rests on, by its ID. A person who
 * typed such a line only gets their message withheld with what it names.
 */
const summariesIn = async (
  records: SummaryRecords,
  messages: readonly Message[]
): Promise<Map<string, RestsOn>> => {
  const ids = new Set(messages.flatMap(summaryIds));
  const found = await Promise.all(
    [...ids].map(async (id) => {
      const runs = await records.runs(id);
      return [id, runs === undefined ? "everything" : new Set(runs)] as const;
    })
  );
  return new Map(found);
};

/** Whether a summary resting on `on` must be withheld while `withheld` is. */
const restsOnWithheld = (
  on: RestsOn | undefined,
  withheld: ReadonlySet<string>
): boolean =>
  on === "everything"
    ? withheld.size > 0
    : [...(on ?? [])].some((id) => withheld.has(id));

/** What a summary resting on what the chat can no longer read reads as. */
export const withheldSummary =
  "(summary withheld: it rests on what this chat can no longer read)";

/**
 * `messages` with each summary that rests on a run in `withheld` read as
 * a note, and what follows it in its turn as `withholdRuns` withholds what
 * follows a result; and whether the turn under way starts at one, which
 * stops it as a withheld result of its own would.
 */
const withholdSummaries = (
  messages: readonly Message[],
  withheld: ReadonlySet<string>,
  summaries: ReadonlyMap<string, RestsOn>
): { messages: Message[]; underWay: boolean } => {
  let after = false;
  let underWay = false;
  const shown = messages.map((message): Message => {
    if (message.role === "user") {
      after = summaryIds(message).some((id) =>
        restsOnWithheld(summaries.get(id), withheld)
      );
      underWay = after;
      return after
        ? { ...message, content: [{ type: "text", text: withheldSummary }] }
        : message;
    }
    if (!after) {
      return message;
    }
    if (message.role === "toolResult") {
      return { ...message, content: [{ type: "text", text: withheldResult }] };
    }
    return message.role === "assistant" ? withheldAssistant(message) : message;
  });
  return { messages: shown, underWay };
};

/** `messages` as one request may send them while `withheld` is withheld. */
const withholding = (
  messages: readonly Message[],
  withheld: ReadonlySet<string>,
  records: ReadonlyMap<string, RestsOn>
): { messages: Message[]; underWay: boolean } => {
  const summaries = withholdSummaries(messages, withheld, records);
  return {
    messages: withholdRuns(summaries.messages, withheld),
    underWay: summaries.underWay || readsUnderWay(summaries.messages, withheld),
  };
};

/** Why a turn stops when what it may read can't be told. */
const unreadable = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new Error("What this chat may read could not be told.");

/**
 * `messages` with every result and every summary blanked, and what the
 * model wrote after a result in its turn: for when what is withheld
 * can't be told. A plain pass that can't fail on any message.
 */
const blanked = (messages: readonly Message[]): Message[] => {
  let after = false;
  return messages.map((message): Message => {
    if (message.role === "toolResult") {
      after = true;
      return { ...message, content: [{ type: "text", text: withheldResult }] };
    }
    if (message.role === "assistant") {
      return after ? withheldAssistant(message) : message;
    }
    if (message.role !== "user") {
      return message;
    }
    after = false;
    const summary =
      typeof message.content !== "string" &&
      message.content.some(
        (part) => part.type === "text" && part.text.includes(summaryMark)
      );
    return summary
      ? { ...message, content: [{ type: "text", text: withheldSummary }] }
      : message;
  });
};

/**
 * What a request may send of `messages`, and why the turn must stop, if
 * it must. Results of runs the chat can no longer read are withheld, so
 * are summaries resting on them, and each section is given only where it
 * was given last, so a stale one (memory a person lost) never reaches the
 * model. One of these in the turn under way stops the turn: the provider
 * takes the latest response whole. Never throws, as pi sends the request
 * unchanged past a hook that throws: should anything fail, every result
 * and every summary is blanked, with a plain map, and the turn stops.
 */
const guarded = async (
  agent: Pick<ChatAgent, "withheld" | "summaries">,
  messages: readonly Message[]
): Promise<{ messages: Message[]; stop?: Error }> => {
  try {
    const sent = withholding(
      messages,
      await agent.withheld(),
      await summariesIn(agent.summaries, messages)
    );
    return {
      messages: latestSections(sent.messages),
      ...(sent.underWay
        ? { stop: agentErrors.create("agent.history_revoked") }
        : {}),
    };
  } catch (error) {
    return { messages: blanked(messages), stop: unreadable(error) };
  }
};

/** Most tokens a summary takes, as pi's summarizer allows itself. */
const summaryMaxTokens = 13_000;

/** Most characters of a tool result a summary reads, as pi's summarizer does. */
const summaryResultChars = 2000;

/** The conversation a summary is made of, as plain text, system messages left out. */
const transcriptOf = (messages: readonly Message[]): string =>
  messages
    .flatMap((message) => {
      if (message.role === "user") {
        return [`[Person]: ${userText(message)}`];
      }
      if (message.role === "toolResult") {
        const text = message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        return [`[Tool result]: ${text.slice(0, summaryResultChars)}`];
      }
      if (message.role === "assistant") {
        return message.content.flatMap((part) => {
          if (part.type === "text") {
            return [`[Assistant]: ${part.text}`];
          }
          return part.type === "toolCall"
            ? [
                `[Assistant called ${part.name}]: ${JSON.stringify(part.arguments)}`,
              ]
            : [];
        });
      }
      return [];
    })
    .join("\n\n");

const summarySystem =
  "You summarize a conversation between a person and an AI assistant, so the assistant can go on from the summary alone. Don't continue the conversation or answer anything in it: write only the summary.";

const summaryAsk = (focus: string | undefined): string =>
  [
    "Summarize the conversation above as a checkpoint the assistant goes on from: what the person wants and asked, what was done and found (with exact IDs, file paths, names and error messages), what was decided, and what is still open. If it starts with an earlier summary, keep what it holds and fold the newer messages into it. Leave out what reads as withheld.",
    ...(focus === undefined ? [] : [`Also: ${focus}`]),
  ].join("\n\n");

/**
 * The summary of the part of a chat a compaction replaces, made from what
 * a request may send of it now (`withholding`), ending with its ID. What
 * it rests on is kept by that ID: the runs whose results it read, and
 * those its earlier summary rested on, less any withheld now, whose
 * content it never saw. An earlier summary that rests on everything (its
 * record lost) leaves this one without a record, so it does too. Through
 * the conversation's own model, as pi's summarizer would call it, its
 * retryable errors retried as pi retries a model request. None when the
 * model gives no summary.
 */
const summarize = async (
  agent: Pick<ChatAgent, "withheld" | "summaries">,
  part: { messages: readonly Message[]; instructions?: string },
  api: HookApi,
  context: Context
): Promise<string | undefined> => {
  const withheld = await agent.withheld();
  const agentState = await api.snapshot(AgentDoc, api.conversationId, context);
  const ref = agentState?.model;
  const model =
    ref === undefined
      ? undefined
      : api.models.getModel(ref.provider, ref.modelId);
  if (model === undefined) {
    return undefined;
  }
  const earlier = await summariesIn(agent.summaries, part.messages);
  const covered = runsIn(part.messages);
  let everything = false;
  for (const on of earlier.values()) {
    if (on === "everything") {
      everything = true;
    } else {
      for (const id of on) {
        covered.add(id);
      }
    }
  }
  const shown = withholding(part.messages, withheld, earlier).messages;
  const now = Date.now();
  const ask = async () =>
    await api.models.completeSimple(
      model,
      {
        messages: [
          { role: "system", content: summarySystem, timestamp: now },
          {
            role: "user",
            content: `<conversation>\n${transcriptOf(shown)}\n</conversation>\n\n${summaryAsk(part.instructions)}`,
            timestamp: now,
          },
        ],
      },
      {
        maxTokens:
          model.maxTokens > 0
            ? Math.min(summaryMaxTokens, model.maxTokens)
            : summaryMaxTokens,
        ...(context.abortSignal === undefined
          ? {}
          : { signal: context.abortSignal }),
      }
    );
  const answer = await retryAssistantCall(
    ask,
    DEFAULT_RETRY_POLICY,
    context.abortSignal
  );
  const text = answer.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (answer.stopReason !== "stop" || text === "") {
    return undefined;
  }
  const id = crypto.randomUUID();
  if (!everything) {
    await agent.summaries.keep(
      id,
      [...covered].filter((run) => !withheld.has(run))
    );
  }
  return `${text}\n\n${summaryLine(id)}`;
};

/**
 * A chat's agent for one turn, as a pi-durable extension: the instructions
 * and the chat's sections (each tagged by itself, as the model has always
 * read them), `executeCode` in our locked isolate, `readApi`, the
 * dedicated tools the chat's APIs allow, the thinking tool where it may,
 * `askQuestions` in Grasp's own chat only, and the guard before every
 * request.
 */
export const chatAgent = (agent: ChatAgent): Extension => {
  const { apis, scope, runs, assets } = agent;
  const sections = sectionsOf(apis, agent.context);
  const tools: AgentTool[] = [
    executeCode(agent),
    readApi(apis),
    ...dedicatedTools({ apis, scope, runs, assets }, agent.history),
    ...(agent.thinking === undefined ? [] : [agent.thinking]),
    // A chat app's chat asks in words: the questions take the composer's
    // place, which only Grasp's own chat has.
    ...(agent.context.channel === undefined ? [askQuestions()] : []),
  ];
  return defineExtension({
    name: chatAgentName(scope.chatId),
    tools: tools.map((tool) => durableTool(tool)),
    sections: [
      // Not `instructions`, the key of a conversation's own, which pi renders last.
      section("preamble", () => instructions, { tag: false }),
      ...sectionNames.map((name) =>
        section(name, () => sections[name] ?? undefined, { tag: false })
      ),
    ],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }) => {
          const sent = await guarded(agent, messages);
          if (sent.stop !== undefined) {
            try {
              agent.stop(sent.stop);
            } catch {
              // The request still goes out withheld.
            }
          }
          return { messages: sent.messages };
        },
      }),
      // Every compaction is summarized here, from what a request may send,
      // or declined: pi's own summarizer, which a hook that throws falls
      // back to, would read what the chat can no longer read.
      hook(CompactionTask, {
        beforeCompact: async (part, api, context) => {
          try {
            const summary = await summarize(agent, part, api, context);
            return summary === undefined ? { decline: true } : { summary };
          } catch {
            return { decline: true };
          }
        },
      }),
    ],
  });
};
