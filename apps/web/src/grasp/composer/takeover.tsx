// ComposerTakeover: what replaces a composer's text and footer while the assistant needs one thing
// before it can go on (composer.tsx), after Palermo's "Pick a brand to continue": a line, then a
// row of choices. Escape leaves it, when the composer is given `onTakeoverDismiss`. For a question
// with numbered choices and Other, give the composer a QuestionTool with `embedded` instead.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import { useId } from "react";

import { Button } from "../button";
import { grasp } from "../tokens/tokens.stylex";

/** One choice in a takeover. */
export interface ComposerChoice {
  /** What `onChoose` receives. */
  value: string;
  /** Its words ("Spring launch"). */
  label: string;
}

/** Every prop a ComposerTakeover takes. */
export interface ComposerTakeoverProps {
  /** The line that says what is needed ("Pick a project to continue."). It names the choices. */
  prompt: string;
  /** The choices, as buttons in a row. */
  choices: ComposerChoice[];
  /** Runs with the chosen value. Return a Promise and the button shows it is working. */
  onChoose: (value: string) => unknown;
}

const styles = stylex.create({
  root: {
    display: "grid",
    gap: grasp.space3,
    padding: grasp.space4,
  },
  prompt: {
    margin: 0,
    color: grasp.ink,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    overflowWrap: "anywhere",
  },
  choices: {
    display: "flex",
    flexWrap: "wrap",
    gap: grasp.space2,
  },
});

/** A line and a row of choices, in place of the text. */
export const ComposerTakeover = ({
  prompt,
  choices,
  onChoose,
}: ComposerTakeoverProps) => {
  const id = useId();
  return (
    <div data-slot="composer-takeover" {...stylex.props(styles.root)}>
      <p id={id} {...stylex.props(styles.prompt)}>
        {prompt}
      </p>
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <fieldset> brings its own border, padding and min-width */}
      <div role="group" aria-labelledby={id} {...stylex.props(styles.choices)}>
        {choices.map((choice) => (
          <PressPrimitive
            key={choice.value}
            onClick={() => {
              onChoose(choice.value);
            }}
            pendingAnnouncement=""
            render={(props: Record<string, unknown>) => (
              <Button {...props} variant="quiet" size="sm">
                {choice.label}
              </Button>
            )}
          />
        ))}
      </div>
    </div>
  );
};
