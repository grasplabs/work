// The quiet text control of a composer's footer (model.tsx, reasoning.tsx), after Capy: no fill
// until hovered, words in muted at the small size, a chevron, the compact 28px height Palermo's
// footer controls have, and a 44px reach on a touch screen.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const swap = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

export const controlStyles = stylex.create({
  control: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    flexShrink: 0,
    boxSizing: "border-box",
    height: grasp.controlXs,
    minWidth: 0,
    margin: 0,
    paddingInline: grasp.space2,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "transparent",
    // First in a footer that leads with it, it stands at the card's corner and nests in it: the card's
    // corner less its room, when that is the smaller (corner.ts, F71).
    borderRadius: {
      default: `min(${grasp.corner}, calc(${grasp.controlXs} / 2))`,
      ":first-child": `min(${grasp.corner}, calc(${grasp.controlXs} / 2), var(--grasp-composer-first, ${grasp.corner}))`,
    },
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
      ":active": grasp.ghostFillPress,
      ":is([data-open], [aria-expanded=true])": grasp.ghostFillPress,
    },
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
    transitionProperty: "background-color, color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  // A finger needs 44px: an unseen reach round the control on a touch screen.
  reach: {
    position: "absolute",
    insetInline: {
      default: 0,
      [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
    insetBlock: {
      default: 0,
      [media.coarse]: `calc((${grasp.controlXs} - ${grasp.tap}) / 2)`,
    },
  },
  // A new value fades in where the old one stood: the control keeps its place.
  value: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    animationName: { default: swap, [media.reduced]: "none" },
    animationDuration: grasp.durationUi,
    animationTimingFunction: grasp.ease,
  },
  words: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // Narrow, in this order: first the model's name folds to its mark, then reasoning steps aside.
  narrowWords: {
    display: {
      default: "inline",
      "@container composer-footer (width < 24rem)": "none",
    },
  },
  foldLast: {
    display: {
      default: "inline-flex",
      "@container composer-footer (width < 19rem)": "none",
    },
  },
});
