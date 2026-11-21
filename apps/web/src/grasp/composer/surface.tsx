// ComposerSurface: a band tucked under the top of a composer's card (composer.tsx), for a notice
// that belongs to the composer, such as a limit reached, with one action at its end. The card
// overlaps its foot, so the two read as one piece.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Button } from "../button";
import { Cross, Icon } from "../icons";
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
  /** One action at the end, such as a small Button ("See usage"). In a narrow band it stands under the words. */
  action?: ReactNode;
  /** A quiet close at the band's end, on the words' first line. Give `dismissLabel` with it. */
  onDismiss?: () => void;
  /** The close's name, read by a screen reader ("Dismiss"). */
  dismissLabel?: string;
}

// Narrower than this, the action takes its own line under the words, so the words keep the width.
const NARROW = "@container (width < 24rem)";

const styles = stylex.create({
  band: {
    containerType: "inline-size",
    flexWrap: "wrap",
    rowGap: grasp.space2,
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
  // On the words' first line when they run to two.
  mark: {
    display: "flex",
    alignSelf: { default: "center", [NARROW]: "flex-start" },
    marginBlockStart: {
      default: 0,
      [NARROW]: `calc((${grasp.textSmLine} - ${grasp.iconSm}) / 2)`,
    },
  },
  words: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  // The action at the end, or on its own line under the words, from where they start.
  action: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    flexBasis: { default: "auto", [NARROW]: "100%" },
    paddingInlineStart: {
      default: 0,
      [NARROW]: `calc(${grasp.iconSm} + ${grasp.space2})`,
    },
  },
  actionBare: {
    paddingInlineStart: { default: 0, [NARROW]: 0 },
  },
  // In a narrow band the action moves under the words, and the close stays on their first line.
  actionAfter: { order: { default: 0, [NARROW]: 1 } },
  dismiss: {
    alignSelf: { default: "center", [NARROW]: "flex-start" },
    marginBlock: {
      default: 0,
      [NARROW]: `calc((${grasp.textSmLine} - ${grasp.space7}) / 2)`,
    },
    marginInlineEnd: `calc(-1 * ${grasp.space1})`,
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
  onDismiss,
  dismissLabel,
}: ComposerSurfaceProps) => (
  <div data-slot="composer-surface" {...stylex.props(styles.band)}>
    {icon && (
      <span {...stylex.props(styles.mark, styles[tone])}>
        <Icon icon={icon} />
      </span>
    )}
    <span {...stylex.props(styles.words)}>{children}</span>
    {action === undefined ? null : (
      <span
        {...stylex.props(
          styles.action,
          !icon && styles.actionBare,
          onDismiss !== undefined && styles.actionAfter
        )}
      >
        {action}
      </span>
    )}
    {onDismiss !== undefined && dismissLabel !== undefined && (
      <Button
        variant="ghost"
        size="xs"
        icon={Cross}
        aria-label={dismissLabel}
        onClick={onDismiss}
        layout={styles.dismiss}
      />
    )}
  </div>
);
