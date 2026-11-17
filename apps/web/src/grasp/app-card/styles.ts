// App card's look: the frame on its grainy ground, the app window cropped by the frame's foot, and
// the words under it. Every value is a token (src/tokens); every move is simply.* (0s with reduced
// motion).
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { cardMarker } from "./app-card.stylex";

// The ring is the system's one ring (src/focus/focus.ts), drawn on the frame: the picture of what
// the link opens, not the title's words. No selector on the frame can see the link's focus but one
// through the card, so it is written here, with the card's marker (stylex.when.ancestor is
// written inline: the compiler cannot read a constant).
const ring = `${grasp.ringWidth} solid ${grasp.ring}`;
const forcedRing = `calc(2 * ${grasp.ringWidth}) solid Highlight`;

export const styles = stylex.create({
  card: {
    position: "relative",
    display: "grid",
    gridTemplateRows: "auto auto",
    // Stretched to its row's height beside a card with a longer description, it keeps its frame
    // and title at the top, so titles line up across a row.
    alignContent: "start",
    gap: grasp.space4,
    minWidth: 0,
    fontFamily: grasp.fontSans,
    color: grasp.text,
  },
  // The frame: the picture, a squircle on its ground. Its own room is the inset's measure (cqi).
  frame: {
    position: "relative",
    containerType: "inline-size",
    isolation: "isolate",
    overflow: "clip",
    aspectRatio: grasp.appCardRatio,
    borderRadius: grasp.appCardCorner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    // Under the pointer on the card (its link reaches over it) the frame rises and its shadow
    // grows; pressed, it settles back, as if pushed. The "…" is not the link: over it, nothing moves.
    boxShadow: {
      default: grasp.appCardFrameEdge,
      [stylex.when.ancestor(":has([data-card-link]:hover)", cardMarker)]: {
        default: grasp.appCardFrameEdge,
        [media.hover]: grasp.appCardFrameLift,
      },
    },
    transform: {
      default: "none",
      [stylex.when.ancestor(":has([data-card-link]:hover)", cardMarker)]: {
        default: "none",
        [media.hover]: `translateY(${grasp.appCardRise})`,
        [media.reduced]: "none",
      },
      [stylex.when.ancestor(":has([data-card-link]:active)", cardMarker)]:
        "none",
    },
    transitionProperty: "transform, box-shadow",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
    outline: {
      default: "none",
      [stylex.when.ancestor(
        ":has([data-card-link]:focus-visible)",
        cardMarker
      )]: { default: ring, [media.forced]: forcedRing },
    },
    outlineOffset: grasp.ringOffset,
  },
  sea: { backgroundImage: `${grasp.appCardGlow}, ${grasp.appCardSea}` },
  sand: { backgroundImage: `${grasp.appCardGlow}, ${grasp.appCardSand}` },
  moss: { backgroundImage: `${grasp.appCardGlow}, ${grasp.appCardMoss}` },
  dusk: { backgroundImage: `${grasp.appCardGlow}, ${grasp.appCardDusk}` },
  // The paper grain over the ground, under the window.
  grain: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    backgroundImage: grasp.appCardGrain,
    backgroundSize: "180px 180px",
    mixBlendMode: "overlay",
    opacity: grasp.appCardGrainStrength,
    pointerEvents: "none",
  },
  // The window: inset from the top and sides, running on past the frame's foot, which crops it.
  window: {
    position: "absolute",
    insetBlockStart: grasp.appCardInset,
    insetInline: grasp.appCardInset,
    insetBlockEnd: `calc(-1 * ${grasp.appCardWindowCorner})`,
    overflow: "hidden",
    borderRadius: grasp.appCardWindowCorner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.paper,
    boxShadow: grasp.appCardWindowLift,
  },
  // The app as it lays out on a desktop, scaled down to the window's width (--app-card-scale and
  // --app-card-width, measured and snapped so it stays sharp: parts.tsx), as tall again as the
  // scale took off, so it fills the window to its foot. Before the window is measured (the card
  // drawn by the server, or a stage whose script has not come alive) the app lays out at the
  // token's width, the window's own at the first scale, so it never runs past the window.
  canvas: {
    position: "absolute",
    insetBlockStart: 0,
    insetInlineStart: 0,
    width: `var(--app-card-width, ${grasp.appCardAppWidth})`,
    height: "calc(100% / var(--app-card-scale, 0.4))",
    transform:
      "translate(var(--app-card-shift-x, 0px), var(--app-card-shift-y, 0px)) scale(var(--app-card-scale, 0.4))",
    transformOrigin: { default: "top left", ":dir(rtl)": "top right" },
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: simply.swap,
    transitionTimingFunction: grasp.ease,
    pointerEvents: "none",
    userSelect: "none",
  },
  measured: { opacity: 1 },
  fit: (scale: number, width: number, shiftX: number, shiftY: number) => ({
    "--app-card-scale": scale,
    "--app-card-width": `${width}px`,
    "--app-card-shift-x": `${shiftX}px`,
    "--app-card-shift-y": `${shiftY}px`,
  }),
  iframe: {
    display: "block",
    width: "100%",
    height: "100%",
    borderWidth: 0,
    backgroundColor: grasp.paper,
  },
  // The screenshot: as wide as the window, from its top, run on past the frame's foot. Inert, as the
  // frame is: the card's link is its one press.
  shot: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    userSelect: "none",
  },
  image: {
    position: "absolute",
    insetBlockStart: 0,
    insetInlineStart: 0,
    display: "block",
    width: "100%",
    maxWidth: "none",
    height: "auto",
  },
  // With a narrow screenshot beside it, each width's shots are hidden where the frame (a container)
  // is the other's: under 25.5rem a live app here would lay out under 720px on a 2x screen (twice
  // a window of 0.88 of the frame), where an app turns to its narrow layout. A hidden lazy image is
  // never loaded.
  onWide: {
    display: { default: "block", "@container (width < 25.5rem)": "none" },
  },
  onNarrow: {
    display: { default: "none", "@container (width < 25.5rem)": "block" },
  },
  // A picture given as children fills the app's room.
  picture: {
    width: "100%",
    height: "100%",
    overflow: "hidden",
  },
  // No app to show: the window holds a quiet line in its middle.
  quiet: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingBlockEnd: grasp.appCardWindowCorner,
    boxSizing: "border-box",
    height: "100%",
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  // Under the frame: the title row, the description, the owner and meta.
  words: {
    display: "grid",
    gap: grasp.space1,
    minWidth: 0,
    paddingInline: grasp.space1,
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    minHeight: grasp.controlSm,
  },
  heading: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    fontSize: grasp.titleUi,
    lineHeight: grasp.titleUiLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  // The title is the link; its ::after reaches over the whole card, so the card is one press.
  link: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "inherit",
    // Under the pointer the title underlines: the card is a link, and says which words name it.
    textDecorationLine: {
      default: "none",
      ":hover": { default: "none", [media.hover]: "underline" },
    },
    textDecorationThickness: grasp.linkUnderlineWidth,
    textDecorationColor: grasp.linkUnderline,
    textUnderlineOffset: grasp.linkUnderlineOffset,
    outline: "none",
    "::after": {
      content: "''",
      position: "absolute",
      inset: 0,
      borderRadius: grasp.appCardCorner,
      cornerShape: grasp.cornerShape,
    },
  },
  // The more button stands over the link's reach, so it stays its own press.
  // With a pointer it rests a step quieter and comes up whole when the card is under the pointer,
  // holds focus, or has its menu open: it reads as the card's own. On touch it is always whole.
  more: {
    position: "relative",
    zIndex: 1,
    flexShrink: 0,
    marginInlineEnd: `calc(-1 * ${grasp.space1})`,
    opacity: {
      default: 1,
      [media.hover]: {
        default: 0.6,
        [stylex.when.ancestor(":hover", cardMarker)]: 1,
        ":focus-within": 1,
        ":has([aria-expanded=true])": 1,
      },
    },
    transitionProperty: "opacity",
    // simply.hover: 0s with reduced motion, so the "…" comes up at once (the sweep's motion pass).
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  // Where the grid stands cards side by side, two lines are kept for it on every card, one line or
  // none, so the title, the description and the owner's line stand level across a row. In one
  // column, or a card on its own, nothing stands beside it: it keeps only the lines it has.
  description: {
    minHeight: {
      default: 0,
      "@container (width >= 40rem)": `calc(2 * ${grasp.textSmLine})`,
    },
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    overflowWrap: "anywhere",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    marginBlockStart: grasp.space1,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  metaWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  owner: {
    color: grasp.text,
  },
  // The grid: one card a row on a narrow room, two from 40rem, three from 96rem. The room, not the
  // window: on the Apps page a sidebar takes part of the width.
  room: {
    containerType: "inline-size",
    width: "100%",
    minWidth: 0,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@container (width >= 40rem)": "repeat(2, minmax(0, 1fr))",
      "@container (width >= 96rem)": "repeat(3, minmax(0, 1fr))",
    },
    columnGap: grasp.space6,
    rowGap: grasp.space8,
  },
});
