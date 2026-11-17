// Badge's dot (`variant="dot"`): how serious something is, as a small dot in the tone's colour
// beside words that stay in the text's colour (once Severity). Its own file, as it reads the
// product's words (GraspWords): the pill Badge stays a server component.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import type { BadgeLayoutStyle, BadgeTone } from "./badge";
import { badgeWords } from "./words";

const FORCED = media.forced;

// The dot: how serious, beside words that stay in the text's colour.
const dotStyles = stylex.create({
  mark: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  dot: {
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.severityDot,
    height: grasp.severityDot,
    borderRadius: grasp.cornerCircle,
    forcedColorAdjust: "none",
  },
  danger: {
    backgroundColor: { default: grasp.danger, [FORCED]: "CanvasText" },
  },
  success: {
    backgroundColor: { default: grasp.success, [FORCED]: "CanvasText" },
  },
  // In forced colours a ring, so attention and danger never rest on colour alone.
  attention: {
    backgroundColor: { default: grasp.attention, [FORCED]: "Canvas" },
    boxShadow: { default: null, [FORCED]: "inset 0 0 0 1.5px CanvasText" },
  },
  // Info and neutral are quiet: the text's own faint colour, a dash in forced colours.
  info: {
    backgroundColor: { default: grasp.quiet, [FORCED]: "CanvasText" },
    height: { default: grasp.severityDot, [FORCED]: "2px" },
    borderRadius: { default: grasp.cornerCircle, [FORCED]: 0 },
  },
  neutral: {
    backgroundColor: { default: grasp.quiet, [FORCED]: "CanvasText" },
    height: { default: grasp.severityDot, [FORCED]: "2px" },
    borderRadius: { default: grasp.cornerCircle, [FORCED]: 0 },
  },
  words: {
    minWidth: 0,
    overflowWrap: "anywhere",
  },
});

/** `variant="dot"`: the dot in the tone's colour, and the words beside it, or the dot alone, named. */
export const Dot = ({
  tone,
  children,
  named,
  layout,
}: {
  tone: BadgeTone;
  children: ReactNode;
  named: string | undefined;
  layout: BadgeLayoutStyle | undefined;
}) => {
  const words = useWords("badge", badgeWords);
  const alone = children === undefined || children === null || children === "";
  return (
    <span
      data-slot="badge"
      data-variant="dot"
      data-tone={tone}
      {...stylex.props(dotStyles.mark, layout)}
    >
      <span
        // Alone, the dot is the thing said; beside words, the words say it.
        role={alone ? "img" : undefined}
        aria-label={alone ? (named ?? words.dot[tone]) : undefined}
        aria-hidden={alone ? undefined : true}
        {...stylex.props(dotStyles.dot, dotStyles[tone])}
      />
      {alone ? null : (
        <span {...stylex.props(dotStyles.words)}>{children}</span>
      )}
    </span>
  );
};
