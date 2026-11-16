// ComposerSurface: a band tucked under the top of a composer's card (composer.tsx), for a notice
// that belongs to the composer, such as a limit reached, with one action at its end. The card
// overlaps its foot, so the two read as one piece.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp } from "../tokens/tokens.stylex";

/** Every prop a ComposerSurface takes. */
export interface ComposerSurfaceProps {
  /** The notice, in one short line ("You have used this month's questions"). */
  children: ReactNode;
  /** An icon before the words. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * The colour of the icon: `muted` for a plain note, `attention` or `danger` when it stops work.
   * @default "muted"
   */
  tone?: "muted" | "attention" | "danger";
  /** One action at the end, such as a small Button ("See usage"). */
  action?: ReactNode;
}

const styles = stylex.create({
  band: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    // In from the card's sides by space-2, as the band under the card, so its side lies inside the
    // card's rounded corner and never runs beside it; its words still start where the card's do.
    marginInline: grasp.space2,
    paddingInline: `calc(${grasp.space4} - ${grasp.space2})`,
    paddingBlockStart: grasp.space3,
    // Room for the card's corner to sit over its foot.
    paddingBlockEnd: `calc(${grasp.space3} + ${grasp.corner})`,
    marginBlockEnd: `calc(-1 * ${grasp.corner})`,
    borderStartStartRadius: grasp.corner,
    borderStartEndRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
  },
  words: {
    flexGrow: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  muted: { color: grasp.muted },
  attention: { color: grasp.attention },
  danger: { color: grasp.danger },
});

/** A notice tucked under the top of the card. */
export const ComposerSurface = ({
  children,
  icon,
  tone = "muted",
  action,
}: ComposerSurfaceProps) => (
  <div data-slot="composer-surface" {...stylex.props(styles.band)}>
    {icon && (
      <span {...stylex.props(styles[tone])}>
        <Icon icon={icon} />
      </span>
    )}
    <span {...stylex.props(styles.words)}>{children}</span>
    {action}
  </div>
);
