// The look of a thread. Every value is a token (src/tokens).
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { threadVars } from "./thread.stylex";

const REDUCED = media.reduced;

// The fade at an edge with more rows past it: space-16 tall, clear for only the last space-1, so a
// row cut there dissolves over most of a message's height, not in a thin band before the edge
// (eyes-b, B3-thread-01 to -03: at space-10 with a space-2 clear band a cut row read as a hard
// sliver at the foot, and as an empty band at the top).
const fadeTop = `transparent ${grasp.space1}, black ${grasp.space16}`;
const fadeBottom = `black calc(100% - ${grasp.space16}), transparent calc(100% - ${grasp.space1})`;

// A message arriving: it fades in, a little lower first; with reduced motion, a fade only. Nothing
// else on screen moves.
const arrive = stylex.keyframes({
  from: { opacity: 0, transform: `translateY(${grasp.space2})` },
  to: { opacity: 1, transform: "none" },
});
const fade = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

export const threadStyles = stylex.create({
  root: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "grid",
    // The rows, and under them, while the reader is away from the end, "Jump to latest" in a row of
    // its own: the pill never lies over a message, and the view's foot rises to make room for it.
    gridTemplateRows: "minmax(0, 1fr) auto",
    height: "100%",
    minHeight: 0,
    fontFamily: grasp.fontSans,
    // The keyboard's ring is drawn here, round the scroller, while the scroller has the focus:
    // with the corners of the box the thread stands in (the scroller itself is square, and a
    // ring on it broke at a rounded box's corners), and over the rows, which are placed parts
    // and would lie over a ring of the scroller's own. Its own layer, so the ring is drawn last.
    isolation: "isolate",
    borderRadius: "inherit",
    cornerShape: "inherit",
    outlineWidth: grasp.ringWidth,
    outlineColor: grasp.ring,
    outlineStyle: { default: "none", ":has(> :focus-visible)": "solid" },
    outlineOffset: `calc(-1 * ${grasp.ringWidth})`,
  },
  // The scroller: it holds the rows, and the keys can scroll it. An edge with rows past it fades
  // out (markEdges in thread.tsx marks it), so a row is never cut hard at the edge: the top with
  // rows above, the foot with rows below. "Jump to latest" stands in its own row under the
  // scroller, out of the fade. No transition: the fade is there or not as the scroll moves. Forced
  // colours keep it, as the others do: a mask only fades what it covers, the words stay whole.
  scroller: {
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "auto",
    borderRadius: "inherit",
    // Where a row scrolled to stands: below the top's fade, whole (the Unread line it opens at,
    // a row the keyboard's focus brings into view).
    scrollPaddingTop: grasp.space16,
    maskImage: {
      default: null,
      ":is([data-under-start]:not([data-under-end]))": `linear-gradient(to bottom, ${fadeTop}, black)`,
      ":is([data-under-end]:not([data-under-start]))": `linear-gradient(to bottom, ${fadeBottom})`,
      ":is([data-under-start][data-under-end])": `linear-gradient(to bottom, ${fadeTop}, ${fadeBottom})`,
    },
  },
  // While an old chat loads: nothing to scroll to, the shapes stand at the foot, cut at the top.
  still: {
    overflowY: "hidden",
  },
  // The rows' box, as tall as all of them; each row brings its own room.
  // Down by the lead while a wheel is under way (thread.stylex.ts); at rest it stands at the top.
  box: {
    position: "relative",
    top: threadVars.lead,
    width: "100%",
  },
  // Before it is alive a thread that opens at its end already stands there: a column that runs
  // upward starts its scroll at the end, with no script. The rows inside keep their order, and a
  // thread shorter than its view still starts at the top.
  opening: {
    display: "flex",
    flexDirection: "column-reverse",
  },
  openingFlow: {
    flexShrink: 0,
    marginBlockEnd: "auto",
  },
  // Opened at the Unread line, it stands where it will once alive: down by the scroll padding,
  // below the top's fade.
  openingUnread: {
    paddingBlockStart: grasp.space16,
  },
  openingEnd: {
    paddingBlockStart: 0,
  },
  // Before the virtualiser has measured anything (on the server, and with JavaScript off), the
  // rows stand in their natural flow.
  // No room of its own above or below: the rows' box has none once alive, and they must agree.
  flow: {
    display: "grid",
  },
  row: {
    boxSizing: "border-box",
    width: "100%",
    paddingInline: grasp.space4,
    paddingBlock: grasp.space2,
  },
  placed: {
    position: "absolute",
    insetInline: 0,
    top: 0,
  },
  arriving: {
    // With reduced motion a new row is simply there.
    animationName: { default: arrive, [REDUCED]: "none" },
    animationDuration: grasp.durationUi,
    animationTimingFunction: grasp.ease,
    animationFillMode: "backwards",
  },
  // A date line, and the unread line: a word in the middle of a hairline, clear of it on each side.
  divider: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
    "::before": {
      content: '""',
      flexGrow: 1,
      height: grasp.hairline,
      backgroundColor: grasp.line,
    },
    "::after": {
      content: '""',
      flexGrow: 1,
      height: grasp.hairline,
      backgroundColor: grasp.line,
    },
  },
  unread: {
    color: grasp.danger,
    "::before": {
      content: '""',
      flexGrow: 1,
      height: grasp.hairline,
      backgroundColor: grasp.dangerEdge,
    },
    "::after": {
      content: '""',
      flexGrow: 1,
      height: grasp.hairline,
      backgroundColor: grasp.dangerEdge,
    },
  },
  // At the top while older messages load: a small raised pill over the rows, so nothing under it
  // moves.
  older: {
    position: "absolute",
    top: grasp.space2,
    insetInlineStart: "50%",
    zIndex: 1,
    // Back by half its width toward the start, whichever side that is.
    transform: { default: "translateX(-50%)", ":dir(rtl)": "translateX(50%)" },
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    boxSizing: "border-box",
    minHeight: grasp.controlSm,
    margin: 0,
    paddingInline: grasp.space3,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
  // "Jump to latest", in its own row under the rows, while the reader is away from the end.
  jump: {
    display: "flex",
    justifyContent: "center",
    paddingBlock: grasp.space2,
    pointerEvents: "none",
    animationName: { default: fade, [REDUCED]: "none" },
    animationDuration: grasp.durationUi,
    animationTimingFunction: grasp.ease,
  },
  // Its own raised ground under the quiet button, with the edge shadow, so the rows it lies over
  // never show through it. The button's corner, so the two read as one pill.
  jumpButton: {
    display: "inline-flex",
    pointerEvents: "auto",
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
  },
});

// The virtualiser's measures, in pixels: the rows' box's height and each row's place in it.
export const threadPlaces = stylex.create({
  height: (height: string) => ({ height }),
  at: (start: string) => ({ transform: `translateY(${start})` }),
  // Room kept under a sent message: the box is at least as tall as puts that message (or the day
  // line straight above it) at the top of the view, below the top's fade (the scroller's scroll
  // padding, space-16), so it reads whole and the answer under it grows into space.
  room: (start: string) => ({
    minHeight: `calc(${start} + 100% - ${grasp.space16})`,
  }),
  // The lead, set straight on the box as it changes (thread.stylex.ts).
  lead: (lead: string) => ({ [threadVars.lead]: lead }),
});
