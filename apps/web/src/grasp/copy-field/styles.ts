import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { copyFieldMarker } from "./copy-field.stylex";

const done = '[data-copied="done"]';
const failed = '[data-copied="failed"]';
const resting = ":not([data-copied])";

/** The fade at an end with more beyond it: the space-8 nearest that end goes to nothing. */
const fadeEnd = `linear-gradient(to right, black calc(100% - ${grasp.space8}), transparent)`;
const fadeStart = `linear-gradient(to left, black calc(100% - ${grasp.space8}), transparent)`;
const fadeBoth = `linear-gradient(to right, transparent, black ${grasp.space8}, black calc(100% - ${grasp.space8}), transparent)`;

export const styles = stylex.create({
  // The field: the install line's look, a quiet fill in the system's corner, one line.
  field: {
    [iconVars.size]: grasp.iconSm,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    boxSizing: "border-box",
    maxWidth: "100%",
    minWidth: 0,
    margin: 0,
    paddingBlock: 0,
    paddingInlineStart: grasp.space3,
    fontFamily: grasp.fontMono,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightRegular,
    textAlign: "start",
    color: grasp.ink,
    cursor: "copy",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
    verticalAlign: "middle",
    backgroundColor: {
      default: grasp.codeFill,
      // Hover only at rest: while it says "copied", that wins.
      [`${resting}:hover`]: {
        default: null,
        [media.hover]: `color-mix(in oklch, ${grasp.codeFill}, ${grasp.ink} 7%)`,
      },
      // The field is its own marker, so its own state is read as a selector on itself.
      [`:is(${done})`]: grasp.successSoft,
    },
    // Forced colours drop the fill: a line keeps the field.
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "ButtonText",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: {
      default: "inset 0 0 0 1px transparent",
      [`:is(${done})`]: `inset 0 0 0 1px color-mix(in oklch, ${grasp.mintDeep} 35%, transparent)`,
      // Strong enough to stand off the fill in dark, where a third of danger read as a dull brown.
      [`:is(${failed})`]: `inset 0 0 0 1px color-mix(in oklch, ${grasp.danger} 60%, transparent)`,
      // With the keyboard's ring round it, the ring is the field's one edge: a coloured line just
      // inside it read as two lines stacked.
      [`:is(${done}, ${failed}):has(:focus-visible)`]:
        "inset 0 0 0 1px transparent",
    },
    transform: { default: null, ":active": `scale(${grasp.pressScale})` },
    transitionProperty: "background-color, box-shadow, transform",
    // The ground and ring change with the icons' crossfade, never ahead of it.
    transitionDuration: `${grasp.durationHover}, ${simply.swap}, ${simply.press}`,
    transitionTimingFunction: grasp.ease,
  },
  // The ring for the keyboard goes round the whole field, though the focus is on its button.
  // (focus.within, src/focus, is added after this.)
  // The button is a square as tall as the field, its icon in the middle: the room at the end makes
  // up the rest, so the icon stands as far from the end as the words from the start (space-3).
  sm: {
    height: grasp.controlXs,
    paddingInlineEnd: `max(0px, calc(${grasp.space3} - (${grasp.controlXs} - ${grasp.iconSm}) / 2))`,
  },
  md: {
    height: grasp.controlSm,
    paddingInlineEnd: `max(0px, calc(${grasp.space3} - (${grasp.controlSm} - ${grasp.iconSm}) / 2))`,
  },
  // A colour before the value: a small round of it with a 1px ring in the muted ink (4.5:1 on the
  // field in light and dark), so a colour like the field's own ground (paper, soft in dark) still
  // shows as a round.
  swatch: (colour: string) => ({
    flexShrink: 0,
    width: 12,
    height: 12,
    marginInlineEnd: grasp.space2,
    borderRadius: grasp.cornerCircle,
    backgroundColor: colour,
    boxShadow: `inset 0 0 0 1px ${grasp.muted}`,
    forcedColorAdjust: "none",
  }),
  // The value: one line, never broken, never cut with an ellipsis. Narrower than its text, it
  // scrolls sideways inside the field with no bar and the end with more fades out.
  value: {
    flexGrow: 1,
    minWidth: 0,
    overflowX: "auto",
    overflowY: "hidden",
    whiteSpace: "nowrap",
    scrollbarWidth: "none",
    // A scroller the browser can focus with the keyboard: the field's ring (focus.within) shows
    // that, so no second, square ring tight round the words, half eaten by the fade.
    outline: "none",
    maskImage: {
      default: "none",
      ":is([data-more='end'])": fadeEnd,
      ":is([data-more='start'])": fadeStart,
      ":is([data-more='both'])": fadeBoth,
    },
  },
  // The button at the end: a square as tall as the field, the Copy icon in its middle. The whole
  // field copies on a press; the button is its one tab stop and its name.
  button: {
    position: "relative",
    display: "inline-grid",
    flexShrink: 0,
    placeItems: "center",
    alignSelf: "stretch",
    boxSizing: "border-box",
    aspectRatio: "1",
    margin: 0,
    padding: 0,
    color: "inherit",
    font: "inherit",
    cursor: "inherit",
    backgroundColor: "transparent",
    borderWidth: 0,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    outline: "none",
    WebkitTapHighlightColor: "transparent",
  },
  // A finger needs 44px: on a touch screen an unseen area round the button makes up the difference.
  target: {
    position: "absolute",
    inset: { default: 0, [media.coarse]: `calc((100% - ${grasp.tap}) / 2)` },
  },
  // The icons, one cell: copy at rest, the tick once copied, the failed mark when it could not.
  // They cross by opacity and a small scale, so nothing beside them moves.
  mark: {
    gridArea: "1 / 1",
    display: "inline-flex",
    color: grasp.muted,
    opacity: 0,
    transform: {
      default: `scale(${grasp.swapScale})`,
      [media.reduced]: "none",
    },
    transitionProperty: "opacity, transform, color",
    transitionDuration: `${simply.swap}, ${simply.swap}, ${grasp.durationHover}`,
    transitionTimingFunction: grasp.ease,
  },
  copy: {
    color: {
      default: grasp.muted,
      [stylex.when.ancestor(`${resting}:hover`, copyFieldMarker)]: {
        default: null,
        [media.hover]: grasp.ink,
      },
    },
    opacity: {
      default: 1,
      [stylex.when.ancestor("[data-copied]", copyFieldMarker)]: 0,
    },
    transform: {
      default: "none",
      [stylex.when.ancestor("[data-copied]", copyFieldMarker)]: {
        default: `scale(${grasp.swapScale})`,
        [media.reduced]: "none",
      },
    },
  },
  tick: {
    color: grasp.mintDeep,
    opacity: { default: 0, [stylex.when.ancestor(done, copyFieldMarker)]: 1 },
    transform: {
      default: `scale(${grasp.swapScale})`,
      [media.reduced]: "none",
      [stylex.when.ancestor(done, copyFieldMarker)]: "none",
    },
  },
  failed: {
    color: grasp.danger,
    opacity: { default: 0, [stylex.when.ancestor(failed, copyFieldMarker)]: 1 },
    transform: {
      default: `scale(${grasp.swapScale})`,
      [media.reduced]: "none",
      [stylex.when.ancestor(failed, copyFieldMarker)]: "none",
    },
  },
});
