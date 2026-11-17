// The look of a hover card, shared by its parts. The surface is the popup's, as Popover's: raised,
// lifted, the one corner. Every value is a token (src/tokens).
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const HOVER = media.hover;
const FORCED = media.forced;
const REDUCED = media.reduced;
const PHONE = media.belowPhone;

// While it opens and as it closes: a little smaller and clear.
const moving = ":is([data-starting-style], [data-ending-style])";

export const hoverCardStyles = stylex.create({
  // The link: the words of the page around it, underlined, a little stronger under a pointer. On a
  // touch screen an unseen area makes it 44px each way, so a link on its own (in a list) can be hit.
  trigger: {
    position: "relative",
    "::after": {
      content: '""',
      position: "absolute",
      insetInline: {
        default: 0,
        [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
      },
      insetBlock: {
        default: 0,
        [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
      },
    },
    color: "inherit",
    fontWeight: grasp.weightMedium,
    textDecorationLine: "underline",
    textDecorationThickness: grasp.hairline,
    textUnderlineOffset: grasp.frameUnderlineOffset,
    textDecorationColor: {
      default: grasp.frameUnderline,
      ":hover": { default: null, [HOVER]: "currentColor" },
    },
    borderRadius: grasp.cornerMark,
    transitionProperty: "text-decoration-color",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  open: {
    textDecorationColor: "currentColor",
  },

  // The card: beside its link, as wide as popover-width or the window less the gutter. A preview
  // is short, so it never scrolls: everything in it is also on the link's page.
  panel: {
    boxSizing: "border-box",
    display: "grid",
    alignContent: "start",
    rowGap: grasp.space1,
    width: {
      default: `min(${grasp.popoverWidth}, 100vw - 2 * ${grasp.popupGutter})`,
      [PHONE]: `calc(100vw - 2 * ${grasp.popupGutter})`,
    },
    margin: 0,
    padding: grasp.popoverPadding,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.popupLift,
    color: grasp.text,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightRegular,
    overflowWrap: "anywhere",
    hyphens: "manual",
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, [moving]: 0 },
    transform: {
      default: "none",
      [moving]: {
        default: `scale(${grasp.popupFromScale})`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: simply.popup,
      ":is([data-ending-style])": simply.leave,
    },
    transitionTimingFunction: grasp.ease,
  },

  // What the link leads to: the interface's own type, a step up from its text.
  title: {
    margin: 0,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    textWrap: "balance",
  },
  // A line or two about it, and a quiet fact after.
  description: {
    margin: 0,
    color: grasp.text,
    textWrap: "pretty",
  },
  meta: {
    margin: 0,
    marginBlockStart: grasp.space1,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
});
