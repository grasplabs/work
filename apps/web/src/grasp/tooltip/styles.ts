// The look of a tooltip, shared by its parts, and by its still drawing for the docs (still.tsx), so
// a drawing on a page wears the real panel's own styles, never a copy.
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const REDUCED = media.reduced;

// Where a tooltip stands while it opens and as it closes: clear, a little smaller, and nearer its
// trigger by tooltip-rise, so it rises away from whichever side it landed on. It grows from
// `--transform-origin`, the point on the trigger UI SDK placed it against.
const moving = ":is([data-starting-style], [data-ending-style])";
const RISE = grasp.tooltipRise;

export const tooltipStyles = stylex.create({
  // A dark capsule: the one corner, capped at half its height, so one line reads as a pill and
  // more lines as a rounded panel. Lifted like every popup, never interactive.
  panel: {
    boxSizing: "border-box",
    margin: 0,
    padding: grasp.tooltipPadding,
    // The browser's own popover box: no border, no limits of its own. Forced colours drop the
    // fill and the lift, so a 1px border in the text colour draws its edge.
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: grasp.tooltipText,
    backgroundColor: grasp.tooltipFill,
    // Translucent like Palermo's, with the page softened behind it; a faint lift and the edge ring
    // separate it from a dark page.
    backdropFilter: grasp.tooltipBlur,
    boxShadow: grasp.liftLow,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    textWrap: "pretty",
    overflowWrap: "anywhere",
    hyphens: "manual",
  },

  // Beside its trigger, as wide as its words up to tooltip-width, and never wider than the window
  // less the gutter on each side.
  placed: {
    width: "max-content",
    maxWidth: `min(${grasp.tooltipWidth}, 100vw - 2 * ${grasp.popupGutter})`,
    transformOrigin: "var(--transform-origin)",
  },

  // A fade with a slight rise from the trigger's side, on the one ease. Leaving is faster than
  // arriving. Under reduced motion only the fade is left. When it opened at once because another
  // tooltip was just open, it is there and gone at once.
  motion: {
    opacity: { default: 1, [moving]: 0 },
    transform: {
      default: "none",
      [moving]: {
        default: `scale(${grasp.popupFromScale})`,
        [REDUCED]: "none",
      },
    },
    translate: {
      default: "none",
      [`${moving}:is([data-side="top"])`]: {
        default: `0 ${RISE}`,
        [REDUCED]: "none",
      },
      [`${moving}:is([data-side="bottom"])`]: {
        default: `0 calc(-1 * ${RISE})`,
        [REDUCED]: "none",
      },
      [`${moving}:is([data-side="left"])`]: {
        default: `${RISE} 0`,
        [REDUCED]: "none",
      },
      [`${moving}:is([data-side="right"])`]: {
        default: `calc(-1 * ${RISE}) 0`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: {
      default: "opacity, transform, translate",
      [REDUCED]: "opacity",
    },
    // Under reduced motion it is simply there, and simply gone.
    transitionDuration: {
      default: simply.hover,
      ":is([data-ending-style])": simply.tooltipLeave,
      // Above the closing rule: a tooltip that opened at once also closes at once.
      ":is([data-instant][data-ending-style], [data-instant])": "0s",
    },
    transitionTimingFunction: grasp.ease,
  },

  // The panel's words. With a shortcut they are a wrapping row: the words keep their line whole,
  // and the keys stand at its end; when words and keys do not fit together, the keys go under the
  // words, at the line's end. A tooltip that fits stays on one line. The words never break to make
  // room for the keys (A3-layers-07: "Copy a link to / this report" broke for them).
  words: {
    display: { default: "block", ":has([data-tooltip-keys])": "flex" },
    flexWrap: "wrap",
    alignItems: "last baseline",
    columnGap: grasp.space2,
  },

  // The shortcut's keys: quieter than the words, a little apart, never broken across lines.
  shortcut: {
    marginInlineStart: "auto",
    color: grasp.tooltipMuted,
    fontWeight: grasp.weightRegular,
    whiteSpace: "nowrap",
  },
});
