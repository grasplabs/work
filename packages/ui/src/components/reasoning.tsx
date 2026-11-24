// Reasoning: the assistant's thinking, behind one quiet line that opens. It is made of Damsko's
// Trace: a Trace with a TraceCollapsible, its line a TraceLine with a TraceIcon and a TraceTitle.
// While it streams the line runs (`status="running"`: Trace shimmers its title) and the thoughts
// show open; a second after it ends it settles into how long it thought ("Thought for 6 seconds")
// and closes, unless the person opened or closed it meanwhile: their choice wins. It measures the
// time itself when no `duration` is given.
//
//   <Reasoning isStreaming={thinking} duration={seconds}>
//     <ReasoningTrigger />
//     <ReasoningContent>{thoughts}</ReasoningContent>
//   </Reasoning>
//
// The thoughts are drawn through Markdown at its note size, a hairline down their start edge so
// where the thinking ends and the answer begins is plain; a line that is only bold (the model's own
// title for a step) becomes a small label over its words. Markdown is loaded the first time the
// thoughts show: until then they are plain text in the browser, and the server draws them through
// Markdown as before, which the browser keeps until it has Markdown. Trace draws the line that opens
// and the panel; thinking that starts is said once to a screen reader, its end and the thoughts
// themselves are silent. Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Suspense,
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { BrainIcon, Icon } from "../lib/icons";
import { colors, font, size, space } from "../lib/tokens.stylex";
import { announce, lazyPart, NotYetShown, nothing } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "./trace";

/** Every prop a Reasoning takes. */
export interface ReasoningProps {
  /** Its ReasoningTrigger, then its ReasoningContent. */
  children: ReactNode;
  /**
   * The assistant is thinking: the line says so in the shimmer and the thoughts show open. Turn it
   * off the moment the thinking ends.
   * @default false
   */
  isStreaming?: boolean;
  /** How long the thinking took, in seconds. Without it, the time from `isStreaming` on to off. */
  duration?: number;
  /** Whether the thoughts show. Pass it with `onOpenChange` to control it. */
  open?: boolean;
  /**
   * Whether the thoughts show at first, when you do not control it. They open by themselves while
   * it streams.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs when the thoughts open or close, by a press or by themselves. */
  onOpenChange?: (open: boolean) => void;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a ReasoningTrigger takes. */
export interface ReasoningTriggerProps {
  /** Words of your own on the line, in place of Thinking and Thought for n seconds. */
  children?: ReactNode;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a ReasoningContent takes. */
export interface ReasoningContentProps {
  /** The thoughts, in Markdown: as much as has arrived. */
  children: string;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** What the parts of a Reasoning share, and `useReasoning` returns. */
interface ReasoningState {
  /** The assistant is thinking. */
  isStreaming: boolean;
  /** The thoughts show. */
  isOpen: boolean;
  /** Opens or closes the thoughts. */
  setIsOpen: (open: boolean) => void;
  /** How long it thought, in seconds, once known. */
  duration: number | undefined;
}

// How long the thoughts stay open once the thinking has ended: a second, long enough to see it end.
const CLOSE_AFTER = 1000;

// Markdown, loaded the first time the thoughts show; NotYetShown stands in until then.
const LazyMarkdown = lazyPart(
  async () => await import("./markdown"),
  (module) => module.Markdown
);

const styles = stylex.create({
  // The thoughts: quiet, inset beside a hairline down their start edge, clear of the answer below.
  content: {
    display: "grid",
    gap: space["3"],
    minWidth: 0,
    marginBlockStart: space["1"],
    marginBlockEnd: space["5"],
    paddingInlineStart: space["3"],
    borderInlineStartWidth: size.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
    color: colors.mutedForeground,
    fontSize: size.messageText,
    lineHeight: size.messageTextLine,
    whiteSpace: "normal",
  },
  step: {
    display: "grid",
    gap: space["1"],
    minWidth: 0,
  },
  // A step's title: a small label, a step firmer than its words.
  label: {
    margin: 0,
    color: colors.foreground,
    fontWeight: font.weightMedium,
  },
  // A step's words before Markdown is loaded: as they came, line for line.
  plain: {
    margin: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
});

const ReasoningContext = createContext<ReasoningState | null>(null);

/** The state of the Reasoning around it: whether it streams and shows, and how long it thought. */
export const useReasoning = (): ReasoningState => {
  const state = use(ReasoningContext);
  if (state === null) {
    throw new Error("useReasoning must be inside a Reasoning.");
  }
  return state;
};

/** The assistant's thinking, behind one line that opens. */
export const Reasoning = ({
  children,
  isStreaming = false,
  duration,
  open,
  defaultOpen = false,
  onOpenChange,
  style,
}: ReasoningProps) => {
  const words = useI18n().reasoning;
  const [shown, setShown] = useState(defaultOpen || isStreaming);
  const isOpen = open ?? shown;
  const setIsOpen = (next: boolean) => {
    setShown(next);
    onOpenChange?.(next);
  };

  // The time it thought, from streaming on to off, unless the caller gives it.
  const [measured, setMeasured] = useState<number | undefined>();
  const started = useRef<number | null>(null);
  useEffect(() => {
    if (isStreaming) {
      started.current = performance.now();
      return;
    }
    if (started.current !== null) {
      setMeasured(
        Math.max(1, Math.ceil((performance.now() - started.current) / 1000))
      );
      started.current = null;
    }
  }, [isStreaming]);

  // Thinking is said once as it starts; thinking drawn from history is not.
  useEffect(() => {
    if (isStreaming) {
      announce(words.thinking);
    }
  }, [isStreaming, words.thinking]);

  // Open while it streams; closed a moment after it ends. A press on the line is the person's
  // choice, and from then on nothing opens or closes it by itself.
  const chosen = useRef(false);
  const streamed = useRef(isStreaming);
  const follow = useEffectEvent((next: boolean) => {
    if (!chosen.current && isOpen !== next) {
      setIsOpen(next);
    }
  });
  useEffect(() => {
    if (isStreaming) {
      streamed.current = true;
      follow(true);
      return nothing;
    }
    if (!streamed.current) {
      return nothing;
    }
    const timer = setTimeout(() => {
      streamed.current = false;
      follow(false);
    }, CLOSE_AFTER);
    return () => {
      clearTimeout(timer);
    };
  }, [isStreaming]);

  const state: ReasoningState = {
    isStreaming,
    isOpen,
    setIsOpen,
    duration: duration ?? measured,
  };
  return (
    <Trace style={style}>
      <TraceCollapsible
        open={isOpen}
        onOpenChange={(next) => {
          chosen.current = true;
          setIsOpen(next);
        }}
      >
        {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
        <ReasoningContext value={state}>{children}</ReasoningContext>
      </TraceCollapsible>
    </Trace>
  );
};

/** The line that opens the thoughts: Thinking while it runs, then how long it thought. */
export const ReasoningTrigger = ({
  children,
  style,
}: ReasoningTriggerProps) => {
  const { isStreaming, duration } = useReasoning();
  const words = useI18n().reasoning;
  let line = words.done;
  if (isStreaming) {
    line = words.thinking;
  } else if (duration !== undefined) {
    line = words.thought(duration);
  }
  return (
    <TraceCollapsibleTrigger style={style}>
      {/* A new line once the thinking ends, so Trace does not say its end: Reasoning said it
          started, and the answer follows. */}
      <TraceLine
        key={isStreaming ? "thinking" : "thought"}
        status={isStreaming ? "running" : undefined}
      >
        <TraceIcon>
          <Icon icon={BrainIcon} />
        </TraceIcon>
        <TraceTitle>{children ?? line}</TraceTitle>
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
};

/** One step of the thoughts: the model's title for it, where it gave one, and its words. */
interface Step {
  title: string | undefined;
  body: string;
}

// A line that is only bold: the model's own title for the step that follows.
const TITLE = /^\s*\*\*(?<title>[^*\n]+)\*\*\s*$/u;
// A line that opens or closes fenced code, as Markdown reads it.
const FENCE = /^\s{0,3}(?:`{3,}|~{3,})/u;

/** The thoughts, cut into steps at each line that is only bold, outside fenced code. */
const stepsOf = (text: string): Step[] => {
  const steps: Step[] = [];
  let step: Step = { title: undefined, body: "" };
  let fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      fenced = !fenced;
    }
    const title = fenced ? undefined : TITLE.exec(line)?.groups?.title;
    if (title === undefined) {
      step.body += `${line}\n`;
    } else {
      if (step.title !== undefined || step.body.trim() !== "") {
        steps.push(step);
      }
      step = { title: title.trim(), body: "" };
    }
  }
  if (step.title !== undefined || step.body.trim() !== "") {
    steps.push(step);
  }
  return steps;
};

/** The thoughts, under the line, while it is open. */
export const ReasoningContent = ({
  children,
  style,
}: ReasoningContentProps) => {
  const { isStreaming, isOpen } = useReasoning();
  // Markdown is loaded once the thoughts have shown; the server always draws them through it.
  const [shown, setShown] = useState(isOpen);
  if (isOpen && !shown) {
    setShown(true);
  }
  const markdown = shown || typeof document === "undefined";
  return (
    <TraceCollapsibleContent style={style}>
      <div data-slot="reasoning-content" {...stylex.props(styles.content)}>
        {stepsOf(children).map((step, index) => (
          // A step keeps its place by its order as more thoughts arrive: steps never move.
          <div key={index} {...stylex.props(styles.step)}>
            {step.title === undefined ? null : (
              <p {...stylex.props(styles.label)}>{step.title}</p>
            )}
            {step.body.trim() === "" ? null : (
              <Suspense
                fallback={
                  <p {...stylex.props(styles.plain)}>{step.body.trim()}</p>
                }
              >
                {markdown ? (
                  // Silent: the thoughts are not read out as they come, open or closed; that
                  // thinking started is said once, by Reasoning.
                  <LazyMarkdown size="xs" streaming={isStreaming} live="off">
                    {step.body.trim()}
                  </LazyMarkdown>
                ) : (
                  <NotYetShown />
                )}
              </Suspense>
            )}
          </div>
        ))}
      </div>
    </TraceCollapsibleContent>
  );
};
