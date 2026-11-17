// The look of a date picker (date-picker.tsx): closed, Input's field with a calendar button at its
// end; open, Calendar in a popup with the popup tokens Popover and Select share.
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const COARSE = media.coarse;
const SIZES = "@supports (field-sizing: content)";
const HOVER = media.hover;
const moving = ":is([data-starting-style], [data-ending-style])";
const edge = `inset 0 0 0 1px ${grasp.fieldEdge}, ${grasp.fieldLift}`;
// The popup's content fades at an end while there is more past it, as Popover's body does
// (src/components/popover/styles.ts): a month's sixth row cut on the popup's foot reads as more to
// come, never as the month's end (A3-choice-01). The padding stays an inset the fade stands in.
const FADE = grasp.space6;
const INSET = grasp.popoverPadding;
const fadeBelow = `linear-gradient(to bottom, black calc(100% - ${INSET} - ${FADE}), transparent calc(100% - ${INSET}))`;
const fadeBoth = `linear-gradient(to bottom, transparent ${INSET}, black calc(${INSET} + ${FADE}), black calc(100% - ${INSET} - ${FADE}), transparent calc(100% - ${INSET}))`;
const fadeAbove = `linear-gradient(to bottom, transparent ${INSET}, black calc(${INSET} + ${FADE}))`;
const ends = stylex.keyframes({
  "0%": { maskImage: fadeBelow },
  "1%, 99%": { maskImage: fadeBoth },
  "100%": { maskImage: fadeAbove },
});
const TIMELINE = "@supports (animation-timeline: scroll())";
const SHEET = ":is([data-presentation=sheet])";

export const datePickerStyles = stylex.create({
  // The field: Input's fill, hairline and lift, its focus edge while its words have focus.
  field: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: grasp.popupWidth,
    paddingInlineStart: grasp.dateFieldInset,
    paddingInlineEnd: grasp.space1,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.fieldFill,
    boxShadow: edge,
    transitionProperty: "box-shadow, background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  // Open for typing: the hairline deepens under a pointer, and takes the focus edge while
  // anything in the field has focus. Not while it is read only or disabled.
  live: {
    boxShadow: {
      default: edge,
      ":hover:not(:has(input:focus-visible))": {
        default: null,
        [HOVER]: `inset 0 0 0 1px ${grasp.fieldEdgeHover}, ${grasp.fieldLift}`,
      },
      // While its words have focus: the field's own focus edge, as Input's.
      ":has(input:focus-visible)": grasp.fieldFocus,
    },
  },
  // Input's heights and corners. On a touch screen every size is a whole fingertip's target.
  // The calendar button, a size below the field's (xs in sm, sm in md, md in lg; trigger.tsx),
  // stands as far from the field's end as from its top and bottom: the end padding is half the room
  // the field has round it. At sm and md that is 2px; at lg 4px (A-choice-15: one 32px button stood
  // flush in sm and 6px in at lg).
  sm: {
    minHeight: { default: grasp.controlSm, [COARSE]: grasp.tap },
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    paddingInlineEnd: {
      default: `calc((${grasp.controlSm} - ${grasp.controlXs}) / 2)`,
      [COARSE]: `calc((${grasp.tap} - ${grasp.controlXs}) / 2)`,
    },
  },
  md: {
    minHeight: { default: grasp.controlMd, [COARSE]: grasp.tap },
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))`,
    paddingInlineEnd: {
      default: `calc((${grasp.controlMd} - ${grasp.controlSm}) / 2)`,
      [COARSE]: `calc((${grasp.tap} - ${grasp.controlSm}) / 2)`,
    },
  },
  lg: {
    minHeight: grasp.controlLg,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlLg} / 2))`,
    paddingInlineEnd: `calc((${grasp.controlLg} - ${grasp.controlMd}) / 2)`,
  },
  // A typed date that is not one, or one that cannot be chosen: Input's danger lift.
  invalid: {
    boxShadow: {
      default: grasp.fieldInvalid,
      ":has(input:focus-visible)": grasp.fieldFocusInvalid,
    },
    // In forced colours the danger tint is dropped: a wrong field's edge turns dashed instead, the
    // same 1px, so it is no bigger than the fields beside it.
    borderStyle: { default: "solid", [media.forced]: "dashed" },
  },
  // Settled, as Input's: its words stay ink, no fill of its own, no lift. Disabled is the weaker look.
  readOnly: {
    backgroundColor: grasp.fieldFillRead,
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.fieldEdge}`,
      ":has(input:focus-visible)": grasp.fieldFocus,
    },
  },
  disabled: { opacity: grasp.dim, cursor: "not-allowed" },

  // The words typed, with no box of their own: the field is the box.
  // As tall as the field, so a press anywhere on it puts the caret in the words.
  input: {
    alignSelf: "stretch",
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    appearance: "none",
    backgroundColor: "transparent",
    // Read only, the quieter words, as Input's.
    color: {
      default: grasp.ink,
      ":read-only:not(:disabled)": grasp.fieldInkRead,
    },
    caretColor: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    fontVariantNumeric: "tabular-nums",
    // The field draws focus round all its parts (focus.fieldWithin); the words draw none.
    outline: "none",
    "::selection": { backgroundColor: grasp.fieldSelection, color: grasp.ink },
    "::placeholder": { color: grasp.muted, opacity: 1 },
  },
  // A range's two dates, each as wide as its words (or its placeholder), so the range reads as one
  // phrase; the end also takes the room after it, so a press there reaches it. Neither grows past
  // half the field, so a long entry in one never pushes the other against the calendar button or
  // cuts it through a character (A2-date-range-picker-03); words longer than that end in an
  // ellipsis at rest, as a field's value does, and scroll inside their own date while typed. Where
  // a browser cannot size a field to its words, the two share the room evenly.
  rangeDate: {
    fieldSizing: "content",
    flexGrow: { default: 1, [SIZES]: 0 },
    flexBasis: { default: 0, [SIZES]: "auto" },
    flexShrink: 1,
    maxWidth: "50%",
    textOverflow: "ellipsis",
  },
  rangeEnd: {
    flexGrow: 1,
    maxWidth: "none",
  },
  // Between a range's two dates: the field's gap and as much again on each side.
  between: {
    flexShrink: 0,
    marginInline: grasp.space1,
    color: grasp.muted,
  },

  // The popup: raised, the popup's lift, the one corner, Popover's padding. It grows from the
  // side of the field it opens on.
  // It is the frame: what it holds scrolls inside it (inner), so the fade never takes its ground.
  popup: {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.popupLift,
    color: grasp.text,
    // As a sheet (a range on a phone, A3-choice-01): the window's width, from its foot, its foot's
    // corners square on the window's edge.
    width: { default: null, [SHEET]: "100%" },
    maxWidth: {
      default: `min(100vw - 2 * ${grasp.popupGutter}, var(--available-width, 100vw))`,
      [SHEET]: "none",
    },
    borderEndStartRadius: { default: null, [SHEET]: 0 },
    borderEndEndRadius: { default: null, [SHEET]: 0 },
    maxHeight: "var(--available-height)",
    overflow: "hidden",
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, [moving]: 0 },
    transform: { default: "none", [moving]: `scale(${grasp.popupFromScale})` },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: simply.popup,
      ":is([data-ending-style])": simply.leave,
    },
    transitionTimingFunction: grasp.ease,
  },
  // What the popup holds, scrolling inside it when the window has less room than it needs, its ends
  // fading while there is more past them. No bar (the product's rule).
  inner: {
    boxSizing: "border-box",
    minHeight: 0,
    padding: grasp.popoverPadding,
    overflowX: "hidden",
    overflowY: "auto",
    scrollbarWidth: "none",
    // Only where the browser drives an animation by scroll, and never while the popup leaves: a
    // scroll-driven animation does not end, and the close may wait for its animations to end.
    animationName: {
      default: null,
      [TIMELINE]: { default: ends, ":is([data-ending-style] *)": "none" },
    },
    animationDuration: { default: null, [TIMELINE]: "auto" },
    animationTimingFunction: { default: null, [TIMELINE]: "linear" },
    animationFillMode: { default: null, [TIMELINE]: "both" },
    animationTimeline: { default: null, [TIMELINE]: "scroll(self)" },
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});
