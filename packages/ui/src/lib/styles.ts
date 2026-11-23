// The styles every component shares: the focus ring, visually hidden words, hidden scrollbars,
// hyphenation, the fade of content that replaces a placeholder, the box of a text field, and the
// looks of a list in a popup and of a menu. Each is a StyleX style, or a set of them, that a
// component puts in its stylex.props(); a focus style goes last.
//
// Importing this file starts the focus watcher (below), once per document: a press marks what it
// focuses, so a field focused by a press keeps its soft halo and one the keyboard reached shows the
// ring.
import * as stylex from "@stylexjs/stylex";

import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "./tokens.stylex";
import {
  fieldControlMarker,
  focusMarker,
  iconVars,
  listMarker,
  menuMarker,
  motionVars,
  ringInsetMarker,
  traceCardMarker,
} from "./vars.stylex";

const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const HOVER = media.hover;
const REDUCED = media.reducedMotion;

// ---- Focus --------------------------------------------------------------------------------------
//
//   stylex.props(styles.button, focusRing)          a control: a button, a tab, a chip
//   stylex.props(styles.box, focusRingOffset)       a small mark whose own edge is a line (a
//                                                   checkbox, a radio, a switch): the ring stands off
//   stylex.props(styles.thumb, focusWithin)         a part whose focus is on a hidden input inside it
//   stylex.props(styles.link, focusRingText)        words: a link, a row's name
//   stylex.props(styles.scroller, focusRingInset)   a box its parent clips, or one whose
//                                                   neighbours touch it: a code view, a nav row, a
//                                                   segment
//   stylex.props(styles.fill, focusOnColor)         a part filled with the action colour that holds
//                                                   controls: their rings take the ink seen on it
//   stylex.props(styles.input, focusField.default)  a field you type in: no ring, its own edge and
//                                                   halo say it (`within` for a box round the input,
//                                                   `slot` for a one-time code's cell)
//   stylex.props(styles.tab, focusMarker, focusCarrier) with stylex.props(styles.words, focusLabel)
//                                                   a control drawn edge to edge (a line tab): the
//                                                   ring goes round its words, with a small corner
//
// The ring is ring-width of the ring's ink, standing ring-offset off the control's edge with the
// ground showing between them, so it reads as a ring round the control and never as its border.
//
// A control shows focus only for the keyboard (:focus-visible), so a click shows nothing extra. A
// field shows it whenever it has focus, because typing needs to know where it goes, but draws no
// ring in normal colours: its own edge and halo say it, and the caret says where the words go. A
// text field matches :focus-visible on a press as well, so the press is told apart: a pointer press
// marks the element it focuses with data-focus-pointer until it loses focus (watchPointerFocus), and
// the ring asks for :focus-visible without it. In forced colours, where shadows are dropped, a
// pointer-focused field keeps a thin real outline and a keyboard-focused one the thick Highlight
// ring.

const line = `${size.ringWidth} solid ${colors.ring}`;
// In forced colours a control already has a line of its own at rest (its edge), and a ring as fine
// as that edge would look like rest: the ring is twice line-strong, in the system's Highlight, and
// stands off the edge, so a focused control is told from one at rest. Its measure is its own, so
// the ring's width in normal colours never changes it.
const forcedLine = `calc(2 * ${size.lineStrong}) solid Highlight`;
const forcedThin = `${size.lineStrong} solid`;

// Focus the keyboard brought: on the field itself, or on the input inside a field's box.
const KEY = ":focus-visible:not([data-focus-pointer])";
const KEY_IN =
  ":has(:is(input, textarea):focus-visible:not([data-focus-pointer]))";
const ANY_KEY_IN = ":has(:focus-visible:not([data-focus-pointer]))";
const ANY_IN = ":has(:is(input, textarea):focus-visible)";

/**
 * Marks an element a pointer press focuses with data-focus-pointer, and takes it off when it loses
 * focus, so a field focused by a press keeps its soft halo and one the keyboard reached shows the
 * ring. Once per document; in the browser only.
 */
const watchPointerFocus = (root: Document) => {
  const flag = "damskoPointerFocus";
  if (root.documentElement.dataset[flag] === "") {
    return;
  }
  root.documentElement.dataset[flag] = "";
  // Until a key is pressed, focus moved by code (a page's first stop after a navigation, focus
  // given back) counts as a press: the ring is the keyboard's, and nothing has come from it yet.
  let pointer = true;
  // A press on what already has focus moves no focus, so focusin never hears it: the element is
  // marked here, so a ring the keyboard drew earlier goes with the press. A key brings it back.
  root.addEventListener(
    "pointerdown",
    (event) => {
      pointer = true;
      const active = root.activeElement;
      if (
        active instanceof HTMLElement &&
        event.target instanceof Node &&
        active.contains(event.target)
      ) {
        active.dataset.focusPointer = "";
      }
    },
    { capture: true, passive: true }
  );
  root.addEventListener(
    "keydown",
    () => {
      pointer = false;
      const active = root.activeElement;
      if (active instanceof HTMLElement) {
        delete active.dataset.focusPointer;
      }
    },
    { capture: true, passive: true }
  );
  root.addEventListener(
    "focusin",
    (event) => {
      if (pointer && event.target instanceof HTMLElement) {
        event.target.dataset.focusPointer = "";
      }
    },
    { capture: true }
  );
  root.addEventListener(
    "focusout",
    (event) => {
      if (event.target instanceof HTMLElement) {
        delete event.target.dataset.focusPointer;
      }
    },
    { capture: true }
  );
};
if (typeof document !== "undefined") {
  watchPointerFocus(document);
}

const focusStyles = stylex.create({
  // The keyboard's focus only: never after a press (data-focus-pointer), even on an element the
  // keyboard focused before it was pressed.
  ring: {
    outline: {
      default: "none",
      [KEY]: { default: line, [FORCED]: forcedLine },
    },
    // Inside a part that packs or clips its controls (ringInsetMarker) the ring is drawn just
    // inside the control, as focusRingInset draws it.
    outlineOffset: {
      default: size.ringOffset,
      [stylex.when.ancestor(":is(*)", ringInsetMarker)]: {
        default: `calc(-1 * ${size.ringWidth})`,
        [FORCED]: size.ringOffsetMark,
      },
      [FORCED]: size.ringOffsetMark,
    },
  },
  // A small mark whose own edge is already a line: the ring stands ring-offset-mark off it, the
  // mark's own measure, a gap of the ground between them.
  ringOffset: {
    outline: {
      default: "none",
      [KEY]: { default: line, [FORCED]: forcedLine },
    },
    outlineOffset: size.ringOffsetMark,
  },
  // Inside a part that packs or clips its controls (ringInsetMarker), just inside, as ring is.
  within: {
    outline: { default: "none", ":has(:focus-visible)": line },
    outlineOffset: {
      default: size.ringOffset,
      [stylex.when.ancestor(":is(*)", ringInsetMarker)]:
        `calc(-1 * ${size.ringWidth})`,
    },
  },
  ringText: {
    outline: { default: "none", [KEY]: line },
    // 1px off the words, a pixel in from ring-offset-words: clears the letters and the next word.
    outlineOffset: `calc(${size.ringOffsetText} - 1px)`,
  },
  ringInset: {
    outline: { default: "none", [KEY]: line },
    outlineOffset: `calc(-1 * ${size.ringWidth})`,
  },
  // On action-fill the ring's own ink is lost (the fill is that ink's mode): the rings inside take
  // the other mode's. Not for the filled control itself, whose ring stands off it, on the ground.
  onColor: {
    "--damsko-ring": colors.ringOnColor,
  },
  // A control whose ring is drawn on its words (focusLabel): it draws none itself.
  carrier: {
    outline: "none",
  },
  // The words of a focusCarrier: the ring round them, keyboard only, with the small corner.
  label: {
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    outline: {
      default: "none",
      [stylex.when.ancestor(KEY, focusMarker)]: line,
    },
    outlineOffset: size.ringOffsetText,
  },
});

/** The keyboard's ring round a control, standing off its edge. */
export const focusRing = focusStyles.ring;
/** The ring standing off a small mark whose own edge is a line (a checkbox, a radio, a switch). */
export const focusRingOffset = focusStyles.ringOffset;
/** The ring just inside a box its parent clips or its neighbours touch (a code view, a nav row). */
export const focusRingInset = focusStyles.ringInset;
/** The ring round words (a link, a row's name). */
export const focusRingText = focusStyles.ringText;
/** The ring on a part whose focus is on a hidden input inside it (a slider's thumb). */
export const focusWithin = focusStyles.within;
/** The words of a control that carries focusMarker and focusCarrier: the ring goes round them. */
export const focusLabel = focusStyles.label;
/** A control whose ring is drawn on its words (focusLabel). */
export const focusCarrier = focusStyles.carrier;
/** A part filled with the action colour: every ring inside it takes the ink seen on that fill. */
export const focusOnColor = focusStyles.onColor;

/**
 * A field you type in: its own edge and halo show focus, so no ring, only the system's line in
 * forced colours, where that edge is dropped.
 */
export const focusField = stylex.create({
  default: {
    outline: {
      default: "none",
      ":focus-visible": { default: "none", [FORCED]: forcedThin },
      [KEY]: { default: "none", [FORCED]: forcedLine },
    },
    outlineOffset: {
      default: size.ringOffset,
      [FORCED]: size.ringOffsetMark,
    },
  },
  // A read-only field: it takes focus, so its words can be selected and copied, but shows no ring,
  // which would invite typing; its own hairline goes a step stronger instead. In forced colours the
  // system's line shows it.
  readOnly: {
    outline: {
      default: "none",
      ":focus-visible": { default: "none", [FORCED]: forcedLine },
    },
    outlineOffset: {
      default: size.ringOffset,
      [FORCED]: size.ringOffsetMark,
    },
  },
  // A box round the input that types (a number field, a tags input, a date picker): the box's own
  // edge and halo show focus; in forced colours the system's line goes round the box. The input
  // inside takes focusCarrier.
  within: {
    outline: {
      default: "none",
      [ANY_IN]: { default: "none", [FORCED]: forcedThin },
      [KEY_IN]: { default: "none", [FORCED]: forcedLine },
    },
    outlineOffset: {
      default: size.ringOffset,
      [FORCED]: size.ringOffsetMark,
    },
  },
  // `within` for a group whose input may be read only (an input group): in forced colours, the
  // system's line round it while its input has focus.
  withinEditable: {
    outline: {
      default: "none",
      [ANY_IN]: { default: "none", [FORCED]: forcedLine },
    },
    outlineOffset: {
      default: size.ringOffset,
      [FORCED]: size.ringOffsetMark,
    },
  },
  // A field whose box sits flush in a surface (a command's search): the ring drawn just inside it.
  inset: {
    outline: {
      default: "none",
      ":focus-visible": { default: "none", [FORCED]: forcedThin },
      [KEY]: { default: line, [FORCED]: forcedLine },
    },
    outlineOffset: {
      default: `calc(-1 * ${size.ringWidth})`,
      [FORCED]: `calc(-2 * ${size.lineStrong})`,
    },
  },
  // A control made of parts, one rounded box (a filter's segments): the ring round the whole box
  // while the keyboard has focus on any part; the part says which by its own fill.
  group: {
    outline: {
      default: "none",
      [ANY_KEY_IN]: { default: line, [FORCED]: forcedLine },
    },
    outlineOffset: {
      default: size.ringOffset,
      [FORCED]: size.ringOffsetMark,
    },
  },
  // A cell of a one-time code, the one typing goes to, inside a root that carries focusMarker and
  // holds the code's one input.
  slot: {
    outline: {
      default: "none",
      [stylex.when.ancestor(ANY_IN, focusMarker)]: {
        default: "none",
        [FORCED]: forcedThin,
      },
      [stylex.when.ancestor(KEY_IN, focusMarker)]: {
        default: "none",
        [FORCED]: forcedLine,
      },
    },
    outlineOffset: {
      default: size.ringOffset,
      [FORCED]: size.ringOffsetMark,
    },
  },
});

// ---- Words and scrolling ------------------------------------------------------------------------

const textStyles = stylex.create({
  // One pixel, clipped to nothing and kept out of the flow: takes no room, never wraps, and is still
  // read, found and announced.
  visuallyHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    borderWidth: 0,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  // Scrolls by wheel, touch, keys and focus with no visible bar, at rest or in motion. Where it
  // matters that there is more, the part says so itself (a hairline, a fade at the edge).
  scrollbarHidden: {
    scrollbarWidth: "none",
  },
  // A word hyphenates only when long (12 letters or more), never within 5 of its ends, where its
  // language allows (the page's `lang`). Safari reads its own two limits.
  hyphenate: {
    hyphens: "auto",
    hyphenateLimitChars: "12 5 5",
    WebkitHyphenateLimitBefore: 5,
    WebkitHyphenateLimitAfter: 5,
  },
});

/** Hides words from the eye and keeps them for a screen reader. */
export const { visuallyHidden } = textStyles;
/** A scroller with no visible bar. Scroll area is the one part that draws bars of its own. */
export const { scrollbarHidden } = textStyles;
/** How interface words break: only a long word, never near its ends. */
export const { hyphenate } = textStyles;

// ---- Fade in ------------------------------------------------------------------------------------
//
// Content that replaces its placeholder fades in over duration-mark where the placeholder stood, so
// nothing moves; with reduced motion it is there at once. Never on what was there at first paint.
//
//   {loading ? <Skeleton /> : <span {...stylex.props(fadeIn)}>{name}</span>}

const fade = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const fadeStyles = stylex.create({
  in: {
    animationName: { default: fade, [REDUCED]: "none" },
    animationDuration: duration.mark,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
  },
});

/** What replaces a placeholder fades in, where the placeholder stood. */
export const fadeIn = fadeStyles.in;

// ---- Edge fade ----------------------------------------------------------------------------------
//
// A row that scrolls sideways (Suggestions, a row of Attachments) fades out at the side with more
// beyond it, clear of the room a control's ring takes at its very edge. The side is marked by
// useScrollEdges (`data-under-start`, `data-under-end`). A control reached by Tab stops clear of the
// fade (scroll padding); a part keeps its controls out of it at rest by keeping room for it. In forced
// colours the fade goes, as it would dissolve the edges inside it.
//
//   const edges = useScrollEdges();   <div ref={edges} {...stylex.props(styles.row, edgeFade)}>

// How far the fade reaches in from a side with more beyond it (Attachment keeps its cards this far
// clear of each side).
const EDGE_FADE = space["10"];
const FADE_ROOM = space["1"];
const fadeFrom = `transparent ${FADE_ROOM}, black ${EDGE_FADE}`;
const fadeTo = `black calc(100% - ${EDGE_FADE}), transparent calc(100% - ${FADE_ROOM})`;

const edgeFadeStyles = stylex.create({
  edges: {
    scrollPaddingInline: EDGE_FADE,
    maskImage: {
      default: null,
      ":is([data-under-end]:not([data-under-start]))": {
        default: `linear-gradient(to right, ${fadeTo})`,
        [FORCED]: "none",
      },
      ":is([data-under-start]:not([data-under-end]))": {
        default: `linear-gradient(to right, ${fadeFrom}, black)`,
        [FORCED]: "none",
      },
      ":is([data-under-start][data-under-end])": {
        default: `linear-gradient(to right, ${fadeFrom}, ${fadeTo})`,
        [FORCED]: "none",
      },
      ":is([dir=rtl] *):is([data-under-end]:not([data-under-start]))": {
        default: `linear-gradient(to left, ${fadeTo})`,
        [FORCED]: "none",
      },
      ":is([dir=rtl] *):is([data-under-start]:not([data-under-end]))": {
        default: `linear-gradient(to left, ${fadeFrom}, black)`,
        [FORCED]: "none",
      },
      ":is([dir=rtl] *):is([data-under-start][data-under-end])": {
        default: `linear-gradient(to left, ${fadeFrom}, ${fadeTo})`,
        [FORCED]: "none",
      },
    },
  },
});

/** The fade at the sides of a sideways row with more beyond them. */
export const edgeFade = edgeFadeStyles.edges;

// ---- Input --------------------------------------------------------------------------------------

/**
 * The box a text field draws, the same for Input, Textarea and Select's closed control: its height,
 * padding and corner at each size, the 44px target a finger needs, and its states. Each field keeps
 * its own base and its read-only look, which differ.
 */
export const inputStyles = stylex.create({
  // The height, the same as Button's, the words centred on it, the one corner capped at half.
  sm: {
    minHeight: size.controlSm,
    paddingBlock: `calc((${size.controlSm} - ${font.textSmLine}) / 2)`,
    borderRadius: `min(${radius.xl}, calc(${size.controlSm} / 2))`,
  },
  default: {
    minHeight: size.controlDefault,
    paddingBlock: `calc((${size.controlDefault} - ${font.textSmLine}) / 2)`,
    borderRadius: `min(${radius.xl}, calc(${size.controlDefault} / 2))`,
  },
  lg: {
    minHeight: size.controlLg,
    paddingBlock: `calc((${size.controlLg} - ${font.textSmLine}) / 2)`,
    borderRadius: `min(${radius.xl}, calc(${size.controlLg} / 2))`,
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
      [COARSE]: `calc((${size.controlSm} - ${size.tapTarget}) / 2)`,
    },
  },
  targetDefault: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${size.controlDefault} - ${size.tapTarget}) / 2)`,
    },
  },
  targetLg: { insetBlock: 0 },
  // Can be typed in or opened: the hairline deepens under a pointer.
  enabled: {
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}, ${shadow.inputShadow}`,
      // Hover never covers the focus edge: the pointer often rests on a field while you type.
      ":hover:not(:focus-visible)": {
        default: null,
        [HOVER]: `inset 0 0 0 1px ${colors.inputBorderHover}, ${shadow.inputShadow}`,
      },
      ":focus-visible": size.inputFocus,
    },
  },
  // Out of use: half strength, a hairline and no lift.
  disabled: {
    opacity: size.opacityDisabled,
    boxShadow: `inset 0 0 0 1px ${colors.input}`,
    cursor: "not-allowed",
  },
  invalid: {
    boxShadow: {
      default: size.inputInvalid,
      ":focus-visible": size.inputFocusInvalid,
    },
    // In forced colours the destructive tint is dropped: a wrong field's edge turns dashed instead,
    // the same 1px, so it is no bigger than the fields beside it.
    borderStyle: { default: "solid", [FORCED]: "dashed" },
  },
});

// ---- Popups: lists and menus --------------------------------------------------------------------

// While a popup opens and as it closes: a little smaller and clear. It grows from
// `--transform-origin`, the point on the trigger UI SDK placed it against.
const moving = ":is([data-starting-style], [data-ending-style])";

const SCROLLS = "@supports (animation-timeline: scroll())";

// The fade at the foot of a list that goes on: there while there is more below, gone at the end.
const more = stylex.keyframes({
  "0%, 94%": { opacity: 1 },
  "100%": { opacity: 0 },
});

// A row the list's foot cuts dims as it comes in, and only that row. A filter, so an item out of
// use keeps its own opacity.
const cut = stylex.keyframes({
  "0%": { filter: "opacity(0.2)" },
  "100%": { filter: "opacity(1)" },
});

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});

/**
 * A list in a popup, for the pickers (combobox, command, tags input, tree view's
 * filter). The popup carries listMarker. An item nests its corner inside the popup's.
 */
export const listStyles = stylex.create({
  // The popup: raised, lifted, the one corner, scrolling past popup-height or the room the window
  // has. It grows from where it was opened and shrinks back, faster.
  popup: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    boxSizing: "border-box",
    maxWidth: `min(${size.popupWidth}, var(--available-width, ${size.popupWidth}))`,
    maxHeight: `min(${size.popupHeight}, var(--available-height, ${size.popupHeight}))`,
    overflowY: "auto",
    overscrollBehavior: "contain",
    margin: 0,
    padding: space.popupPadding,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.popover,
    boxShadow: shadow.popupShadow,
    color: colors.foreground,
    fontFamily: font.sans,
    // A panel that opens inside its trigger's parent (it is not portalled) would take that parent's
    // text: it sets its own, and keeps only the direction, which follows the page.
    textAlign: "start",
    whiteSpace: "normal",
    fontWeight: "normal",
    fontStyle: "normal",
    textTransform: "none",
    letterSpacing: "normal",
    wordSpacing: "normal",
    textIndent: 0,
    fontSize: {
      default: font.textSm,
      [media.maxSmOrCoarse]: size.inputTextTouch,
    },
    lineHeight: font.textSmLine,
    outline: "none",
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, [moving]: 0 },
    transform: {
      default: "none",
      [moving]: {
        default: `scale(${size.popupFromScale})`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: motionVars.popup,
      ":is([data-ending-style])": motionVars.leave,
    },
    transitionTimingFunction: duration.ease,
  },
  // A row while the list's foot cuts it: dimmed by how much of it is hidden, clear once whole.
  cut: {
    animationName: {
      default: null,
      [SCROLLS]: {
        default: cut,
        [stylex.when.ancestor("[data-ending-style]", listMarker)]: "none",
        [stylex.when.ancestor("[data-closed]", listMarker)]: "none",
      },
    },
    animationDuration: { default: null, [SCROLLS]: "auto" },
    animationTimingFunction: { default: null, [SCROLLS]: "linear" },
    animationFillMode: { default: null, [SCROLLS]: "none" },
    animationTimeline: { default: null, [SCROLLS]: "view(block 0px)" },
    animationRange: { default: null, [SCROLLS]: "entry 0% entry 100%" },
  },
  // A list that goes on says so: a fade at its foot while there is more below (the list's own
  // scroll drives it). Placed after the list, it takes no room. Never while the popup leaves: a
  // scroll-driven animation does not end, and the close waits for its animations to end.
  more: {
    display: "block",
    position: "sticky",
    insetBlockEnd: `calc(-1 * ${space.popupPadding})`,
    // Over the end padding only, so it never lies on a row in view whole.
    height: space.popupPadding,
    marginBlockStart: `calc(-1 * ${space.popupPadding})`,
    marginInline: `calc(-1 * ${space.popupPadding})`,
    backgroundImage: {
      default: `linear-gradient(to bottom, transparent, ${colors.popover})`,
      [FORCED]: "none",
    },
    opacity: 0,
    pointerEvents: "none",
    animationName: {
      default: null,
      [SCROLLS]: {
        default: more,
        [stylex.when.ancestor("[data-ending-style]", listMarker)]: "none",
        [stylex.when.ancestor("[data-closed]", listMarker)]: "none",
      },
    },
    animationDuration: { default: null, [SCROLLS]: "auto" },
    animationTimingFunction: { default: null, [SCROLLS]: "linear" },
    animationFillMode: { default: null, [SCROLLS]: "both" },
    animationTimeline: { default: null, [SCROLLS]: "scroll(nearest)" },
  },
  // An item: an icon, its words, and something at the end (a tick, a key). 32px tall, words in
  // text-xs medium, 44px on touch.
  item: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
    minHeight: { default: size.controlSm, [COARSE]: size.tapTarget },
    boxSizing: "border-box",
    paddingBlock: `calc((${size.controlSm} - ${font.textXsLine}) / 2)`,
    paddingInline: space[2],
    borderRadius: `min(${radius.lg}, calc(${size.controlSm} / 2))`,
    cornerShape: radius.shape,
    color: colors.foreground,
    fontSize: { default: font.textXs, [COARSE]: font.textSm },
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
    overflowWrap: "anywhere",
    hyphens: "manual",
    textDecoration: "none",
  },
  // A menu's item in a list: the interface's text size, 36px with its line.
  menuItem: {
    minHeight: { default: size.controlDefault, [COARSE]: size.tapTarget },
    paddingBlock: `calc((${size.controlDefault} - ${font.textSmLine}) / 2)`,
    borderRadius: `min(${radius.lg}, calc(${size.controlDefault} / 2))`,
    color: colors.foreground,
    fontSize: {
      default: font.textSm,
      [media.maxSmOrCoarse]: size.inputTextTouch,
    },
    lineHeight: font.textSmLine,
  },
  // Where the keyboard or the pointer is. In forced colours, the system's own highlight, drawn by
  // the item itself: left to the browser, each run of words gets a backplate in the page's colour,
  // which hides words in HighlightText.
  itemHighlighted: {
    forcedColorAdjust: { default: null, [FORCED]: "none" },
    backgroundColor: {
      default: colors.accentHighlight,
      [FORCED]: "Highlight",
    },
    color: { default: colors.foreground, [FORCED]: "HighlightText" },
  },
  // Out of use: the muted colour at half strength, clearly under a group's name.
  itemDisabled: {
    opacity: size.opacityDisabled,
    color: { default: colors.mutedForeground, [FORCED]: "GrayText" },
    cursor: "not-allowed",
  },
  // The icon takes the words' colour.
  itemIcon: {
    display: "inline-flex",
    flexShrink: 0,
    color: "inherit",
  },
  itemText: {
    flexGrow: 1,
    minWidth: 0,
  },
  // The end of an item: a tick or a key, quiet.
  itemEnd: {
    display: "inline-flex",
    flexShrink: 0,
    marginInlineStart: "auto",
    // In forced colours it takes its row's colour, the highlighted row's too.
    color: { default: colors.mutedForeground, [FORCED]: "inherit" },
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
  check: {
    display: "inline-flex",
    flexShrink: 0,
    color: { default: colors.foreground, [FORCED]: "inherit" },
  },
  // The letters the typed words matched: in the foreground colour, never a fill.
  match: {
    backgroundColor: "transparent",
    color: { default: colors.foreground, [FORCED]: "inherit" },
    fontWeight: "inherit",
  },
  // A group's name: small and quiet, above its items, a weight under theirs.
  groupLabel: {
    paddingInline: space[2],
    paddingTop: space[2],
    paddingBottom: space[1],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightNormal,
    color: { default: colors.mutedForeground, [FORCED]: "CanvasText" },
    userSelect: "none",
  },
  separator: {
    height: 1,
    marginBlock: space[1],
    // Edge to edge of the popup.
    marginInline: `calc(-1 * ${space.popupPadding})`,
    backgroundColor: { default: colors.border, [FORCED]: "CanvasText" },
  },
  // Nothing matches: one quiet line, as tall as an item. UI SDK keeps the part in the page while
  // something matches; it takes room only when empty.
  empty: {
    display: { default: "none", ":is([data-empty])": "block" },
    boxSizing: "border-box",
    minHeight: size.controlSm,
    paddingBlock: `calc((${size.controlSm} - ${font.textXsLine}) / 2)`,
    paddingInline: space[2],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
    textAlign: "start",
  },
});

// An item's corner nests inside the panel's, capped at half a control's height.
const ITEM_CORNER = `min(${radius.lg}, calc(${size.controlDefault} / 2))`;

/**
 * A menu: the panel and its items, for dropdown menu, context menu and menubar. The panel carries
 * menuMarker. A 4px padded panel at high lift, items 36px tall with 8px round their icon and words,
 * labels, and separators that run to the panel's edge.
 */
export const menuStyles = stylex.create({
  // Raised, at high lift, the one corner. At least menu-width, as wide as its longest item up to
  // popup-width, never wider than the window less the gutter; it scrolls past popup-height.
  panel: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    boxSizing: "border-box",
    minWidth: `min(${size.menuWidth}, 100vw - 2 * ${space.popupGutter})`,
    maxWidth: `min(${size.popupWidth}, 100vw - 2 * ${space.popupGutter})`,
    maxHeight: `min(${size.popupHeight}, var(--available-height, ${size.popupHeight}))`,
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    margin: 0,
    padding: space.popupPadding,
    // Forced colours drop the fill and the lift, so a border in the text colour draws its edge.
    borderWidth: { default: 0, [FORCED]: size.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.popover,
    boxShadow: shadow.menuShadow,
    color: colors.foreground,
    fontFamily: font.sans,
    // A panel that opens inside its trigger's parent sets its own text, keeping only the direction.
    textAlign: "start",
    whiteSpace: "normal",
    fontWeight: "normal",
    fontStyle: "normal",
    textTransform: "none",
    letterSpacing: "normal",
    wordSpacing: "normal",
    textIndent: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    outline: "none",
    transformOrigin: "var(--transform-origin)",
  },
  // In and out from the trigger's side: duration-popup in, the faster duration-leave out.
  motion: {
    opacity: { default: 1, [moving]: 0 },
    transform: {
      default: "none",
      [moving]: {
        default: `scale(${size.popupFromScale})`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: { default: "opacity, transform", [REDUCED]: "opacity" },
    transitionDuration: {
      default: motionVars.popup,
      ":is([data-ending-style])": motionVars.leave,
    },
    transitionTimingFunction: duration.ease,
  },
  // An item: an icon, its words, and something at the end (keys, a tick, a spinner); 44px tall on a
  // touch screen.
  item: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space[2],
    minHeight: { default: null, [COARSE]: size.tapTarget },
    boxSizing: "border-box",
    padding: space.menuItemPadding,
    borderRadius: ITEM_CORNER,
    cornerShape: radius.shape,
    color: colors.foreground,
    fontWeight: font.weightMedium,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
    overflowWrap: "anywhere",
    hyphens: "manual",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
  },
  // Where the keyboard or the pointer is: the highlight is the focus mark. In forced colours the
  // item draws the system's highlight itself, so the browser puts no backplate over its words.
  highlighted: {
    forcedColorAdjust: { default: null, [FORCED]: "none" },
    backgroundColor: {
      default: colors.accentHighlight,
      [FORCED]: "Highlight",
    },
    color: { default: colors.foreground, [FORCED]: "HighlightText" },
  },
  // Out of use: half strength, still reached by the keys, as the menu pattern asks.
  disabled: {
    opacity: size.opacityDisabled,
    color: { default: colors.foreground, [FORCED]: "GrayText" },
    cursor: "not-allowed",
  },
  // An item that deletes or cannot be undone: its words and icon in the destructive colour.
  destructive: {
    color: { default: colors.destructive, [FORCED]: "CanvasText" },
  },
  destructiveHighlighted: {
    color: { default: colors.destructive, [FORCED]: "HighlightText" },
  },
  loading: {
    cursor: "progress",
  },
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    color: "inherit",
  },
  // The words and the end sit on one baseline; the icon, the check and the spinner stay centred.
  // On a touch screen the row is taller than its words, and there they centre.
  text: {
    flexGrow: 1,
    minWidth: 0,
    alignSelf: { default: "baseline", [COARSE]: "auto" },
  },
  // The words of an item with no icon, in a panel where other items have one: they start where the
  // others' words do, so the column of words stays one edge.
  inset: {
    paddingInlineStart: {
      default: 0,
      [stylex.when.ancestor(":has([data-menu-icon])", menuMarker)]:
        `calc(${size.iconSm} + ${space[2]})`,
    },
  },
  // The end of an item: the keys of its shortcut, quieter and smaller than its words.
  shortcut: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    marginInlineStart: "auto",
    alignSelf: { default: "baseline", [COARSE]: "auto" },
    color: { default: colors.mutedForeground, [FORCED]: "inherit" },
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightNormal,
    whiteSpace: "nowrap",
  },
  // The words of an action that failed.
  error: {
    color: { default: colors.destructive, [FORCED]: "inherit" },
  },
  spinner: {
    alignSelf: "center",
    animationName: { default: spin, [REDUCED]: "none" },
    animationDuration: duration.spin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  // The check of a checked item, in the words' colour.
  check: {
    display: "inline-flex",
    flexShrink: 0,
    marginInlineStart: "auto",
    color: "inherit",
  },
  // The selected one of a radio group: a dot in the check's place, as wide as an icon.
  dot: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: size.iconSm,
    height: size.iconSm,
    marginInlineStart: "auto",
    "::before": {
      content: '""',
      width: `calc(${size.iconSm} * 0.375)`,
      height: `calc(${size.iconSm} * 0.375)`,
      borderRadius: radius.circle,
      backgroundColor: { default: "currentColor", [FORCED]: "CanvasText" },
    },
  },
  // A group's name: small and quiet, above its items, as tall as a small control.
  label: {
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    minHeight: size.controlSm,
    paddingInline: space.menuItemPadding,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightNormal,
    color: { default: colors.mutedForeground, [FORCED]: "CanvasText" },
    userSelect: "none",
  },
  // A hairline between groups, edge to edge of the panel. A host may set its own line on the panel
  // (`--damsko-popup-line`, as the app shell does); everywhere else the border colour.
  separator: {
    height: size.hairline,
    marginBlock: space.popupPadding,
    marginInline: `calc(-1 * ${space.popupPadding})`,
    backgroundColor: {
      default: `var(--damsko-popup-line, ${colors.border})`,
      [FORCED]: "CanvasText",
    },
  },
});

// ---- Tap target ---------------------------------------------------------------------------------
//
// A finger needs 44px. A small control holds an unseen box that, on a touch screen, grows round it
// to 44px each way it is short of that, and never shrinks it. The control is `position: relative`
// and the box its first child, hidden from screen readers:
//
//   <button {...stylex.props(styles.remove)}><span aria-hidden="true" {...stylex.props(tapTarget)} />…
//
// The inset is a share of the control's own box (`100%`), so one style fits every size.

const tapInset = `min(0px, calc((100% - ${size.tapTarget}) / 2))`;

const tapStyles = stylex.create({
  target: {
    position: "absolute",
    insetInline: { default: 0, [COARSE]: tapInset },
    insetBlock: { default: 0, [COARSE]: tapInset },
  },
});

export const tapTarget = tapStyles.target;

// ---- Disclosure ---------------------------------------------------------------------------------
//
// A Collapsible's and an Accordion's shared look: a quiet full-width trigger, its words and a
// chevron at its end that turns as it opens, and the panel under it that opens over its height.
//
//   stylex.props(disclosureStyles.trigger, disclosureStyles.ghost, focusRing)
//   className(disclosureStyles.panel, disclosureStyles.quiet)
//
// A part marks itself disabled with data-disabled, as UI SDK does.

const OFF = ":is([data-disabled])";

export const disclosureStyles = stylex.create({
  trigger: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    minHeight: size.collapsibleTrigger,
    // The trigger bleeds out by its own padding, so its words and the panel's share one left edge
    // and the chevron ends where the panel does; hover and focus still have room round them.
    marginBlock: 0,
    marginInline: `calc(-1 * ${size.collapsiblePadding})`,
    paddingBlock: 0,
    paddingInline: size.collapsiblePadding,
    // In forced colours a line round it, except in a card (Tool's), whose own edge is the line.
    borderWidth: {
      default: 0,
      [FORCED]: {
        default: 1,
        [stylex.when.ancestor(":is(*)", traceCardMarker)]: 0,
      },
    },
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: `min(${radius.lg}, calc(${size.collapsibleTrigger} / 2))`,
    cornerShape: radius.shape,
    fontFamily: "inherit",
    fontSize: font.textSm,
    lineHeight: "1.125rem",
    fontWeight: font.weightMedium,
    textAlign: "start",
    color: {
      default: colors.foreground,
      [OFF]: { default: colors.subtleForeground, [FORCED]: "GrayText" },
    },
    cursor: { default: "pointer", [OFF]: "not-allowed" },
    transform: {
      default: null,
      ":active": { default: `scale(${size.buttonPressScale})`, [OFF]: "none" },
    },
    transitionProperty: "transform, background-color",
    // With reduced motion the press still shows, at once, without travelling.
    transitionDuration: `${motionVars.hover}, ${duration.hover}`,
    transitionTimingFunction: duration.ease,
    touchAction: "manipulation",
    WebkitTapHighlightColor: "transparent",
  },
  // On the page, filled only under the pointer and the press. A disabled trigger takes no hover and
  // no press: its rest wins under the pointer. Said inside :hover and :active, since a bare
  // [data-disabled] sorts before them and lost. In a card that holds the row (Tool's,
  // traceCardMarker) none: a fill would stand as a block of its own inside the card.
  ghost: {
    backgroundColor: {
      default: "transparent",
      ":hover": {
        default: null,
        [HOVER]: {
          default: colors.accent,
          [OFF]: "transparent",
          [stylex.when.ancestor(":is(*)", traceCardMarker)]: "transparent",
        },
      },
      ":active": {
        default: colors.accentActive,
        [OFF]: "transparent",
        [stylex.when.ancestor(":is(*)", traceCardMarker)]: "transparent",
      },
      [OFF]: "transparent",
    },
  },
  words: {
    flexGrow: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  // Points down while closed and turns up as it opens.
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  chevronOpen: {
    transform: "rotate(0.5turn)",
  },
  panel: {
    // A base stylesheet that hides [hidden] with !important (the docs' own) still wins over this.
    // Without script nothing opens a panel, so every panel shows open.
    display: { default: null, [media.noScript]: "block" },
    overflow: "hidden",
    // The height UI SDK measures and writes, as a Collapsible's panel or an Accordion's.
    height: {
      default: "var(--collapsible-panel-height, var(--accordion-panel-height))",
      ":is([data-starting-style], [data-ending-style])": 0,
      [media.noScript]: "auto",
    },
    transitionProperty: "height",
    transitionDuration: motionVars.collapsibleOpen,
    transitionTimingFunction: "ease-out",
  },
  // The panel's own words: small and quiet under the trigger. A panel drawn as a part of its own
  // (CollapsibleContent's `asChild`) leaves it out and keeps that part's type.
  quiet: {
    fontSize: font.textXs,
    lineHeight: "1.125rem",
    color: colors.mutedForeground,
  },
  // The words in an open panel stand a step off the trigger above and the next thing below. On a
  // part inside the panel: padding on the panel itself would show while it is closed.
  body: {
    paddingBlock: space["2"],
  },
});

// ---- The segmented track -------------------------------------------------------------------------
//
// One of a few, on one soft track, the chosen one raised out of it: Tabs' default list, a
// ToggleGroup and ThemeToggle's segmented form. Each lays its own items out on the track.
//
//   stylex.props(segmentedStyles.track)
//   stylex.props(chosen && segmentedStyles.chosen)

export const segmentedStyles = stylex.create({
  // The same room on every side, so the chosen one stands evenly inside the track.
  track: {
    padding: space.toggleTrackPadding,
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.muted,
    // Forced colours drop the fill: a line keeps the track.
    outline: { default: "none", [FORCED]: "1px solid CanvasText" },
    outlineOffset: "-1px",
  },
  // Raised out of the track with the low lift, so the choice is a shape and not a colour alone. In
  // dark a lift's shadow is lost on the dark ground and the fill is barely off the track, so there
  // it also takes the pressed veil. Light is untouched.
  // In forced colours, the system's own highlight, drawn by the part itself: left to the browser,
  // each run of words gets a backplate in the page's colour, which hides words in HighlightText.
  chosen: {
    forcedColorAdjust: { default: null, [FORCED]: "none" },
    color: { default: colors.foreground, [FORCED]: "HighlightText" },
    backgroundColor: { default: colors.tabBgSelected, [FORCED]: "Highlight" },
    backgroundImage: {
      default: `linear-gradient(light-dark(transparent, ${colors.accentActive}), light-dark(transparent, ${colors.accentActive}))`,
      [FORCED]: "none",
    },
    boxShadow: { default: shadow.sm, [FORCED]: "none" },
  },
  // The chosen one's words where they are a part of their own, over a pill that wears `chosen`
  // (ThemeToggle): in ink, and in forced colours the highlight's text with no backplate.
  chosenWords: {
    forcedColorAdjust: { default: null, [FORCED]: "none" },
    color: { default: colors.foreground, [FORCED]: "HighlightText" },
  },
});

// ---- The code surface ----------------------------------------------------------------------------
//
// What code, a command's output and an error's text stand on: CodeBlock's box, Terminal's output,
// a failed test's error and a stack trace's frames.
//
//   stylex.props(codeStyles.surface)                    a box with parts of its own (CodeBlock)
//   stylex.props(codeStyles.surface, codeStyles.text)   words set straight on it

export const codeStyles = stylex.create({
  // The wash and the edge (drawn outside, so it adds no size): the box reads by both. Forced
  // colours drop both, so a real border draws the edge there.
  surface: {
    backgroundColor: colors.codeBlockBg,
    boxShadow: size.borderStrong,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    color: colors.bodyForeground,
  },
  // Small mono words, with the same room on every side.
  text: {
    boxSizing: "border-box",
    minWidth: 0,
    paddingBlock: space["3"],
    paddingInline: space["3"],
    fontFamily: font.mono,
    fontSize: font.textXs,
    lineHeight: font.codeBlockLine,
  },
});

const tileStyles = stylex.create({
  edge: {
    boxShadow: size.borderStrong,
    outline: {
      default: "none",
      [FORCED]: `${size.hairline} solid CanvasText`,
    },
    outlineOffset: `calc(-1 * ${size.hairline})`,
  },
});

/** A tile's edge: the system's strong edge, and in forced colours, where shadows drop, a hairline. */
export const tileEdge = tileStyles.edge;

// ---- A choice in a Field's row ------------------------------------------------------------------
//
// Checkbox's box and RadioGroupItem's circle look and answer alike, so the two stand in one column;
// Switch shares their row. A pointer anywhere on its horizontal Field's row lights and presses the
// control: the row is the nearest Field marked with fieldControlMarker whose orientation is
// horizontal, read through stylex.when.ancestor, which takes its selector written inline.
//
//   <button {...stylex.props(choiceBoxStyles.control, styles.box, focusRingOffset)}>
//     <span {...stylex.props(choiceHitArea)} />
//     <span {...stylex.props(choiceBoxStyles.face, on ? choiceBoxStyles.full : choiceBoxStyles.empty)}>
//       <Indicator {...stylex.props(choiceBoxStyles.mark)} />

const choiceEdge = (color: string) =>
  `inset 0 0 0 ${size.checkboxBorderWidth} ${color}`;
const choiceRing = (color: string) =>
  `0 0 0 ${size.checkboxBorderWidth} ${color}`;

const hitStyles = stylex.create({
  area: {
    display: {
      default: "none",
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal])",
        fieldControlMarker
      )]: "block",
    },
    position: "absolute",
    zIndex: -1,
    inset: 0,
  },
});

/**
 * Inside a checkbox's, a radio's or a switch's button, behind its horizontal Field's words, so a
 * press anywhere on the row lands on the control. Outside such a row it takes no room.
 */
export const choiceHitArea = hitStyles.area;

/** A checkbox's box and a radio's circle: the button, the face inside it, and the mark's motion. */
export const choiceBoxStyles = stylex.create({
  // The button, on the first line of the words. It holds the focus ring; the face inside it draws
  // the box, so a press can scale the box while the ring and the hit area stay. Its size and corner
  // are the control's own.
  control: {
    appearance: "none",
    display: "grid",
    boxSizing: "border-box",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.primaryForeground,
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    cursor: "pointer",
  },
  disabled: {
    opacity: size.opacityDisabled,
    cursor: "not-allowed",
  },
  readOnly: {
    cursor: "default",
  },
  face: {
    display: "grid",
    placeItems: "center",
    boxSizing: "border-box",
    // No border: the edge is a ring drawn inside, which adds no size. In forced colours shadows
    // are dropped, so a real one appears there, doubled when it is wrong.
    borderWidth: {
      default: 0,
      [FORCED]: {
        default: 1,
        [stylex.when.ancestor(":is([data-invalid])", fieldControlMarker)]: 2,
      },
    },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: "inherit",
    cornerShape: "inherit",
    transitionProperty: "transform, background-color, box-shadow",
    // With reduced motion the press still shows, at once, without travelling.
    transitionDuration: `${motionVars.press}, ${duration.hover}, ${duration.hover}`,
    transitionTimingFunction: duration.ease,
  },
  // Empty: no fill, a soft hairline drawn inside: it reads by its shape. Wrong in its Field: the
  // invalid edge.
  empty: {
    backgroundColor: "transparent",
    boxShadow: {
      default: choiceEdge(colors.controlBorder),
      [stylex.when.ancestor(":is([data-invalid])", fieldControlMarker)]:
        choiceEdge(colors.controlBorderInvalid),
    },
  },
  // Under a pointer anywhere on the row, the edge one step stronger and a faint fill; pressed, one
  // step deeper. Never the stronger edge when it is wrong, so the danger stays.
  emptyLive: {
    backgroundColor: {
      default: "transparent",
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):hover",
        fieldControlMarker
      )]: {
        default: null,
        [HOVER]: colors.accent,
      },
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):active",
        fieldControlMarker
      )]: colors.accentActive,
    },
    boxShadow: {
      default: choiceEdge(colors.controlBorder),
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):hover",
        fieldControlMarker
      )]: {
        default: null,
        [HOVER]: choiceEdge(colors.controlBorderHover),
      },
      [stylex.when.ancestor(":is([data-invalid])", fieldControlMarker)]:
        choiceEdge(colors.controlBorderInvalid),
    },
  },
  // Wrong by its own `aria-invalid`.
  emptyInvalid: {
    boxShadow: choiceEdge(colors.controlBorderInvalid),
  },
  // Checked or chosen: the action's fill, with the mark in its words' colour; a danger line round
  // it when it is wrong. Never the success green: that is for approving.
  full: {
    backgroundColor: colors.primary,
    boxShadow: {
      default: choiceRing("transparent"),
      [stylex.when.ancestor(":is([data-invalid])", fieldControlMarker)]:
        choiceRing(colors.controlBorderInvalid),
    },
  },
  fullLive: {
    backgroundColor: {
      default: colors.primary,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):hover",
        fieldControlMarker
      )]: {
        default: null,
        [HOVER]: colors.checkboxBgHover,
      },
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):active",
        fieldControlMarker
      )]: colors.primaryActive,
    },
  },
  fullInvalid: {
    boxShadow: choiceRing(colors.controlBorderInvalid),
  },
  // A press anywhere on the row presses the box.
  pressable: {
    transform: {
      default: null,
      [stylex.when.ancestor(
        ":is([data-orientation=horizontal]):active",
        fieldControlMarker
      )]: `scale(${size.buttonPressScale})`,
    },
  },
  // The tick, the dash or the dot. It grows in and fades in; it leaves faster than it came.
  mark: {
    opacity: {
      default: 1,
      ":is([data-starting-style], [data-ending-style])": 0,
    },
    transform: {
      default: "none",
      ":is([data-starting-style], [data-ending-style])": {
        default: `scale(${size.checkboxMarkFrom})`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: motionVars.mark,
      ":is([data-ending-style])": motionVars.hover,
    },
    transitionTimingFunction: duration.ease,
  },
});
