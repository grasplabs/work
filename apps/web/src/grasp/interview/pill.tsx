// A kind's pill: its icon (or a small dot in its tone), then its label, on the tone's soft fill in
// the tone's ink, as small as Badge's `sm` and from the same tokens (height, inset, icon size, the
// system's edge). Badge cannot carry it: it has no dot, and only five of the seven tones. It
// stands; it does nothing when pressed, so it is never a button.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { tones } from "./tone";
import { toneVars } from "./tone.stylex";
import type { InterviewKindMark, InterviewTone } from "./types";

const styles = stylex.create({
  pill: {
    [iconVars.size]: grasp.badgeIcon,
    [iconVars.stroke]: grasp.iconStroke,
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    blockSize: grasp.badgeHeightSm,
    paddingInline: grasp.badgeInset,
    borderRadius: grasp.cornerPill,
    backgroundColor: toneVars.wash,
    boxShadow: grasp.edge,
    color: toneVars.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.badgeHeightSm,
    fontWeight: grasp.weightMedium,
    whiteSpace: "nowrap",
    verticalAlign: "middle",
    // In forced colours fills and shadows are dropped: a line draws the pill there, inside it.
    outline: { default: "none", [media.forced]: "1px solid currentColor" },
    outlineOffset: -1,
  },
  dot: {
    flexShrink: 0,
    inlineSize: `calc(${grasp.space1} + ${grasp.hairline} * 2)`,
    blockSize: `calc(${grasp.space1} + ${grasp.hairline} * 2)`,
    borderRadius: grasp.cornerCircle,
    backgroundColor: { default: toneVars.ink, [media.forced]: "CanvasText" },
    forcedColorAdjust: "none",
  },
});

/** What stands before the label, by `kindMark`: the icon, the dot, or nothing. */
const markOf = (mark: InterviewKindMark, icon: IconData | undefined) => {
  if (mark === "none" || (mark === "icon" && icon === undefined)) {
    return null;
  }
  return mark !== "dot" && icon !== undefined ? (
    <Icon icon={icon} />
  ) : (
    <span data-slot="interview-pill-dot" {...stylex.props(styles.dot)} />
  );
};

interface PillProps {
  tone: InterviewTone;
  icon: IconData | undefined;
  mark: InterviewKindMark;
  /** Its words: the kind's label, or the label with a count. */
  children: ReactNode;
}

/** A kind, as a small pill in its tone. */
export const KindPill = ({ tone, icon, mark, children }: PillProps) => (
  <span
    data-slot="interview-pill"
    data-tone={tone}
    {...stylex.props(styles.pill, tones[tone])}
  >
    {markOf(mark, icon)}
    <span>{children}</span>
  </span>
);
