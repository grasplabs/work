// One step of agent activity (agent-activity.tsx): its mark, its title and a quiet summary, its
// time, and, when it has input or a result, a press that opens them. Long output is cut to six
// lines with "Show more".
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@ui-sdk/react/collapsible";
import type { CollapsibleState } from "@ui-sdk/react/collapsible";
import { useLayoutEffect, useRef, useState } from "react";

import { AgentIndicator } from "../agent-indicator";
import { Button } from "../button";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { ChevronDown, Failed, Icon, Skipped } from "../icons";
import { seconds } from "./format";
import { activityStyles as styles } from "./styles";
import type { ActivityStep, AgentActivityWords } from "./types";

/**
 * A step's mark: the working mark while it works; a dot when done or waiting (the trail's dots);
 * its own icon when it failed or was skipped, or when it brings one of its own.
 */
const Mark = ({ step }: { step: ActivityStep }) => {
  if (step.state === "working") {
    return <AgentIndicator />;
  }
  if (step.state === "failed") {
    return <Icon icon={Failed} />;
  }
  if (step.state === "skipped") {
    return <Icon icon={Skipped} />;
  }
  if (step.icon !== undefined) {
    return <Icon icon={step.icon} />;
  }
  return (
    <span
      {...stylex.props(
        styles.dot,
        step.state === "waiting" && styles.dotWaiting
      )}
    />
  );
};

const said = (text: string | undefined): text is string =>
  text !== undefined && text !== "";

/** Output that may run long: cut to six lines, with "Show more" when it is. */
const Output = ({
  label,
  text,
  failed = false,
  words,
}: {
  label: string;
  text: string;
  failed?: boolean;
  words: AgentActivityWords;
}) => {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const box = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    // Measured again whenever the text changes.
    const element = box.current;
    if (element !== null && text !== "") {
      setLong(element.scrollHeight > element.clientHeight + 1);
    }
  }, [text]);
  return (
    <div {...stylex.props(styles.block)}>
      <span {...stylex.props(styles.blockLabel)}>{label}</span>
      <pre {...stylex.props(styles.code, failed && styles.failed)}>
        <span
          ref={box}
          {...stylex.props(styles.codeWords, !open && styles.cut)}
        >
          {text}
        </span>
      </pre>
      {(long || open) && (
        <span {...stylex.props(styles.more)}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? words.showLess : words.showMore}
          </Button>
        </span>
      )}
    </div>
  );
};

const ended = (step: ActivityStep) =>
  step.state === "done" || step.state === "failed";

/** A step's line: its title, a quiet summary, its state for a screen reader, and its time. */
const StepLine = ({
  step,
  words,
}: {
  step: ActivityStep;
  words: AgentActivityWords;
}) => (
  <>
    <span
      {...stylex.props(
        styles.title,
        step.state === "done" && styles.titleDone,
        step.state === "waiting" && styles.titleWaiting,
        step.state === "working" && styles.titleWorking,
        step.state === "skipped" && styles.titleSkipped
      )}
    >
      {step.state === "working" ? (step.active ?? step.title) : step.title}
    </span>
    {/* Commas a screen reader says between the parts; the eye has the space. */}
    {said(step.summary) && <span {...stylex.props(visuallyHidden)}>, </span>}
    {said(step.summary) && (
      <span {...stylex.props(styles.summary)}>{step.summary}</span>
    )}
    {/* The state in words, for a screen reader: the mark says it to the eye. */}
    <span
      {...stylex.props(visuallyHidden)}
    >{`, ${words.states[step.state]}`}</span>
    {step.duration !== undefined && ended(step) && (
      <>
        <span {...stylex.props(visuallyHidden)}>, </span>
        <span {...stylex.props(styles.stepTime)}>{seconds(step.duration)}</span>
      </>
    )}
  </>
);

/** A step's input and result, behind a press on its line. */
const Detailed = ({
  step,
  words,
}: {
  step: ActivityStep;
  words: AgentActivityWords;
}) => (
  <Collapsible>
    <CollapsibleTrigger
      {...stylex.props(styles.line, styles.lineButton, focus.words)}
    >
      {(state: CollapsibleState) => (
        <>
          <span aria-hidden="true" {...stylex.props(styles.stepTarget)} />
          <StepLine step={step} words={words} />
          <span
            aria-hidden="true"
            {...stylex.props(
              styles.stepChevron,
              state.open && styles.chevronOpen
            )}
          >
            <Icon icon={ChevronDown} />
          </span>
        </>
      )}
    </CollapsibleTrigger>
    <CollapsiblePanel {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.detail)}>
        {said(step.input) && (
          <Output label={words.input} text={step.input} words={words} />
        )}
        {said(step.result) && (
          <Output
            label={step.state === "failed" ? words.error : words.result}
            text={step.result}
            failed={step.state === "failed"}
            words={words}
          />
        )}
      </div>
    </CollapsiblePanel>
  </Collapsible>
);

/** One step: its mark, its line, and its detail when it has one. `last` leaves out the line down to the next. */
export const Step = ({
  step,
  last,
  words,
}: {
  step: ActivityStep;
  last: boolean;
  words: AgentActivityWords;
}) => {
  const detailed = said(step.input) || said(step.result);
  return (
    <li
      data-slot="agent-activity-step"
      data-state={step.state}
      {...stylex.props(styles.step)}
    >
      {!last && (
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.join,
            step.state === "done" && styles.joinDone
          )}
        />
      )}
      <span
        aria-hidden="true"
        data-slot="agent-activity-mark"
        {...stylex.props(
          styles.mark,
          step.state === "failed" && styles.markFailed,
          step.state === "skipped" && styles.markSkipped
        )}
      >
        <Mark step={step} />
      </span>
      <div {...stylex.props(styles.body)}>
        {detailed ? (
          <Detailed step={step} words={words} />
        ) : (
          <p {...stylex.props(styles.line)}>
            <StepLine step={step} words={words} />
          </p>
        )}
      </div>
    </li>
  );
};
