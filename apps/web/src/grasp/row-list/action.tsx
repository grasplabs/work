// RowListAction: a quiet 28px button for a row's end or a panel section's label row, as Profound's
// grey bin and "Add": muted, no ground until a pointer rests on it. Icon only (with `aria-label`), or
// an icon and short words. On touch its target is 44px.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Button as ButtonPrimitive } from "@ui-sdk/react/button";

import { focus } from "../focus/focus";
import { Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

/**
 * Words after the icon.
 */
interface WithWords {
  /** Its words, a verb at most two words long ("Add"). */
  children: string;
  /** @deprecated Use `aria-label`. */
  label?: never;
  "aria-label"?: never;
}

/**
 * Only the icon: `aria-label` is its name.
 */
interface IconOnly {
  children?: never;
  /** Its name for a screen reader and an agent, with what it acts on ("Remove Search the web"). */
  "aria-label": string;
  /** @deprecated Use `aria-label`. */
  label?: never;
}

/**
 * The same, named the old way.
 */
interface IconOnlyLabel {
  children?: never;
  /** @deprecated Use `aria-label`. */
  label: string;
  "aria-label"?: string;
}

/** Every prop a RowListAction takes. */
export type RowListActionProps = (WithWords | IconOnly | IconOnlyLabel) & {
  /** Its icon, from the icons entry (`@/components/grasp/icons`): a plus to add, a bin to remove. */
  icon: IconData;
  /** Runs when it is pressed. */
  onPress?: () => void;
  /** For a button that opens and closes something: whether it is open now (`aria-expanded`). */
  expanded?: boolean;
  /** The id of what it opens and closes (`aria-controls`). */
  controls?: string;
  /**
   * Out of use. Say why near it.
   * @default false
   */
  disabled?: boolean;
};

const HOVER = media.hover;
const COARSE = media.coarse;

const styles = stylex.create({
  action: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    height: grasp.controlXs,
    minWidth: grasp.controlXs,
    margin: 0,
    paddingBlock: 0,
    paddingInline: `calc(${grasp.space2} - ${grasp.hairline} * 2)`,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.ghostFillHover },
      ":active": grasp.ghostFillPress,
    },
    fontFamily: grasp.fontSans,
    fontSize: grasp.inspectorText,
    lineHeight: grasp.inspectorTextLine,
    fontWeight: grasp.weightMedium,
    whiteSpace: "nowrap",
    cursor: "pointer",
    transitionProperty: "background-color, color",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
    // A finger's target: 44px round the 28px button, drawn unseen.
    "::after": {
      content: '""',
      position: "absolute",
      inset: {
        default: 0,
        [COARSE]: `calc((${grasp.controlXs} - ${grasp.tap}) / 2)`,
      },
    },
  },
  square: { paddingInline: 0, width: grasp.controlXs },
  off: { opacity: grasp.dim, cursor: "default" },
});

/** A quiet 28px action: a bin at a row's end, "Add" on a section's label row. */
export const RowListAction = ({
  icon,
  children,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  onPress,
  expanded,
  controls,
  disabled = false,
}: RowListActionProps) => {
  const square = children === undefined || children === "";
  return (
    <ButtonPrimitive
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onPress}
      disabled={disabled}
      data-slot="row-list-action"
      {...stylex.props(
        styles.action,
        square && styles.square,
        disabled && styles.off,
        focus.ring
      )}
    >
      <Icon icon={icon} />
      {children}
    </ButtonPrimitive>
  );
};
