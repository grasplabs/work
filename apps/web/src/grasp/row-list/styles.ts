// A row list's look (row-list.tsx, item.tsx, add.tsx): 44px rows of one height, a hairline between
// them with clear space on both sides, and a fill under a pointer drawn as an inset band that never
// touches a line, as Table's rows. Every value is a token (src/tokens).
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const HOVER = media.hover;
const ROW = "[data-slot=row-list-item]";

export const styles = stylex.create({
  list: {
    display: "grid",
    margin: 0,
    padding: 0,
    listStyle: "none",
    minWidth: 0,
  },
  row: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    boxSizing: "border-box",
    // One height for every row, whatever it holds.
    height: grasp.inspectorRow,
    minWidth: 0,
    paddingInline: grasp.inspectorInset,
    // The first and last rows take the card's own corner where they meet it, so the ring drawn
    // inside a row (focus.inside, focus.band) follows the card's curve and the card never clips it.
    borderStartStartRadius: {
      default: grasp.cornerMark,
      ":is(li:first-child, li:first-child > button)": grasp.corner,
    },
    borderStartEndRadius: {
      default: grasp.cornerMark,
      ":is(li:first-child, li:first-child > button)": grasp.corner,
    },
    borderEndStartRadius: {
      default: grasp.cornerMark,
      ":is(li:last-child, li:last-child > button)": grasp.corner,
    },
    borderEndEndRadius: {
      default: grasp.cornerMark,
      ":is(li:last-child, li:last-child > button)": grasp.corner,
    },
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    fontSize: grasp.inspectorText,
    lineHeight: grasp.inspectorTextLine,
    color: grasp.ink,
    // The band: a fill space-1 clear of the hairlines and the card's sides, under a pointer.
    "::before": {
      content: '""',
      position: "absolute",
      inset: grasp.space1,
      borderRadius: grasp.cornerMark,
      cornerShape: grasp.cornerShape,
      backgroundColor: "transparent",
      transitionProperty: "background-color",
      transitionDuration: simply.hover,
      transitionTimingFunction: grasp.ease,
      pointerEvents: "none",
    },
  },
  // The hairline between rows, at the top edge of every row after the first: the band stands
  // space-1 clear of it.
  lined: {
    borderBlockStartWidth: { default: 0, ":not(:first-child)": grasp.hairline },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
    borderStartStartRadius: {
      default: grasp.cornerMark,
      ":not(:first-child)": 0,
    },
    borderStartEndRadius: {
      default: grasp.cornerMark,
      ":not(:first-child)": 0,
    },
  },
  kind: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.inspectorKind,
    // Above the band.
    position: "relative",
  },
  name: {
    position: "relative",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: grasp.weightMedium,
  },
  // A row that is one press: its name is a button whose target stretches over the whole row.
  press: {
    position: "static",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    fontWeight: grasp.weightMedium,
    textAlign: "start",
    cursor: "pointer",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    outline: "none",
    "::after": {
      content: '""',
      position: "absolute",
      inset: 0,
      zIndex: 0,
    },
  },
  mark: {
    position: "relative",
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    color: grasp.quiet,
  },
  // The room between the name and what stands at the end.
  spring: { flexGrow: 1 },
  detail: {
    position: "relative",
    flexShrink: 0,
    maxWidth: "45%",
    // A pill in the detail (a Badge) stands past the column's end by its own inset, so its words
    // end where a plain detail's words end ("Owner" stopped 6px short of "Can read" above it). Its
    // pill keeps clear of the row's band.
    marginInlineEnd: {
      default: null,
      ":has(> [data-slot=badge]:only-child)": `calc(-1 * ${grasp.badgeInset})`,
    },
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: grasp.muted,
  },
  // The end actions: always there on touch and for the keyboard, shown under a pointer only when
  // the row is hovered or holds focus.
  actions: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space1,
    opacity: {
      default: 1,
      [HOVER]: {
        default: 0,
        [`:is(${ROW}:hover > *)`]: 1,
        [`:is(${ROW}:focus-within > *)`]: 1,
      },
    },
    transitionProperty: "opacity",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  // An add row's li hands its whole box to its button.
  flush: { paddingInline: 0, "::before": { content: "none" } },
  quietKind: { color: grasp.quiet },
  // The room a row without actions keeps, so every row's end stands in one line, and stays there:
  // kept only while another row had actions, it went with the last removal and "Read only" jumped
  // sideways. It is where the others' bin appears under a pointer.
  held: {
    width: grasp.controlXs,
    display: "flex",
  },
  // The add row: the whole row is the button, its words and plus quiet.
  add: {
    margin: 0,
    width: "100%",
    // Its row's height, inside the row's hairline: a row's own height would hang a pixel below the
    // card's edge, where the card clips the ring's lower side.
    height: "100%",
    borderWidth: 0,
    backgroundColor: "transparent",
    color: grasp.quiet,
    cursor: "pointer",
    textAlign: "start",
  },
  // Out of use, as a disabled Button: dimmed, no hover band, the pointer says it cannot be pressed.
  addDisabled: {
    opacity: grasp.dim,
    cursor: "not-allowed",
  },
  addWords: {
    position: "relative",
    fontWeight: grasp.weightMedium,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

// The band lights under a pointer on a row that does something.
export const band = stylex.create({
  on: {
    "::before": {
      backgroundColor: {
        default: "transparent",
        [HOVER]: { default: "transparent", ":hover": grasp.ghostFillHover },
      },
    },
  },
});
