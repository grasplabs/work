// The box a text field draws, where Input, Textarea and Select's closed control draw it the same:
// its heights, padding and corner at each size, the 44px target a finger needs, and its states
// (live under a pointer, out of use, wrong). Each field keeps its own base and its read-only look,
// which differ. Every value is a token (src/tokens).
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";

const HOVER = media.hover;
const COARSE = media.coarse;
const FORCED = media.forced;

export const fieldBoxStyles = stylex.create({
  // The height, the same as Button's, the words centred on it, the one corner capped at half.
  sm: {
    minHeight: grasp.controlSm,
    paddingBlock: `calc((${grasp.controlSm} - ${grasp.textSmLine}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
  },
  md: {
    minHeight: grasp.controlMd,
    paddingBlock: `calc((${grasp.controlMd} - ${grasp.textSmLine}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))`,
  },
  lg: {
    minHeight: grasp.controlLg,
    paddingBlock: `calc((${grasp.controlLg} - ${grasp.textSmLine}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlLg} / 2))`,
  },

  // A finger needs 44px: an invisible area inside the control reaches past its edges.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: 0,
  },
  targetSm: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlSm} - ${grasp.tap}) / 2)`,
    },
  },
  targetMd: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlMd} - ${grasp.tap}) / 2)`,
    },
  },
  targetLg: { insetBlock: 0 },

  // Can be typed in or opened: the hairline deepens under a pointer.
  live: {
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.fieldEdge}, ${grasp.fieldLift}`,
      // Hover never covers the focus edge: the pointer often rests on a field while you type.
      ":hover:not(:focus-visible)": {
        default: null,
        [HOVER]: `inset 0 0 0 1px ${grasp.fieldEdgeHover}, ${grasp.fieldLift}`,
      },
      ":focus-visible": grasp.fieldFocus,
    },
  },
  // Out of use: half strength, a hairline and no lift.
  disabled: {
    opacity: grasp.dim,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
    cursor: "not-allowed",
  },
  invalid: {
    boxShadow: {
      default: grasp.fieldInvalid,
      ":focus-visible": grasp.fieldFocusInvalid,
    },
    // In forced colours the danger tint is dropped: a wrong field's edge turns dashed instead, the
    // same 1px, so it is no bigger than the fields beside it.
    borderStyle: { default: "solid", [FORCED]: "dashed" },
  },
});

/** Whether a field is marked wrong: `aria-invalid` as React and UI SDK give it, a boolean or the string. */
export const isInvalid = (value: unknown) => value === true || value === "true";
