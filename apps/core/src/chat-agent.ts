import type { Context } from "@earendil-works/chord";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import {
  estimateContextTokens,
  estimateMessageTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import {
  CompactionEntry,
  CompactionTask,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ResetEntry,
  section,
  SystemEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import type {
  Conversation,
  EntryId,
  EntryRecord,
  Extension,
  HookApi,
} from "@earendil-works/pi-durable";
import { agentErrors } from "@grasp-os/shared/agent";
import { z } from "zod";

import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { dedicatedTools, durableTool } from "./agent-tools.ts";
import {
  askQuestions,
  executeCode,
  instructions,
  latestSections,
  filesNoteText,
  readApi,
  resultRunId,
  sectionNames,
  sectionsOf,
  withheldAssistant,
  withheldResult,
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
//
// What the chat can no longer read never reaches the model, and the chat
// keeps its context: once a code run whose result the chat holds read
// what its agent may no longer read for its person (a revoked grant, a
// team left, a document erased), the host starts the chat's context afresh
// with a pi reset and appends the chat's history again after it, each
// entry as it was but that run's result, and what the model wrote after it
// in its turn, as a note (`rebase`). Nothing from before the reset is sent
// again, a summary pi made of it included; pi's own compaction summarizes
// the history again as it needs to, from what may be read. Until the host
// has done so, no request carries what the chat read and no compaction
// summarizes it: pi's hooks can't append to a transcript, only the host can.

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
   * The code runs whose results the chat may no longer send (workspace.ts),
   * asked before every model request and every compaction.
   */
  withheld: () => Promise<ReadonlySet<string>>;
  /**
   * Stops the turn, for `reason`: a hook can't end a run itself, so the
   * host aborts the chat's conversation (`Conversation.abort`), and for
   * `agent.history_revoked` rebases its context (`rebase`). The request
   * being prepared goes out with nothing the chat read.
   */
  stop: (reason: Error) => void;
}

/** The extension's name: one per chat, so each conversation selects only its own. */
export const chatAgentName = (chatId: string): string => `grasp.chat.${chatId}`;

/**
 * Where a conversation's context starts (`rebase`): the reset of its last
 * rebase, the runs whose results it left out, and whether a rebase is
 * under way, one a restart cut short being done again.
 */
const BaseDoc = defineDoc<{
  base: EntryId | null;
  dropped: string[];
  rebasing: boolean;
}>({
  kind: "grasp.base",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ base: null, dropped: [], rebasing: false }),
  checkpointWhen: () => true,
});

/** An entry of the history a rebase appended again, with its own kind as `data`. */
export const historyKind = "grasp.history";

/** A person's question: it starts a turn. */
export const questionKind = "grasp.question";

/**
 * What the host tells a turn under way between its steps (a build job's
 * end), steered in as a user message: no turn of its own.
 */
export const noticeKind = "grasp.notice";

const copiedSchema = z.object({ kind: z.string() });

/** An entry's own kind, a copy's as it was. */
const kindOf = (entry: EntryRecord): string => {
  if (entry.kind !== historyKind) {
    return entry.kind;
  }
  const copied = copiedSchema.safeParse(entry.data);
  return copied.success ? copied.data.kind : entry.kind;
};

/** Whether `entry` starts a turn: a question, or pi's plain input. */
const startsTurn = (entry: EntryRecord): boolean => {
  const kind = kindOf(entry);
  return kind === questionKind || kind === UserEntry.kind;
};

// A question carries what the recall before it found (`recallFor` in
// agent.ts, GRA-1544) as a part of its own, headed by the recall's run: pi
// takes nothing between an input and the run's first request, and the run
// is what a revocation withholds it by, as a code step's result.

const recallPattern = /^\[Recall (?<run>[^\]\s]+)\]\n/u;

/** The run the recall in `part` was, if it is one. */
const recallRunOf = (part: {
  type: string;
  text?: string;
}): string | undefined =>
  part.type === "text"
    ? recallPattern.exec(part.text ?? "")?.groups?.run
    : undefined;

/**
 * A question as the model reads it: the person's words, the note of the
 * files it carries, and what the recall before it found, each a part.
 */
export const questionContent = (
  text: string,
  files: readonly { id: string; type: string }[],
  recall?: { runId: string; text: string }
): UserMessage["content"] => [
  { type: "text", text },
  ...(files.length === 0
    ? []
    : [{ type: "text" as const, text: filesNoteText(files) }]),
  ...(recall === undefined
    ? []
    : [
        {
          type: "text" as const,
          text: `[Recall ${recall.runId}]\n${recall.text}`,
        },
      ]),
];

/** The person's own words of a question, as `questionContent` put them first. */
export const questionText = (message: UserMessage): string => {
  if (typeof message.content === "string") {
    return message.content;
  }
  const [first] = message.content;
  return first?.type === "text" ? first.text : "";
};

/** A user message with each recall of a run in `withheld` read as a note. */
const withRecallsNoted = (
  message: UserMessage,
  withheld: ReadonlySet<string>
): { message: UserMessage; read: boolean } => {
  if (typeof message.content === "string") {
    return { message, read: false };
  }
  let read = false;
  const content = message.content.map((part) => {
    const run = recallRunOf(part);
    if (run === undefined || !withheld.has(run)) {
      return part;
    }
    read = true;
    return { type: "text" as const, text: withheldResult };
  });
  return { message: read ? { ...message, content } : message, read };
};

/** Whether every run in `withheld` was left out of the context. */
const leftOut = (
  withheld: ReadonlySet<string>,
  dropped: readonly string[]
): boolean => [...withheld].every((run) => dropped.includes(run));

/** Whether the model may read the context as it is: nothing withheld in it. */
const mayRead = async (
  agent: Pick<ChatAgent, "withheld">,
  api: HookApi,
  context: Context
): Promise<boolean> => {
  const withheld = await agent.withheld();
  if (withheld.size === 0) {
    return true;
  }
  const base = await api.snapshot(BaseDoc, api.conversationId, context);
  return leftOut(withheld, base?.dropped ?? []);
};

/**
 * Whether `conversation`'s context must be rebased before its next turn:
 * it holds what `withheld` withholds, or a rebase was cut short.
 */
export const needsRebase = async (
  conversation: Conversation,
  withheld: ReadonlySet<string>,
  context: Context
): Promise<boolean> =>
  await conversation.commit(async (tx) => {
    const base = await tx.doc(BaseDoc, conversation.id);
    return base.rebasing || !leftOut(withheld, base.dropped);
  }, context);

/**
 * The entries of `conversation`'s history since `base`, the reset of its
 * last rebase: the model's messages of each, without pi's own system
 * entries, resets and summaries, nor what a rebase cut short appended.
 */
const historySince = async (
  conversation: Conversation,
  base: EntryId | null,
  context: Context
): Promise<EntryRecord[]> => {
  const history: EntryRecord[] = [];
  let afterLaterReset = false;
  let cursor;
  do {
    // oxlint-disable-next-line no-await-in-loop -- page after page
    const page = await conversation.entries(
      { order: "ascending", ...(base === null ? {} : { minEntryId: base }) },
      200,
      cursor,
      context
    );
    for (const entry of page.items) {
      if (ResetEntry.is(entry)) {
        afterLaterReset ||= entry.id !== base;
      } else if (
        !SystemEntry.is(entry) &&
        !CompactionEntry.is(entry) &&
        !(entry.kind === historyKind && afterLaterReset) &&
        (entry.model?.length ?? 0) > 0
      ) {
        history.push(entry);
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return history;
};

/** An entry of a rebased history: its own kind, and its messages as they may be sent. */
interface Copied {
  kind: string;
  model: Message[];
}

/**
 * The entries of `history` as a rebased context may hold them while
 * `withheld` is withheld: the result of each run in it, a code step's or
 * a recall's, read as a note, and so is everything the model wrote after
 * it in its turn, which may repeat what it read, up to the next question.
 * A notice steered in mid-turn ends no turn. Each call keeps its ID and
 * its result; the person's words stay as they are.
 */
const withheldFrom = (
  history: readonly EntryRecord[],
  withheld: ReadonlySet<string>
): Copied[] => {
  let after = false;
  return history.map((entry) => {
    if (startsTurn(entry)) {
      after = false;
    }
    const model = (entry.model ?? []).map((message): Message => {
      if (message.role === "user") {
        const noted = withRecallsNoted(message, withheld);
        after ||= noted.read;
        return noted.message;
      }
      if (message.role === "toolResult") {
        const run = resultRunId(message);
        if (!after && (run === undefined || !withheld.has(run))) {
          return message;
        }
        after = true;
        return {
          ...message,
          content: [{ type: "text", text: withheldResult }],
        };
      }
      return message.role === "assistant" && after
        ? withheldAssistant(message)
        : message;
    });
    return { kind: kindOf(entry), model };
  });
};

/** The tokens `copied`'s messages take, as pi estimates them. */
const tokensOf = (copied: Copied): number =>
  copied.model.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0
  );

/** What a rebased context keeps of a result too large for the model's window. */
export const tooLargeResult =
  "[This result was too large to keep in the chat's context, so it was left out when the context was rebuilt.]";

/** What a rebased context keeps of a response too large for the model's window. */
export const tooLargeResponse =
  "[This response was too large to keep in the chat's context, so it was left out when the context was rebuilt.]";

/**
 * `copied` with each of its results read as {@link tooLargeResult}, and
 * what each response wrote or thought as {@link tooLargeResponse}, its
 * calls kept.
 */
const tooLargeNoted = (copied: Copied): Copied => ({
  ...copied,
  model: copied.model.map((message): Message => {
    if (message.role === "toolResult") {
      return { ...message, content: [{ type: "text", text: tooLargeResult }] };
    }
    if (message.role !== "assistant") {
      return message;
    }
    const calls = message.content.filter(({ type }) => type === "toolCall");
    return calls.length === message.content.length
      ? message
      : {
          ...message,
          content: [{ type: "text", text: tooLargeResponse }, ...calls],
        };
  }),
});

/**
 * Starts `conversation`'s context afresh without what `withheld` withholds,
 * keeping the rest: a pi reset, then its history since its last rebase
 * again, entry by entry, each run in `withheld` read as a note in place of
 * its result (`withheldFrom`). The history is compacted by pi as it is
 * appended, whenever it holds more than `room` tokens (the model's window
 * less pi's reserve), so pi's summarizer never takes more than a window.
 * Only while the conversation is idle. A rebase a restart cut short is
 * done again from the same history (`needsRebase`).
 */
export const rebase = async (
  conversation: Conversation,
  withheld: ReadonlySet<string>,
  room: number,
  context: Context
): Promise<void> => {
  const start = await conversation.commit(async (tx) => {
    const base = await tx.doc(BaseDoc, conversation.id);
    return { base: base.base, dropped: [...base.dropped] };
  }, context);
  const history = withheldFrom(
    await historySince(conversation, start.base, context),
    withheld
  );
  const reset = await conversation.commit(async (tx) => {
    const entry = await tx.appendEntry(conversation.id, {
      kind: ResetEntry.kind,
      head: "self",
    });
    const base = await tx.doc(BaseDoc, conversation.id);
    base.dropped = [...new Set([...start.dropped, ...withheld])];
    base.rebasing = true;
    return entry.id;
  }, context);
  let pending: Copied[] = [];
  let tokens = 0;
  const append = async (): Promise<void> => {
    const drafts = pending;
    pending = [];
    await conversation.commit(async (tx) => {
      for (const { kind, model } of drafts) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await tx.appendEntry(conversation.id, {
          kind: historyKind,
          model,
          data: { kind },
        });
      }
    }, context);
  };
  for (const entry of history) {
    // An entry the room can't hold on its own keeps its results as a note:
    // nothing appended is past what pi's summarizer takes.
    let copied = tokensOf(entry) > room ? tooLargeNoted(entry) : entry;
    let size = tokensOf(copied);
    // The context so far compacted first when this entry would take it
    // past the room, so the prefix pi summarizes always fits.
    if (tokens + size > room && tokens > 0) {
      // oxlint-disable-next-line no-await-in-loop -- appended before compacted
      await append();
      // oxlint-disable-next-line no-await-in-loop -- one compaction at a time
      await conversation.compact(undefined, context);
      // oxlint-disable-next-line no-await-in-loop -- its summary placed first
      await conversation.waitForIdle(context);
      // oxlint-disable-next-line no-await-in-loop -- what is left of the context
      const view = await conversation.context(context);
      ({ tokens } = estimateContextTokens(view.messages));
      // pi keeps the most recent turns as they are: an entry that still
      // can't join what is left keeps its results as a note.
      if (tokens + size > room) {
        copied = tooLargeNoted(copied);
        size = tokensOf(copied);
      }
    }
    pending.push(copied);
    tokens += size;
  }
  await append();
  await conversation.commit(async (tx) => {
    const base = await tx.doc(BaseDoc, conversation.id);
    base.base = reset;
    base.rebasing = false;
  }, context);
};

/** Why a turn stops when what it may read can't be told. */
const unreadable = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new Error("What this chat may read could not be told.");

/**
 * What a request may send of `messages`, and why the turn must stop, if
 * it must. While the context holds nothing withheld: everything, each
 * section of the system prompt given only where it was given last, so a
 * stale one (memory a person lost) never reaches the model. Once it does,
 * until the host rebased it, or when that can't be told: only the system
 * prompt and the person's last words, and the turn stops. Never throws, as
 * pi sends the request unchanged past a hook that throws.
 */
const guarded = async (
  agent: Pick<ChatAgent, "withheld">,
  messages: readonly Message[],
  api: HookApi,
  context: Context
): Promise<{ messages: Message[]; stop?: Error }> => {
  let stop: Error | undefined;
  try {
    if (await mayRead(agent, api, context)) {
      return { messages: latestSections(messages) };
    }
    stop = agentErrors.create("agent.history_revoked");
  } catch (error) {
    stop = unreadable(error);
  }
  // The latest sections only, and the person's own words alone: the last
  // user message may carry a recall that was withheld meanwhile, which no
  // request sends, whether or not `stop` takes.
  const kept = latestSections(messages);
  const asked = kept.findLast(
    (message): message is UserMessage => message.role === "user"
  );
  return {
    messages: [
      ...kept.filter(({ role }) => role === "system"),
      ...(asked === undefined
        ? []
        : [{ ...asked, content: questionText(asked) }]),
    ],
    stop,
  };
};

/**
 * A chat's agent for one turn, as a pi-durable extension: the instructions
 * and the chat's sections (each tagged by itself, as the model has always
 * read them), `executeCode` in our locked isolate, `readApi`, the
 * dedicated tools the chat's APIs allow, the thinking tool where it may,
 * `askQuestions` in Grasp's own chat only, and the guards before every
 * request and compaction.
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
        beforeRequest: async ({ messages }, api, context) => {
          const sent = await guarded(agent, messages, api, context);
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
      // pi's summarizer reads the context as stored: declined while it
      // holds what is withheld, until the host rebased it.
      hook(CompactionTask, {
        beforeCompact: async (_part, api, context) => {
          try {
            return (await mayRead(agent, api, context))
              ? undefined
              : { decline: true };
          } catch {
            return { decline: true };
          }
        },
      }),
    ],
  });
};
