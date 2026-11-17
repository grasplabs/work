import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { foldVars } from "./fold.stylex";

const REDUCED = media.reduced;
// With no script, nothing is folded: there would be no Show more to open it. From the shared
// names, never written here: StyleX orders media queries it finds written out, and its parser for
// that does not read this one (the measure's build stops on it); a shared name it leaves alone.
const NO_SCRIPT = media.noScript;

const breathe = stylex.keyframes({
  from: { opacity: grasp.spinnerFaint },
  to: { opacity: 1 },
});

export const codeStyles = stylex.create({
  box: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    width: "100%",
    overflow: "hidden",
    backgroundColor: grasp.codeBlockFill,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    color: grasp.text,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  // The head: the file name or the language at the start, the copy button at the end, a hairline
  // under it, clear of the code. On a touch screen it is a finger tall and the button stands a little
  // further in, so the copy button's 44px press area fits inside the box, which clips.
  head: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: { default: grasp.codeBlockHead, [media.coarse]: grasp.tap },
    // The label starts where the code does: past the room every line keeps for a marked line's bar.
    paddingInlineStart: `calc(${grasp.space3} + ${grasp.codeBlockBarWidth})`,
    paddingInlineEnd: {
      default: grasp.space1,
      [media.coarse]: `calc((${grasp.tap} - ${grasp.controlSm}) / 2)`,
    },
    boxShadow: `inset 0 calc(-1 * ${grasp.hairline}) 0 ${grasp.line}`,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  // One line, cut with an ellipsis when it is too long: the full name is its title.
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    color: grasp.text,
    fontFamily: grasp.fontMono,
  },
  language: {
    flexShrink: 0,
  },
  // While the code is still coming in: the word for it breathes, quietly.
  writing: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    flexShrink: 0,
    animationName: { default: breathe, [REDUCED]: "none" },
    animationDuration: grasp.skeletonPulse,
    animationTimingFunction: grasp.easeInOut,
    animationIterationCount: "infinite",
    animationDirection: "alternate",
  },

  // The code. Lines too wide scroll sideways in here, never the page; it takes keyboard focus
  // for that when they do.
  scroller: {
    position: "relative",
    minWidth: 0,
    overflowX: "auto",
    overflowY: "hidden",
    paddingBlock: grasp.space3,
    fontFamily: grasp.fontMono,
    fontSize: grasp.textSm,
    lineHeight: grasp.codeBlockLine,
    tabSize: 2,
    // No visible bar (src/scroll/scroll.ts); the code still scrolls by wheel, touch and keys. The
    // edge with more beyond it fades instead (code-block.tsx marks which), as the docs' code does;
    // the foot fades while it is folded. Both at once: the two masks intersect.
    scrollbarWidth: "none",
    [foldVars.start]: {
      default: "0px",
      ":is([data-under-start])": grasp.space6,
    },
    [foldVars.end]: { default: "0px", ":is([data-under-end])": grasp.space6 },
    maskImage: {
      default: `linear-gradient(to right, transparent, black ${foldVars.start}, black calc(100% - ${foldVars.end}), transparent), linear-gradient(to bottom, black calc(100% - ${foldVars.foot}), transparent)`,
      ":is([dir=rtl] *)": `linear-gradient(to left, transparent, black ${foldVars.start}, black calc(100% - ${foldVars.end}), transparent), linear-gradient(to bottom, black calc(100% - ${foldVars.foot}), transparent)`,
    },
    maskComposite: "intersect",
  },
  // Cut at `maxLines`, with a fade, until Show more.
  folded: {
    maxHeight: { default: foldVars.height, [NO_SCRIPT]: "none" },
    [foldVars.foot]: { default: grasp.codeBlockFade, [NO_SCRIPT]: "0px" },
  },
  // The ring of the code that scrolls, while it has the keyboard's focus: a part of its own laid
  // round the whole block, head and code, in the block's own corners and just inside its edge,
  // clear of the code's room. Not on the scroller: its mask would fade it, its top would lie
  // square on the head's line, and the code would run into its side.
  ring: {
    position: "absolute",
    inset: 0,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    pointerEvents: "none",
    outlineWidth: {
      default: grasp.ringWidth,
      [media.forced]: `calc(2 * ${grasp.ringWidth})`,
    },
    outlineColor: { default: grasp.ring, [media.forced]: "Highlight" },
    outlineStyle: { default: "none", ":is(:focus-visible + *)": "solid" },
    outlineOffset: {
      default: `calc(-1 * ${grasp.ringWidth})`,
      [media.forced]: `calc(-2 * ${grasp.ringWidth})`,
    },
  },
  code: {
    display: "block",
    width: "max-content",
    minWidth: "100%",
    margin: 0,
    fontFamily: "inherit",
  },
  wrapped: {
    width: "auto",
  },
  // Every line has room for the bar at its start, so a marked one does not move; it follows the
  // reading direction.
  line: {
    display: "flex",
    borderInlineStartWidth: grasp.codeBlockBarWidth,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: "transparent",
    minHeight: grasp.codeBlockLine,
    paddingInlineEnd: grasp.space3,
    whiteSpace: "pre",
  },
  lineWrapped: {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  // A marked line: a wash of mint and a bar at its start, so colour is never the only mark.
  marked: {
    backgroundColor: grasp.codeBlockMarked,
    borderInlineStartColor: grasp.codeBlockMarkedBar,
  },
  // The line numbers: quiet, never selected or copied.
  number: {
    flexShrink: 0,
    boxSizing: "content-box",
    paddingInlineStart: grasp.space3,
    paddingInlineEnd: grasp.space4,
    textAlign: "end",
    color: grasp.codeBlockGutter,
    userSelect: "none",
    fontVariantNumeric: "tabular-nums",
  },
  // Without numbers, the code keeps its room at the start.
  bare: {
    paddingInlineStart: grasp.space3,
  },
  text: {
    minWidth: 0,
  },

  // Show more and Show less, at the foot, in the middle.
  foot: {
    display: { default: "flex", [NO_SCRIPT]: "none" },
    justifyContent: "center",
    paddingBlockEnd: grasp.space3,
  },

  // The colours of the highlighting.
  keyword: { color: grasp.syntaxKeyword },
  string: { color: grasp.syntaxString },
  constant: { color: grasp.syntaxConstant },
  comment: { color: grasp.syntaxComment, fontStyle: "italic" },
  function: { color: grasp.syntaxFunction },
  punctuation: { color: grasp.syntaxPunctuation },
  attribute: { color: grasp.syntaxAttribute },
  inserted: { color: grasp.syntaxInserted },
  deleted: { color: grasp.syntaxDeleted },
});

/** Which colour a run of code takes, from Prism's names for it (the innermost that has one). */
export const tones: Record<string, keyof typeof codeStyles> = {
  keyword: "keyword",
  important: "keyword",
  atrule: "keyword",
  rule: "keyword",
  builtin: "keyword",
  string: "string",
  char: "string",
  "template-string": "string",
  regex: "string",
  url: "string",
  "attr-value": "string",
  number: "constant",
  boolean: "constant",
  constant: "constant",
  symbol: "constant",
  entity: "constant",
  comment: "comment",
  prolog: "comment",
  doctype: "comment",
  cdata: "comment",
  function: "function",
  "class-name": "function",
  tag: "function",
  selector: "function",
  title: "function",
  punctuation: "punctuation",
  operator: "punctuation",
  "attr-name": "attribute",
  property: "attribute",
  key: "attribute",
  parameter: "attribute",
  inserted: "inserted",
  deleted: "deleted",
};
