"use client";

import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

import { focus } from "../focus/focus";
import { Icon, Tick } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { LevelWords } from "./reasoning";
import type { ComposerReasoningOption } from "./reasoning";

/** How the levels are drawn: a list of rows, or one segmented control. */
export type ComposerEffortLook = "rows" | "segments";

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
  /** Rows or segments. */
  look: ComposerEffortLook;
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
  rows: {
    display: "grid",
    gap: 0,
  },
  row: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    boxSizing: "border-box",
    minHeight: { default: grasp.controlSm, [media.coarse]: grasp.tap },
    paddingBlock: grasp.space1,
    paddingInline: grasp.space2,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.itemFillHighlight },
    },
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    // The chosen level's name a step firmer, beside its tick; its note stays quiet.
    fontWeight: {
      default: grasp.weightRegular,
      ":is([data-checked])": grasp.weightMedium,
    },
    cursor: "pointer",
  },
  tick: {
    display: "inline-flex",
    flexShrink: 0,
    width: grasp.iconSm,
    marginInlineStart: "auto",
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

/** The levels as radio rows or segments, under their heading. */
export const ComposerEffort = ({
  levels,
  value,
  onValueChange,
  label,
  look,
}: ComposerEffortProps) => {
  const name = useId();
  const heading = useId();
  const chosen = levels.find((level) => level.value === value);
  return (
    <div
      role="radiogroup"
      aria-labelledby={heading}
      data-slot="composer-effort"
      data-look={look}
      {...stylex.props(styles.root)}
    >
      <p id={heading} {...stylex.props(styles.heading)}>
        {label}
      </p>
      {look === "rows" ? (
        <div {...stylex.props(styles.rows)}>
          {levels.map((level) => (
            <label
              key={level.value}
              data-checked={level.value === value || undefined}
              {...stylex.props(styles.row, focus.within)}
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
              <LevelWords level={level} noteId={`${name}-${level.value}`} />
              <span aria-hidden="true" {...stylex.props(styles.tick)}>
                {level.value === value ? <Icon icon={Tick} /> : null}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <>
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
                />
                <span aria-hidden="true">{level.label}</span>
              </label>
            ))}
          </div>
          {chosen?.note !== undefined && chosen.note !== "" && (
            <p aria-hidden="true" {...stylex.props(styles.note)}>
              {chosen.note}
            </p>
          )}
        </>
      )}
    </div>
  );
};
