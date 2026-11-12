import { definitionToolNames } from "@grasp-os/shared/chat";
import type {
  ChatCitation,
  ChatCode,
  ChatMessage,
  ChatOutput,
  ChatPartial,
  ChatReasoning,
  ChatToolCall,
  ChatToolEvent,
} from "@grasp-os/shared/chat";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import { Button } from "@grasp-os/ui/components/button";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@grasp-os/ui/components/message";
import { Spinner } from "@grasp-os/ui/components/spinner";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/ui/components/trace";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useLocation } from "@tanstack/react-router";
import {
  BrainIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleIcon,
  ClockIcon,
  CopyIcon,
  LayoutDashboardIcon,
  RefreshCcwIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";
import { createContext, Fragment, lazy, Suspense, use, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import type { ThinkingOf } from "../brain/thinking/play.ts";
import { useCopy } from "../copy.ts";
import { ConnectAiProvider } from "../frame/connect-ai-provider.tsx";
import { useMemberAdmin } from "../use-member-admin.ts";
import { AnswerMarkdown } from "./answer-markdown.tsx";
import {
  SeeInBrain,
  ThinkingLine,
  useAnswerThinking,
} from "./answer-thinking.tsx";
import { answeredOf } from "./answered.ts";
import { AskedLine } from "./asked-questions.tsx";
import { pendingPlan, ThreadPlan } from "./build-progress.tsx";
import type { ThreadBuild } from "./build-progress.tsx";
import { FileCards } from "./chat-files.tsx";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./conversation.tsx";
import { failureMessage } from "./failure.ts";
import { GraspSign } from "./grasp-sign.tsx";
import { recoveredSteps } from "./recovered.ts";
import { readingFileOf, signOf } from "./sign.ts";
import type { WorkState } from "./sign.ts";
import { AnswerCited, AnswerSources, useCitedDocuments } from "./sources.tsx";
import { minutesAndSeconds, turnsOf, workedFor } from "./turns.ts";
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

// A chat as the person reads it, in the prototype's look
// (grasplabs/prototype `components/chat/chat-thread.tsx` and
// `chat-message.tsx`): their questions in a grey bubble on the right,
// Grasp's answers with the steps it took as one trace over their words
// (`Trace`): what it does, or how long it worked, as its first line, then
// its thinking and each code step, a step at work turning and one done
// folded, to open for more. While Grasp works on a question, Grasp's sign
// stands under its newest answer and each new word fades in where it
// lands; once it is done, the answer has its actions in a quiet row under
// it. It follows the answer as it streams, unless the person scrolls
// up to read (`Conversation`); each message is the kit's (`Message`), a
// question in its `Bubble`, an answer's words set for reading.

type Result = Extract<ChatMessage, { role: "result" }>;
type Answer = Extract<ChatMessage, { role: "assistant" }>;
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

const statusIcon: Record<StepStatus, ReactNode> = {
  writing: <CircleIcon />,
  running: <ClockIcon />,
  done: <CheckCircleIcon className="text-status-agreed" />,
  failed: <XCircleIcon />,
  retried: <RefreshCcwIcon />,
  stopped: <XCircleIcon />,
};

/** How a step's line stands in the trace: turning while at work. */
const lineStatus: Record<
  StepStatus,
  "running" | "error" | "attention" | undefined
> = {
  writing: "running",
  running: "running",
  done: undefined,
  failed: "error",
  retried: undefined,
  stopped: "attention",
};

/** The steps of the thread that failed and were recovered from (recovered.ts). */
const Recovered = createContext<ReadonlySet<string>>(new Set());

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

/** A step's status, said short: on every step's line but one done well. */
const useStatusLabel = (): ((status: StepStatus) => string) => {
  const { t } = useLingui();
  return (status) =>
    ({
      writing: t`Writing`,
      running: t`Running`,
      done: t`Done`,
      failed: t`Failed`,
      retried: t`Retried`,
      stopped: t`Stopped`,
    })[status];
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

/** The paths of the files a call writes (`files`, by path), as far as they came. */
const pathsOf = (input: Record<string, unknown>): string[] => {
  const { files } = input;
  return typeof files === "object" && files !== null ? Object.keys(files) : [];
};

/**
 * What a call of one of Grasp's tools did, in a line: in the past once it
 * is done, as it goes while it is written, runs, failed or was stopped.
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

/** One part of a step, opened: a heading, and its text as code. */
const StepPart = ({
  heading,
  text,
  failed = false,
}: {
  heading: ReactNode;
  text: string;
  failed?: boolean;
}) => (
  <section className="flex flex-col gap-2">
    <h4 className="text-xs font-medium tracking-wide uppercase">{heading}</h4>
    <pre
      className={
        failed
          ? "bg-destructive/10 text-destructive overflow-x-auto rounded-md p-3 text-xs"
          : "bg-muted/50 text-foreground overflow-x-auto rounded-md p-3 text-xs"
      }
    >
      <code className="font-mono">{text}</code>
    </pre>
  </section>
);

/**
 * One call of Grasp's tools, folded: a line saying what it did, and what
 * it was given and what came of it on opening.
 */
const ToolStep = ({
  call,
  result,
  writing,
  running,
}: {
  call: ChatToolCall;
  result: Result | undefined;
  writing: boolean;
  running: boolean;
}) => {
  const status = stepStatusOf(
    result,
    writing,
    running,
    use(Recovered).has(call.callId)
  );
  const summary = useToolSummary()(call, status === "done");
  const label = useStatusLabel()(status);
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={lineStatus[status]}>
          <TraceIcon>{statusIcon[status]}</TraceIcon>
          <TraceTitle>{summary}</TraceTitle>
          {status === "done" ? null : (
            <TraceDescription>{label}</TraceDescription>
          )}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <div className="flex flex-col gap-4 py-1">
          <StepPart
            heading={<Trans>Input</Trans>}
            text={JSON.stringify(call.input, null, 2)}
          />
          {result === undefined ? null : (
            <StepPart
              failed={status === "failed"}
              heading={
                result.failed ? <Trans>Error</Trans> : <Trans>Result</Trans>
              }
              text={result.text}
            />
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
};

/** One code step, folded: its status, and the code and result on opening. */
const CodeStep = ({
  code,
  result,
  output,
  writing,
  running,
}: {
  code: ChatCode;
  result: Result | undefined;
  /** What it has logged so far, while it runs and has no result yet. */
  output: string | undefined;
  /** Still being written by the model. */
  writing: boolean;
  /** Whether the agent is working on the chat now. */
  running: boolean;
}) => {
  const status = stepStatusOf(
    result,
    writing,
    running,
    use(Recovered).has(code.callId)
  );
  const label = useStatusLabel()(status);
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={lineStatus[status]}>
          <TraceIcon>{statusIcon[status]}</TraceIcon>
          <TraceTitle>
            <Trans>Code step</Trans>
          </TraceTitle>
          <TraceDescription>{label}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <div className="flex flex-col gap-4 py-1">
          <StepPart heading={<Trans>Code</Trans>} text={code.code} />
          {result !== undefined || output === undefined ? null : (
            <StepPart heading={<Trans>Output</Trans>} text={output} />
          )}
          {result === undefined ? null : (
            <StepPart
              failed={status === "failed"}
              heading={
                result.failed ? <Trans>Error</Trans> : <Trans>Result</Trans>
              }
              text={result.text}
            />
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
};

/** Copies the answer's text, and says so for a moment. */
const CopyAnswer = ({ text }: { text: string }) => {
  const { t } = useLingui();
  const { copied, copy } = useCopy();
  return (
    <MessageAction
      label={copied ? t`Copied` : t`Copy the answer`}
      onClick={() => {
        void copy(text);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </MessageAction>
  );
};

/** No step of thinking has arrived. */
const noArrivals: readonly (number | undefined)[] = [];

/**
 * The trace's first line, over an answer Grasp works on: what it does now,
 * as a light runs through the words; the file it reads, while its code reads
 * one of the chat's; the step of its thinking it is at, while it shows that
 * in the brain.
 */
const Working = ({
  doing,
  file,
  thinking,
  checking = false,
  arrivals = noArrivals,
}: {
  doing: WorkState;
  file?: string;
  thinking?: ThinkingOf;
  /** The turn checks the drafts it wrote, past its answer. */
  checking?: boolean;
  arrivals?: readonly (number | undefined)[];
}) => {
  const { t } = useLingui();
  let label =
    file === undefined
      ? {
          reading: t`Reading the workspace`,
          thinking: t`Thinking`,
          writing: t`Writing`,
          working: t`Working on it`,
        }[doing]
      : t({
          message: `Reading ${file}`,
          comment:
            "Grasp reads a file the person attached; {file} is its name.",
        });
  if (checking) {
    label = t({
      message: "Checking the App…",
      comment:
        "Grasp checks the App it changed (its types, lint and preview) before its turn ends.",
    });
  } else if (thinking !== undefined) {
    return (
      <ThinkingLine arrivals={arrivals} fallback={label} thinking={thinking} />
    );
  }
  return (
    <TraceLine>
      <TraceIcon>
        <ClockIcon />
      </TraceIcon>
      <TraceTitle>
        {/* A live status, so a screen reader hears that Grasp is working. */}
        <output className="shimmer-text">{label}</output>
      </TraceTitle>
    </TraceLine>
  );
};

/** A length of time in whole seconds, said short: "4m 21s", or "21s". */
const useSaidShort = (): ((seconds: number) => string) => {
  const { t } = useLingui();
  return (seconds) => {
    const { minutes, rest } = minutesAndSeconds(seconds);
    return minutes > 0
      ? t({
          message: `${minutes}m ${rest}s`,
          comment: "A length of time, said short: 4 minutes and 21 seconds.",
        })
      : t({
          message: `${rest}s`,
          comment: "A length of time, said short: 21 seconds.",
        });
  };
};

/** The trace's first line, over a finished answer: how long Grasp worked on the question, said short. */
const WorkedFor = ({ seconds }: { seconds: number }) => {
  const { t } = useLingui();
  const time = useSaidShort()(seconds);
  return (
    <TraceLine>
      <TraceIcon>
        <CheckCircleIcon />
      </TraceIcon>
      <TraceTitle>{t`Worked for ${time}`}</TraceTitle>
    </TraceLine>
  );
};

/**
 * The trace's first lines over a finished answer: how long Grasp worked,
 * and, when it showed its thinking in the brain, the way to see it there
 * again.
 */
const FinishedTop = ({
  chatId,
  seconds,
  thinking,
}: {
  chatId: string;
  seconds: number | undefined;
  /** Its thinking, to see again in the brain; none where the answer carries its card instead. */
  thinking: ThinkingOf | undefined;
}) => (
  <>
    {seconds === undefined ? null : <WorkedFor seconds={seconds} />}
    {thinking === undefined ? null : (
      <SeeInBrain chatId={chatId} thinking={thinking} />
    )}
  </>
);

/**
 * What the model thought before a response, a step of the trace: open
 * under "Thinking" while it still thinks, so its words stream in, then
 * folded, to open again. Once kept, the line says how long it thought, at
 * least a second; a response kept before that was timed says only that it
 * reasoned. A provider that showed none of its words leaves only the line.
 */
const Reasoning = ({
  reasoning,
  thinking,
}: {
  reasoning: ChatReasoning;
  /** The model is thinking now: the response has no words or code yet. */
  thinking: boolean;
}) => {
  const { t } = useLingui();
  const saidShort = useSaidShort();
  // Opened or folded by the person; until then, open while it thinks.
  const [opened, setOpened] = useState<boolean>();
  const { text, ms } = reasoning;
  let label = t`Reasoning`;
  if (thinking) {
    label = t`Thinking`;
  } else if (ms !== null) {
    const time = saidShort(Math.max(1, Math.round(ms / 1000)));
    label = t`Thought for ${time}`;
  }
  const line = (
    <TraceLine status={thinking ? "running" : undefined}>
      <TraceIcon>
        <BrainIcon />
      </TraceIcon>
      <TraceTitle>{label}</TraceTitle>
    </TraceLine>
  );
  if (text.trim() === "") {
    return line;
  }
  return (
    <TraceCollapsible onOpenChange={setOpened} open={opened ?? thinking}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <p className="text-xs whitespace-pre-wrap">{text}</p>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
};

/** The quiet row of actions under an answer, with what it cites when it cites any. */
const ReplyActions = ({
  cited,
  children,
}: {
  cited?: { chatId: string; messageId: number };
  children: ReactNode;
}) => {
  const sources = useCitedDocuments();
  return cited === undefined ? (
    <MessageActions>{children}</MessageActions>
  ) : (
    <AnswerSources cited={sources}>{children}</AnswerSources>
  );
};

/** An answer's words, each span that cites a document an inline citation. */
const ReplyText = ({
  text,
  citations,
  written,
}: {
  text: string;
  citations?: ChatCitation[];
  /** Still being written: each new word fades in. */
  written: boolean;
}) => (
  <AnswerMarkdown
    cited={citations?.map(({ documentId }) => documentId)}
    sources={useCitedDocuments()}
    text={text}
    written={written}
  />
);

/** The calls the chat's code made, as the thread was given them. */
const ChatTools = createContext<readonly ChatToolEvent[]>([]);

/** Under a code step: each widget it made or changed on the dashboard, with the way there. */
const WidgetLines = ({ callId }: { callId: string }) => {
  const lines = widgetLinesOf(use(ChatTools), callId);
  return lines.map(({ id, done }) => (
    <TraceLine key={id} wrap>
      <TraceIcon>
        <LayoutDashboardIcon />
      </TraceIcon>
      <TraceTitle>
        {done === "made" ? (
          <Trans>Grasp added a widget to your dashboard.</Trans>
        ) : (
          <Trans>Grasp changed a widget on your dashboard.</Trans>
        )}{" "}
        <Link className="text-foreground underline" to="/dashboard">
          <Trans>Open the dashboard</Trans>
        </Link>
      </TraceTitle>
    </TraceLine>
  ));
};

/**
 * A response's steps as one trace: what Grasp does or how long it worked,
 * what the model thought, and each code step with what it did; none for a
 * response that took none.
 */
const ReplySteps = ({
  reply,
  results,
  output,
  writing,
  running,
  thinking,
  top,
}: {
  reply: Pick<ChatPartial, "code" | "tools"> & { reasoning?: ChatReasoning };
  results: ReadonlyMap<string, Result>;
  output: ChatOutput | null;
  writing: boolean;
  running: boolean;
  /** The model is thinking now: the response has no words or code yet. */
  thinking: boolean;
  top: ReactNode;
}) => {
  if (
    top === undefined &&
    reply.reasoning === undefined &&
    reply.code.length === 0 &&
    reply.tools.length === 0
  ) {
    return null;
  }
  return (
    <Trace>
      {top}
      {reply.reasoning === undefined ? null : (
        <Reasoning reasoning={reply.reasoning} thinking={thinking} />
      )}
      {/* Each step where the response made it: the calls of its tools
          before each code step, then those after its last. */}
      {[...reply.code, undefined].map((code, before) => (
        <Fragment key={code?.callId ?? "end"}>
          {reply.tools
            .filter(({ codeBefore }) =>
              code === undefined ? codeBefore >= before : codeBefore === before
            )
            .map((call) => (
              <ToolStep
                call={call}
                key={call.callId}
                result={results.get(call.callId)}
                running={running}
                writing={writing}
              />
            ))}
          {code === undefined ? null : (
            <>
              <CodeStep
                code={code}
                output={
                  output?.callId === code.callId ? output.text : undefined
                }
                result={results.get(code.callId)}
                running={running}
                writing={writing}
              />
              <WidgetLines callId={code.callId} />
            </>
          )}
        </Fragment>
      ))}
    </Trace>
  );
};

type Asked = Extract<ChatMessage, { role: "user" }>;

/** A question, or the replies that answer it: one item of the thread. */
type ThreadItem =
  | { kind: "question"; message: Asked }
  | { kind: "answer"; replies: Answer[] };

/**
 * The thread's items, in one pass: each question, and the replies to it
 * together, a step's result between them being no message of the
 * thread's. Grasp may answer in several replies (its steps, then its
 * words); they read as one answer, its words right under its steps, as in
 * the prototype.
 */
const threadItemsOf = (messages: readonly ChatMessage[]): ThreadItem[] => {
  const items: ThreadItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      items.push({ kind: "question", message });
    } else if (message.role === "assistant") {
      const last = items.at(-1);
      if (last?.kind === "answer") {
        last.replies.push(message);
      } else {
        items.push({ kind: "answer", replies: [message] });
      }
    }
  }
  return items;
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
 * its key: its admins get the way to check or replace it, everyone else
 * who to ask.
 */
const KeyFailed = () => {
  const { i18n } = useLingui();
  if (!useMemberAdmin()) {
    return failureMessage("model.provider_key_failed", i18n);
  }
  return (
    <>
      <Trans>Your AI provider is refusing your key.</Trans>{" "}
      <Link
        className="underline underline-offset-4"
        to="/settings/ai-providers"
      >
        <Trans>Check or replace it in Settings › AI providers</Trans>
      </Link>
    </>
  );
};

/** Asking a failed answer's question again, without typing it again. */
const TryAgain = ({ onRetry }: { onRetry: (() => void) | undefined }) =>
  onRetry === undefined ? null : (
    <Button onClick={onRetry} size="sm" variant="outline">
      <RefreshCcwIcon data-icon="inline-start" />
      <Trans>Try again</Trans>
    </Button>
  );

/**
 * Why an answer failed, in people's words, and the way to ask again; with
 * no AI provider to call, the way to connect one (to Settings › AI
 * providers for the organization's admins), never an error, and still the
 * way to ask again once one is.
 */
const Failed = ({
  failure,
  onRetry,
}: {
  failure: Answer["failure"];
  onRetry: (() => void) | undefined;
}) => {
  const { i18n } = useLingui();
  if (needsProvider.has(failure)) {
    return (
      <div className="flex flex-col items-start gap-2">
        <ConnectAiProvider size="xs" />
        <TryAgain onRetry={onRetry} />
      </div>
    );
  }
  return (
    // As the prototype says a failed answer: the kit's alert, with the way
    // to ask again under what went wrong.
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>
        {failure === "model.provider_key_failed" ? (
          <KeyFailed />
        ) : (
          failureMessage(failure, i18n)
        )}
      </AlertTitle>
      {onRetry === undefined ? null : (
        <AlertDescription>
          <div className="pt-2">
            <TryAgain onRetry={onRetry} />
          </div>
        </AlertDescription>
      )}
    </Alert>
  );
};

/** One response of the agent's, stored or being written. */
const Reply = ({
  reply,
  results,
  output,
  writing,
  running,
  top,
  card,
  sign,
  onRetry,
  cited,
  compact,
}: {
  reply: Omit<ChatPartial, "reasoning"> & {
    /** What the model thought before it, when it thought. */
    reasoning?: ChatReasoning;
    end?: Answer["end"];
    failure?: Answer["failure"];
    /** A stored answer's citations; one being written has none. */
    citations?: ChatCitation[];
  };
  results: ReadonlyMap<string, Result>;
  /** What the running code step has logged so far. */
  output: ChatOutput | null;
  writing: boolean;
  running: boolean;
  /** The trace's first line, in the first answer to a question. */
  top?: ReactNode;
  /** Its thinking as a small picture, in the first answer to a question that showed it, on any page but the brain. */
  card?: ReactNode;
  /** What Grasp does, under the newest answer while it works on it: its sign stands there, and no actions. */
  sign?: WorkState;
  /** Asks the last question again, offered under the last answer. */
  onRetry?: () => void;
  /** A stored answer that cites documents: its chat and message, so its row of actions can open them. */
  cited?: { chatId: string; messageId: number };
  /** In the chat dock: its answer at the dock's size. */
  compact: boolean;
}) => {
  const { t } = useLingui();
  const answer = reply.text.trim();
  const quiet = writing || sign !== undefined;
  const shown = (
    <Message>
      {/* Its words set for reading; in the dock, at the dock's size. */}
      <MessageContent size={compact ? "default" : "reading"}>
        <ReplySteps
          output={output}
          reply={reply}
          results={results}
          running={running}
          thinking={
            writing &&
            answer === "" &&
            reply.code.length === 0 &&
            reply.tools.length === 0
          }
          top={top}
          writing={writing}
        />
        {card}
        {answer === "" ? null : (
          <ReplyText
            citations={reply.citations}
            text={reply.text}
            written={writing}
          />
        )}
        {reply.end === "cancelled" ? (
          <p className="text-muted-foreground">
            <Trans>Stopped.</Trans>
          </p>
        ) : null}
        {reply.end === "cut_off" ? (
          <p className="text-muted-foreground">
            <Trans>The answer was cut off at the model&apos;s limit.</Trans>
          </p>
        ) : null}
        {reply.end === "failed" ? (
          <Failed failure={reply.failure} onRetry={onRetry} />
        ) : null}
        {sign === undefined ? null : (
          <GraspSign said={reply.text.length} state={sign} />
        )}
        {quiet || (answer === "" && onRetry === undefined) ? null : (
          <ReplyActions cited={cited}>
            {answer === "" ? null : <CopyAnswer text={answer} />}
            {onRetry === undefined || reply.end === "failed" ? null : (
              <MessageAction label={t`Ask again`} onClick={onRetry}>
                <RefreshCcwIcon />
              </MessageAction>
            )}
          </ReplyActions>
        )}
      </MessageContent>
    </Message>
  );
  // Only an answer that cites documents asks core what it cites.
  return cited === undefined ? (
    shown
  ) : (
    <AnswerCited cited={cited}>{shown}</AnswerCited>
  );
};

/**
 * What the person asked, in their bubble: their answers to the agent's
 * questions (`asked`, the reply before it) as each question and its
 * answer, compact; anything else as they wrote it.
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
      {message.files === undefined || message.files.length === 0 ? null : (
        <FileCards files={message.files} />
      )}
      <Bubble variant="muted">
        <BubbleContent>
          {answered === undefined ? (
            message.text
          ) : (
            <dl className="flex flex-col gap-1.5">
              {answered.map(({ question, answer }) => (
                <div key={question}>
                  <dt className="text-muted-foreground text-xs">{question}</dt>
                  <dd>{answer}</dd>
                </div>
              ))}
            </dl>
          )}
        </BubbleContent>
      </Bubble>
    </Message>
  );
};

/** Grasp, reading before its answer starts: its line, and its sign under it, where the answer will stand. */
const Reading = () => (
  <div className="flex w-full flex-col gap-3">
    <Trace>
      <Working doing="reading" />
    </Trace>
    <GraspSign state="reading" />
  </div>
);

/**
 * Where Grasp stands on the chat's questions: the answer being written,
 * once it shows its first thoughts, words or code; while it works, the replies to
 * the last question so far and what it does on it; and how long it worked
 * on every other, by the ID of its first reply.
 */
const progressOf = (
  messages: readonly ChatMessage[],
  partial: ChatPartial | null,
  running: boolean,
  results: ReadonlyMap<string, Result>
): {
  shown: ChatPartial | null;
  replies: readonly Answer[];
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
    replies,
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
  /** In the chat dock: closer together, 20 pixels from every edge. */
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
  const results = resultsOf(messages);
  const { lastAnswer, answersLast } = lastAnswerOf(messages);
  const { shown, replies, doing, step, worked } = progressOf(
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
  const cardOf = (id: number): ReactNode => {
    const thinking = answerThinking.byReply.get(id);
    if (inBrain || thinking === undefined) {
      return undefined;
    }
    const live = doing !== undefined && replies[0]?.id === id;
    // Until the card is there, and where it can't be drawn: the way to see
    // it in the brain, once the answer is done.
    const instead: ReactElement | null = live ? null : (
      <SeeInBrain chatId={chatId} thinking={thinking} />
    );
    return (
      <Suspense fallback={instead}>
        <ThinkingCard
          chatId={chatId}
          instead={instead}
          live={live}
          thinking={thinking}
        />
      </Suspense>
    );
  };
  const topOf = (id: number): ReactNode => {
    const thinking = answerThinking.byReply.get(id);
    if (doing !== undefined && replies[0]?.id === id) {
      return (
        <Working
          checking={checking}
          doing={doing}
          file={file}
          {...(thinking === undefined
            ? {}
            : { thinking, arrivals: answerThinking.arrivals(thinking) })}
        />
      );
    }
    const seconds = worked.get(id);
    const again = inBrain ? thinking : undefined;
    return seconds === undefined && again === undefined ? undefined : (
      <FinishedTop chatId={chatId} seconds={seconds} thinking={again} />
    );
  };
  const items = threadItemsOf(messages);
  // The answer being written, once it shows something; it joins the
  // replies its question already has, or stands as an answer of its own.
  const written =
    shown === null ? null : (
      <Reply
        compact={compact}
        output={output}
        reply={{
          ...shown,
          reasoning:
            shown.reasoning === ""
              ? undefined
              : { text: shown.reasoning, ms: null },
        }}
        results={results}
        running={running}
        sign={doing}
        top={
          doing !== undefined && replies.length === 0 ? (
            <Working doing={doing} file={file} />
          ) : undefined
        }
        writing
      />
    );
  const writtenGoesOn = written !== null && items.at(-1)?.kind === "answer";
  const waiting = pendingPlan(messages, running);
  const reading =
    doing === "reading" ? (
      <div aria-busy="true">
        <Reading />
      </div>
    ) : null;
  const renderReplies = (answers: readonly Answer[]): ReactNode =>
    answers.map((message) => (
      <Fragment key={message.id}>
        <Reply
          compact={compact}
          onRetry={
            !running && message === lastAnswer && answersLast
              ? onRetry
              : undefined
          }
          output={output}
          reply={message}
          results={results}
          running={running}
          sign={
            shown === null && message === replies.at(-1) ? doing : undefined
          }
          cited={
            message.citations.length === 0
              ? undefined
              : { chatId, messageId: message.id }
          }
          card={cardOf(message.id)}
          top={topOf(message.id)}
          writing={false}
        />
        {message.asked === undefined ? null : (
          <AskedLine asked={message.asked} />
        )}
        {message.planned === undefined ? null : (
          <ThreadPlan
            build={build}
            chatId={chatId}
            plan={message.planned}
            waiting={waiting?.callId === message.planned.callId}
          />
        )}
      </Fragment>
    ));
  const isLast = (at: number): boolean => at === items.length - 1;
  /** The person's question. */
  const questionItem = (message: Asked, at: number): ReactNode => {
    const before = items[at - 1];
    return (
      <li className="flex flex-col gap-3" key={message.id}>
        <Question
          asked={
            before?.kind === "answer" ? before.replies.at(-1)?.asked : undefined
          }
          message={message}
        />
      </li>
    );
  };
  /**
   * Grasp's replies to a question, a Build it's as any other's. The answer
   * being written goes on the last one, when the question already has
   * replies.
   */
  const answerItem = (answers: Answer[], at: number): ReactNode => {
    const goesOn = writtenGoesOn && isLast(at);
    return (
      <li
        aria-busy={goesOn ? true : undefined}
        className="flex flex-col gap-3"
        key={answers[0]?.id}
      >
        {renderReplies(answers)}
        {goesOn ? written : null}
      </li>
    );
  };
  const recovered = recoveredSteps(messages);
  return (
    <ChatTools value={tools}>
      <Recovered value={recovered}>
        <Conversation>
          <ConversationContent label={t`Messages`}>
            <ol
              aria-label={t`Messages`}
              className={
                compact
                  ? "flex w-full flex-col gap-7 p-5"
                  : "mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 md:px-6"
              }
            >
              {loaded ? null : (
                <li className="flex justify-center py-8">
                  <Spinner aria-label={t`Loading…`} />
                </li>
              )}
              {items.map((item, at): ReactNode =>
                item.kind === "question"
                  ? questionItem(item.message, at)
                  : answerItem(item.replies, at)
              )}
              {written === null || writtenGoesOn ? null : (
                <li aria-busy="true">{written}</li>
              )}
              {reading === null ? null : <li>{reading}</li>}
              {children === undefined ? null : <li>{children}</li>}
            </ol>
          </ConversationContent>
          <ConversationScrollButton label={t`Jump to the newest message`} />
        </Conversation>
      </Recovered>
    </ChatTools>
  );
};
