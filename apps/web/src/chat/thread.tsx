import { definitionToolNames } from "@grasp-os/shared/chat";
import type {
  ChatCode,
  ChatMessage,
  ChatOutput,
  ChatPartial,
  ChatReasoning,
  ChatToolCall,
  ChatToolEvent,
} from "@grasp-os/shared/chat";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useLocation } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import type { ReactElement, ReactNode } from "react";

import type { ThinkingOf } from "../brain/thinking/play.ts";
import { ConnectAiProvider } from "../frame/connect-ai-provider.tsx";
import { RouterLink } from "../frame/router-link.tsx";
import { AgentActivity } from "../grasp/agent-activity/index.ts";
import type {
  ActivityKind,
  ActivityStep,
  AgentActivityWords,
} from "../grasp/agent-activity/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  ChatMessage as Message,
  ChatMessageAction,
} from "../grasp/chat-message/index.ts";
import { Retry } from "../grasp/icons/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Thread } from "../grasp/thread/index.ts";
import type { ThreadWords } from "../grasp/thread/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useMemberAdmin } from "../use-member-admin.ts";
import { AnswerMarkdown } from "./answer-markdown.tsx";
import {
  SeeInBrain,
  useAnswerThinking,
  useThinkingStep,
} from "./answer-thinking.tsx";
import { answeredOf } from "./answered.ts";
import { AskedLine } from "./asked-questions.tsx";
import { pendingPlan, ThreadPlan } from "./build-progress.tsx";
import type { ThreadBuild } from "./build-progress.tsx";
import { FileCards } from "./chat-files.tsx";
import { failureMessage } from "./failure.ts";
import { reading } from "./reading.stylex.ts";
import { recoveredSteps } from "./recovered.ts";
import { SavedMemoryLine } from "./saved-memory.tsx";
import { readingFileOf, signOf } from "./sign.ts";
import type { WorkState } from "./sign.ts";
import { AnswerCited, AnswerSources, useCitedDocuments } from "./sources.tsx";
import { turnsOf, workedFor } from "./turns.ts";
import { widgetLinesOf } from "./widget-lines.ts";

/**
 * An answer's thinking as a card (thinking-card.tsx), loaded once an
 * answer shows one: it draws the brain's shapes, which the thread, in the
 * dock on every page, never loads before.
 */
const ThinkingCard = lazy(async () => {
  const { ThinkingCard: card } = await import("./thinking-card.tsx");
  return { default: card };
});

// A chat as the person reads it, on Grasp UI: the library's Thread holds
// the conversation (it follows the newest words, keeps the reader's place
// when they scroll up, offers Jump to latest, and gives a question just
// sent the room under it for its answer). Each turn is one Chat message:
// the person's question in their bubble; Grasp's answer as plain words
// under its name, with the steps it took as one Agent activity over them
// (each tool call and code step, opening to what went in and came back),
// what the model thought behind the message's thinking line, and the
// answer's Markdown. While Grasp works and has shown nothing yet, the
// message's thinking line says what it does; once steps arrive, the
// activity's line does, so there is only ever one working mark.

type Result = Extract<ChatMessage, { role: "result" }>;
type Answer = Extract<ChatMessage, { role: "assistant" }>;
type Asked = Extract<ChatMessage, { role: "user" }>;

const styles = stylex.create({
  // The thread takes the room the chat gives it; the library's Thread is as tall as its box.
  room: {
    display: "grid",
    flexGrow: 1,
    minHeight: 0,
  },
  // Full screen, the conversation reads as one column in the middle.
  column: {
    width: "100%",
    maxWidth: reading.width,
    marginInline: "auto",
  },
  // What stands with an answer: its steps, notes and words, the Markdown's own gap apart.
  stack: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: grasp.space3,
  },
  // A person's answers to Grasp's questions, each question over its answer.
  answered: {
    display: "grid",
    gap: grasp.space2,
    margin: 0,
  },
  answeredPair: {
    display: "grid",
    gap: grasp.space1,
  },
  flat: {
    margin: 0,
  },
  start: {
    justifySelf: "start",
  },
  centre: {
    display: "grid",
    placeItems: "center",
    paddingBlock: grasp.space8,
  },
});

/**
 * Where a step stands; `retried` for one that failed and a later step of
 * its turn recovered from (recovered.ts), which is no failure to the
 * person.
 */
type StepStatus =
  | "writing"
  | "running"
  | "done"
  | "failed"
  | "retried"
  | "stopped";

/** Where a step stands: written, running, done, failed, retried or stopped. */
const stepStatusOf = (
  result: Result | undefined,
  writing: boolean,
  running: boolean,
  recovered: boolean
): StepStatus => {
  if (writing) {
    return "writing";
  }
  if (result !== undefined) {
    if (!result.failed) {
      return "done";
    }
    return recovered ? "retried" : "failed";
  }
  // Without a result once the agent stopped, it never finished.
  return running ? "running" : "stopped";
};

/** How a step stands in Agent activity: a stopped step was skipped, a retried one done. */
const activityState: Record<StepStatus, ActivityStep["state"]> = {
  writing: "working",
  running: "working",
  done: "done",
  failed: "failed",
  retried: "done",
  stopped: "skipped",
};

/** A text a tool call was given, by its field; an ellipsis while none has arrived. */
const fieldOf = (input: Record<string, unknown>, field: string): string => {
  const value = input[field];
  return typeof value === "string" ? value : "…";
};

/** The tools that change an App's definition. */
const definitionTools: ReadonlySet<string> = new Set(definitionToolNames);

/** The tools that read Grasp's docs. */
const docsTools: ReadonlySet<string> = new Set(["searchDocs", "readDocs"]);

/** What kind of step each of Grasp's tools is, for the activity's one line; any other is a tool. */
const toolKinds: Readonly<Record<string, ActivityKind>> = {
  readFile: "read",
  readDocs: "read",
  writeFile: "write",
  editFile: "write",
  createApp: "write",
  editWorkflow: "write",
  remember: "write",
  searchFiles: "search",
  searchBrain: "search",
  searchDocs: "search",
};

/** The paths of the files a call writes (`files`, by path), as far as they came. */
const pathsOf = (input: Record<string, unknown>): string[] => {
  const { files } = input;
  return typeof files === "object" && files !== null ? Object.keys(files) : [];
};

/**
 * What a call of one of Grasp's tools did, in a line: in the past once it
 * is done, as it goes while it is written or runs.
 */
const useToolSummary = (): ((call: ChatToolCall, done: boolean) => string) => {
  const { t } = useLingui();
  /** What a `writeFile` call wrote: its file, or how many. */
  const wrote = (input: Record<string, unknown>, done: boolean): string => {
    const [file, ...others] = pathsOf(input);
    if (file !== undefined && others.length === 0) {
      return done ? t`Wrote ${file}` : t`Writing ${file}`;
    }
    const count = others.length + (file === undefined ? 0 : 1);
    return done
      ? t`${plural(count, { one: "Wrote # file", other: "Wrote # files" })}`
      : t`${plural(count, { one: "Writing # file", other: "Writing # files" })}`;
  };
  /** What a call of the docs' tools read: the docs Grasp's release ships. */
  const docsLineOf = ({ tool, input }: ChatToolCall, done: boolean): string => {
    if (tool === "searchDocs") {
      const query = fieldOf(input, "query");
      return done
        ? t`Searched the docs for ${query}`
        : t`Searching the docs for ${query}`;
    }
    const path = fieldOf(input, "path");
    return done ? t`Read ${path} in the docs` : t`Reading ${path} in the docs`;
  };
  const lineOf = ({ tool, input }: ChatToolCall, done: boolean): string => {
    const name = fieldOf(input, "name");
    const path = fieldOf(input, "path");
    const text = fieldOf(input, "text");
    const query = fieldOf(input, "query");
    const binding = fieldOf(input, "binding");
    switch (tool) {
      case "createApp": {
        return done ? t`Created the App ${name}` : t`Creating the App ${name}`;
      }
      case "readFile": {
        return done ? t`Read ${path}` : t`Reading ${path}`;
      }
      case "writeFile": {
        return wrote(input, done);
      }
      case "editFile": {
        return done ? t`Edited ${path}` : t`Editing ${path}`;
      }
      case "searchFiles": {
        return done
          ? t`Searched the App's files for ${text}`
          : t`Searching the App's files for ${text}`;
      }
      case "searchBrain": {
        return done
          ? t`Searched the brain for ${query}`
          : t`Searching the brain for ${query}`;
      }
      case "requestConnection": {
        return done
          ? t`Asked to connect ${binding}`
          : t`Asking to connect ${binding}`;
      }
      case "editWorkflow": {
        return done ? t`Edited a workflow` : t`Editing a workflow`;
      }
      case "remember": {
        return done ? t`Saved to your memory` : t`Saving to your memory`;
      }
      default: {
        return done ? t`Used ${tool}` : t`Using ${tool}`;
      }
    }
  };
  return (call, done) => {
    if (docsTools.has(call.tool)) {
      return docsLineOf(call, done);
    }
    if (!definitionTools.has(call.tool)) {
      return lineOf(call, done);
    }
    return done
      ? t`Changed the App's definition`
      : t`Changing the App's definition`;
  };
};

/** What a reply took steps with: its tool calls and its code, as stored or being written. */
type Stepped = Pick<ChatPartial, "code" | "tools">;

/** One step of an answer, in the order the response made it. */
type StepOf =
  | { kind: "tool"; call: ChatToolCall }
  | { kind: "code"; code: ChatCode };

/** A response's steps in the order it made them: the calls of its tools before each code step, then those after its last. */
const stepsOf = (reply: Stepped): StepOf[] =>
  [...reply.code, undefined].flatMap((code, before) => [
    ...reply.tools
      .filter(({ codeBefore }) =>
        code === undefined ? codeBefore >= before : codeBefore === before
      )
      .map((call): StepOf => ({ kind: "tool", call })),
    ...(code === undefined ? [] : [{ kind: "code" as const, code }]),
  ]);

/** What the steps of a turn need to know of where the turn is. */
interface StepContext {
  results: ReadonlyMap<string, Result>;
  recovered: ReadonlySet<string>;
  /** What the running code step has logged so far. */
  output: ChatOutput | null;
  /** The reply is still being written. */
  writing: boolean;
  /** Whether the agent is working on the chat now. */
  running: boolean;
}

/** An answer's steps as Agent activity has them, from what it called and ran. */
const useActivitySteps = (): ((
  replies: readonly Stepped[],
  writing: readonly boolean[],
  context: Omit<StepContext, "writing">
) => ActivityStep[]) => {
  const { t } = useLingui();
  const summary = useToolSummary();
  return (replies, writing, context) =>
    replies.flatMap((reply, at) =>
      stepsOf(reply).map((step): ActivityStep => {
        const callId =
          step.kind === "tool" ? step.call.callId : step.code.callId;
        const result = context.results.get(callId);
        const status = stepStatusOf(
          result,
          writing[at] ?? false,
          context.running,
          context.recovered.has(callId)
        );
        const retried = status === "retried" ? t`Retried` : undefined;
        // A step that never finished reads as it went: "Searching the brain", stopped.
        const finished = status === "done" || status === "retried";
        if (step.kind === "tool") {
          return {
            id: callId,
            kind: toolKinds[step.call.tool] ?? "tool",
            title: summary(step.call, finished),
            active: summary(step.call, false),
            state: activityState[status],
            summary: retried,
            input: JSON.stringify(step.call.input, null, 2),
            result: result?.text,
          };
        }
        const logged =
          context.output?.callId === callId ? context.output.text : undefined;
        return {
          id: callId,
          kind: "tool",
          title: finished ? t`Ran a code step` : t`Running a code step`,
          active:
            status === "writing"
              ? t`Writing a code step`
              : t`Running a code step`,
          state: activityState[status],
          summary: retried,
          input: step.code.code,
          result: result?.text ?? logged,
        };
      })
    );
};

/** Agent activity's own words, in the page's language. */
const useActivityWords = (): Partial<AgentActivityWords> => {
  const { t } = useLingui();
  return {
    states: {
      waiting: t`Waiting`,
      working: t`Working`,
      done: t`Done`,
      failed: t`Failed`,
      skipped: t`Stopped`,
    },
    showMore: t`Show more`,
    showLess: t`Show less`,
    input: t`Input`,
    result: t`Result`,
    error: t`Error`,
    stepFailed: (title) => t`${title} failed`,
    summarize: (steps) => {
      const count = steps.length;
      return t`${plural(count, { one: "Took # step", other: "Took # steps" })}`;
    },
  };
};

/** The Thread's own words, in the page's language. */
const useThreadWords = (): Partial<ThreadWords> => {
  const { t, i18n } = useLingui();
  return {
    unread: t`Unread`,
    unreadFrom: t`Unread messages from here`,
    loadingOlder: t`Loading older messages`,
    jumpToNew: () => t`Jump to latest, new messages`,
    arrived: (count) =>
      t`${plural(count, { one: "# new message", other: "# new messages" })}`,
    today: t({ message: "Today", context: "a date line in a chat" }),
    yesterday: t({ message: "Yesterday", context: "a date line in a chat" }),
    day: (day, sameYear) =>
      new Intl.DateTimeFormat(
        i18n.locale,
        sameYear
          ? { weekday: "long", day: "numeric", month: "long" }
          : { day: "numeric", month: "long", year: "numeric" }
      ).format(day),
  };
};

/** What Grasp does while it works on a question, said as the line over its answer. */
const useWorkingLabel = (): ((
  doing: WorkState,
  file: string | undefined,
  checking: boolean
) => string) => {
  const { t } = useLingui();
  return (doing, file, checking) => {
    if (checking) {
      return t({
        message: "Checking the App…",
        comment:
          "Grasp checks the App it changed (its types, lint and preview) before its turn ends.",
      });
    }
    if (file !== undefined) {
      return t({
        message: `Reading ${file}`,
        comment: "Grasp reads a file the person attached; {file} is its name.",
      });
    }
    return {
      reading: t`Reading the workspace`,
      thinking: t`Thinking`,
      writing: t`Writing`,
      working: t`Working on it`,
    }[doing];
  };
};

/** Under a code step's answer: each widget it made or changed on the dashboard, with the way there. */
const WidgetLines = ({
  tools,
  callIds,
}: {
  tools: readonly ChatToolEvent[];
  callIds: readonly string[];
}) =>
  callIds
    .flatMap((callId) => widgetLinesOf(tools, callId))
    .map(({ id, done }) => (
      <Text element="p" key={id} size="sm" tone="muted">
        {done === "made" ? (
          <Trans>Grasp added a widget to your dashboard.</Trans>
        ) : (
          <Trans>Grasp changed a widget on your dashboard.</Trans>
        )}{" "}
        <RouterLink to="/dashboard">
          <Trans>Open the dashboard</Trans>
        </RouterLink>
      </Text>
    ));

/**
 * The codes that mean no model can be reached until an AI provider is
 * connected: models not set up at all, or none connected yet.
 */
const needsProvider: ReadonlySet<unknown> = new Set([
  "model.no_provider",
  "model.unconfigured",
]);

/**
 * An answer that failed because the organization's AI provider refuses
 * its key: its admins get the way to check or replace it.
 */
const KeyFailed = () => (
  <Text element="p" size="sm">
    <RouterLink to="/settings/ai-providers">
      <Trans>Check or replace it in Settings › AI providers</Trans>
    </RouterLink>
  </Text>
);

/**
 * A stored reply's words that cite documents: until sources move onto
 * Grasp UI's Sources, its own Markdown with each cited span marked, and
 * "Based on N sources" under it.
 */
const CitedWords = ({
  text,
  cited,
}: {
  text: string;
  cited: readonly string[];
}) => {
  const sources = useCitedDocuments();
  return (
    <>
      <AnswerMarkdown
        cited={cited}
        sources={sources}
        text={text}
        written={false}
      />
      <AnswerSources cited={sources} />
    </>
  );
};

/** One reply's words, its citations inline where it cites documents. */
const ReplyWords = ({
  reply,
  chatId,
  writing,
}: {
  reply: { id?: number; text: string; citations?: Answer["citations"] };
  chatId: string;
  writing: boolean;
}) => {
  if (reply.text.trim() === "") {
    return null;
  }
  if (
    reply.id === undefined ||
    reply.citations === undefined ||
    reply.citations.length === 0
  ) {
    // Model output, so work's own renderer: a link out of Grasp asks first
    // and carries no address, until the library's Markdown takes a link
    // renderer (`renderLink`).
    return <AnswerMarkdown text={reply.text} written={writing} />;
  }
  return (
    <AnswerCited cited={{ chatId, messageId: reply.id }}>
      <CitedWords
        cited={reply.citations.map(({ documentId }) => documentId)}
        text={reply.text}
      />
    </AnswerCited>
  );
};

/** Where an answer is, as Chat message says it. */
const statusOf = ({
  live,
  failed,
  shows,
}: {
  live: boolean;
  failed: boolean;
  /** It shows steps or words already. */
  shows: boolean;
}): "thinking" | "streaming" | "done" | "failed" => {
  if (live) {
    return shows ? "streaming" : "thinking";
  }
  return failed ? "failed" : "done";
};

/** One answer of Grasp's in the thread: what it stood on while it worked. */
interface AnswerTurn {
  kind: "answer";
  id: string;
  at: string | undefined;
  /** Its stored replies, oldest first. */
  replies: Answer[];
  /** The reply being written, once it shows something. */
  partial: ChatPartial | null;
  /** Grasp works on this answer now. */
  live: boolean;
}

/** One row of the thread. */
type Row =
  | {
      kind: "question";
      id: string;
      at: string;
      message: Asked;
      asked: Answer["asked"];
    }
  | AnswerTurn
  | { kind: "after"; id: string; at?: undefined; children: ReactNode };

/** The thread's rows: each question, then its replies as one answer, the reply being written joined to it. */
const rowsOf = (
  messages: readonly ChatMessage[],
  partial: ChatPartial | null,
  live: boolean
): Row[] => {
  const rows: Row[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const before = rows.at(-1);
      rows.push({
        kind: "question",
        id: `q${message.id}`,
        at: message.at,
        message,
        asked:
          before?.kind === "answer" ? before.replies.at(-1)?.asked : undefined,
      });
    } else if (message.role === "assistant") {
      const last = rows.at(-1);
      if (last?.kind === "answer") {
        last.replies.push(message);
      } else {
        rows.push({
          kind: "answer",
          id: `a${message.id}`,
          at: message.at,
          replies: [message],
          partial: null,
          live: false,
        });
      }
    }
  }
  if (!live) {
    return rows;
  }
  // Grasp works on the last question: its answer goes on, or begins.
  const last = rows.at(-1);
  if (last?.kind === "answer") {
    last.partial = partial;
    last.live = true;
  } else {
    rows.push({
      kind: "answer",
      id: "answering",
      at: last?.at,
      replies: [],
      partial,
      live: true,
    });
  }
  return rows;
};

/**
 * Where Grasp stands on the chat's questions: the answer being written,
 * once it shows its first thoughts, words or code; what it does on the
 * last question while it works; and how long it worked on every other, by
 * the ID of its first reply.
 */
const progressOf = (
  messages: readonly ChatMessage[],
  partial: ChatPartial | null,
  running: boolean,
  results: ReadonlyMap<string, Result>
): {
  shown: ChatPartial | null;
  doing: WorkState | undefined;
  /** The code step being written or run: the newest answer's last. */
  step: ChatCode | undefined;
  worked: ReadonlyMap<number, number>;
} => {
  const shown =
    partial !== null &&
    (partial.text.trim() !== "" ||
      partial.code.length > 0 ||
      partial.tools.length > 0 ||
      partial.reasoning.trim() !== "")
      ? partial
      : null;
  const turns = turnsOf(messages);
  const current = running ? turns.at(-1) : undefined;
  const replies = current?.replies ?? [];
  return {
    shown,
    doing: running
      ? signOf({ partial: shown, replies, ran: (id) => results.has(id) })
      : undefined,
    step: (shown ?? replies.at(-1))?.code.at(-1),
    worked: workedFor(turns, current),
  };
};

/** Each step's result in `messages`, by the step's call. */
const resultsOf = (messages: readonly ChatMessage[]): Map<string, Result> => {
  const results = new Map<string, Result>();
  for (const message of messages) {
    if (message.role === "result") {
      results.set(message.callId, message);
    }
  }
  return results;
};

/**
 * The last answer, and whether it answers the last question: "Ask again"
 * asks that question, only under the answer to it, never under an earlier
 * one when a later question stopped unanswered.
 */
const lastAnswerOf = (
  messages: readonly ChatMessage[]
): { lastAnswer: Answer | undefined; answersLast: boolean } => {
  const lastAnswer = messages.findLast(
    (message): message is Answer => message.role === "assistant"
  );
  return {
    lastAnswer,
    answersLast:
      lastAnswer !== undefined &&
      messages.findLastIndex(({ role }) => role === "user") <
        messages.indexOf(lastAnswer),
  };
};

/**
 * What the person asked, in their bubble: their answers to the agent's
 * questions (`asked`, the reply before it) as each question and its
 * answer; anything else as they wrote it.
 */
const Question = ({
  message,
  asked,
}: {
  message: Asked;
  asked: Answer["asked"];
}) => {
  const { t } = useLingui();
  const answered =
    asked === undefined ? undefined : answeredOf(asked, message.text);
  return (
    <div {...stylex.props(styles.stack)}>
      {message.files === undefined || message.files.length === 0 ? null : (
        <FileCards files={message.files} />
      )}
      <Message dateTime={message.at} from="person" personLabel={t`You`}>
        {answered === undefined ? (
          message.text
        ) : (
          <dl {...stylex.props(styles.answered)}>
            {answered.map(({ question, answer }) => (
              <div key={question} {...stylex.props(styles.answeredPair)}>
                <dt>
                  <Text size="sm" tone="muted">
                    {question}
                  </Text>
                </dt>
                <dd {...stylex.props(styles.flat)}>{answer}</dd>
              </div>
            ))}
          </dl>
        )}
      </Message>
    </div>
  );
};

/** Everything an answer is drawn from, beyond its own replies. */
interface AnswerContext extends Omit<StepContext, "writing"> {
  chatId: string;
  tools: readonly ChatToolEvent[];
  /** What Grasp does on this answer while it works on it. */
  doing: WorkState | undefined;
  /** What the line over it says while Grasp works on it. */
  workingLabel: string;
  /** Grasp checks the drafts it wrote, past its answer. */
  checking: boolean;
  /** How long Grasp worked on each question, by the ID of its first reply. */
  worked: ReadonlyMap<number, number>;
  /** Asks the last question again: offered under its answer only. */
  onRetry: (() => void) | undefined;
  /** Its thinking as a small picture, where it showed one. */
  card: ReactNode;
  /** The way to see its thinking again in the brain, on the brain's own page. */
  again: ThinkingOf | undefined;
  build: ThreadBuild | undefined;
  /** The plan waiting for the person, by its call. */
  waitingPlan: string | undefined;
}

/** What follows a stored reply: the questions it asked, and the plan it made. */
const AnswerAfter = ({
  reply,
  context,
}: {
  reply: Answer;
  context: AnswerContext;
}) => (
  <>
    {reply.asked === undefined ? null : <AskedLine asked={reply.asked} />}
    {reply.planned === undefined ? null : (
      <ThreadPlan
        build={context.build}
        chatId={context.chatId}
        plan={reply.planned}
        waiting={context.waitingPlan === reply.planned.callId}
      />
    )}
  </>
);

/** What the model thought for an answer, all its replies' together, and for how long. */
const thoughtOf = (
  replies: readonly Answer[],
  partial: ChatPartial | null
): { thoughts: string | undefined; seconds: number | undefined } => {
  const reasoning: ChatReasoning[] = [
    ...replies.flatMap(({ reasoning: thought }) =>
      thought === undefined ? [] : [thought]
    ),
    ...(partial === null || partial.reasoning === ""
      ? []
      : [{ text: partial.reasoning, ms: null }]),
  ];
  const thoughts = reasoning
    .map(({ text }) => text)
    .join("\n\n")
    .trim();
  let ms: number | undefined;
  for (const thought of reasoning) {
    if (thought.ms !== null) {
      ms = (ms ?? 0) + thought.ms;
    }
  }
  return {
    thoughts: thoughts === "" ? undefined : thoughts,
    // At least a second, once it was timed.
    seconds: ms === undefined ? undefined : Math.max(1, Math.round(ms / 1000)),
  };
};

/** How an answer ended, when it did not simply finish: stopped, cut off, or failed. */
interface Ending {
  end: Answer["end"] | undefined;
  /** No AI provider to call: the way to connect one, never an error. */
  providerMissing: boolean;
  /** The provider refuses the key, said to one of the organization's admins. */
  keyFailedForAdmin: boolean;
}

/** Under an answer that did not simply finish: why, and the way on. */
const AnswerEnding = ({
  ending,
  retry,
}: {
  ending: Ending;
  /** Asks the question again, once a provider is connected. */
  retry: (() => void) | undefined;
}) => {
  const { t } = useLingui();
  return (
    <>
      {ending.end === "cancelled" ? (
        <Text element="p" size="sm" tone="muted">
          <Trans>Stopped.</Trans>
        </Text>
      ) : null}
      {ending.end === "cut_off" ? (
        <Text element="p" size="sm" tone="muted">
          <Trans>The answer was cut off at the model&apos;s limit.</Trans>
        </Text>
      ) : null}
      {ending.providerMissing ? <ConnectAiProvider size="xs" /> : null}
      {ending.providerMissing && retry !== undefined ? (
        <Button
          icon={Retry}
          layout={styles.start}
          onClick={() => {
            retry();
          }}
          size="sm"
          variant="quiet"
        >
          {t`Try again`}
        </Button>
      ) : null}
      {ending.keyFailedForAdmin ? <KeyFailed /> : null}
    </>
  );
};

/** What an answer holds: its steps, what they did, its words, and how it ended. */
const AnswerBody = ({
  turn,
  context,
  steps,
  ending,
}: {
  turn: AnswerTurn;
  context: AnswerContext;
  steps: ActivityStep[];
  ending: Ending;
}) => {
  const { t } = useLingui();
  const activityWords = useActivityWords();
  const { replies, partial, live } = turn;
  const stepped: Stepped[] = partial === null ? replies : [...replies, partial];
  const firstId = replies[0]?.id;
  const seconds =
    firstId === undefined ? undefined : context.worked.get(firstId);
  // The activity's line says what Grasp does once steps show, or between two
  // replies; while words arrive, they say it themselves.
  const activity =
    steps.length > 0 || (live && (context.checking || partial === null));
  return (
    <div {...stylex.props(styles.stack)}>
      {activity ? (
        <AgentActivity
          aria-label={t`What Grasp did`}
          duration={live || seconds === undefined ? undefined : seconds * 1000}
          steps={steps}
          words={activityWords}
          working={live}
          workingLabel={context.workingLabel}
        />
      ) : null}
      {stepped.flatMap((reply) =>
        reply.tools.flatMap(({ callId }) => {
          const saved = context.results.get(callId)?.saved;
          return saved === undefined
            ? []
            : [<SavedMemoryLine key={callId} saved={saved} />];
        })
      )}
      <WidgetLines
        callIds={stepped.flatMap(({ code }) =>
          code.map(({ callId }) => callId)
        )}
        tools={context.tools}
      />
      {context.card}
      {context.again === undefined ? null : (
        <SeeInBrain chatId={context.chatId} thinking={context.again} />
      )}
      {replies.map((reply) => (
        <ReplyWords
          chatId={context.chatId}
          key={reply.id}
          reply={reply}
          writing={false}
        />
      ))}
      {partial === null ? null : (
        <ReplyWords chatId={context.chatId} reply={partial} writing />
      )}
      <AnswerEnding ending={ending} retry={context.onRetry} />
      {replies.map((reply) => (
        <AnswerAfter context={context} key={reply.id} reply={reply} />
      ))}
    </div>
  );
};

/** Where an answer stands: its words so far, its last reply, and how it ended. */
const answerStateOf = (
  { replies, partial, live }: AnswerTurn,
  steps: readonly ActivityStep[],
  checking: boolean,
  admin: boolean
) => {
  const words = [...replies.map(({ text }) => text), partial?.text ?? ""]
    .map((text) => text.trim())
    .filter((text) => text !== "");
  const last = replies.at(-1);
  const failed = !live && last?.end === "failed";
  const ending: Ending = {
    end: live ? undefined : last?.end,
    providerMissing: failed && needsProvider.has(last?.failure),
    // The organization's admins get the way to check or replace the key; anyone else, who to ask.
    keyFailedForAdmin:
      failed && last?.failure === "model.provider_key_failed" && admin,
  };
  // Before anything shows, the message's thinking line says what Grasp does.
  const shows = steps.length > 0 || words.length > 0 || checking;
  return {
    words,
    last,
    failed,
    ending,
    status: statusOf({ live, failed, shows }),
  };
};

/** One answer of Grasp's: its steps, its words, and what came of them, as one Chat message. */
const AnswerRow = ({
  turn,
  context,
}: {
  turn: AnswerTurn;
  context: AnswerContext;
}) => {
  const { t, i18n } = useLingui();
  const admin = useMemberAdmin();
  const activitySteps = useActivitySteps();
  const { replies, partial, live } = turn;
  const stepped: Stepped[] = partial === null ? replies : [...replies, partial];
  const writing = stepped.map(
    (_, at) => partial !== null && at === stepped.length - 1
  );
  const steps = activitySteps(stepped, writing, context);
  const thought = thoughtOf(replies, partial);
  const { words, last, failed, ending, status } = answerStateOf(
    turn,
    steps,
    context.checking,
    admin
  );
  const copyText = words.join("\n\n");
  const retry = context.onRetry;
  return (
    <Message
      actions={
        retry === undefined || failed ? undefined : (
          <ChatMessageAction
            icon={Retry}
            label={t`Ask again`}
            onClick={() => {
              retry();
            }}
          />
        )
      }
      actionsLabel={t`Answer actions`}
      copyLabels={{
        copy: t`Copy the answer`,
        copied: t`Copied`,
        failed: t`Could not copy`,
      }}
      copyText={live || copyText === "" ? undefined : copyText}
      doneLabel={t`Answer ready`}
      failedLabel={
        ending.keyFailedForAdmin
          ? t`Your AI provider is refusing your key.`
          : failureMessage(last?.failure, i18n)
      }
      from="agent"
      name="Grasp"
      onRetry={ending.providerMissing ? undefined : retry}
      retryLabel={t`Try again`}
      status={ending.providerMissing ? "done" : status}
      streamingLabel={t`Writing`}
      thinkingLabel={context.workingLabel}
      thoughtLabel={(time) =>
        t`${plural(time, { one: "Thought for # second", other: "Thought for # seconds" })}`
      }
      thoughts={thought.thoughts}
      thoughtSeconds={thought.seconds}
    >
      {status === "thinking" ? undefined : (
        <AnswerBody
          context={context}
          ending={ending}
          steps={steps}
          turn={turn}
        />
      )}
    </Message>
  );
};

/** Where the page passes no calls of the chat's code. */
const noTools: readonly ChatToolEvent[] = [];

/** The chat's messages, and the response being written, oldest first. */
export const ChatThread = ({
  chatId,
  loaded,
  messages,
  output,
  partial,
  running,
  checking = false,
  tools = noTools,
  onRetry,
  compact = false,
  build,
  children,
}: {
  /** The chat, whose answers' sources core is asked for. */
  chatId: string;
  /** Whether core has sent the chat yet: until then, it is loading. */
  loaded: boolean;
  messages: readonly ChatMessage[];
  /** What the running code step has logged so far; `null` while none runs. */
  output: ChatOutput | null;
  partial: ChatPartial | null;
  /** Whether the agent is working on the chat now. */
  running: boolean;
  /** Whether its turn checks the drafts it wrote now, past its answer. */
  checking?: boolean;
  /**
   * The calls the chat's code made: what it did to the dashboard, under its
   * step, and what it reads, while it reads it.
   */
  tools?: readonly ChatToolEvent[];
  /** Asks the last question again. */
  onRetry: () => void;
  /** In the chat dock: across its width; full screen, a column in the middle. */
  compact?: boolean;
  /**
   * What a plan's Build it asks with, where the thread can build (Grasp's
   * chat): without it, a plan shows with no way to build it.
   */
  build?: ThreadBuild;
  /** Shown after the messages, in the thread: what is held, why it stopped. */
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const threadWords = useThreadWords();
  const workingLabelOf = useWorkingLabel();
  const results = resultsOf(messages);
  const { lastAnswer, answersLast } = lastAnswerOf(messages);
  const { shown, doing, step, worked } = progressOf(
    messages,
    partial,
    running,
    results
  );
  const file = readingFileOf({ doing, step, tools, messages });
  const answerThinking = useAnswerThinking(messages, running);
  // On the brain's atlas the dive plays an answer's thinking; anywhere else,
  // a note's page in the brain too, the answer carries it as a card.
  const inBrain = useLocation({
    select: ({ pathname }) => pathname === "/brain" || pathname === "/brain/",
  });
  const rows = rowsOf(messages, shown, running);
  const liveRow = rows.findLast(
    (row): row is AnswerTurn => row.kind === "answer" && row.live
  );
  const liveThinking =
    liveRow?.replies[0] === undefined
      ? undefined
      : answerThinking.byReply.get(liveRow.replies[0].id);
  const fallback = workingLabelOf(doing ?? "thinking", file, checking);
  const thinkingStep = useThinkingStep(
    liveThinking,
    liveThinking === undefined ? [] : answerThinking.arrivals(liveThinking),
    fallback
  );
  // While Grasp shows its thinking in the brain, the line says the step it is at.
  const workingLabel =
    checking || liveThinking === undefined ? fallback : thinkingStep;
  const recovered = recoveredSteps(messages);
  const waitingPlan = pendingPlan(messages, running)?.callId;
  const cardOf = (turn: AnswerTurn): ReactNode => {
    const id = turn.replies[0]?.id;
    const thinking =
      id === undefined ? undefined : answerThinking.byReply.get(id);
    if (inBrain || thinking === undefined || id === undefined) {
      return undefined;
    }
    // Until the card is there, and where it can't be drawn: the way to see
    // it in the brain, once the answer is done.
    const instead: ReactElement | null = turn.live ? null : (
      <SeeInBrain chatId={chatId} thinking={thinking} />
    );
    return (
      <Suspense fallback={instead}>
        <ThinkingCard
          chatId={chatId}
          instead={instead}
          live={turn.live}
          thinking={thinking}
        />
      </Suspense>
    );
  };
  const contextOf = (turn: AnswerTurn): AnswerContext => {
    const id = turn.replies[0]?.id;
    const thinking =
      id === undefined ? undefined : answerThinking.byReply.get(id);
    return {
      chatId,
      tools,
      results,
      recovered,
      output,
      running,
      doing: turn.live ? doing : undefined,
      workingLabel,
      checking: turn.live && checking,
      worked,
      onRetry:
        !running &&
        lastAnswer !== undefined &&
        answersLast &&
        turn.replies.includes(lastAnswer)
          ? onRetry
          : undefined,
      card: cardOf(turn),
      again: inBrain && !turn.live ? thinking : undefined,
      build,
      waitingPlan,
    };
  };
  const items: Row[] =
    children === undefined || children === null
      ? rows
      : [...rows, { kind: "after", id: "after", children }];
  // A question just sent goes to the top, the room under it kept for its answer.
  const answerTo = running
    ? rows.findLast((row) => row.kind === "question")?.id
    : undefined;
  if (!loaded) {
    return (
      <div {...stylex.props(styles.centre)}>
        <Spinner label={t`Loading…`} />
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.room)}>
      <Thread
        answerTo={answerTo}
        aria-label={t`Messages`}
        items={items}
        jumpLabel={t`Jump to latest`}
        renderItem={(row) => (
          <div {...stylex.props(!compact && styles.column)}>
            {row.kind === "question" ? (
              <Question asked={row.asked} message={row.message} />
            ) : null}
            {row.kind === "answer" ? (
              <AnswerRow context={contextOf(row)} turn={row} />
            ) : null}
            {row.kind === "after" ? row.children : null}
          </div>
        )}
        words={threadWords}
      />
    </div>
  );
};
