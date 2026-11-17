// The Data table's own look, beside the Table's (src/components/table/styles.ts): its bar, the
// checkboxes in its rows, its menus and handles, and its placeholders. Every value a token.
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";

export const styles = stylex.create({
  table: { display: "grid", gap: grasp.space3, width: "100%", minWidth: 0 },
  // The table's own box, which keeps its last height while rows are on their way.
  hold: { minWidth: 0 },
  keeps: (height: string) => ({ minHeight: height }),
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space3,
    // A control's height whether or not rows are chosen: holding only the count, it was shorter,
    // and the table under it moved each time the chosen rows' actions came and went.
    minHeight: grasp.controlMd,
  },
  // On a phone the search has the row to itself: it runs to the table's edge, as the table does,
  // not 320px and short of it.
  search: {
    flexGrow: 1,
    maxWidth: { default: 320, [media.belowPhone]: "none" },
  },
  count: {
    marginInlineStart: "auto",
    color: grasp.muted,
    fontSize: grasp.textSm,
    fontVariantNumeric: "tabular-nums",
  },
  // The bar that shows while rows are chosen: the count, then what can be done to them. A
  // fieldset, its own frame taken away.
  bulk: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    minInlineSize: 0,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    // Where the bar is too narrow for one line, what wraps stays at the end with the rest.
    justifyContent: "flex-end",
    gap: grasp.space2,
    marginInlineStart: "auto",
  },
  // The last control in the bar stands at its end.
  atEnd: { display: "inline-flex", marginInlineStart: "auto" },
  empty: { color: grasp.muted, textAlign: "center" },
  // A row's checkbox takes only its box's room in the cell. A Checkbox is a whole row of a form,
  // with a 44px reach and room for words; here its words are hidden and its reach spills over.
  // Wide enough that the Checkbox's 44px reach ends inside its own cell's padding, never over the
  // next column's controls.
  pick: {
    display: "block",
    width: `calc(${grasp.tap} - ${grasp.tableCellInline})`,
    height: grasp.tableTextLine,
  },
  // The Checkbox's row is 44px tall; lifted by half the difference it stands centred on the
  // cell's line, as the words beside it do.
  lift: {
    display: "block",
    marginBlock: `calc((${grasp.tableTextLine} - ${grasp.tap}) / 2)`,
  },
  // Inside it, the Checkbox stands 44px wide, spilling over the next cell, so its reach is 44px.
  // Its own context, so the Checkbox's lift stays inside it instead of moving the whole box.
  reach: { display: "flow-root", width: grasp.tap },
  // The words are hidden but keep a width, so the Checkbox's own reach (its box, its gap and its
  // words, 44px tall on a touch screen) is 44px wide too, spilling into the next cell.
  words: {
    display: "inline-block",
    width: `calc(${grasp.tap} - ${grasp.checkboxBox} - ${grasp.space3})`,
    height: 1,
    overflow: "hidden",
    whiteSpace: "nowrap",
    color: "transparent",
  },
  // A group's heading row: its toggle, its value, and how many rows it holds.
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    height: grasp.tableTextLine,
    verticalAlign: "top",
  },
  groupCount: { color: grasp.muted, fontVariantNumeric: "tabular-nums" },
  // The first cell of a row that opens: its toggle, then its words.
  // Held to the line's height and top: an inline box of controls on the text's baseline would
  // take its baseline from a button's bottom edge and stretch the row.
  opener: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    height: grasp.tableTextLine,
    verticalAlign: "top",
  },
  // A name beside a toggle keeps to one line; the table scrolls sideways before it breaks.
  openerWords: { whiteSpace: "nowrap" },
  // Deeper rows step in by a toggle's width a level.
  depth: (depth: number) => ({
    paddingInlineStart: `calc(${depth} * ${grasp.space6})`,
  }),
  // Where a toggle would be, for a row that does not open, so the words line up.
  toggleRoom: {
    display: "inline-block",
    width: grasp.controlXs,
    flexShrink: 0,
  },
  // An xs control in a cell takes no more height than the words: the row keeps its height.
  inRow: {
    display: "inline-flex",
    marginBlock: `calc((${grasp.tableTextLine} - ${grasp.controlXs}) / 2)`,
  },
  // A control alone in a cell (a row's actions): held in a box as tall as the line, so it does not
  // sit on the text's baseline and add height to the row.
  cellControl: {
    display: "inline-flex",
    alignItems: "center",
    verticalAlign: "top",
    height: grasp.tableTextLine,
  },
  // A row's detail, under it.
  // A row that speaks for the whole table: as wide as the box shows (its container, Table's
  // scroller), held at its start while the table scrolls.
  across: {
    position: "sticky",
    insetInlineStart: grasp.tableCellInline,
    width: `calc(100cqi - 2 * ${grasp.tableCellInline})`,
    maxWidth: "100%",
  },
  detail: {
    paddingBlock: grasp.space2,
    paddingInlineStart: grasp.controlXs,
    color: grasp.text,
  },
  // The failed state: Empty's words, then Try again under them.
  state: {
    display: "grid",
    justifyItems: "center",
    gap: grasp.space3,
    paddingBlockEnd: grasp.space6,
  },
  // A placeholder's line: a cell's line, the lead longer than the rest.
  // Held in a box a line tall: the Skeleton's own line is a step taller, its fill in the middle.
  waiting: {
    display: "block",
    height: grasp.tableTextLine,
    width: "60%",
    overflow: "hidden",
  },
  waitingLead: {
    display: "block",
    height: grasp.tableTextLine,
    width: "80%",
    overflow: "hidden",
  },
  // The column's menu, after its name.
  // On a touch screen it stands further off the name, so each keeps a finger's 44px.
  menu: {
    marginInlineStart: { default: grasp.space1, [media.coarse]: grasp.space3 },
  },
  // On a touch screen it stands above its neighbours, so its own 44px press area is whole: the
  // column's name beside it gives up the few pixels where the two areas meet.
  after: {
    display: "inline-flex",
    alignItems: "center",
    verticalAlign: "middle",
    marginInlineStart: { default: grasp.space1, [media.coarse]: grasp.space3 },
    position: { default: null, [media.coarse]: "relative" },
    zIndex: { default: null, [media.coarse]: 1 },
    // And a little in from the head's end, where a sized or held head cuts off what passes it.
    marginInlineEnd: { default: null, [media.coarse]: grasp.space1 },
  },
  // The resize handle: a range input in a reach inside the head's end. Its hairline shows only
  // while the head is under a pointer or the handle is held (pine); with the keyboard it takes the
  // shared focus ring. The range's own track and thumb are taken away.
  handle: {
    // A touch screen cannot take an 8px handle: there the column keeps the width it laid out at.
    display: { default: null, [media.coarse]: "none" },
    appearance: "none",
    position: "absolute",
    insetBlock: 0,
    insetInlineEnd: 0,
    zIndex: 1,
    boxSizing: "border-box",
    width: grasp.space2,
    height: "100%",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "col-resize",
    touchAction: "none",
    backgroundImage: {
      default: null,
      ":is(th:hover *)": {
        default: null,
        [media.hover]: `linear-gradient(to left, ${grasp.line} ${grasp.ringWidth}, transparent ${grasp.ringWidth})`,
      },
      // From right to left the column's end is on the left: the hairline goes there.
      ":is([dir=rtl] th:hover *)": {
        default: null,
        [media.hover]: `linear-gradient(to right, ${grasp.line} ${grasp.ringWidth}, transparent ${grasp.ringWidth})`,
      },
    },
    backgroundSize: `100% calc(100% - 2 * ${grasp.space3})`,
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    "::-webkit-slider-thumb": { appearance: "none", width: 0, height: 0 },
    "::-moz-range-thumb": { width: 0, height: 0, borderWidth: 0 },
  },
  held: {
    backgroundImage: `linear-gradient(to left, ${grasp.pine} ${grasp.ringWidth}, transparent ${grasp.ringWidth})`,
  },
});
