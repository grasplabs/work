import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import { Button } from "@grasp-os/ui/components/button";
import {
  ChainOfThought,
  ChainOfThoughtContent,
} from "@grasp-os/ui/components/chain-of-thought";
import { Shimmer } from "@grasp-os/ui/components/shimmer";
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/ui/components/trace";
import type { TraceLineStatus } from "@grasp-os/ui/components/trace";
import { ChevronDownIcon, CircleMinusIcon, Icon } from "@grasp-os/ui/lib/icons";
import { focusRingText, visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { nothing } from "@grasp-os/ui/lib/utils";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { StepStatus } from "./chat-states.ts";

// An answer's steps as #2503's Agent activity draws them, on Damsko's
// Chain of thought and Trace: one line that opens (what the steps came to,
// or the step at work, in the shimmer, beside the working mark while it is
// closed), then each step a line on the trail of dots: its mark (a dot;
// the working mark while it works; the alert when it failed; a struck
// circle, and its words struck through, when the answer stopped before
// it finished) and its words. A step with an input or a result opens to
// them, each under its small label on the soft ground, cut to six lines
// with Show more. Damsko's Chain of thought has no step that opens (the
// registry gap "a chain of thought's step that opens"), so a step that
// does is Trace's own row that opens among steps.

/** One step of an answer, as the line over it and its own line show it. */
export interface AnswerStep {
  id: string;
  /** What kind of step it is, for the line that says what the steps came to. */
  kind: "search" | "read" | "write" | "remember" | "tool";
  /** What it did, in the past once finished; as it goes until then. */
  label: string;
  /** What it does while it works: the line over the steps says it. */
  active: string;
  status: StepStatus;
  /** What went in: a tool's arguments as JSON, or a code step's code. */
  input: string;
  result: string | undefined;
}

/** A step's status as Trace says it: a done, retried or stopped step has none of its own. */
const traceStatuses: Readonly<Record<StepStatus, TraceLineStatus | undefined>> =
  {
    writing: "running",
    running: "running",
    done: undefined,
    retried: undefined,
    failed: "error",
    stopped: undefined,
  };

/** Whether a step is at work: its input still written, or running. */
export const stepWorking = (status: StepStatus): boolean =>
  status === "writing" || status === "running";

const styles = stylex.create({
  // A step's input and result, under its line: the panel's own room
  // above them, none under (the step's own room ends the row).
  // As wide as its longest line, never wider than the column, as #2503's
  // steps are: long lines wrap there.
  detail: {
    display: "grid",
    rowGap: space["2"],
    width: "max-content",
    maxWidth: "100%",
    minWidth: 0,
    marginBlockEnd: `calc(-1 * ${space["2"]})`,
  },
  block: {
    display: "grid",
    rowGap: space["1"],
    minWidth: 0,
  },
  label: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  // In mono, on the soft ground, with its edge.
  code: {
    margin: 0,
    boxSizing: "border-box",
    maxWidth: "100%",
    paddingBlock: space["2"],
    paddingInline: space["3"],
    borderRadius: `min(${radius.base}, ${space["3"]})`,
    cornerShape: radius.shape,
    backgroundColor: colors.muted,
    boxShadow: size.borderStrong,
    color: colors.bodyForeground,
    fontFamily: font.mono,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  failed: { color: colors.destructive },
  words: { display: "block" },
  // Six lines until Show more, inside the padding, so no part of a seventh shows.
  cut: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 6,
    overflow: "hidden",
  },
  // Show more's words on the labels' edge, its fill reaching past them.
  more: {
    justifySelf: "start",
    marginInlineStart: `calc(-1 * ${space["3"]})`,
  },
  stopped: { textDecorationLine: "line-through" },
  // A step's words, as an item of the steps' list: no box of their own.
  item: { display: "contents" },
  // Its line as the press that opens it: its words, then a small chevron.
  press: {
    position: "relative",
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    columnGap: space["2"],
    width: "100%",
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.xs,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    textAlign: "start",
    cursor: "pointer",
  },
  // A finger needs 44px: an unseen area round the line.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: {
      default: `calc(-1 * ${space["2"]})`,
      [media.pointerCoarse]: `calc((${font.textSmLine} - ${size.tapTarget}) / 2)`,
    },
  },
  chevron: {
    [iconVars.size]: `calc(${size.iconSm} - ${space["1"]})`,
    display: "inline-flex",
    alignSelf: "center",
    color: colors.mutedForeground,
    transform: {
      default: null,
      ":is([aria-expanded=true] > *)": "rotate(0.5turn)",
    },
    transitionProperty: "transform",
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
});

/** What a step took in or gave back: cut to six lines, with Show more when it runs longer. */
const StepOutput = ({
  label,
  text,
  failed = false,
}: {
  label: string;
  text: string;
  failed?: boolean;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const box = useRef<HTMLSpanElement | null>(null);
  // Measured as the text changes, and whenever its box changes size: as
  // the step opens (closed, it has none), and as the column narrows.
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || text === "") {
      return nothing;
    }
    const measure = (): void => {
      setLong(element.scrollHeight > element.clientHeight + 1);
    };
    const resized = new ResizeObserver(measure);
    resized.observe(element);
    return () => {
      resized.disconnect();
    };
  }, [text]);
  return (
    <div {...stylex.props(styles.block)}>
      <span {...stylex.props(styles.label)}>{label}</span>
      <pre {...stylex.props(styles.code, failed && styles.failed)}>
        <span ref={box} {...stylex.props(styles.words, !open && styles.cut)}>
          {text}
        </span>
      </pre>
      {long || open ? (
        <Button
          onClick={() => {
            setOpen(!open);
          }}
          size="sm"
          style={styles.more}
          variant="ghost"
        >
          {open ? t`Show less` : t`Show more`}
        </Button>
      ) : null}
    </div>
  );
};

/** A step's mark: the working mark while it works, struck when it was stopped; else Trace's own. */
const StepMark = ({ status }: { status: StepStatus }) => {
  if (stepWorking(status)) {
    return (
      <TraceIcon>
        <AgentIndicator />
      </TraceIcon>
    );
  }
  if (status === "stopped") {
    return (
      <TraceIcon>
        <Icon icon={CircleMinusIcon} />
      </TraceIcon>
    );
  }
  return <TraceIcon />;
};

/** A step's words: what it did, Retried after one a later step recovered from, struck when stopped. */
const StepWords = ({ step }: { step: AnswerStep }) => {
  const { t } = useLingui();
  const words = stepWorking(step.status) ? step.active : step.label;
  return (
    <>
      <TraceTitle>
        {step.status === "stopped" ? (
          <span {...stylex.props(styles.stopped)}>{words}</span>
        ) : (
          words
        )}
      </TraceTitle>
      {step.status === "retried" ? (
        <TraceDescription>{t`Retried`}</TraceDescription>
      ) : null}
      {step.status === "stopped" ? (
        <span {...stylex.props(visuallyHidden)}>{`, ${t`Stopped`}`}</span>
      ) : null}
    </>
  );
};

/** A step as an item of the steps' list, beside its mark: no box of its own. */
const StepItem = ({ children }: { children: ReactNode }) => (
  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an item inside Trace's line, a span, as Damsko's ChainOfThoughtStep has it
  <span role="listitem" {...stylex.props(styles.item)}>
    {children}
  </span>
);

/** One step: its line, opening to its input and result where it has them. */
const Step = ({ step }: { step: AnswerStep }) => {
  const { t } = useLingui();
  const status = traceStatuses[step.status];
  const result = step.result ?? "";
  if (step.input === "" && result === "") {
    return (
      <TraceLine status={status}>
        <StepMark status={step.status} />
        <StepItem>
          <StepWords step={step} />
        </StepItem>
      </TraceLine>
    );
  }
  const failed = step.status === "failed";
  return (
    <TraceLine status={status}>
      <StepMark status={step.status} />
      <StepItem>
        <TraceCollapsible>
          <TraceCollapsibleTrigger asChild>
            <button
              type="button"
              {...stylex.props(styles.press, focusRingText)}
            >
              <span aria-hidden="true" {...stylex.props(styles.target)} />
              <StepWords step={step} />
              <span aria-hidden="true" {...stylex.props(styles.chevron)}>
                <Icon icon={ChevronDownIcon} />
              </span>
            </button>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <div {...stylex.props(styles.detail)}>
              {step.input === "" ? null : (
                <StepOutput
                  label={t({
                    message: "Input",
                    context: "what a tool was given",
                  })}
                  text={step.input}
                />
              )}
              {result === "" ? null : (
                <StepOutput
                  failed={failed}
                  label={
                    failed
                      ? t`Why it failed`
                      : t({
                          message: "Result",
                          context: "what a tool gave back",
                        })
                  }
                  text={result}
                />
              )}
            </div>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </StepItem>
    </TraceLine>
  );
};

/**
 * An answer's steps behind one line: `line` once the work is done; while
 * it goes on (`live`), the step at work, else `workingLabel`, in the
 * shimmer. A run that ends while nobody opened or closed it settles back
 * into its line.
 */
export const AnswerSteps = ({
  steps,
  line,
  live,
  workingLabel,
}: {
  steps: readonly AnswerStep[];
  line: ReactNode;
  live: boolean;
  workingLabel: string;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState(false);
  // Opened once: the steps are drawn from then on, so they close as they opened.
  const [opened, setOpened] = useState(false);
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) {
    setWasLive(live);
    if (!live && !chosen) {
      setOpen(false);
    }
  }
  const current = steps.find(({ status }) => stepWorking(status));
  const working = live || current !== undefined;
  return (
    <ChainOfThought
      aria-label={t`What Grasp did`}
      onOpenChange={(next) => {
        setChosen(true);
        setOpen(next);
        if (next) {
          setOpened(true);
        }
      }}
      open={open}
    >
      {/* Trace's own trigger line, not ChainOfThoughtHeader: that one holds
        only words, and the working mark put among them touched them and
        sat on their baseline. As the line's TraceIcon it stands where a
        step's mark stands, its words where a step's words start. Given,
        not Trace's status mark, which turns to a dot once a working step
        is drawn in the (closed) panel. */}
      <TraceCollapsibleTrigger>
        <TraceLine>
          {/* One mark in view: on the line while it is closed, on the working step once open. */}
          {working && !open ? (
            <TraceIcon>
              <AgentIndicator />
            </TraceIcon>
          ) : null}
          <TraceTitle>
            {working ? (
              <Shimmer>{current?.active ?? workingLabel}</Shimmer>
            ) : (
              line
            )}
          </TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <ChainOfThoughtContent>
        {opened || open
          ? steps.map((step) => <Step key={step.id} step={step} />)
          : null}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
};
