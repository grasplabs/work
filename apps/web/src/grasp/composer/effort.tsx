"use client";

import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import type { ComposerReasoningOption } from "./reasoning";

/** Every prop a ComposerEffort takes. */
export interface ComposerEffortProps {
  /** The levels, from the least effort to the most. */
  levels: ComposerReasoningOption[];
  /** The chosen level's `value`. */
  value: string;
  /** Called with the level chosen. */
  onValueChange: (value: string) => void;
  /** Its heading, and the radio group's name ("Effort"). */
  label: string;
}

const styles = stylex.create({
  root: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    gap: grasp.space1,
    minWidth: 0,
  },
  heading: {
    margin: 0,
    paddingInline: grasp.space2,
    paddingBlockStart: grasp.space1,
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  // The radio itself: native and unseen, covering its label, which draws it.
  native: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    margin: 0,
    opacity: 0,
    cursor: "pointer",
  },
  // The segmented look: Toggle group's soft track, the chosen segment raised on it.
  track: {
    display: "flex",
    flexWrap: "wrap",
    gap: grasp.toggleGap,
    padding: grasp.toggleTrackInset,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
    outlineOffset: "-1px",
  },
  segment: {
    position: "relative",
    display: "inline-flex",
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    minHeight: { default: grasp.toggleHeight, [media.coarse]: grasp.tap },
    paddingInline: grasp.toggleInset,
    borderRadius: `calc(${grasp.corner} - ${grasp.toggleTrackInset})`,
    cornerShape: grasp.cornerShape,
    color: {
      default: grasp.muted,
      ":hover": { default: null, [media.hover]: grasp.ink },
    },
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  segmentOn: {
    color: grasp.ink,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
    outline: { default: null, [media.forced]: "2px solid Highlight" },
  },
  // The chosen level's note, under the segments.
  note: {
    margin: 0,
    paddingInline: grasp.space2,
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
});

/** One level as a radio: the native input over its label, which draws it. */
const Choice = ({
  level,
  name,
  checked,
  onValueChange,
  noteId,
}: {
  level: ComposerReasoningOption;
  name: string;
  checked: boolean;
  onValueChange: (value: string) => void;
  noteId?: string;
}) => (
  <input
    type="radio"
    name={name}
    value={level.value}
    checked={checked}
    aria-label={level.label}
    aria-describedby={noteId}
    onChange={() => {
      onValueChange(level.value);
    }}
    {...stylex.props(styles.native)}
  />
);

/** The levels as segments, under their heading. */
export const ComposerEffort = ({
  levels,
  value,
  onValueChange,
  label,
}: ComposerEffortProps) => {
  const name = useId();
  const heading = useId();
  const chosen = levels.find((level) => level.value === value);
  return (
    <div
      role="radiogroup"
      aria-labelledby={heading}
      data-slot="composer-effort"
      data-look="segments"
      {...stylex.props(styles.root)}
    >
      <p id={heading} {...stylex.props(styles.heading)}>
        {label}
      </p>
      <div {...stylex.props(styles.track)}>
        {levels.map((level) => (
          <label
            key={level.value}
            data-checked={level.value === value || undefined}
            {...stylex.props(
              styles.segment,
              level.value === value && styles.segmentOn,
              focus.within
            )}
          >
            <Choice
              level={level}
              name={name}
              checked={level.value === value}
              onValueChange={onValueChange}
              noteId={
                level.note === undefined || level.note === ""
                  ? undefined
                  : `${name}-${level.value}`
              }
            />
            <span aria-hidden="true">{level.label}</span>
            {/* Each level's note describes its radio; only the chosen one's shows, under the track. */}
            {level.note !== undefined && level.note !== "" && (
              <span
                id={`${name}-${level.value}`}
                {...stylex.props(visuallyHidden)}
              >
                {level.note}
              </span>
            )}
          </label>
        ))}
      </div>
      {chosen?.note !== undefined && chosen.note !== "" && (
        <p aria-hidden="true" {...stylex.props(styles.note)}>
          {chosen.note}
        </p>
      )}
    </div>
  );
};
