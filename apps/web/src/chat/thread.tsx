import type {
  ChatCitation,
  ChatCode,
  ChatMessage,
  ChatOutput,
  ChatPartial,
  ChatReasoning,
  ChatToolEvent,
} from "@grasp-os/shared/chat";
import { Button } from "@grasp-os/ui/components/button";
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
import {
  createContext,
  Fragment,
  lazy,
  Suspense,
  use,
  useEffect,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";

import type { ThinkingOf } from "../brain/thinking/play.ts";
import {
  SeeInBrain,
  ThinkingLine,
  useAnswerThinking,
} from "./answer-thinking.tsx";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./conversation.tsx";
import { failureMessage } from "./failure.ts";
import { GraspSign } from "./grasp-sign.tsx";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "./message.tsx";
import { signOf } from "./sign.ts";
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
// up to read (`Conversation`); each message is the prototype's AI Elements
// message (`Message`).

type Result = Extract<ChatMessage, { role: "result" }>;
type Answer = Extract<ChatMessage, { role: "assistant" }>;
type StepStatus = "writing" | "running" | "done" | "failed" | "stopped";

const statusIcon: Record<StepStatus, ReactNode> = {
  writing: <CircleIcon />,
  running: <ClockIcon />,
  done: <CheckCircleIcon className="text-status-agreed" />,
  failed: <XCircleIcon />,
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
  stopped: "attention",
};

/** Where a code step stands: written, running, done, failed or stopped. */
const stepStatusOf = (
  result: Result | undefined,
  writing: boolean,
  running: boolean
): StepStatus => {
  if (writing) {
    return "writing";
  }
  if (result !== undefined) {
    return result.failed ? "failed" : "done";
  }
  // Without a result once the agent stopped, it never finished.
  return running ? "running" : "stopped";
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
  const { t } = useLingui();
  const status = stepStatusOf(result, writing, running);
  const label = {
    writing: t`Writing`,
    running: t`Running`,
    done: t`Done`,
    failed: t`Failed`,
    stopped: t`Stopped`,
  }[status];
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
          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-medium tracking-wide uppercase">
              <Trans>Code</Trans>
            </h4>
            <pre className="bg-muted/50 text-foreground overflow-x-auto rounded-md p-3 text-xs">
              <code className="font-mono">{code.code}</code>
            </pre>
          </section>
          {result !== undefined || output === undefined ? null : (
            <section className="flex flex-col gap-2">
              <h4 className="text-xs font-medium tracking-wide uppercase">
                <Trans>Output</Trans>
              </h4>
              <pre className="bg-muted/50 text-foreground overflow-x-auto rounded-md p-3 text-xs">
                <code className="font-mono">{output}</code>
              </pre>
            </section>
          )}
          {result === undefined ? null : (
            <section className="flex flex-col gap-2">
              <h4 className="text-xs font-medium tracking-wide uppercase">
                {result.failed ? <Trans>Error</Trans> : <Trans>Result</Trans>}
              </h4>
              <pre
                className={
                  result.failed
                    ? "bg-destructive/10 text-destructive overflow-x-auto rounded-md p-3 text-xs"
                    : "bg-muted/50 text-foreground overflow-x-auto rounded-md p-3 text-xs"
                }
              >
                <code className="font-mono">{result.text}</code>
              </pre>
            </section>
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
};

/** Copies the answer's text, and says so for a moment. */
const CopyAnswer = ({ text }: { text: string }) => {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = copied
      ? setTimeout(() => {
          setCopied(false);
        }, 1500)
      : undefined;
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // The browser refused the clipboard (no permission): nothing copied,
      // so the button doesn't say it was.
    }
  };
  return (
    <MessageAction
      label={copied ? t`Copied` : t`Copy the answer`}
      onClick={() => {
        void copy();
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
 * as a light runs through the words; the step of its thinking it is at,
 * while it shows that in the brain.
 */
const Working = ({
  doing,
  thinking,
  arrivals = noArrivals,
}: {
  doing: WorkState;
  thinking?: ThinkingOf;
  arrivals?: readonly (number | undefined)[];
}) => {
  const { t } = useLingui();
  const label = {
    reading: t`Reading the workspace`,
    thinking: t`Thinking`,
    writing: t`Writing`,
    working: t`Working on it`,
  }[doing];
  if (thinking !== undefined) {
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
  <MessageResponse
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
  reply: Pick<ChatPartial, "code"> & { reasoning?: ChatReasoning };
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
    reply.code.length === 0
  ) {
    return null;
  }
  return (
    <Trace>
      {top}
      {reply.reasoning === undefined ? null : (
        <Reasoning reasoning={reply.reasoning} thinking={thinking} />
      )}
      {reply.code.map((code) => (
        <Fragment key={code.callId}>
          <CodeStep
            code={code}
            output={output?.callId === code.callId ? output.text : undefined}
            result={results.get(code.callId)}
            running={running}
            writing={writing}
          />
          <WidgetLines callId={code.callId} />
        </Fragment>
      ))}
    </Trace>
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
}) => {
  const { t, i18n } = useLingui();
  const answer = reply.text.trim();
  const quiet = writing || sign !== undefined;
  const shown = (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <Message from="assistant">
        <MessageContent>
          <ReplySteps
            output={output}
            reply={reply}
            results={results}
            running={running}
            thinking={writing && answer === "" && reply.code.length === 0}
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
            <div className="flex items-start gap-3 rounded-lg border px-3.5 py-3">
              <TriangleAlertIcon className="text-destructive mt-0.5 size-4 flex-none" />
              <p className="flex-1" role="alert">
                {failureMessage(reply.failure, i18n)}
              </p>
              {onRetry === undefined ? null : (
                <Button onClick={onRetry} size="sm" variant="outline">
                  <RefreshCcwIcon data-icon="inline-start" />
                  <Trans>Try again</Trans>
                </Button>
              )}
            </div>
          ) : null}
        </MessageContent>
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
      </Message>
    </div>
  );
  // Only an answer that cites documents asks core what it cites.
  return cited === undefined ? (
    shown
  ) : (
    <AnswerCited cited={cited}>{shown}</AnswerCited>
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
  worked: ReadonlyMap<number, number>;
} => {
  const shown =
    partial !== null &&
    (partial.text.trim() !== "" ||
      partial.code.length > 0 ||
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
    worked: workedFor(turns, current),
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
  tools = noTools,
  onRetry,
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
  /** The calls the chat's code made: what it did to the dashboard, under its step. */
  tools?: readonly ChatToolEvent[];
  /** Asks the last question again. */
  onRetry: () => void;
  /** Shown after the messages, in the thread: what is held, why it stopped. */
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const results = new Map<string, Result>();
  for (const message of messages) {
    if (message.role === "result") {
      results.set(message.callId, message);
    }
  }
  const lastAnswer = messages.findLast(({ role }) => role === "assistant");
  // "Ask again" asks the last question: only under the answer to it, never
  // under an earlier one when a later question stopped unanswered.
  const answersLast =
    lastAnswer !== undefined &&
    messages.findLastIndex(({ role }) => role === "user") <
      messages.indexOf(lastAnswer);
  const { shown, replies, doing, worked } = progressOf(
    messages,
    partial,
    running,
    results
  );
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
          doing={doing}
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
  return (
    <ChatTools value={tools}>
      <Conversation>
        <ConversationContent label={t`Messages`}>
          <ol
            aria-label={t`Messages`}
            className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 md:px-6"
          >
            {loaded ? null : (
              <li className="flex justify-center py-8">
                <Spinner aria-label={t`Loading…`} />
              </li>
            )}
            {messages.map((message) => {
              if (message.role === "user") {
                return (
                  <li key={message.id}>
                    <Message from="user">
                      <MessageContent>{message.text}</MessageContent>
                    </Message>
                  </li>
                );
              }
              if (message.role === "assistant") {
                return (
                  <li key={message.id}>
                    <Reply
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
                        shown === null && message === replies.at(-1)
                          ? doing
                          : undefined
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
                  </li>
                );
              }
              return null;
            })}
            {shown === null ? null : (
              <li aria-busy="true">
                <Reply
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
                      <Working doing={doing} />
                    ) : undefined
                  }
                  writing
                />
              </li>
            )}
            {doing === "reading" ? (
              <li aria-busy="true">
                <Reading />
              </li>
            ) : null}
            {children === undefined ? null : <li>{children}</li>}
          </ol>
        </ConversationContent>
        <ConversationScrollButton label={t`Jump to the newest message`} />
      </Conversation>
    </ChatTools>
  );
};
