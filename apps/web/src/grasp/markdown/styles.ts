// The look of an answer drawn from Markdown (markdown.tsx): the interface's own type, from the
// tokens only. Body in text-md; headings a step or two up in ink, never a page's sizes, as an
// answer sits inside a message; lists, quotes and rules spaced as one column of reading.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const REDUCED = media.reduced;
const arrive = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

export const markdownStyles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    minWidth: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.text,
    // Its own white space, whatever the message round it sets.
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
  // A block that arrives while the answer is written fades in; at once with reduced motion.
  arrives: {
    animationName: { default: arrive, [REDUCED]: "none" },
    animationDuration: grasp.durationUi,
    animationTimingFunction: grasp.ease,
  },
  paragraph: {
    margin: 0,
    textWrap: "pretty",
  },
  // An answer written on the page: lines break where they fill (see Context.greedy).
  greedy: {
    textWrap: "wrap",
  },
  heading: {
    margin: 0,
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
    textWrap: "balance",
  },
  h1: { fontSize: grasp.textLg, lineHeight: grasp.textLgLine },
  h2: { fontSize: grasp.textLg, lineHeight: grasp.textLgLine },
  h3: { fontSize: grasp.textMd, lineHeight: grasp.textMdLine },
  h4: { fontSize: grasp.textMd, lineHeight: grasp.textMdLine },
  // The smaller size, for words in a card or a panel: a step down, headings too.
  small: {
    gap: grasp.space3,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  smallHeading: { fontSize: grasp.textMd, lineHeight: grasp.textMdLine },
  smallMinor: { fontSize: grasp.textSm, lineHeight: grasp.textSmLine },
  strong: { fontWeight: grasp.weightMedium, color: grasp.ink },
  emphasis: { fontStyle: "italic" },
  deleted: { textDecorationLine: "line-through", color: grasp.muted },
  // Code in a sentence: the docs' own chip.
  inlineCode: {
    paddingInline: grasp.space1,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    // While its words fade in (src/motion/arrive-highlight.ts), the chip arrives with them, at the
    // step its words are at (ARRIVE_STEPS there).
    backgroundColor: {
      default: grasp.codeFill,
      ':is([data-arrive-step="0"])': `color-mix(in srgb, ${grasp.codeFill} 14%, transparent)`,
      ':is([data-arrive-step="1"])': `color-mix(in srgb, ${grasp.codeFill} 30%, transparent)`,
      ':is([data-arrive-step="2"])': `color-mix(in srgb, ${grasp.codeFill} 45%, transparent)`,
      ':is([data-arrive-step="3"])': `color-mix(in srgb, ${grasp.codeFill} 58%, transparent)`,
      ':is([data-arrive-step="4"])': `color-mix(in srgb, ${grasp.codeFill} 70%, transparent)`,
      ':is([data-arrive-step="5"])': `color-mix(in srgb, ${grasp.codeFill} 80%, transparent)`,
      ':is([data-arrive-step="6"])': `color-mix(in srgb, ${grasp.codeFill} 88%, transparent)`,
      ':is([data-arrive-step="7"])': `color-mix(in srgb, ${grasp.codeFill} 95%, transparent)`,
    },
    fontFamily: grasp.fontMono,
    fontSize: grasp.textSm,
    color: grasp.ink,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    margin: 0,
    paddingInlineStart: grasp.space6,
  },
  ordered: { listStyleType: "decimal" },
  unordered: { listStyleType: "disc" },
  item: {
    paddingInlineStart: grasp.space1,
    "::marker": { color: grasp.muted },
  },
  // A loose item's paragraphs stand apart, as blocks do.
  itemBody: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
  },
  // A task: a small box, ticked when done, before the words.
  task: {
    listStyleType: "none",
    marginInlineStart: `calc(-1 * ${grasp.space6})`,
    display: "flex",
    alignItems: "flex-start",
    gap: grasp.space2,
  },
  box: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.checkboxBox,
    height: grasp.checkboxBox,
    marginBlock: `calc((${grasp.textMdLine} - ${grasp.checkboxBox}) / 2)`,
    marginInlineStart: grasp.space1,
    borderRadius: grasp.cornerMark,
    boxShadow: `inset 0 0 0 ${grasp.hairline} ${grasp.choiceEdge}`,
    color: grasp.actionText,
  },
  boxDone: {
    backgroundColor: grasp.actionFill,
    boxShadow: "none",
  },
  quote: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    margin: 0,
    paddingInlineStart: grasp.space4,
    borderInlineStartWidth: grasp.codeBlockBarWidth,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
    color: grasp.muted,
  },
  rule: {
    width: "100%",
    height: 0,
    margin: 0,
    borderWidth: 0,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  // A footnote's mark in the sentence, and the notes at the foot.
  // The room a link's arrow takes (Link's mark and the gap before it), kept while the link is
  // still being written.
  arrowRoom: {
    display: "inline-block",
    width: `calc(${grasp.linkMarkGap} + ${grasp.linkMark})`,
  },
  footnoteMark: {
    fontSize: grasp.textXs,
    verticalAlign: "super",
  },
  footnotes: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    margin: 0,
    paddingInlineStart: grasp.space6,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    listStyleType: "decimal",
  },
  // Raw HTML in the source, shown as the text it is.
  raw: {
    fontFamily: grasp.fontMono,
    fontSize: grasp.textSm,
    color: grasp.muted,
    whiteSpace: "pre-wrap",
  },
});
