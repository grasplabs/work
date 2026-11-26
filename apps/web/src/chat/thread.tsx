import { definitionToolNames } from "@grasp-os/shared/chat";
import type {
  ChatAgent,
  ChatAsked,
  ChatCode,
  ChatMessage,
  ChatOutput,
  ChatPartial,
  ChatReasoning,
  ChatToolCall,
  ChatToolEvent,
} from "@grasp-os/shared/chat";
import type { ModelWait } from "@grasp-os/shared/models";
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import { Button } from "@grasp-os/ui/components/button";
import { CopyButton } from "@grasp-os/ui/components/copy-button";
import { Link } from "@grasp-os/ui/components/link";
import { Marker, MarkerContent } from "@grasp-os/ui/components/marker";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageError,
  MessageFooter,
  MessageHeader,
  MessageResponse,
  MessageSkeleton,
} from "@grasp-os/ui/components/message";
import type { MessageStatus } from "@grasp-os/ui/components/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@grasp-os/ui/components/message-scroller";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@grasp-os/ui/components/reasoning";
import { Separator } from "@grasp-os/ui/components/separator";
import { Shimmer } from "@grasp-os/ui/components/shimmer";
import { Text } from "@grasp-os/ui/components/text";
import {
  Trace,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/ui/components/trace";
import { Icon, MessageCircleIcon, RefreshCwIcon } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink, useLocation } from "@tanstack/react-router";
import { lazy, Suspense, useId, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import type { ThinkingOf } from "../brain/thinking/play.ts";
import { formatList, formatTime } from "../format.ts";
import { useMemberAdmin } from "../use-member-admin.ts";
import { ThreadAgentChange } from "./agent-change-card.tsx";
import { ThreadAgentDraft } from "./agent-draft-card.tsx";
import { AnswerSteps } from "./answer-steps.tsx";
import type { AnswerStep } from "./answer-steps.tsx";
import {
  SeeInBrain,
  useAnswerThinking,
  useThinkingStep,
} from "./answer-thinking.tsx";
import { AnswerLinks } from "./answer-words.tsx";
import { answeredOf } from "./answered.ts";
import { ThreadPlan } from "./build-progress.tsx";
import type { ThreadBuild } from "./build-progress.tsx";
import { FileCards } from "./chat-files.tsx";
import { answerStatusOf, stepFinished, stepStatusOf } from "./chat-states.ts";
import { modelName } from "./composer.tsx";
import { ConnectAiProvider } from "./connect-ai-provider.tsx";
import { failureMessage, retryMends } from "./failure.ts";
import { pendingCard } from "./make-card.tsx";
import { recoveredSteps } from "./recovered.ts";
import { SavedMemoryLine } from "./saved-memory.tsx";
import { readingFileOf, signOf } from "./sign.ts";
import type { WorkState } from "./sign.ts";
import { shortTime, turnsOf, workedFor } from "./turns.ts";
import { newLineRow, OpenAtNewLine } from "./unread.ts";

/**
 * An answer's thinking as a card (thinking-card.tsx), loaded once an
 * answer shows one: it draws the brain's shapes, which the thread, in the
 * dock on every page, never loads before.
 */
const ThinkingCard = lazy(async () => {
  const { ThinkingCard: card } = await import("./thinking-card.tsx");
  return { default: card };
});

// A chat as the person reads it, on Damsko's chat parts: a Message
// scroller holds the conversation (it follows the newest words, keeps the
// reader's place when they scroll up, offers Jump to latest, and gives a
// question just sent the room under it for its answer). Each turn is a
// Message: the person's question in their bubble; Grasp's answer as plain
// words, with what the model thought (Reasoning), the steps it took as
// one line that opens over them (answer-steps.tsx: each tool call and
// code step a line, opening to what went in and came back), and the
// answer's Markdown
// (MessageResponse, which paces it while it is written). While Grasp works
// and has shown nothing yet, one working line says what it does; once
// steps arrive, the chain's line does, so there is only ever one working
// mark. What the stream reports is read as the parts' states in one place
// (chat-states.ts).

type Result = Extract<ChatMessage, { role: "result" }>;
type Answer = Extract<ChatMessage, { role: "assistant" }>;
type Asked = Extract<ChatMessage, { role: "user" }>;

const styles = stylex.create({
  // The thread takes the room the chat gives it; the scroller is as tall as its box.
  room: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  // Full screen (the panel's column in the middle), each row's words as
  // far in from its sides as #2503's: 32px, the row's own 16 and these.
  column: {
    width: "auto",
    marginInline: space["4"],
  },
  // What stands with an answer: its steps, notes and words, the Markdown's own gap apart.
  stack: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: space["3"],
  },
  // A person's answers to Grasp's questions, each question over its answer.
  answered: {
    display: "grid",
    gap: space["2"],
    margin: 0,
  },
  answeredPair: {
    display: "grid",
    gap: space["1"],
  },
  flat: { margin: 0 },
  // A day line, as #2503's thread draws it: the day between two hairlines.
  dayLine: { display: "flex", alignItems: "center", gap: space["3"] },
  dayRule: { flexGrow: 1, flexBasis: 0, alignSelf: "center" },
  // A loading pair: the person's question over Grasp's answer.
  pair: { display: "grid", gap: space["6"] },
  // An answer's foot, as #2503's: its actions, then when it was given, on one line.
  foot: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space["3"],
    rowGap: space["2"],
    minHeight: size.controlSm,
  },
  // When an answer was given, beside its actions.
  beside: { alignSelf: "center" },
  // How long Grasp worked, a step after the line's words.
  took: {
    marginInlineStart: space["2"],
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
});

/** A text a tool call was given, by its field; an ellipsis while none has arrived. */
const fieldOf = (input: Record<string, unknown>, field: string): string => {
  const value = input[field];
  return typeof value === "string" ? value : "…";
};

/** The tools that change an App's definition. */
const definitionTools: ReadonlySet<string> = new Set(definitionToolNames);

/** The tools that read Grasp's docs. */
const docsTools: ReadonlySet<string> = new Set(["searchDocs", "readDocs"]);

/** What kind of step each of Grasp's tools is, for the answer's one line; any other is a tool. */
const toolKinds: Readonly<Record<string, AnswerStep["kind"]>> = {
  readFile: "read",
  readDocs: "read",
  writeFile: "write",
  editFile: "write",
  createApp: "write",
  editWorkflow: "write",
  remember: "remember",
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
    const query = fieldOf(input, "question");
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
        return done ? t`Saved to memory` : t`Saving to memory`;
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
  /** Whether the agent is working on the chat now. */
  running: boolean;
}

/** An answer's steps, from what it called and ran. */
const useAnswerSteps = (): ((
  replies: readonly Stepped[],
  writing: readonly boolean[],
  context: StepContext
) => AnswerStep[]) => {
  const { t } = useLingui();
  const summary = useToolSummary();
  return (replies, writing, context) =>
    replies.flatMap((reply, at) =>
      stepsOf(reply).map((step): AnswerStep => {
        const callId =
          step.kind === "tool" ? step.call.callId : step.code.callId;
        const result = context.results.get(callId);
        const status = stepStatusOf({
          result,
          writing: writing[at] ?? false,
          running: context.running,
          recovered: context.recovered.has(callId),
        });
        // A step that never finished reads as it went: "Searching the brain", stopped.
        const finished = stepFinished(status);
        if (step.kind === "tool") {
          return {
            id: callId,
            kind: toolKinds[step.call.tool] ?? "tool",
            label: summary(step.call, finished),
            active: summary(step.call, false),
            status,
            input: JSON.stringify(step.call.input, null, 2),
            result: result?.text,
          };
        }
        const logged =
          context.output?.callId === callId ? context.output.text : undefined;
        return {
          id: callId,
          kind: "tool",
          label: finished ? t`Ran a code step` : t`Running a code step`,
          active:
            status === "writing"
              ? t`Writing a code step`
              : t`Running a code step`,
          status,
          input: step.code.code,
          result: result?.text ?? logged,
        };
      })
    );
};

/** What Grasp does while it works on a question, said as the line over its answer. */
const useWorkingLabel = (): ((
  doing: WorkState,
  file: string | undefined,
  checking: boolean,
  modelWait: ModelWait | null
) => string) => {
  const { t } = useLingui();
  return (doing, file, checking, modelWait) => {
    if (checking) {
      return t({
        message: "Checking the App…",
        comment:
          "Grasp checks the App it changed (its types, lint and preview) before its turn ends.",
      });
    }
    if (modelWait?.kind === "rate_limited") {
      const { seconds } = modelWait;
      return t({
        message: plural(seconds, {
          one: "Your AI provider is busy. Grasp tries again in # second.",
          other: "Your AI provider is busy. Grasp tries again in # seconds.",
        }),
        comment:
          "The AI provider asked Grasp to wait before asking again (its rate limit); Grasp waits, then asks again by itself.",
      });
    }
    if (modelWait?.kind === "fallback") {
      const model = modelName(modelWait.model);
      return t({
        message: `Answering with ${model} instead.`,
        comment:
          "The chosen model couldn't take the question (its provider refused or was busy), so another of the organization's models answers it; {model} is that model's name.",
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

/** The kinds of step, in the order the answer's one line names them. */
const kindOrder: readonly AnswerStep["kind"][] = [
  "search",
  "read",
  "write",
  "remember",
  "tool",
];

/**
 * What an answer's steps came to, in a line, as #2503 says it: each kind
 * of step that ran, done or failed ("Searched once and ran 1 tool"), then
 * how many failed.
 */
const useStepsSummary = (): ((steps: readonly AnswerStep[]) => string) => {
  const { t, i18n } = useLingui();
  // Each a part of the line, joined with the others: "searched once and ran 1 tool".
  const partOf = (kind: AnswerStep["kind"], count: number): string =>
    ({
      search: t`${plural(count, { one: "searched once", other: "searched # times" })}`,
      read: t`${plural(count, { one: "read # file", other: "read # files" })}`,
      write: t`${plural(count, { one: "changed # file", other: "changed # files" })}`,
      remember: t`${plural(count, { one: "saved # memory", other: "saved # memories" })}`,
      tool: t`${plural(count, { one: "ran # tool", other: "ran # tools" })}`,
    })[kind];
  return (steps) => {
    const ran = steps.filter(
      ({ status }) => stepFinished(status) || status === "failed"
    );
    const parts = kindOrder.flatMap((kind) => {
      const count = ran.filter((step) => step.kind === kind).length;
      return count === 0 ? [] : [partOf(kind, count)];
    });
    if (parts.length === 0) {
      return t`No steps yet`;
    }
    const joined = formatList(parts);
    const line = `${joined.charAt(0).toLocaleUpperCase(i18n.locale)}${joined.slice(1)}`;
    const failedCount = steps.filter(
      ({ status }) => status === "failed"
    ).length;
    if (failedCount === 0) {
      return line;
    }
    const failed = t`${plural(failedCount, { one: "# step failed", other: "# steps failed" })}`;
    return t({
      message: `${line}; ${failed}`,
      comment:
        "What an answer's steps came to, then how many failed: Read 2 files; 1 step failed.",
    });
  };
};

/** A length of time in milliseconds, said short as #2503 says it: "5.0s", "21s", "4m 05s". */
const useSaidShort = (): ((ms: number) => string) => {
  const { t, i18n } = useLingui();
  return (ms) => {
    const { minutes, seconds, tenths } = shortTime(ms);
    if (minutes > 0) {
      const rest = String(seconds).padStart(2, "0");
      return t({
        message: `${minutes}m ${rest}s`,
        comment: "A length of time, said short: 4 minutes and 05 seconds.",
      });
    }
    const rest = tenths
      ? new Intl.NumberFormat(i18n.locale, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(seconds)
      : String(seconds);
    return t({
      message: `${rest}s`,
      comment:
        "A length of time, said short: 21 seconds, or 5.0 seconds (to a tenth under ten).",
    });
  };
};

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
  <Link asChild variant="plain">
    <RouterLink to="/settings/ai-providers">
      <Trans>Check or replace it in Settings › AI providers</Trans>
    </RouterLink>
  </Link>
);

/** What the questions the agent asked were about, under the answer that asked them. */
const AskedLine = ({ asked }: { asked: ChatAsked }) => {
  const { t } = useLingui();
  const topics = asked.questions.flatMap(({ header }) => header ?? []);
  const count = asked.questions.length;
  const list = formatList(topics);
  return (
    <Trace>
      <TraceLine>
        <TraceIcon>
          <Icon icon={MessageCircleIcon} />
        </TraceIcon>
        <TraceTitle>
          {topics.length === count
            ? t`Asked you about ${list}`
            : t`${plural(count, { one: "Asked you a question", other: "Asked you # questions" })}`}
        </TraceTitle>
      </TraceLine>
    </Trace>
  );
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
  | { kind: "after"; id: string; at?: undefined; children: ReactNode }
  | { kind: "new"; id: string; at?: undefined }
  | {
      kind: "day";
      id: string;
      at?: undefined;
      /** When the day began, where the reader is. */
      day: number;
      /** How many days before today it is: 0 today, 1 yesterday. */
      ago: number;
      sameYear: boolean;
    };

/** When the day `date` falls on began, where the reader is. */
const dayOf = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const msPerDay = 24 * 60 * 60 * 1000;

/**
 * The rows with a day line where the day changes, as #2503's thread draws
 * them: none over a thread that starts today, so its first line stands
 * only for an earlier day.
 */
const withDayLines = (rows: readonly Row[], now = new Date()): Row[] => {
  const today = dayOf(now).getTime();
  const lined: Row[] = [];
  let last: number | undefined;
  for (const row of rows) {
    const time =
      row.at === undefined ? Number.NaN : dayOf(new Date(row.at)).getTime();
    if (!Number.isNaN(time) && time !== last) {
      if (last !== undefined || time !== today) {
        lined.push({
          kind: "day",
          id: `day-${time}`,
          day: time,
          ago: Math.round((today - time) / msPerDay),
          sameYear: new Date(time).getFullYear() === now.getFullYear(),
        });
      }
      last = time;
    }
    lined.push(row);
  }
  return lined;
};

/** A day line: the day in the middle, a hairline each side; today, yesterday, or the day as the page's language writes it. */
const DayLine = ({
  day,
  ago,
  sameYear,
}: Pick<Extract<Row, { kind: "day" }>, "day" | "ago" | "sameYear">) => {
  const { t, i18n } = useLingui();
  let words = new Intl.DateTimeFormat(
    i18n.locale,
    sameYear
      ? { weekday: "long", day: "numeric", month: "long" }
      : { day: "numeric", month: "long", year: "numeric" }
  ).format(day);
  if (ago === 0) {
    words = t({ message: "Today", context: "a day line in a chat" });
  } else if (ago === 1) {
    words = t({ message: "Yesterday", context: "a day line in a chat" });
  }
  return (
    <div {...stylex.props(styles.dayLine)}>
      <Separator decorative style={styles.dayRule} />
      <Text as="span" color="muted" size="xs" weight="medium">
        {words}
      </Text>
      <Separator decorative style={styles.dayRule} />
    </div>
  );
};

/**
 * The rows with the New line over the answer that holds reply `before`,
 * the first the person hadn't seen as the chat opened (unread.ts); as
 * they are where there is none.
 */
const withNewLine = (rows: readonly Row[], before: number | undefined) => {
  const at = rows.findIndex(
    (row) =>
      row.kind === "answer" && row.replies.some(({ id }) => id === before)
  );
  return at === -1
    ? [...rows]
    : [
        ...rows.slice(0, at),
        { kind: "new" as const, id: newLineRow },
        ...rows.slice(at),
      ];
};

/**
 * The New line, over what the person hadn't seen: a separator named New,
 * its word in the middle of a hairline, in the primary colour as news is.
 * Never focused: the thread opens with it near the top instead.
 */
const NewLine = () => {
  const { t } = useLingui();
  const words = t({
    message: "New",
    context: "the line in a chat over the answers the person hasn't read",
  });
  return (
    <Marker color="primary" decorative={false} variant="separator">
      <MarkerContent>{words}</MarkerContent>
    </Marker>
  );
};

/**
 * Whether a reply by `agentId` goes on `answer`: given by the same agent as
 * its last reply. A question that mentions several agents (`@`) is answered
 * by each in turn, each its own answer.
 */
const sameAgent = (
  answer: AnswerTurn,
  agentId: string | undefined
): boolean => {
  const before = answer.replies.at(-1)?.agentId;
  return before === undefined || agentId === undefined || before === agentId;
};

/** The thread's rows: each question, then its replies as one answer per agent, the reply being written joined to it. */
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
      if (last?.kind === "answer" && sameAgent(last, message.agentId)) {
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
  if (last?.kind === "answer" && sameAgent(last, partial?.agentId)) {
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

/** When a message was sent, at its foot: the time of day, after what else stands there (an answer's actions). */
const SentAt = ({
  at,
  children,
  style,
}: {
  at: string | undefined;
  children?: ReactNode;
  style?: LayoutStyle;
}) => (
  <MessageFooter {...(style === undefined ? {} : { style })}>
    {children}
    {at === undefined ? null : <time dateTime={at}>{formatTime(at)}</time>}
  </MessageFooter>
);

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
  const answered =
    asked === undefined ? undefined : answeredOf(asked, message.text);
  return (
    <Message align="end">
      <MessageContent>
        {message.files === undefined || message.files.length === 0 ? null : (
          <FileCards files={message.files} />
        )}
        <Bubble align="end" variant="secondary">
          <BubbleContent>
            {answered === undefined ? (
              message.text
            ) : (
              <dl {...stylex.props(styles.answered)}>
                {answered.map(({ question, answer }) => (
                  <div key={question} {...stylex.props(styles.answeredPair)}>
                    <dt>
                      <Text color="muted" size="sm">
                        {question}
                      </Text>
                    </dt>
                    <dd {...stylex.props(styles.flat)}>{answer}</dd>
                  </div>
                ))}
              </dl>
            )}
          </BubbleContent>
        </Bubble>
        <SentAt at={message.at} />
      </MessageContent>
    </Message>
  );
};

/** Everything an answer is drawn from, beyond its own replies. */
interface AnswerContext extends StepContext {
  chatId: string;
  /** What Grasp does on this answer while it works on it. */
  doing: WorkState | undefined;
  /** What the line over it says while Grasp works on it. */
  workingLabel: string;
  /** Grasp checks the drafts it wrote, past its answer. */
  checking: boolean;
  /**
   * The model's request waits (its provider's rate limit, another model
   * answering instead): the line says so, not what Grasp does.
   */
  modelWaits: boolean;
  /** How long Grasp worked on each question, in milliseconds, by the ID of its first reply. */
  worked: ReadonlyMap<number, number>;
  /** Asks the last question again: offered under its answer only. */
  onRetry: (() => void) | undefined;
  /** Its thinking as a small picture, where it showed one. */
  card: ReactNode;
  /** The way to see its thinking again in the brain, on the brain's own page. */
  again: ThinkingOf | undefined;
  build: ThreadBuild | undefined;
  /** The card waiting for the person (a plan, or an agent's draft or change), by its call. */
  waiting: string | undefined;
  /** Who gave it, named where the chat has answers from more than one agent. */
  agentName: string | undefined;
  /** What the chat read, folded under its words: the last answer's alone, once it is done. */
  sources: ReactNode;
}

/** What follows a stored reply: the questions it asked, and the plan or agent it drafted. */
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
        waiting={context.waiting === reply.planned.callId}
      />
    )}
    {reply.agentDraft === undefined ? null : (
      <ThreadAgentDraft
        build={context.build}
        chatId={context.chatId}
        draft={reply.agentDraft}
        waiting={context.waiting === reply.agentDraft.callId}
      />
    )}
    {reply.agentChange === undefined ? null : (
      <ThreadAgentChange
        build={context.build}
        change={reply.agentChange}
        chatId={context.chatId}
        waiting={context.waiting === reply.agentChange.callId}
      />
    )}
  </>
);

/**
 * What the model thought for an answer, all its replies' together, and for
 * how long: only once no round being written has thought, as that one
 * isn't timed until it is saved (`timed`).
 */
const thoughtOf = (
  replies: readonly Answer[],
  partial: ChatPartial | null
): {
  thoughts: string | undefined;
  seconds: number | undefined;
  timed: boolean;
} => {
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
  const timed = partial === null || partial.reasoning === "";
  return {
    thoughts: thoughts === "" ? undefined : thoughts,
    // At least a second, once it was timed.
    seconds:
      ms === undefined || !timed
        ? undefined
        : Math.max(1, Math.round(ms / 1000)),
    timed,
  };
};

/** How an answer ended, when it did not simply finish: cut off, or with no provider to call. */
interface Ending {
  cutOff: boolean;
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
}) => (
  <>
    {ending.cutOff ? (
      <Text as="p" color="muted" size="sm">
        <Trans>The answer was cut off at the model&apos;s limit.</Trans>
      </Text>
    ) : null}
    {ending.providerMissing ? <ConnectAiProvider /> : null}
    {ending.providerMissing && retry !== undefined ? (
      <Button
        onClick={() => {
          retry();
        }}
        size="sm"
        variant="ghost"
      >
        <Icon icon={RefreshCwIcon} />
        <Trans>Try again</Trans>
      </Button>
    ) : null}
  </>
);

/** What an answer holds: its steps, what they did, its words, and how it ended. */
const AnswerBody = ({
  turn,
  context,
  steps,
  ending,
  status,
}: {
  turn: AnswerTurn;
  context: AnswerContext;
  steps: AnswerStep[];
  ending: Ending;
  status: MessageStatus;
}) => {
  const { t } = useLingui();
  const saidShort = useSaidShort();
  const summary = useStepsSummary();
  const { replies, partial, live } = turn;
  const stepped: Stepped[] = partial === null ? replies : [...replies, partial];
  const text = [...replies.map((reply) => reply.text), partial?.text ?? ""]
    .filter((words) => words.trim() !== "")
    .join("\n\n");
  const firstId = replies[0]?.id;
  const workedMs =
    firstId === undefined ? undefined : context.worked.get(firstId);
  // The chain's line says what Grasp does once steps show, or between two
  // replies; while words arrive, they say it themselves.
  const activity =
    steps.length > 0 || (live && (context.checking || partial === null));
  // What Grasp does next is work, never a second "Thinking": the thought's
  // own line has said that.
  const working =
    !context.checking &&
    !context.modelWaits &&
    (context.doing ?? "thinking") === "thinking"
      ? t`Working on it`
      : context.workingLabel;
  // Done: what the steps came to, and how long Grasp worked, quieter.
  const line: ReactNode = (
    <>
      {summary(steps)}
      {workedMs === undefined ? null : (
        <>
          {/* The space a screen reader says; the eye has the gap. */}
          <span {...stylex.props(visuallyHidden)}> </span>
          <span {...stylex.props(styles.took)}>{saidShort(workedMs)}</span>
        </>
      )}
    </>
  );
  return (
    <div {...stylex.props(styles.stack)}>
      {activity ? (
        <AnswerSteps
          line={line}
          live={live}
          steps={steps}
          workingLabel={working}
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
      {context.card}
      {context.again === undefined ? null : (
        <SeeInBrain chatId={context.chatId} thinking={context.again} />
      )}
      {/* All its replies' words as one response, as Damsko draws a
        Message: so a stopped answer says Stopped once under its words,
        and also when it was stopped before any. */}
      {text === "" && status !== "stopped" ? null : (
        <MessageResponse streaming={partial !== null}>{text}</MessageResponse>
      )}
      <AnswerEnding ending={ending} retry={context.onRetry} />
      {context.sources}
      {replies.map((reply) => (
        <AnswerAfter context={context} key={reply.id} reply={reply} />
      ))}
    </div>
  );
};

/** Where an answer stands: its words so far, its last reply, and how it ended. */
const answerStateOf = (
  { replies, partial, live }: AnswerTurn,
  steps: readonly AnswerStep[],
  checking: boolean,
  admin: boolean
) => {
  const words = [...replies.map(({ text }) => text), partial?.text ?? ""]
    .map((text) => text.trim())
    .filter((text) => text !== "");
  const last = replies.at(-1);
  const end = live ? undefined : last?.end;
  const failed = end === "failed";
  const providerMissing = failed && needsProvider.has(last?.failure);
  const ending: Ending = {
    cutOff: end === "cut_off",
    providerMissing,
    // The organization's admins get the way to check or replace the key; anyone else, who to ask.
    keyFailedForAdmin:
      failed && last?.failure === "model.provider_key_failed" && admin,
  };
  return {
    words,
    last,
    ending,
    status: answerStatusOf({
      live,
      // Before anything shows, the working line says what Grasp does.
      shows: steps.length > 0 || words.length > 0 || checking,
      end,
      providerMissing,
    }),
  };
};

/** The reply being written still thinks: its thoughts come, nothing else yet. */
const stillThinks = (partial: ChatPartial | null): boolean =>
  partial !== null &&
  partial.reasoning.trim() !== "" &&
  partial.text.trim() === "" &&
  partial.code.length === 0 &&
  partial.tools.length === 0;

/**
 * What the model thought for an answer, under Thinking while it thinks
 * (`workingLabel` before anything else shows), then how long. Done
 * thinking but not yet `timed`: no duration, nor Reasoning's own count of
 * its last round alone.
 */
const Thoughts = ({
  thoughts,
  seconds,
  timed,
  streaming,
  workingLabel,
}: {
  thoughts: string;
  seconds: number | undefined;
  timed: boolean;
  streaming: boolean;
  workingLabel: string | undefined;
}) => {
  const { t } = useLingui();
  let line = workingLabel;
  if (line === undefined && !streaming && !timed) {
    line = t({ message: "Thought", context: "the model thought first" });
  }
  return (
    <Reasoning
      {...(seconds === undefined ? {} : { duration: seconds })}
      isStreaming={streaming}
    >
      <ReasoningTrigger>{line}</ReasoningTrigger>
      <ReasoningContent>{thoughts}</ReasoningContent>
    </Reasoning>
  );
};

/**
 * Whether the thought's line shows, as #2503's: once the model thought
 * here it has its line for good; an answer read back has one only where
 * its thinking was timed.
 */
const useThoughtShown = (
  thinks: boolean,
  seconds: number | undefined
): boolean => {
  const [began, setBegan] = useState(thinks);
  if (thinks && !began) {
    setBegan(true);
  }
  return began || seconds !== undefined;
};

/**
 * An answer's foot: its actions, then when it was given, on one line;
 * with no words to act on (its turn asked the person instead, or it
 * failed), the time alone. The actions stand in the time's own
 * MessageFooter, so they come and go exactly as it does: where a pointer
 * hovers, while the message is hovered or holds the focus (so the
 * keyboard reaches them, and they show as it does); on touch always;
 * never hidden from a screen reader, and their room always kept. They
 * are there from the start, while it is written too: the Message keeps
 * them unseen and out of reach until the answer is done, so the end
 * moves nothing. A stopped answer keeps them out of the footer, always
 * shown: Damsko says Stopped on the actions' row, and that must not hide.
 */
const AnswerFoot = ({
  at,
  copyText,
  retry,
  stopped,
}: {
  at: string | undefined;
  copyText: string;
  retry: (() => void) | undefined;
  stopped: boolean;
}) => {
  const { t } = useLingui();
  if (copyText === "") {
    return at === undefined ? null : <SentAt at={at} />;
  }
  const actions = (
    <MessageActions aria-label={t`Answer actions`}>
      <CopyButton aria-label={t`Copy the answer`} value={copyText} />
      {retry === undefined ? null : (
        <MessageAction aria-label={t`Ask again`} onClick={retry}>
          <Icon icon={RefreshCwIcon} />
        </MessageAction>
      )}
    </MessageActions>
  );
  if (stopped) {
    return (
      <div {...stylex.props(styles.foot)}>
        {actions}
        {/* Level with the actions, in the middle of their line. */}
        {at === undefined ? null : <SentAt at={at} style={styles.beside} />}
      </div>
    );
  }
  return <SentAt at={at}>{actions}</SentAt>;
};

/** One answer of Grasp's: what it thought, its steps, its words, and what came of them, as one Message. */
const AnswerRow = ({
  turn,
  context,
}: {
  turn: AnswerTurn;
  context: AnswerContext;
}) => {
  const { t, i18n } = useLingui();
  const admin = useMemberAdmin();
  const answerSteps = useAnswerSteps();
  const { replies, partial } = turn;
  const stepped: Stepped[] = partial === null ? replies : [...replies, partial];
  const writing = stepped.map(
    (_, at) => partial !== null && at === stepped.length - 1
  );
  const steps = answerSteps(stepped, writing, context);
  const thought = thoughtOf(replies, partial);
  const { words, last, ending, status } = answerStateOf(
    turn,
    steps,
    context.checking,
    admin
  );
  const copyText = words.join("\n\n");
  const retry = context.onRetry;
  const thinking = status === "thinking";
  const thinksNow = thinking || stillThinks(partial);
  const thoughtShown = useThoughtShown(thinksNow, thought.seconds);
  return (
    <Message aria-label={context.agentName ?? "Grasp"} status={status}>
      <MessageContent>
        {context.agentName === undefined ? null : (
          <MessageHeader>{context.agentName}</MessageHeader>
        )}
        {thought.thoughts === undefined || !thoughtShown ? null : (
          <Thoughts
            seconds={thought.seconds}
            streaming={thinksNow}
            thoughts={thought.thoughts}
            timed={thought.timed}
            workingLabel={thinking ? context.workingLabel : undefined}
          />
        )}
        {thinking && thought.thoughts === undefined ? (
          <Shimmer>{context.workingLabel}</Shimmer>
        ) : null}
        {thinking ? null : (
          <AnswerBody
            context={context}
            ending={ending}
            status={status}
            steps={steps}
            turn={turn}
          />
        )}
        {status === "error" ? (
          <MessageError
            // Only where asking the same again may mend it: never under a
            // decline, or a chat past the model's window.
            {...(retry === undefined || !retryMends(last?.failure)
              ? {}
              : { onRetry: retry })}
          >
            {ending.keyFailedForAdmin ? (
              <>
                {t`Your AI provider is refusing your key.`}{" "}
                {/* With the failure it fixes: the way to check or replace the key. */}
                <KeyFailed />
              </>
            ) : (
              failureMessage(last?.failure, i18n)
            )}
          </MessageError>
        ) : null}
        <AnswerFoot
          at={last?.at}
          copyText={status === "error" ? "" : copyText}
          retry={retry}
          stopped={status === "stopped"}
        />
      </MessageContent>
    </Message>
  );
};

/** Where the page passes no calls of the chat's code. */
const noTools: readonly ChatToolEvent[] = [];

/** Where the page passes no agents. */
const noAgents: readonly ChatAgent[] = [];

/**
 * The answers that name their agent, by ID: in a chat more than one agent
 * answered in, each answer whose agent isn't the one before it. A chat one
 * agent answers in names none, as it always did.
 */
export const answerAgentsOf = (
  messages: readonly ChatMessage[]
): ReadonlyMap<number, string> => {
  const answers = messages.filter(
    (message): message is Answer => message.role === "assistant"
  );
  const named = new Map<number, string>();
  if (new Set(answers.flatMap(({ agentId }) => agentId ?? [])).size < 2) {
    return named;
  }
  let before: string | undefined;
  for (const { id, agentId } of answers) {
    if (agentId !== undefined && agentId !== before) {
      named.set(id, agentId);
    }
    before = agentId ?? before;
  }
  return named;
};

/** The keys of the loading pairs: the same each time. */
const loadingPairs = ["first", "second"] as const;

/** The chat's messages, and the response being written, oldest first. */
export const ChatThread = ({
  agents = noAgents,
  chatId,
  loaded,
  messages,
  output,
  partial,
  running,
  checking = false,
  modelWait = null,
  tools = noTools,
  onRetry,
  compact = false,
  build,
  newLineBefore,
  sources,
  children,
}: {
  /**
   * The agents the person may ask, which name each answer that another
   * agent gave than the one before it; none, and no names, where the page
   * hasn't them.
   */
  agents?: readonly ChatAgent[] | undefined;
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
   * What its turn's model request waits on now (`ChatUpdate.waiting`):
   * said in the line over the answer while it waits.
   */
  modelWait?: ModelWait | null;
  /**
   * The calls the chat's code made: what it reads, while it reads it.
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
  /**
   * The answer the New line goes over, the first the person hadn't seen
   * as the chat opened: the thread opens with it near the top, or at its
   * end when all it has unread fits (MessageScroller's `last-anchor`).
   * None, and it opens at its end.
   */
  newLineBefore?: number;
  /**
   * What the chat read (its provenance, kept for the chat as a whole):
   * under the last answer's words once it is done, as Damsko's Sources
   * folds what an answer drew on under it.
   */
  sources?: ReactNode;
  /** Shown after the messages, in the thread: what is held, why it stopped. */
  children?: ReactNode;
}) => {
  const { t } = useLingui();
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
  const lastAnswerRow = rows.findLast(
    (row): row is AnswerTurn => row.kind === "answer"
  );
  const liveThinking =
    liveRow?.replies[0] === undefined
      ? undefined
      : answerThinking.byReply.get(liveRow.replies[0].id);
  const fallback = workingLabelOf(
    doing ?? "thinking",
    file,
    checking,
    modelWait
  );
  const thinkingStep = useThinkingStep(
    liveThinking,
    liveThinking === undefined ? [] : answerThinking.arrivals(liveThinking),
    fallback
  );
  // While Grasp shows its thinking in the brain, the line says the step it is at.
  const workingLabel =
    checking || modelWait !== null || liveThinking === undefined
      ? fallback
      : thinkingStep;
  const recovered = recoveredSteps(messages);
  // The one card that waits for the person, whichever it is.
  const waiting = pendingCard(messages, running)?.callId;
  const answerAgents = answerAgentsOf(messages);
  // Who gave an answer, where the chat has answers from more than one
  // agent: each that isn't the one before it, the one writing now too.
  const agentNameOf = (turn: AnswerTurn): string | undefined => {
    const [first] = turn.replies;
    const writer =
      first === undefined ? turn.partial?.agentId : answerAgents.get(first.id);
    if (
      writer === undefined ||
      (first === undefined &&
        (lastAnswer?.agentId === undefined || writer === lastAnswer.agentId))
    ) {
      return undefined;
    }
    return (
      agents.find(({ id }) => id === writer)?.name ??
      t`An agent you can no longer ask`
    );
  };
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
      results,
      recovered,
      output,
      running,
      doing: turn.live ? doing : undefined,
      workingLabel,
      checking: turn.live && checking,
      modelWaits: turn.live && modelWait !== null,
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
      waiting,
      agentName: agentNameOf(turn),
      sources:
        turn.id === lastAnswerRow?.id && !turn.live ? sources : undefined,
    };
  };
  const lined = withNewLine(withDayLines(rows), newLineBefore);
  const logId = useId();
  const items: Row[] =
    children === undefined || children === null
      ? lined
      : [...lined, { kind: "after", id: "after", children }];
  const column: { style?: LayoutStyle } = compact
    ? {}
    : { style: styles.column };
  return (
    <div {...stylex.props(styles.room)}>
      <AnswerLinks>
        <MessageScrollerProvider autoScroll loading={!loaded}>
          {/* It opens at its end, as ever, or at the New line (unread.ts). */}
          <OpenAtNewLine
            line={loaded ? newLineBefore : undefined}
            logId={logId}
          />
          <MessageScroller>
            <MessageScrollerViewport aria-label={t`Messages`} id={logId}>
              <MessageScrollerContent aria-busy={running}>
                {loaded
                  ? items.map((row) => (
                      <MessageScrollerItem
                        key={row.id}
                        messageId={row.id}
                        scrollAnchor={row.kind === "question"}
                        {...column}
                      >
                        {row.kind === "question" ? (
                          <Question asked={row.asked} message={row.message} />
                        ) : null}
                        {row.kind === "answer" ? (
                          <AnswerRow context={contextOf(row)} turn={row} />
                        ) : null}
                        {row.kind === "after" ? row.children : null}
                        {row.kind === "new" ? <NewLine /> : null}
                        {row.kind === "day" ? (
                          <DayLine
                            ago={row.ago}
                            day={row.day}
                            sameYear={row.sameYear}
                          />
                        ) : null}
                      </MessageScrollerItem>
                    ))
                  : loadingPairs.map((key) => (
                      <MessageScrollerItem key={key} {...column}>
                        <div {...stylex.props(styles.pair)}>
                          <MessageSkeleton align="end" />
                          <MessageSkeleton />
                        </div>
                      </MessageScrollerItem>
                    ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </AnswerLinks>
    </div>
  );
};
