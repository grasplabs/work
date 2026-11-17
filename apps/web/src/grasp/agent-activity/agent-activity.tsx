// AgentActivity: what an agent is doing now and what it did, as steps: a thought, a tool call
// with its name and a short summary of input and result, a file read or changed, a search. Each
// step is waiting, working, done, failed or skipped. It stands as one line ("Searched 3 times and
// read 2 files"), which opens to the steps; a step opens to its input and result. While it works
// the line says the current step, beside the Composer's light in small, and a finished run
// settles back into its one line. Learned from how Claude, ChatGPT and Cursor show an agent's
// work: one quiet line that opens, never a wall of logs. There is no shadcn or Palermo original.
// While it works, the working mark (src/components/working-mark) stands on the line while it is
// closed and on the working step while it is open: never both.
//
//   <AgentActivity steps={steps} />                              collapsed to its line
//   <AgentActivity steps={steps} defaultOpen duration={14200} />  open, with the run's time
//
// A screen reader hears a step when it finishes, not every tick. Every value is a token.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@ui-sdk/react/collapsible";
import type { CollapsibleState } from "@ui-sdk/react/collapsible";
import { useEffect, useRef, useState } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { ChevronDown, Icon } from "../icons";
import { TextShimmer } from "../text-shimmer";
import { WorkingMark } from "../working-mark";
import { seconds, summaryOf } from "./format";
import { Step } from "./step";
import { activityStyles as styles } from "./styles";
import type { ActivityStep, AgentActivityWords } from "./types";

/** Every prop an AgentActivity takes. */
export interface AgentActivityProps {
  /** The steps, in the order they happened; add to them as the agent works. */
  steps: ActivityStep[];
  /**
   * The one line when it is not working. Leave it out to have it counted from the steps
   * ("Searched 3 times and read 2 files").
   */
  summary?: string;
  /** How long the whole run took, in milliseconds, shown after the line. */
  duration?: number;
  /**
   * Open on the steps at first. A run that finishes while closed settles into its one line.
   * @default false
   */
  defaultOpen?: boolean;
  /** Open now. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /** Runs when it wants to open or close. */
  onOpenChange?: (open: boolean) => void;
  /** Its name, as a screen reader and an agent say it. @default "Agent activity" */
  "aria-label"?: string;
  /**
   * The run is still going, though no step is working now (between two steps). The line keeps
   * the light, says Working, and shows no time yet.
   * @default false
   */
  working?: boolean;
  /**
   * What the line says while the run goes on between two steps.
   * @default "Working"
   */
  workingLabel?: string;
  /** The words it writes itself, any of them replaced: state names, Show more, the labels, the one line. */
  words?: Partial<AgentActivityWords>;
}

/** Its words in English: replace any of them through `words`. */
const englishWords: AgentActivityWords = {
  states: {
    waiting: "Waiting",
    working: "Working",
    done: "Done",
    failed: "Failed",
    skipped: "Skipped",
  },
  showMore: "Show more",
  showLess: "Show less",
  input: "Input",
  result: "Result",
  error: "Why it failed",
  stepFailed: (title) => `${title} failed`,
  summarize: summaryOf,
};

/** The cleanup of an effect that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

/** What the line says: the step working now, the run between steps, or the run's one line. */
const lineOf = (
  current: ActivityStep | undefined,
  working: boolean,
  workingLabel: string,
  summary: string | undefined,
  steps: ActivityStep[],
  words: AgentActivityWords
) => {
  if (current !== undefined) {
    return current.active ?? current.title;
  }
  if (working) {
    return workingLabel;
  }
  return summary ?? words.summarize(steps);
};

/** The steps an agent took, behind one line. */
export const AgentActivity = ({
  steps,
  summary,
  duration,
  defaultOpen = false,
  open,
  onOpenChange,
  "aria-label": ariaLabel = "Agent activity",
  working: running = false,
  workingLabel = "Working",
  words: given,
}: AgentActivityProps) => {
  const words = { ...englishWords, ...given };
  // Its own name, so the effect that says finished steps follows only this word, not the object.
  const { stepFailed } = words;
  const current = steps.find((step) => step.state === "working");
  const working = current !== undefined || running;
  const line = lineOf(current, working, workingLabel, summary, steps, words);

  // Open and closed: the person's choice wins. A run that finishes without the person having
  // opened it settles back into its one line.
  const [shown, setShown] = useState(defaultOpen);
  const chosen = useRef(false);
  const isOpen = open ?? shown;
  const was = useRef(working);
  useEffect(() => {
    if (was.current && !working && !chosen.current && open === undefined) {
      setShown(false);
    }
    was.current = working;
  }, [working, open]);
  const change = (next: boolean) => {
    chosen.current = true;
    setShown(next);
    onOpenChange?.(next);
  };

  // Say each step once, when it finishes, never every tick: a step seen working that is now done,
  // or a step that arrives already done. What was there at first is history, not news.
  const [said, setSaid] = useState("");
  const seen = useRef<Map<string, ActivityStep["state"]> | null>(null);
  useEffect(() => {
    const first = seen.current === null;
    const known = seen.current ?? new Map<string, ActivityStep["state"]>();
    const finished: string[] = [];
    for (const step of steps) {
      const before = known.get(step.id);
      if (
        !first &&
        before !== step.state &&
        (step.state === "done" || step.state === "failed")
      ) {
        finished.push(
          step.state === "failed" ? stepFailed(step.title) : step.title
        );
      }
      known.set(step.id, step.state);
    }
    seen.current = known;
    if (finished.length === 0) {
      return keep;
    }
    // Empty first, so the same words said twice are heard twice.
    const clear = setTimeout(() => {
      setSaid("");
    }, 0);
    const say = setTimeout(() => {
      setSaid(finished.join(". "));
    }, 50);
    return () => {
      clearTimeout(clear);
      clearTimeout(say);
    };
  }, [steps, stepFailed]);

  return (
    <>
      <section
        aria-label={ariaLabel}
        aria-busy={working || undefined}
        data-slot="agent-activity"
        {...stylex.props(styles.root)}
      >
        <Collapsible
          open={isOpen}
          onOpenChange={(next: boolean) => {
            change(next);
          }}
        >
          <CollapsibleTrigger
            className={(state: CollapsibleState) =>
              stylex.props(
                styles.head,
                state.open && styles.headOpen,
                focus.ring
              ).className
            }
          >
            {(state: CollapsibleState) => (
              <>
                <span aria-hidden="true" {...stylex.props(styles.target)} />
                {/* One mark in view: on the line while closed; open, the working step has it, and the
                  line's words stand on the column's edge, as they do once the run is done. */}
                {working && !state.open && <WorkingMark />}
                {/* The line changes as the work goes on: the new words replace the old in one
                  frame, never passing through empty. It is a sentence, so on a narrow screen it may
                  wrap rather than lose its end. */}
                <span
                  data-may-wrap=""
                  {...stylex.props(
                    styles.headWords,
                    working && styles.headWorking
                  )}
                >
                  {working ? <TextShimmer>{line}</TextShimmer> : line}
                </span>
                {!working && duration !== undefined && (
                  <span {...stylex.props(styles.time)}>
                    {seconds(duration)}
                  </span>
                )}
                <span
                  aria-hidden="true"
                  {...stylex.props(
                    styles.chevron,
                    state.open && styles.chevronOpen
                  )}
                >
                  <Icon icon={ChevronDown} />
                </span>
              </>
            )}
          </CollapsibleTrigger>
          <CollapsiblePanel {...stylex.props(styles.panel)}>
            <ol {...stylex.props(styles.steps)}>
              {steps.map((step, index) => (
                <Step
                  key={step.id}
                  step={step}
                  last={index === steps.length - 1}
                  words={words}
                />
              ))}
            </ol>
          </CollapsiblePanel>
        </Collapsible>
      </section>
      {/* Outside the busy section, so what it says is heard while the run goes on. */}
      <div
        // On the role's own line, so the product's formatter cannot move it off.
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region; role="status" is
        role="status"
        data-slot="agent-activity-status"
        {...stylex.props(visuallyHidden)}
      >
        {said}
      </div>
    </>
  );
};
