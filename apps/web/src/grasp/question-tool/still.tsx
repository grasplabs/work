// QuestionOptionStill: one choice of a QuestionTool drawn standing still, for the docs' every-state
// row. It uses the tool's own styles, so hover and keyboard focus forced from its CSS show what
// the real choice does. Not exported from the component's index.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { Done, Icon, Plus, Tick } from "../icons";
import { rowMarker } from "./markers.stylex";
import { questionStyles as styles } from "./question-tool";

// A picture, not a control: inert, and no pointer over it or hover on it, so nothing in it reads as
// pressable (Ruben pressed a still's buttons, 15 November).
const picture = stylex.create({ still: { pointerEvents: "none" } });

/** Every prop a still choice takes. */
export interface QuestionOptionStillProps {
  /** `single` draws a numbered mark, `multi` a box, `other` the Other row. */
  kind?: "single" | "multi" | "other";
  /** Chosen: the mark filled. */
  chosen?: boolean;
  /** Its words. */
  label?: string;
  /** Its line under the words. */
  description?: string;
  /**
   * The Other row's words.
   * @default "Other"
   */
  otherLabel?: string;
}

/** What the mark holds: a plus for Other, a tick in a ticked box, the number otherwise. */
const markFor = (
  kind: QuestionOptionStillProps["kind"],
  chosen: boolean
): ReactNode => {
  if (kind === "other") {
    return <Icon icon={Plus} />;
  }
  if (kind === "multi") {
    return chosen ? <Icon icon={Tick} /> : null;
  }
  return "1";
};

/** One choice row, inert, in one state. */
export const QuestionOptionStill = ({
  kind = "single",
  chosen = false,
  label = "Quarterly summary",
  description,
  otherLabel = "Other",
}: QuestionOptionStillProps) => {
  const mark = markFor(kind, chosen);
  return (
    <div
      inert
      data-question-still=""
      {...stylex.props(rowMarker, styles.row, focus.within, picture.still)}
    >
      <span {...stylex.props(styles.markLine)}>
        {/* The row is inert, so the mark is out of the tab order already. It carries no tabindex of
            its own: the docs' forced keyboard focus skips a control taken out of the tab order (the
            other stops of a roving group), and this one stands for the stop that has it. */}
        <button
          type="button"
          data-checked={chosen || undefined}
          {...stylex.props(styles.mark, chosen && styles.markOn)}
        >
          <span aria-hidden="true" {...stylex.props(styles.reach)} />
          {mark}
        </button>
      </span>
      <span {...stylex.props(styles.words)}>
        <span
          {...stylex.props(styles.label, kind === "other" && styles.otherWords)}
        >
          {kind === "other" ? otherLabel : label}
        </span>
        {description !== undefined && description !== "" && (
          <span {...stylex.props(styles.description)}>{description}</span>
        )}
      </span>
      <span
        aria-hidden="true"
        {...stylex.props(styles.check, !chosen && styles.checkOff)}
      >
        <Icon icon={Done} />
      </span>
    </div>
  );
};
