"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Icon, Waiting } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { Markdown } from "../markdown";
import { grasp } from "../tokens/tokens.stylex";

/** How the opened thoughts are set apart from the answer (a study: one stays). */
export type ChatMessageThoughtsLook = "rule" | "panel" | "steps";

/** One step of the thoughts: the model's title for it, where it gave one, and its words. */
interface Step {
  title: string | undefined;
  body: string;
}

// A line that is only bold: the model's own title for the step that follows.
const TITLE = /^\s*\*\*(?<title>[^*\n]+)\*\*\s*$/u;

/** The thoughts, cut into steps at each line that is only bold. */
export const thoughtSteps = (text: string): Step[] => {
  const steps: Step[] = [];
  let step: Step = { title: undefined, body: "" };
  for (const line of text.split("\n")) {
    const title = TITLE.exec(line)?.groups?.title;
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

const styles = stylex.create({
  // Shared: small and quiet, and clear room before the answer's first line.
  root: {
    display: "grid",
    gap: grasp.space3,
    minWidth: 0,
    marginBlockStart: grasp.space1,
    marginBlockEnd: grasp.space5,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    whiteSpace: "normal",
  },
  rule: {
    paddingInlineStart: grasp.space3,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
  panel: {
    padding: grasp.space3,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
  },
  steps: {
    gap: 0,
  },
  step: {
    display: "grid",
    gap: grasp.space1,
    minWidth: 0,
  },
  // A step's title: a small label, a step firmer than its note.
  label: {
    margin: 0,
    color: grasp.ink,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
  },
  // The timeline: a small mark beside each label, a hairline joining the marks.
  timed: {
    [iconVars.size]: grasp.space3,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    gridTemplateColumns: `${grasp.space3} minmax(0, 1fr)`,
    columnGap: grasp.space2,
    minWidth: 0,
  },
  mark: {
    display: "flex",
    alignItems: "center",
    height: grasp.textXsLine,
    color: grasp.muted,
  },
  joint: {
    justifySelf: "center",
    width: grasp.hairline,
    minHeight: grasp.space3,
    backgroundColor: grasp.line,
  },
  timedBody: {
    display: "grid",
    gap: grasp.space1,
    minWidth: 0,
    paddingBlockEnd: grasp.space3,
  },
});

/** A step: its label, and its words through Markdown at the smallest size. */
const StepWords = ({ step, writing }: { step: Step; writing: boolean }) => (
  <>
    {step.title === undefined ? null : (
      <p {...stylex.props(styles.label)}>{step.title}</p>
    )}
    {step.body.trim() === "" ? null : (
      <Markdown source={step.body.trim()} size="xs" streaming={writing} />
    )}
  </>
);

/** The opened thoughts, in the look asked for. */
export const Thoughts = ({
  thoughts,
  look,
  writing,
}: {
  thoughts: ReactNode;
  look: ChatMessageThoughtsLook;
  writing: boolean;
}) => {
  const box = stylex.props(
    styles.root,
    look === "rule" && styles.rule,
    look === "panel" && styles.panel,
    look === "steps" && styles.steps
  );
  if (typeof thoughts !== "string") {
    return <div {...box}>{thoughts}</div>;
  }
  const steps = thoughtSteps(thoughts);
  return (
    <div data-slot="chat-message-thoughts" data-look={look} {...box}>
      {steps.map((step, index) =>
        look === "steps" ? (
          // A step keeps its place by its order as more thoughts arrive: they never move.
          <div key={index} {...stylex.props(styles.timed)}>
            <span aria-hidden="true" {...stylex.props(styles.mark)}>
              <Icon icon={Waiting} />
            </span>
            <div {...stylex.props(styles.step)}>
              {step.title === undefined ? null : (
                <p {...stylex.props(styles.label)}>{step.title}</p>
              )}
            </div>
            {index < steps.length - 1 ? (
              <span aria-hidden="true" {...stylex.props(styles.joint)} />
            ) : (
              <span />
            )}
            <div {...stylex.props(styles.timedBody)}>
              {step.body.trim() === "" ? null : (
                <Markdown
                  source={step.body.trim()}
                  size="xs"
                  streaming={writing}
                />
              )}
            </div>
          </div>
        ) : (
          <div key={index} {...stylex.props(styles.step)}>
            <StepWords step={step} writing={writing} />
          </div>
        )
      )}
    </div>
  );
};
