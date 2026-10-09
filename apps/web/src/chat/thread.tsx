import type { ChatCode, ChatMessage, ChatPartial } from "@grasp-os/shared/chat";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  ArrowDownIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  CodeIcon,
  CopyIcon,
  RefreshCcwIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { PlainMarkdown } from "../knowledge/markdown.tsx";
import { GraspSign } from "./grasp-sign.tsx";
import { signOf } from "./sign.ts";
import type { WorkState } from "./sign.ts";
import { minutesAndSeconds, turnsOf, workedFor } from "./turns.ts";

// A chat as the person reads it, in the prototype's look
// (grasplabs/prototype `components/chat/chat-thread.tsx` and
// `chat-message.tsx`): their questions in a grey bubble on the right,
// Grasp's answers under a quiet line, each code step folded with its
// status. While Grasp works on a question, the line says what it does and
// Grasp's sign stands under its newest answer; once it is done, the line
// says how long it worked, and the answer has its actions in a quiet row
// under it. It follows the answer as it streams, unless the person scrolls
// up to read.

type Result = Extract<ChatMessage, { role: "result" }>;
type Answer = Extract<ChatMessage, { role: "assistant" }>;
type StepStatus = "writing" | "running" | "done" | "failed" | "stopped";

const statusIcon: Record<StepStatus, ReactNode> = {
  writing: <CircleIcon className="size-3.5" />,
  running: <ClockIcon className="size-3.5 animate-pulse" />,
  done: <CheckCircleIcon className="text-status-agreed size-3.5" />,
  failed: <XCircleIcon className="text-destructive size-3.5" />,
  stopped: <XCircleIcon className="text-status-attention size-3.5" />,
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
  writing,
  running,
}: {
  code: ChatCode;
  result: Result | undefined;
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
    <details className="group w-full rounded-md border">
      <summary className="flex w-full cursor-pointer list-none items-center justify-between gap-4 p-3 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <CodeIcon className="text-muted-foreground size-4" />
          <span className="text-sm font-medium">
            <Trans>Code step</Trans>
          </span>
          <Badge variant="secondary">
            {statusIcon[status]}
            {label}
          </Badge>
        </span>
        <ChevronDownIcon className="text-muted-foreground size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-4 px-4 pb-4">
        <section className="flex flex-col gap-2">
          <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            <Trans>Code</Trans>
          </h4>
          <pre className="bg-muted/50 overflow-x-auto rounded-md p-3 text-xs">
            <code className="font-mono">{code.code}</code>
          </pre>
        </section>
        {result === undefined ? null : (
          <section className="flex flex-col gap-2">
            <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {result.failed ? <Trans>Error</Trans> : <Trans>Result</Trans>}
            </h4>
            <pre
              className={
                result.failed
                  ? "bg-destructive/10 text-destructive overflow-x-auto rounded-md p-3 text-xs"
                  : "bg-muted/50 overflow-x-auto rounded-md p-3 text-xs"
              }
            >
              <code className="font-mono">{result.text}</code>
            </pre>
          </section>
        )}
      </div>
    </details>
  );
};

/** A small button under an answer, named by its tooltip. */
const AnswerAction = ({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Button
          aria-label={label}
          onClick={onClick}
          size="icon-sm"
          variant="ghost"
        />
      }
    >
      {children}
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

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
    <AnswerAction
      label={copied ? t`Copied` : t`Copy the answer`}
      onClick={() => {
        void copy();
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </AnswerAction>
  );
};

/** The line over an answer: a few quiet words, then a hairline to the end of the thread. */
const AnswerTop = ({ children }: { children: ReactNode }) => (
  <div className="text-muted-foreground flex items-center gap-3 text-xs">
    <span className="flex-none">{children}</span>
    <span aria-hidden="true" className="bg-border h-px min-w-0 flex-1" />
  </div>
);

/** Over an answer Grasp works on: what it does now, as a light runs through the words. */
const Working = ({ doing }: { doing: WorkState }) => {
  const { t } = useLingui();
  const label = {
    reading: t`Reading the workspace`,
    thinking: t`Thinking`,
    writing: t`Writing`,
    working: t`Working on it`,
  }[doing];
  return (
    <AnswerTop>
      {/* A live status, so a screen reader hears that Grasp is working. */}
      <output className="shimmer-text">{label}</output>
    </AnswerTop>
  );
};

/** Over a finished answer: how long Grasp worked on the question, said short. */
const WorkedFor = ({ seconds }: { seconds: number }) => {
  const { t } = useLingui();
  const { minutes, rest } = minutesAndSeconds(seconds);
  const time =
    minutes > 0
      ? t({
          message: `${minutes}m ${rest}s`,
          comment: "A length of time, said short: 4 minutes and 21 seconds.",
        })
      : t({
          message: `${rest}s`,
          comment: "A length of time, said short: 21 seconds.",
        });
  return <AnswerTop>{t`Worked for ${time}`}</AnswerTop>;
};

/** One response of the agent's, stored or being written. */
const Reply = ({
  reply,
  results,
  writing,
  running,
  top,
  sign,
  onRetry,
}: {
  reply: ChatPartial & { end?: Answer["end"]; error?: string };
  results: ReadonlyMap<string, Result>;
  writing: boolean;
  running: boolean;
  /** The line over it, over the first answer to a question. */
  top?: ReactNode;
  /** What Grasp does, under the newest answer while it works on it: its sign stands there, and no actions. */
  sign?: WorkState;
  /** Asks the last question again, offered under the last answer. */
  onRetry?: () => void;
}) => {
  const { t } = useLingui();
  const answer = reply.text.trim();
  const quiet = writing || sign !== undefined;
  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      {top}
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex w-full min-w-0 flex-col gap-3 text-sm">
          {answer === "" ? null : <PlainMarkdown text={reply.text} />}
          {reply.code.map((code) => (
            <CodeStep
              code={code}
              key={code.callId}
              result={results.get(code.callId)}
              running={running}
              writing={writing}
            />
          ))}
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
                {reply.error ?? t`The model call failed.`}
              </p>
              {onRetry === undefined ? null : (
                <Button onClick={onRetry} size="sm" variant="outline">
                  <RefreshCcwIcon data-icon="inline-start" />
                  <Trans>Try again</Trans>
                </Button>
              )}
            </div>
          ) : null}
        </div>
        {sign === undefined ? null : (
          <GraspSign said={reply.text.length} state={sign} />
        )}
        {quiet || (answer === "" && onRetry === undefined) ? null : (
          <div className="-ml-1.5 flex items-center gap-1">
            {answer === "" ? null : <CopyAnswer text={answer} />}
            {onRetry === undefined || reply.end === "failed" ? null : (
              <AnswerAction label={t`Ask again`} onClick={onRetry}>
                <RefreshCcwIcon />
              </AnswerAction>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/** Grasp, reading before its answer starts: its line, and its sign under it, where the answer will stand. */
const Reading = () => (
  <div className="flex w-full flex-col gap-3">
    <Working doing="reading" />
    <GraspSign state="reading" />
  </div>
);

/**
 * Follows the end of `scroller` as what is in `content` grows, while the
 * person is at the end; scrolled up to read, it stays where they are.
 */
const useFollow = (): {
  scroller: React.RefObject<HTMLDivElement | null>;
  content: React.RefObject<HTMLOListElement | null>;
  atEnd: boolean;
  toEnd: () => void;
} => {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLOListElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  useEffect(() => {
    const box = scroller.current;
    const inner = content.current;
    if (box === null || inner === null) {
      return () => {
        // Nothing was followed.
      };
    }
    let following = true;
    const onScroll = (): void => {
      following = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
      setAtEnd(following);
    };
    const onGrow = new ResizeObserver(() => {
      if (following) {
        box.scrollTop = box.scrollHeight;
      }
    });
    box.scrollTop = box.scrollHeight;
    box.addEventListener("scroll", onScroll, { passive: true });
    onGrow.observe(inner);
    return () => {
      box.removeEventListener("scroll", onScroll);
      onGrow.disconnect();
    };
  }, []);
  const toEnd = (): void => {
    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: "smooth",
    });
  };
  return { scroller, content, atEnd, toEnd };
};

/**
 * Where Grasp stands on the chat's questions: the answer being written,
 * once it shows its first words or code; while it works, the replies to
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
    partial !== null && (partial.text.trim() !== "" || partial.code.length > 0)
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

/** The chat's messages, and the response being written, oldest first. */
export const ChatThread = ({
  loaded,
  messages,
  partial,
  running,
  onRetry,
  children,
}: {
  /** Whether core has sent the chat yet: until then, it is loading. */
  loaded: boolean;
  messages: readonly ChatMessage[];
  partial: ChatPartial | null;
  /** Whether the agent is working on the chat now. */
  running: boolean;
  /** Asks the last question again. */
  onRetry: () => void;
  /** Shown after the messages, in the thread: what is held, why it stopped. */
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const { scroller, content, atEnd, toEnd } = useFollow();
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
  const topOf = (id: number): ReactNode => {
    if (doing !== undefined && replies[0]?.id === id) {
      return <Working doing={doing} />;
    }
    const seconds = worked.get(id);
    return seconds === undefined ? undefined : <WorkedFor seconds={seconds} />;
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto" ref={scroller}>
        <ol
          aria-label={t`Messages`}
          className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 md:px-6"
          ref={content}
        >
          {loaded ? null : (
            <li className="flex justify-center py-8">
              <Spinner aria-label={t`Loading…`} />
            </li>
          )}
          {messages.map((message) => {
            if (message.role === "user") {
              return (
                <li
                  className="bg-secondary text-foreground ml-auto w-fit max-w-11/12 rounded-lg px-4 py-3 text-sm whitespace-pre-wrap"
                  key={message.id}
                >
                  {message.text}
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
                    reply={message}
                    results={results}
                    running={running}
                    sign={
                      shown === null && message === replies.at(-1)
                        ? doing
                        : undefined
                    }
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
                reply={shown}
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
      </div>
      {atEnd ? null : (
        <Button
          aria-label={t`Jump to the newest message`}
          className="absolute bottom-4 left-1/2 -translate-x-1/2"
          onClick={toEnd}
          size="icon"
          variant="outline"
        >
          <ArrowDownIcon />
        </Button>
      )}
    </div>
  );
};
