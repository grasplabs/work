// The Data grid's look: the Table's type, room and hairlines, a step denser, drawn as a sheet.
// One line only between any two cells: each cell draws the hairline at its end and below it, the
// last column and last row keep theirs clear, and the frame's soft edge closes the grid. A chosen
// range's edge is those same hairlines in another colour, never a second line beside them.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

export const styles = stylex.create({
  // ---- The frame: whole on all four sides, the grid scrolling inside it ---------------------------
  frame: {
    position: "relative",
    isolation: "isolate",
    width: "100%",
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
    outline: { default: "none", [media.forced]: `${grasp.hairline} solid` },
  },
  // It scrolls without a bar (the product shows none); the fades say there is more.
  scroller: {
    overflowX: "auto",
    overscrollBehaviorX: "contain",
  },
  // A cell brought into view stops clear of the row numbers, which stay put over the grid's start.
  scrollerNumbered: { scrollPaddingInlineStart: grasp.gridNumberWidth },
  grid: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "grid",
    minWidth: "min-content",
    margin: 0,
    borderSpacing: 0,
    color: grasp.text,
    fontFamily: grasp.fontSans,
    fontSize: grasp.tableText,
    lineHeight: grasp.tableTextLine,
    fontVariantNumeric: "tabular-nums",
    textAlign: "start",
    userSelect: "none",
    WebkitUserSelect: "none",
    outline: "none",
  },
  // A column is never narrower than its header or its widest cell, until it is given a width.
  columns: (template: string) => ({ gridTemplateColumns: template }),
  group: { display: "contents" },
  row: {
    display: "grid",
    gridColumn: "1 / -1",
    gridTemplateColumns: "subgrid",
  },
  // ---- The header --------------------------------------------------------------------------------
  headRow: { position: "relative", zIndex: 3 },
  headRowQuiet: { backgroundColor: grasp.soft },
  // As a header with rows scrolled under it: the low lift in place of the hairline.
  headRowLifted: { backgroundColor: grasp.raised, boxShadow: grasp.liftLow },
  headRowChip: { backgroundColor: grasp.raised },
  head: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    height: grasp.gridHeadHeight,
    padding: 0,
    boxSizing: "border-box",
    whiteSpace: "nowrap",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
    borderWidth: 0,
    borderBlockEndWidth: grasp.hairline,
    borderInlineEndWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.line,
  },
  headLifted: { borderBlockEndColor: "transparent" },
  // A head's name and its kind's icon: plain, or a button that sorts.
  name: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    flexGrow: 1,
    minWidth: 0,
    height: "100%",
    boxSizing: "border-box",
    paddingInline: grasp.tableCellInline,
    color: "inherit",
    font: "inherit",
  },
  sorts: {
    appearance: "none",
    margin: 0,
    borderWidth: 0,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
    },
    color: {
      default: "inherit",
      ":hover": { default: null, [media.hover]: grasp.ink },
    },
    cursor: "pointer",
    textAlign: "start",
    transitionProperty: "background-color, color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  // On a touch screen the button takes a finger's 44px, as Button does: a press area a little
  // taller than the head it is drawn in, which keeps its height.
  // A head's ring stands a little further in than the shared inside ring, so its lower side never
  // lies on the active cell's edge just below it (two lines, one on the other).
  sortsRing: {
    outlineOffset: {
      default: null,
      ":focus-visible": `calc(-1 * ${grasp.ringWidth} - ${grasp.space1})`,
    },
  },
  sortsReach: {
    position: "relative",
    "::after": {
      content: { default: null, [media.coarse]: '""' },
      position: "absolute",
      insetInline: 0,
      insetBlock: `calc((${grasp.gridHeadHeight} - ${grasp.hairline} - ${grasp.tap}) / 2)`,
    },
  },
  sorted: { color: grasp.ink },
  nameEnd: { justifyContent: "flex-end" },
  nameCentre: { justifyContent: "center", paddingInline: grasp.space2 },
  words: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
  kindQuiet: { display: "flex", flexShrink: 0 },
  kindLifted: { display: "flex", flexShrink: 0, color: grasp.gridActiveEdge },
  kindChip: {
    display: "grid",
    flexShrink: 0,
    placeItems: "center",
    width: grasp.kbdHeight,
    height: grasp.kbdHeight,
    borderRadius: grasp.cornerMark,
    backgroundColor: grasp.gridRangeWash,
    color: grasp.gridActiveEdge,
  },
  // The sort's arrow, in the kind icon's place while the column is sorted: in ink, as its name is.
  sortMark: { color: grasp.ink },
  // The resize handle: a range input in a reach inside the head's end, so the keys and a screen
  // reader know it. Its line shows under a pointer and while held.
  handle: {
    display: { default: null, [media.coarse]: "none" },
    appearance: "none",
    position: "absolute",
    insetBlock: 0,
    // The last column's handle stands a step in from the grid's rounded corner, so its ring is
    // whole (the corner clipped it).
    insetInlineEnd: { default: 0, ":is(th:last-child *)": grasp.space1 },
    zIndex: 1,
    boxSizing: "border-box",
    width: grasp.space2,
    height: "100%",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderInlineEndWidth: grasp.ringWidth,
    borderStyle: "solid",
    borderColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.gridActiveEdge },
      ":active": grasp.gridActiveEdge,
    },
    backgroundColor: "transparent",
    cursor: "col-resize",
    touchAction: "none",
    "::-webkit-slider-thumb": { appearance: "none", width: 0, height: 0 },
    "::-moz-range-thumb": {
      appearance: "none",
      width: 0,
      height: 0,
      borderWidth: 0,
    },
  },
  // ---- Cells -------------------------------------------------------------------------------------
  cell: {
    position: "relative",
    // Scrolled into view, a cell stops clear of the fade at the edge (and of the row numbers at the
    // start), so the active cell's edge is never painted over.
    scrollMarginInlineStart: `calc(${grasp.gridNumberWidth} + ${grasp.space6})`,
    scrollMarginInlineEnd: grasp.space6,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    boxSizing: "border-box",
    minWidth: 0,
    height: grasp.gridRowHeight,
    paddingBlock: 0,
    paddingInline: grasp.tableCellInline,
    whiteSpace: "nowrap",
    fontWeight: "inherit",
    outline: "none",
    cursor: "cell",
    borderWidth: 0,
    borderBlockEndWidth: grasp.hairline,
    borderInlineEndWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.line,
  },
  // One line only: the last column and the last row leave the edge to the frame. The line keeps
  // its room, so a range's edge can still be drawn there and nothing moves.
  lastCol: { borderInlineEndColor: "transparent" },
  lastRow: { borderBlockEndColor: "transparent" },
  text: { overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
  // In the dither look the dots never run through the words: the words stand on a pad of the
  // range's own ground (the wash over the sheet), a little wider than them, and the dots go round.
  textClear: {
    marginInline: `calc(-1 * ${grasp.space1})`,
    paddingInline: grasp.space1,
    borderRadius: grasp.cornerMark,
    backgroundColor: grasp.raised,
    backgroundImage: `linear-gradient(${grasp.gridRangeWash}, ${grasp.gridRangeWash})`,
  },
  // Kept in the cell while its editor is open, unseen, so the column keeps its width.
  unseenText: { visibility: "hidden" },
  // The row numbers stay put while the grid scrolls sideways.
  number: {
    position: "sticky",
    insetInlineStart: 0,
    zIndex: 2,
    justifyContent: "center",
    paddingInline: grasp.space2,
    color: grasp.muted,
    backgroundColor: grasp.soft,
    cursor: "default",
  },
  numberHead: {
    position: "sticky",
    insetInlineStart: 0,
    zIndex: 2,
    backgroundColor: "inherit",
  },
  end: { justifyContent: "flex-end" },
  centre: { justifyContent: "center", paddingInline: grasp.space2 },
  ink: { color: grasp.ink },
  readOnly: { cursor: "default" },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    height: grasp.tagHeightSm,
    paddingInline: grasp.space2,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.quietFill,
    boxShadow: grasp.edge,
    color: grasp.ink,
    // The table's own type, so its words sit on the row's line with their neighbours'.
    fontSize: grasp.tableText,
    lineHeight: grasp.tableTextLine,
  },
  // In a range drawn in dither, a chip stands on the raised ground under its own fill, as the
  // words' pad does: its fill alone is see-through, and in dark the dots showed behind its words.
  chipClear: {
    backgroundColor: grasp.raised,
    backgroundImage: `linear-gradient(${grasp.quietFill}, ${grasp.quietFill})`,
  },
  // The Checkbox's own box (src/choice), at its own size, on the row's centre. The cell is the
  // control: a press anywhere on it, or Space, ticks it.
  box: {
    [iconVars.size]: grasp.checkboxMark,
    [iconVars.stroke]: grasp.checkboxMarkStroke,
    width: grasp.checkboxBox,
    height: grasp.checkboxBox,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
  },
  boxCell: { cursor: "pointer" },
  // ---- The editor: the cell's own words, typed in place --------------------------------------------
  editor: {
    appearance: "none",
    position: "absolute",
    inset: 0,
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    margin: 0,
    paddingBlock: 0,
    paddingInline: grasp.tableCellInline,
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: grasp.ink,
    font: "inherit",
    fontVariantNumeric: "tabular-nums",
    cursor: "text",
  },
  editorEnd: { textAlign: "end" },
  editing: { backgroundColor: grasp.raised, cursor: "text" },
  wrong: {
    boxShadow: `inset 0 0 0 ${grasp.ringWidth} ${grasp.fieldEdgeInvalid}, 0 0 0 3px ${grasp.ringHaloInvalid}`,
  },
  // ---- A chosen range: the wash, quiet mint lines inside, and its edge on the hairlines --------------
  inRange: {
    backgroundColor: {
      default: grasp.gridRangeWash,
      [media.forced]: "Highlight",
    },
    // The words in ink, as the pills' are: on the wash a cell's own text colour read fainter than
    // the same words outside the range, so choosing them seemed to weaken them.
    color: { default: grasp.ink, [media.forced]: "HighlightText" },
    borderColor: grasp.gridRangeLine,
  },
  inRangeDither: {
    backgroundImage: `radial-gradient(circle, ${grasp.gridRangeDot} 0.75px, transparent 1.25px)`,
    backgroundSize: `${grasp.space1} ${grasp.space1}`,
  },
  // The edge is the hairline itself: the line at a cell's end, or below it, takes the edge's colour.
  edgeEndPine: {
    borderInlineEndColor: {
      default: grasp.gridActiveEdge,
      [media.forced]: "Highlight",
    },
  },
  edgeBelowPine: {
    borderBlockEndColor: {
      default: grasp.gridActiveEdge,
      [media.forced]: "Highlight",
    },
  },
  edgeEndMint: {
    borderInlineEndColor: {
      default: grasp.gridRangeRing,
      [media.forced]: "Highlight",
    },
  },
  edgeBelowMint: {
    borderBlockEndColor: {
      default: grasp.gridRangeRing,
      [media.forced]: "Highlight",
    },
  },
  // The firmer edge: a second hairline just inside the range, on the sides of its outer cells.
  firm: {
    "::after": {
      content: '""',
      position: "absolute",
      // Over the cell's own lines at its end and below, so all four sides meet the edge.
      insetBlockStart: 0,
      insetInlineStart: 0,
      // Over the cell's own lines at its end and below (outside its padding box), so a row's line
      // never notches the edge where it meets it.
      insetBlockEnd: `calc(-1 * ${grasp.hairline})`,
      insetInlineEnd: `calc(-1 * ${grasp.hairline})`,
      zIndex: 1,
      borderWidth: 0,
      borderStyle: "solid",
      borderColor: grasp.gridRangeRing,
      pointerEvents: "none",
    },
  },
  firmTop: { "::after": { borderBlockStartWidth: grasp.hairline } },
  firmBottom: { "::after": { borderBlockEndWidth: grasp.hairline } },
  firmStart: { "::after": { borderInlineStartWidth: grasp.hairline } },
  firmEnd: { "::after": { borderInlineEndWidth: grasp.hairline } },
  // ---- The active cell, three ways ---------------------------------------------------------------
  activeBase: {
    zIndex: 1,
    outline: {
      default: "none",
      [media.forced]: `${grasp.ringWidth} solid Highlight`,
    },
    outlineOffset: `calc(-1 * ${grasp.ringWidth})`,
  },
  // Our soft focus, and plain to see in light and dark: the hairlines round the cell turn pine
  // (lines.ts) with a second hairline just inside them, 2px in all, and a mint shadow fades out
  // round it.
  // At rest the pine edge alone; when focus comes into the grid the halo comes up round it, so
  // entering the grid is seen (it wore the halo at rest, and nothing changed).
  activeHalo: {
    boxShadow: {
      default: `inset 0 0 0 ${grasp.hairline} ${grasp.gridActiveEdge}`,
      ":focus": `inset 0 0 0 ${grasp.hairline} ${grasp.gridActiveEdge}, 0 0 10px 1px ${grasp.gridActiveHalo}, 0 2px 6px ${grasp.gridActiveHalo}`,
    },
  },
  // The cell lifts off the sheet: a pine edge, 2px in all, and the medium lift.
  // One ring 2px wide, drawn as an outline over the cell's own lines: two hairlines (one outside,
  // one inside) parted on the sides where the cell's lines lie, and read as a misdrawn double edge.
  // The low lift under focus only: the medium lift smudged the cells round it.
  activeLifted: {
    borderRadius: grasp.cornerMark,
    borderColor: "transparent",
    outlineStyle: "solid",
    outlineWidth: `calc(2 * ${grasp.hairline})`,
    outlineColor: {
      default: grasp.gridActiveEdge,
      [media.forced]: "Highlight",
    },
    outlineOffset: `calc(-1 * ${grasp.hairline})`,
    boxShadow: { default: "none", ":focus": grasp.liftLow },
  },
  // Alone, the active cell stands on the raised ground. In a range it keeps the range's wash, as
  // every chosen cell does, and its edge marks it.
  activeAlone: { backgroundColor: grasp.raised, backgroundImage: "none" },
  // Calmest: a mint wash and a pine line under the words.
  activeUnderline: {
    backgroundColor: grasp.gridRangeWash,
    // Under the keyboard's ring the cell's own pine line below is let go, so the ring is as heavy at
    // its foot as at its sides (the two made 3px there).
    borderBlockEndColor: { default: null, ":focus-visible": "transparent" },
    // Reached by the keyboard, a line under the words is too little to find: a line all round.
    boxShadow: {
      default: `inset 0 calc(-1 * ${grasp.hairline}) 0 ${grasp.gridActiveEdge}`,
      ":focus-visible": `inset 0 0 0 ${grasp.ringWidth} ${grasp.gridActiveEdge}`,
    },
  },
  // In a range the underline's cell needs more than the wash its neighbours share: a line all round.
  activeUnderlineInRange: {
    boxShadow: `inset 0 0 0 ${grasp.ringWidth} ${grasp.gridActiveEdge}`,
  },
  // ---- What scrolls under the edges ----------------------------------------------------------------
  fade: {
    position: "absolute",
    insetBlock: 0,
    zIndex: 4,
    width: grasp.space6,
    pointerEvents: "none",
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  fadeShown: { opacity: 1 },
  fadeEnd: { insetInlineEnd: 0 },
  fadeStart: { insetInlineStart: 0 },
  fadeStartNumbered: { insetInlineStart: grasp.gridNumberWidth },
  fadeToRight: {
    backgroundImage: `linear-gradient(to right, transparent, ${grasp.raised})`,
  },
  fadeToLeft: {
    backgroundImage: `linear-gradient(to left, transparent, ${grasp.raised})`,
  },
});
