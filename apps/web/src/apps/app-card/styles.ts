// App card's look: the frame on its drawn ground, the app window cropped by the frame's foot, and
// the words under it. Every value is one of Damsko's tokens or the card's own (app-card.stylex.ts);
// every move is a motionVars time (0s with reduced motion).
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { motionVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";

import { appCard, cardMarker } from "./app-card.stylex.ts";

// The ring is Damsko's one ring, drawn on the frame: the picture of what the link opens, not the
// title's words. No selector on the frame can see the link's focus but one through the card, so it
// is written here, with the card's marker.
const ring = `${size.ringWidth} solid ${colors.ring}`;
const forcedRing = `calc(2 * ${size.ringWidth}) solid Highlight`;

export const styles = stylex.create({
  card: {
    position: "relative",
    display: "grid",
    gridTemplateRows: "auto auto",
    // Stretched to its row's height beside a card with a longer description, it keeps its frame
    // and title at the top, so titles line up across a row.
    alignContent: "start",
    gap: space[4],
    minWidth: 0,
    fontFamily: font.sans,
    color: colors.bodyForeground,
  },
  // The frame: the picture, a squircle on its ground. Its own room is the inset's measure (cqi).
  frame: {
    position: "relative",
    containerType: "inline-size",
    isolation: "isolate",
    overflow: "clip",
    aspectRatio: appCard.ratio,
    maxHeight: appCard.frameMax,
    // The card's width whatever the height: without it the ratio takes the width from the capped height.
    width: "100%",
    borderRadius: appCard.corner,
    cornerShape: radius.shape,
    backgroundColor: colors.muted,
    // Under the pointer on the card (its link reaches over it) the frame rises and its shadow
    // grows; pressed, it settles back. The "…" is not the link: over it, nothing moves.
    boxShadow: {
      default: appCard.frameEdge,
      [stylex.when.ancestor(":has([data-card-link]:hover)", cardMarker)]: {
        default: appCard.frameEdge,
        [media.hover]: appCard.frameLift,
      },
    },
    transform: {
      default: "none",
      [stylex.when.ancestor(":has([data-card-link]:hover)", cardMarker)]: {
        default: "none",
        [media.hover]: `translateY(${appCard.rise})`,
        [media.reducedMotion]: "none",
      },
      [stylex.when.ancestor(":has([data-card-link]:active)", cardMarker)]:
        "none",
    },
    transitionProperty: "transform, box-shadow",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
    outline: {
      default: "none",
      [stylex.when.ancestor(
        ":has([data-card-link]:focus-visible)",
        cardMarker
      )]: { default: ring, [media.forcedColors]: forcedRing },
    },
    outlineOffset: size.ringOffset,
  },
  // The window: inset from the top and sides, running on past the frame's foot, which crops it.
  window: {
    position: "absolute",
    insetBlockStart: appCard.inset,
    insetInline: appCard.inset,
    insetBlockEnd: `calc(-1 * ${appCard.windowCorner})`,
    overflow: "hidden",
    borderRadius: appCard.windowCorner,
    cornerShape: radius.shape,
    backgroundColor: colors.background,
    boxShadow: appCard.windowLift,
  },
  // No picture of the App yet: the window holds its mark and a quiet line in its middle, above
  // the frame's foot.
  quiet: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space[3],
    paddingBlockEnd: appCard.windowCorner,
    boxSizing: "border-box",
    height: "100%",
  },
  quietMark: {
    display: "flex",
  },
  quietWords: {
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  // Under the frame: the title row, the description and the meta.
  words: {
    display: "grid",
    gap: space[1],
    minWidth: 0,
    paddingInline: space[1],
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
    minWidth: 0,
    minHeight: size.controlSm,
  },
  // The App's mark before its title.
  mark: {
    display: "flex",
    flexShrink: 0,
  },
  heading: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    fontSize: font.headingXs,
    lineHeight: font.headingXsLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
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
    textDecorationThickness: size.linkUnderlineWidth,
    textDecorationColor: colors.linkUnderline,
    textUnderlineOffset: size.linkUnderlineOffset,
    outline: "none",
    "::after": {
      content: "''",
      position: "absolute",
      inset: 0,
      borderRadius: appCard.corner,
      cornerShape: radius.shape,
    },
  },
  // The more button stands over the link's reach, so it stays its own press. With a pointer it
  // rests a step quieter and comes up whole when the card is under the pointer, holds focus, or has
  // its menu open. On touch it is always whole.
  more: {
    position: "relative",
    zIndex: 1,
    flexShrink: 0,
    marginInlineEnd: `calc(-1 * ${space[1]})`,
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
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  // Where the grid stands cards side by side, two lines are kept for it on every card, so the
  // title, the description and the meta stand level across a row. In one column it keeps only the
  // lines it has.
  description: {
    minHeight: `calc(var(--app-card-side, 0) * 2 * ${font.textSmLine})`,
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
    minWidth: 0,
    margin: 0,
    marginBlockStart: space[1],
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  metaWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The grid: one card a row on a narrow room, then two, three and four. The room, not the window:
  // the sidebar takes part of the width. Where cards stand side by side it sets --app-card-side,
  // which keeps two lines for every description.
  room: {
    containerType: "inline-size",
    width: "100%",
    minWidth: 0,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@container (width >= 28rem)": "repeat(2, minmax(0, 1fr))",
      "@container (width >= 44rem)": "repeat(3, minmax(0, 1fr))",
      "@container (width >= 64rem)": "repeat(4, minmax(0, 1fr))",
    },
    "--app-card-side": { default: "0", "@container (width >= 28rem)": "1" },
    columnGap: space[5],
    rowGap: space[6],
  },
  // The grid with no Apps: its empty state across every column.
  empty: {
    gridColumn: "1 / -1",
  },
});
