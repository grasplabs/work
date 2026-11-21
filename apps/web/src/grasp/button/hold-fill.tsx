// The look of a held Button (hold.tsx): its fill crossing the button while held, and no callout or
// press look meanwhile. Apart from hold.tsx, so a Button that is not held never loads Popover: the
// Button draws these itself, and loads hold.tsx only for a Button with `hold`.
"use client";

import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import type { ButtonVariant } from "./button";

const REDUCED = media.reduced;
const FORCED = media.forced;

const styles = stylex.create({
  // Always on a hold button: a long press selects no text and opens no callout, and it never
  // shrinks under the press: the fill shows the press. (The press scale was turned off only while
  // holding; once the hold fired Firefox kept :active until the release, at 97%.)
  button: {
    WebkitTouchCallout: "none",
    WebkitUserSelect: "none",
    transform: "none",
  },
  // While held, the button keeps its size and its rest fill: the fill shows the press instead.
  held: {
    transform: "none",
  },
  heldInk: { backgroundColor: grasp.actionFill },
  heldQuiet: { backgroundColor: grasp.quietFill },
  heldGhost: { backgroundColor: "transparent" },
  heldDanger: { backgroundColor: grasp.dangerFill },
  heldApprove: { backgroundColor: grasp.approveFill },
  // The fill's frame: the button's own shape, so the fill never leaves it.
  clip: {
    position: "absolute",
    zIndex: -1,
    inset: 0,
    borderRadius: "inherit",
    cornerShape: "inherit",
    overflow: "hidden",
    pointerEvents: "none",
  },
  // The fill crosses from the start to the end, at an even pace, in the hold's time; let go, it
  // runs back quickly. In forced colours it is a line at the foot in the highlight colour.
  fill: {
    position: "absolute",
    insetInlineStart: 0,
    insetBlockStart: { default: 0, [FORCED]: "auto" },
    insetBlockEnd: 0,
    inlineSize: "0%",
    blockSize: { default: "auto", [FORCED]: grasp.ringWidth },
    forcedColorAdjust: "none",
    transitionProperty: "inline-size",
    // Let go, it runs back; with reduced motion it is simply empty again. While held it fills over
    // the hold's own time even then: it is the timer, as a progress bar is, not a decoration.
    transitionDuration: simply.leave,
    transitionTimingFunction: { default: grasp.ease, [REDUCED]: "linear" },
  },
  fillOn: {
    inlineSize: "100%",
    transitionTimingFunction: "linear",
  },
  fillTime: (time: string) => ({ transitionDuration: time }),
  // The variant's own pressed colour.
  fillInk: {
    backgroundColor: { default: grasp.actionFillPress, [FORCED]: "Highlight" },
  },
  fillQuiet: {
    backgroundColor: { default: grasp.quietFillPress, [FORCED]: "Highlight" },
  },
  fillGhost: {
    backgroundColor: { default: grasp.ghostFillPress, [FORCED]: "Highlight" },
  },
  fillDanger: {
    backgroundColor: { default: grasp.dangerHoldFill, [FORCED]: "Highlight" },
  },
  fillApprove: {
    backgroundColor: { default: grasp.approveFillPress, [FORCED]: "Highlight" },
  },
});

const held = {
  ink: styles.heldInk,
  quiet: styles.heldQuiet,
  ghost: styles.heldGhost,
  danger: styles.heldDanger,
  approve: styles.heldApprove,
} as const;

const fills = {
  ink: styles.fillInk,
  quiet: styles.fillQuiet,
  ghost: styles.fillGhost,
  danger: styles.fillDanger,
  approve: styles.fillApprove,
} as const;

/** The hold's styles on the Button, after its variant's: no callout, and while held no press look. */
export const holdLook = (variant: ButtonVariant, holding: boolean) => [
  styles.button,
  holding && styles.held,
  holding && held[variant],
];

/** The fill, inside the Button and under its words. */
export const HoldFill = ({
  variant,
  holding,
  ms,
}: {
  variant: ButtonVariant;
  holding: boolean;
  ms: number;
}) => (
  <span aria-hidden="true" {...stylex.props(styles.clip)}>
    <span
      data-slot="button-hold-fill"
      {...stylex.props(
        styles.fill,
        fills[variant],
        holding && styles.fillOn,
        holding && styles.fillTime(`${ms}ms`)
      )}
    />
  </span>
);
