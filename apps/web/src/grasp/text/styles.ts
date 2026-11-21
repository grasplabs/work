// Text's type: the sizes, weights and inks of running words, from the tokens. Text draws them, and a
// part whose words are Text's own (Section header's title and sentence) builds on the same styles,
// so the two never drift apart.
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";

export const textStyles = stylex.create({
  text: {
    margin: 0,
    fontFamily: grasp.fontSans,
    letterSpacing: grasp.trackingUi,
    overflowWrap: "break-word",
  },
  xs: { fontSize: grasp.textXs, lineHeight: grasp.textXsLine },
  sm: { fontSize: grasp.textSm, lineHeight: grasp.textSmLine },
  md: { fontSize: grasp.textMd, lineHeight: grasp.textMdLine },
  lg: { fontSize: grasp.textLg, lineHeight: grasp.textLgLine },
  regular: { fontWeight: grasp.weightRegular },
  medium: { fontWeight: grasp.weightMedium },
  ink: { color: grasp.ink },
  tone: { color: grasp.text },
  muted: { color: grasp.muted },
  quiet: { color: grasp.quiet },
  // The display face: the serif with the title's tracking, at the size and line given.
  display: { fontFamily: grasp.fontSerif, letterSpacing: grasp.trackingTitle },
  // How a long line breaks; `words` is the text's own.
  words: {},
  anywhere: { overflowWrap: "anywhere" },
  truncate: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
});
