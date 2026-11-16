// The look of a table, shared by its parts (table.tsx and the rest). Plain HTML table elements:
// UI SDK has no table, and a table needs no behaviour of its own.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { tableVars } from "./table.stylex";

// Values only the moment knows: where a held column stands, how wide a sized one is, how tall the
// box may grow. Given as StyleX values, never as an inline style.
export const tablePlace = stylex.create({
  start: (offset: string) => ({ insetInlineStart: offset }),
  end: (offset: string) => ({ insetInlineEnd: offset }),
  width: (width: string) => ({ width }),
  tall: (height: string) => ({ maxBlockSize: height }),
});

export const tableStyles = stylex.create({
  // What holds the box. The box fades at an edge with more beyond it (a mask), and a mask would
  // fade its own focus ring too: so the ring is drawn here (ring, below), over the box.
  frame: {
    position: "relative",
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    borderRadius: tableVars.corner,
  },
  // The ring: a part of its own laid over the box, above the head's fill and a held column, which
  // would hide a ring drawn under them. Shown while the box before it has the keyboard's focus.
  ring: {
    position: "absolute",
    inset: 0,
    zIndex: 5,
    borderRadius: "inherit",
    pointerEvents: "none",
    outlineWidth: grasp.ringWidth,
    outlineColor: grasp.ring,
    outlineStyle: { default: "none", ":is(:focus-visible + *)": "solid" },
    // Off the box, on the page's own ground, as a mark's ring stands off its edge: drawn on the
    // edge, it lay over the head's and the rows' fills and read against them (1.7:1 in light, 1.2:1
    // in dark), not against the page.
    outlineOffset: grasp.ringOffsetMark,
  },
  // The box round the table. A table wider than its column scrolls sideways inside it, never the
  // page. When it scrolls it takes focus (table.tsx), so the keys can scroll it too.
  scroller: {
    position: "relative",
    // A container of its own size, so a row that speaks for the whole table (nothing found, it
    // failed) can stand as wide as the box shows, not as wide as the table runs.
    containerType: "inline-size",
    width: "100%",
    maxWidth: "100%",
    overflowX: "auto",
    overscrollBehaviorX: "contain",
    borderRadius: tableVars.corner,
    // No scrollbar (the product's rule, which also hides every bar in its own sheet): the edge
    // that has more to scroll fades instead (fade).
    scrollbarWidth: "none",
  },
  // The edge with more beyond it fades out over space-6, so the table says it scrolls without a
  // bar: a side with columns beyond it, and the foot of a table with a height while rows lie below
  // it (a row there stood cut by the box's foot, with nothing to say more came). Two layers, the
  // sides' and the foot's, kept where both are black. Off at the sides where columns are held:
  // their lift says it instead, and a fade would dim them.
  fade: {
    // The sides' layer is plain unless fadeSides sets it.
    "--table-fade-x": "linear-gradient(black, black)",
    "--table-fade-y": {
      default: "linear-gradient(black, black)",
      ":is([data-under-foot])": `linear-gradient(to bottom, black calc(100% - ${grasp.space6}), transparent)`,
    },
    maskImage: {
      default: null,
      ":is([data-under-start], [data-under-end], [data-under-foot])":
        "var(--table-fade-x), var(--table-fade-y)",
    },
    maskComposite: "intersect",
  },
  // The sides' layer, where no column is held.
  fadeSides: {
    "--table-fade-x": {
      default: "linear-gradient(black, black)",
      ":is([data-under-end]:not([data-under-start]))": `linear-gradient(to right, black calc(100% - ${grasp.space6}), transparent)`,
      ":is([data-under-start]:not([data-under-end]))": `linear-gradient(to left, black calc(100% - ${grasp.space6}), transparent)`,
      ":is([data-under-start][data-under-end])": `linear-gradient(to right, transparent, black ${grasp.space6}, black calc(100% - ${grasp.space6}), transparent)`,
      ":is([dir=rtl] *):is([data-under-end]:not([data-under-start]))": `linear-gradient(to left, black calc(100% - ${grasp.space6}), transparent)`,
      ":is([dir=rtl] *):is([data-under-start]:not([data-under-end]))": `linear-gradient(to right, black calc(100% - ${grasp.space6}), transparent)`,
    },
  },
  // A table with a height: its rows scroll inside the box, under a head that stays.
  tall: {
    overflowY: "auto",
    overscrollBehaviorY: "auto",
  },
  table: {
    width: "100%",
    margin: 0,
    borderCollapse: "collapse",
    borderSpacing: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.tableText,
    lineHeight: grasp.tableTextLine,
    color: grasp.text,
    // Figures line up from row to row.
    fontVariantNumeric: "tabular-nums",
  },
  // Rows that arrive one at a time: even columns, so no row that comes moves the ones above it.
  arriving: {
    tableLayout: "fixed",
  },
  // Columns sized by the Data table: widths from the head, laid out at once.
  sized: {
    tableLayout: "fixed",
    maxWidth: "none",
  },
  // The box and its ring stand in this, so the ring lies over the box alone.
  box: { position: "relative", borderRadius: tableVars.corner },
  // The caption a screen reader meets as the table's name: there, unseen.
  captionNamed: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  },
  // A TableCaption written into the table: under it, as a table's caption.
  captionUnder: { captionSide: "bottom" },
  // The caption a reader sees: under the box, still and whole while the table scrolls sideways.
  caption: {
    margin: 0,
    fontFamily: grasp.fontSans,
    marginBlockStart: grasp.space4,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    textAlign: "start",
  },
  // Every row has a hairline under it (the table's borders collapse, so a row can carry one); the
  // body's last row leaves it to the footer or to nothing.
  row: {
    // A head row whose cells all draw the line themselves (held heads) leaves its own off: both
    // drew one, a pixel apart, and the line under the head read double.
    // A head row whose cells all draw the line themselves (held heads) leaves its own off: both
    // drew one, a pixel apart, and the line under the head read double. The footer's last row
    // leaves it off too: the table ends there, and a line under its total stood over nothing.
    borderBlockEndWidth: {
      default: grasp.hairline,
      ":has(> [data-own-line]):not(:has(> :not([data-own-line])))": 0,
      ":is(tfoot > :last-child)": 0,
      // The head's line is drawn by its cells (head), not by a collapsed border: WebKit painted that
      // border twice over a column of row heads and the line was darker there.
      ":is(thead > *)": 0,
    },
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  // A row kept for its widths: it takes no room and is not drawn, but its cells still size the columns.
  collapsed: { visibility: "collapse" },
  // A row of the body: lit under a pointer, and its last one leaves the hairline to the footer.
  bodyRow: {
    borderBlockEndWidth: { default: grasp.hairline, ":last-child": 0 },
    // The fill is drawn as an image and meets the hairlines above and below it: no strip of plain
    // row between the band and its lines. Sized from the row's border box, which holds its half of
    // the collapsed hairline: from the padding box it stopped a pixel short of the line below.
    backgroundImage: {
      default: null,
      ":hover": {
        default: null,
        [media.hover]: `linear-gradient(${grasp.tableRowFillHover}, ${grasp.tableRowFillHover})`,
      },
    },
    backgroundSize: "100% 100%",
    backgroundOrigin: "border-box",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    transitionProperty: "background-image",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  // The chosen looks other than the grey band (look.ts): a mint wash, or the band with a pine bar
  // at the row's start.
  chosenMint: {
    backgroundImage: {
      default: `linear-gradient(${grasp.tableRowFillChosenMint}, ${grasp.tableRowFillChosenMint})`,
      ":hover": {
        default: null,
        [media.hover]: `linear-gradient(${grasp.tableRowFillHover}, ${grasp.tableRowFillHover}), linear-gradient(${grasp.tableRowFillChosenMint}, ${grasp.tableRowFillChosenMint})`,
      },
    },
  },
  chosenBar: {
    backgroundImage: {
      default: `linear-gradient(${grasp.pine}, ${grasp.pine}), linear-gradient(${grasp.tableRowFillChosen}, ${grasp.tableRowFillChosen})`,
      ":hover": {
        default: null,
        [media.hover]: `linear-gradient(${grasp.pine}, ${grasp.pine}), linear-gradient(${grasp.tableRowFillHover}, ${grasp.tableRowFillHover}), linear-gradient(${grasp.tableRowFillChosen}, ${grasp.tableRowFillChosen})`,
      },
    },
    // The pine bar and the band behind it run from line to line.
    // Under a pointer a third layer (the hover's) lies between the bar and the band: each list
    // names all three, or the bar's size would be given to the hover too.
    backgroundSize: {
      default: `${grasp.ringWidth} 100%, 100% 100%`,
      ":hover": {
        default: null,
        [media.hover]: `${grasp.ringWidth} 100%, 100% 100%, 100% 100%`,
      },
    },
    backgroundPosition: {
      default: "left center, center",
      ":is([dir=rtl] *)": "right center, center",
      ":hover": { default: null, [media.hover]: "left center, center, center" },
    },
    backgroundOrigin: "border-box",
    backgroundRepeat: "no-repeat",
  },
  // A held cell in a chosen row of the mint look: the wash drawn again over its ground.
  pinnedMint: {
    backgroundImage: {
      default: null,
      ":is([data-state=selected] > *)": `linear-gradient(${grasp.tableRowFillChosenMint}, ${grasp.tableRowFillChosenMint})`,
    },
  },
  // The head on the soft ground, and the quiet head's pine line under a sorted name.
  headSoft: { backgroundColor: grasp.tableHeadFillSoft },
  // Drawn as an image along the cell's foot, not an inset shadow: on a cell of a collapsed table
  // Firefox drew the shadow's sides too, a pine hairline down each side, and the line thinner.
  headQuietSorted: {
    backgroundImage: `linear-gradient(to top, ${grasp.pine} ${grasp.ringWidth}, transparent ${grasp.ringWidth})`,
    backgroundRepeat: "no-repeat",
  },
  // A sorted head's place in a chip, in the quiet look.
  orderChip: {
    display: "inline-grid",
    placeItems: "center",
    minWidth: grasp.space4,
    height: grasp.space4,
    paddingInline: grasp.space1,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.tableSortChip,
    color: grasp.ink,
  },
  // Chosen: a fill drawn as an image, which forced colours drop, so the system's highlight there.
  chosen: {
    // Under a pointer a chosen row deepens a step, as every row answers the pointer.
    backgroundImage: {
      default: `linear-gradient(${grasp.tableRowFillChosen}, ${grasp.tableRowFillChosen})`,
      ":hover": {
        default: null,
        [media.hover]: `linear-gradient(${grasp.tableRowFillHover}, ${grasp.tableRowFillHover}), linear-gradient(${grasp.tableRowFillChosen}, ${grasp.tableRowFillChosen})`,
      },
    },
    backgroundColor: { default: null, [media.forced]: "Highlight" },
    color: { default: null, [media.forced]: "HighlightText" },
  },
  // The footer sits on the soft ground, its words in ink, with a hairline above it.
  footer: {
    backgroundColor: grasp.soft,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
  },
  head: {
    height: grasp.tableHeadHeight,
    boxSizing: "border-box",
    // The head's line, drawn by each cell along its foot: one line in every engine (row).
    backgroundImage: `linear-gradient(to top, ${grasp.line} ${grasp.hairline}, transparent ${grasp.hairline})`,
    paddingBlock: 0,
    paddingInline: grasp.tableCellInline,
    textAlign: "start",
    verticalAlign: "middle",
    fontSize: grasp.textSm,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
    whiteSpace: "nowrap",
  },
  // A head with controls after its name (a column's menu, a resize handle): they sit at its end.
  headWithAfter: {
    position: "relative",
    paddingInlineEnd: grasp.space1,
  },
  // Where a dragged column will land: a pine line on that side of the head.
  dropBefore: {
    boxShadow: {
      default: `inset ${grasp.ringWidth} 0 0 ${grasp.pine}`,
      ":is([dir=rtl] *)": `inset calc(-1 * ${grasp.ringWidth}) 0 0 ${grasp.pine}`,
    },
  },
  dropAfter: {
    boxShadow: {
      default: `inset calc(-1 * ${grasp.ringWidth}) 0 0 ${grasp.pine}`,
      ":is([dir=rtl] *)": `inset ${grasp.ringWidth} 0 0 ${grasp.pine}`,
    },
  },
  // A column that can be sorted: its name is a button, with the sort's icon after it.
  sort: {
    // Reached by Tab, it is scrolled clear of the fade at the box's edges, so its ring is whole.
    scrollMarginInline: grasp.space8,
    position: "relative",
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    margin: 0,
    marginInline: `calc(-1 * ${grasp.space1})`,
    paddingBlock: 0,
    paddingInline: grasp.space1,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
    },
    color: {
      default: "inherit",
      ":hover": { default: null, [media.hover]: grasp.ink },
    },
    fontFamily: "inherit",
    fontSize: "inherit",
    fontWeight: "inherit",
    lineHeight: "inherit",
    cursor: "pointer",
  },
  // A 44px press area round the column's name, unseen (head.tsx).
  target: {
    position: "absolute",
    top: "50%",
    insetInline: 0,
    height: grasp.tap,
    transform: "translateY(-50%)",
  },
  sorted: {
    color: grasp.ink,
  },
  // A column's place in a sort by several, in a small muted figure after its icon.
  order: {
    fontSize: grasp.textXs,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  // Words for a screen reader only.
  unseen: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  // The icon of a column not sorted yet is quieter than the words.
  unsorted: {
    opacity: 0.6,
  },
  cell: {
    paddingBlock: grasp.tableCellBlock,
    paddingInline: grasp.tableCellInline,
    textAlign: "start",
    verticalAlign: "middle",
    // Words stay whole: a table too narrow for them scrolls sideways (the box), it never breaks a
    // word in two. Only a word wider than a column of a given width breaks.
    overflowWrap: "break-word",
    hyphens: "manual",
  },
  // Every cell but the lead (and one asked to wrap) on one line: on a phone the lead gives way
  // first, in whole words, and when the row still does not fit the box scrolls sideways. A date
  // broke into "Mar / 2024", a badge into a tall blob, every owner onto two lines.
  oneLine: { whiteSpace: "nowrap" },
  // A column of figures stands at the end, so units line up.
  end: {
    textAlign: "end",
  },
  centre: {
    textAlign: "center",
  },
  // The first words of a row: what the row is.
  // It keeps a least width: in a table too narrow for its columns the lead was squeezed to a word
  // a line while the table already scrolled sideways. Now it reads in phrases and the table scrolls.
  lead: {
    color: grasp.ink,
    fontWeight: "inherit",
    minWidth: grasp.tableLeadMin,
  },
  // Density: the room above and below the words; the words stay 13px on 18px.
  compact: { paddingBlock: grasp.tableCellBlockCompact },
  roomy: { paddingBlock: grasp.tableCellBlockRoomy },
  headCompact: { height: grasp.tableHeadHeightCompact },
  // A head that stays in view while rows scroll under it, casting the low lift only then. The
  // lift is clipped to the head's lower side, so it reads as one edge, not a frame.
  stuck: {
    position: "sticky",
    top: 0,
    zIndex: 2,
    backgroundColor: grasp.paper,
    // The hairline under the head travels with it (a collapsed border would stay behind).
    backgroundImage: `linear-gradient(to top, ${grasp.line} ${grasp.hairline}, transparent ${grasp.hairline})`,
    boxShadow: { default: null, ":is([data-under-head] *)": grasp.liftLow },
    // A pixel wider at each side than the cell: clipped on its own box, two cells meeting on a
    // fractional pixel each half-covered it, and Firefox and WebKit showed the page's paper there,
    // a seam down the head. The neighbour paints over the pixel of lift this lets through.
    clipPath: `inset(0 -1px calc(-1 * ${grasp.space3}) -1px)`,
    // That pixel past each side showed the lift's edge while rows were under the head: a grey line
    // down every join in WebKit and Firefox (A2-tables-13). The cell's own ground, a pixel wider at
    // each side, lies over its lift and under its words, so the joins read as one ground.
    "::before": {
      content: '""',
      position: "absolute",
      insetBlock: 0,
      insetInline: "-1px",
      zIndex: -1,
      backgroundColor: "inherit",
      backgroundImage: "inherit",
      pointerEvents: "none",
    },
  },
  // A column held at the start or the end while the rest scroll sideways. Its ground is the
  // table's, with the row's hover and chosen bands drawn again over it, so the band runs unbroken.
  pinned: {
    position: "sticky",
    zIndex: 1,
    backgroundColor: grasp.paper,
    backgroundImage: {
      default: null,
      ":is([data-slot=table-row]:hover > *)": {
        default: null,
        [media.hover]: `linear-gradient(${grasp.tableRowFillHover}, ${grasp.tableRowFillHover})`,
      },
      ":is([data-state=selected] > *)": `linear-gradient(${grasp.tableRowFillChosen}, ${grasp.tableRowFillChosen})`,
    },
    backgroundSize: "100% 100%",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  },
  // A held head cell: the head's hairline, drawn by the cell itself. Held, it stands on its own
  // ground over the row's collapsed border, which would otherwise be hidden under it.
  pinnedHead: {
    backgroundImage: `linear-gradient(to top, ${grasp.line} ${grasp.hairline}, transparent ${grasp.hairline})`,
    backgroundSize: "100% 100%",
  },
  // A held cell whose control reaches into the held cell after it: drawn above that one.
  aboveBody: { zIndex: 2 },
  aboveHead: { zIndex: 4 },
  // Held in a head that also stays: above both the head and the held body cells.
  corner: {
    zIndex: 3,
    clipPath: {
      default: `inset(0 calc(-1 * ${grasp.space3}) calc(-1 * ${grasp.space3}) 0)`,
      ":is([dir=rtl] *)": `inset(0 0 calc(-1 * ${grasp.space3}) calc(-1 * ${grasp.space3}))`,
    },
  },
  // The held column nearest the scrolling ones: the low lift on its open side, while a column is
  // under it. Clipped to that side.
  edgeStart: {
    boxShadow: { default: null, ":is([data-under-start] *)": grasp.liftLow },
    clipPath: {
      default: `inset(0 calc(-1 * ${grasp.space3}) 0 0)`,
      ":is([dir=rtl] *)": `inset(0 0 0 calc(-1 * ${grasp.space3}))`,
    },
  },
  edgeEnd: {
    boxShadow: { default: null, ":is([data-under-end] *)": grasp.liftLow },
    clipPath: {
      default: `inset(0 0 0 calc(-1 * ${grasp.space3}))`,
      ":is([dir=rtl] *)": `inset(0 calc(-1 * ${grasp.space3}) 0 0)`,
    },
  },
  // A sized column's words stop at its edge rather than widen it.
  clip: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});
