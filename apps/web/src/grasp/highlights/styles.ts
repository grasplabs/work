// The look of highlights, shared by the card and the grid. After Palermo's: 24px in, the title
// small and quiet over the value, the change beside the value in its tone. Every value is a token.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const FORCED = media.forced;

export const highlightStyles = stylex.create({
  // One highlight: the raised ground, the title over the value.
  card: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    alignContent: "start",
    rowGap: grasp.space2,
    minWidth: 0,
    boxSizing: "border-box",
    margin: 0,
    padding: grasp.space6,
    backgroundColor: grasp.raised,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
  },
  // A small chart under the figures (ChartSpark at its tile size), clear of them.
  chart: { marginBlockStart: grasp.space3, minWidth: 0 },
  // Drawn alone, as Palermo's: a flat cell on the raised ground, no corner and no edge, with one
  // hairline rule beneath it. Its own padding keeps clear space above the rule; whatever follows
  // keeps its own gap below it.
  alone: {
    borderBottomWidth: grasp.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: { default: grasp.line, [FORCED]: "CanvasText" },
  },
  // Bare, inside a card: the card's own room and ground serve, so none of its own.
  bare: { padding: 0, backgroundColor: "transparent" },
  // The title row: the name, and an icon at the end, on the title's first line however many lines
  // it wraps to, so the icons of a row of highlights line up.
  head: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: grasp.space3,
    minWidth: 0,
  },
  title: {
    margin: 0,
    minWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
    overflowWrap: "anywhere",
  },
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    marginBlockStart: `calc((${grasp.textSmLine} - ${grasp.iconSm}) / 2)`,
    color: grasp.muted,
  },
  // The value and its change, on one line when there is room.
  figures: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: grasp.space2,
    rowGap: 0,
    margin: 0,
    minWidth: 0,
  },
  value: {
    fontSize: grasp.textLg,
    lineHeight: grasp.textMdLine,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
    color: grasp.ink,
    overflowWrap: "anywhere",
  },
  change: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  neutral: { color: grasp.muted },
  success: { color: grasp.success },
  danger: { color: grasp.danger },
  attention: { color: grasp.attention },
  info: { color: grasp.info },
  // Loading: the value's and the change's room, held by skeletons so nothing moves.
  skeletonValue: { width: "60%", height: grasp.textMdLine },
  skeletonChange: { width: "35%" },

  // The grid: one box with the edge, its cells parted by hairlines: a hairline's gap between the
  // cells shows the box's ground, the line laid over the raised fill, one colour everywhere, so
  // where the lines cross there is no darker knot and no jog (a translucent line drawn round each
  // cell overlapped there). The last highlight takes what is left of its row (see grid.tsx), so no
  // place stands empty.
  grid: {
    display: "grid",
    gap: grasp.hairline,
    backgroundImage: {
      default: `linear-gradient(${grasp.line}, ${grasp.line})`,
      [FORCED]: "none",
    },
    boxSizing: "border-box",
    margin: 0,
    padding: 0,
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    // Medium lift, as Palermo's grid of highlights.
    boxShadow: grasp.liftMedium,
    outline: {
      default: "none",
      [FORCED]: `${grasp.hairline} solid CanvasText`,
    },
    listStyle: "none",
  },
  // The last highlight takes what is left of its row, at the wide count and at the two columns
  // under 768px: one style for each pair, as a later style would replace an earlier one's.
  wide2: { gridColumn: "span 2" },
  wide3: { gridColumn: { default: "span 3", [media.belowTablet]: null } },
  wide3narrow2: {
    gridColumn: { default: "span 3", [media.belowTablet]: "span 2" },
  },
  wide4: { gridColumn: { default: "span 4", [media.belowTablet]: null } },
  wide4narrow2: {
    gridColumn: { default: "span 4", [media.belowTablet]: "span 2" },
  },
  narrow2: { gridColumn: { default: null, [media.belowTablet]: "span 2" } },
  cols1: { gridTemplateColumns: "minmax(0, 1fr)" },
  // Under 768px, at most two in a row: a figure needs its width more than a row needs its length.
  cols2: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
  cols3: {
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      [media.belowTablet]: "repeat(2, minmax(0, 1fr))",
    },
  },
  cols4: {
    gridTemplateColumns: {
      default: "repeat(4, minmax(0, 1fr))",
      [media.belowTablet]: "repeat(2, minmax(0, 1fr))",
    },
  },
  cell: {
    display: "grid",
    margin: 0,
    padding: 0,
    backgroundColor: grasp.raised,
    outline: {
      default: "none",
      [FORCED]: `${grasp.hairline} solid CanvasText`,
    },
  },
});
