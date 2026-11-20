// The look of DocumentEditor. What is written wears Markdown's own styles (markdown/styles.ts),
// handed to each node Tiptap draws as its class, so what you write reads as what is shown. The
// frame is an outlined surface, as Item's outline row; the format bar is a popup that grows from
// the selection.
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const FORCED = media.forced;
const REDUCED = media.reduced;

const grow = stylex.keyframes({
  from: { opacity: 0, transform: "scale(0.96)" },
  to: { opacity: 1, transform: "none" },
});

export const editorStyles = stylex.create({
  frame: {
    position: "relative",
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: {
      default: grasp.edge,
      ":focus-within": `${grasp.edge}, ${grasp.fieldFocus}`,
    },
    outline: { default: "none", [FORCED]: "1px solid CanvasText" },
  },
  // A page (`variant="page"`): no box round it; the words stand on the page's column, the gutter in
  // the room before them.
  page: {
    backgroundColor: "transparent",
    borderRadius: 0,
    boxShadow: "none",
  },
  pageDocument: {
    paddingBlock: 0,
    paddingInline: 0,
  },
  // Out of use: half strength, no press.
  disabled: { opacity: grasp.dim, cursor: "not-allowed" },
  // The header: the host's actions at the end, and what Grasp is doing at the start.
  header: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: grasp.shellIconButton,
    paddingBlockStart: grasp.space3,
    paddingInline: grasp.space4,
  },
  status: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    flexGrow: 1,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    marginInlineStart: "auto",
  },
  // The written document: Markdown's column of reading, inside the frame's room.
  document: {
    minHeight: grasp.space20,
    paddingBlock: grasp.space4,
    paddingInline: grasp.space4,
    outline: "none",
    cursor: "text",
    caretColor: grasp.ink,
    "::selection": { backgroundColor: grasp.fieldSelection },
  },
  // The document drawn still, until the editor mounts: no text caret yet.
  still: {
    cursor: "default",
  },
  stillPlaceholder: {
    color: grasp.muted,
  },
  // While Grasp rewrites it: read only, the words a step back, the caret gone.
  rewriting: {
    color: grasp.muted,
    cursor: "progress",
    caretColor: "transparent",
  },
  // An empty node's words: its placeholder, in the muted ink, taking no room.
  placeholder: {
    "::before": {
      content: "attr(data-placeholder)",
      float: "inline-start",
      height: 0,
      color: grasp.muted,
      pointerEvents: "none",
    },
  },
  // A heading's size by its level, as Markdown's: 1 and 2 a step up, 3 the body's size in ink.
  heading: {
    fontSize: { default: grasp.textMd, ":is(h1, h2)": grasp.textLg },
    lineHeight: { default: grasp.textMdLine, ":is(h1, h2)": grasp.textLgLine },
  },
  link: {
    color: grasp.ink,
    textDecorationLine: "underline",
    textDecorationColor: grasp.line,
    textUnderlineOffset: "0.2em",
  },
  codeBlock: {
    margin: 0,
    padding: grasp.space3,
    borderRadius: grasp.cornerMark,
    backgroundColor: grasp.codeFill,
    fontFamily: grasp.fontMono,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
    whiteSpace: "pre-wrap",
  },
  // A collapsible section wears Markdown's section look (markdown/section.styles.ts). Tiptap draws
  // the toggle before a holder of the summary and the body; that holder gives way, so the three
  // stand in the section's grid as Markdown draws them.
  detailsHolder: {
    display: "contents",
  },
  // A table: GFM's, in Table's look: hairlines between rows, the head row quiet and medium, cells at
  // the table's inset. It may run wider than the column; then it scrolls inside its own box.
  table: {
    width: "100%",
    borderCollapse: "collapse",
    tableLayout: "auto",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  tableRow: {
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  tableCell: {
    paddingBlock: grasp.space2,
    paddingInline: grasp.tableCellInline,
    textAlign: "start",
    verticalAlign: "top",
    minWidth: grasp.space20,
  },
  tableHead: {
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
  },
  // The format bar: a small popup over the selection, in the top layer.
  bar: {
    position: "fixed",
    inset: "auto",
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    padding: grasp.space1,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.popupLift,
    color: grasp.text,
    overflow: "visible",
    transformOrigin: "var(--transform-origin)",
    animationName: { default: grow, [REDUCED]: "none" },
    animationDuration: simply.ui,
    animationTimingFunction: grasp.ease,
  },
  rule: {
    width: grasp.hairline,
    alignSelf: "stretch",
    marginBlock: grasp.space1,
    backgroundColor: grasp.line,
  },
  linkField: {
    width: "16rem",
  },
});
