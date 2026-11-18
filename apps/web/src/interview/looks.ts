import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";

// What the interview's screens share, built on Grasp UI's tokens: the
// column a screen stands in, the line the interviewer says (in the serif,
// as a title is), and the quiet lines under it.

export const looks = stylex.create({
  // A screen: whoever holds the interview over what it says, in one column in the middle.
  screen: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space6,
    width: "100%",
    maxWidth: "36rem",
    textAlign: "center",
  },
  narrow: { maxWidth: "28rem" },
  // What stands under the head: measured, so the head takes the room left.
  body: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space6,
    width: "100%",
  },
  // A title and the sentence under it.
  words: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space2,
  },
  // What the interviewer says, in the serif, as large as a section's title.
  said: {
    margin: 0,
    maxWidth: "32rem",
    fontFamily: grasp.fontSerif,
    fontSize: grasp.titleMd,
    lineHeight: grasp.titleMdLine,
    fontWeight: grasp.weightRegular,
    letterSpacing: grasp.trackingTitle,
    color: grasp.ink,
    textWrap: "balance",
  },
  // Where the line stands: room kept, so the screen doesn't jump as it comes.
  lineRoom: {
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    width: "100%",
    minHeight: "4rem",
  },
  balance: { textWrap: "balance" },
  // One screen of several, faded in as it comes.
  stage: { display: "flex", justifyContent: "center", width: "100%" },
  // The one action of a screen, and what stands with it.
  actions: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space3,
    width: "100%",
    maxWidth: "24rem",
  },
  // A row of quiet ways to do something else.
  quietRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    columnGap: grasp.space4,
    rowGap: grasp.space2,
  },
  // Words a phone hides, so a button there is its sign alone; still its name.
  wideOnly: {
    position: { default: null, [media.belowPhone]: "absolute" },
    width: { default: null, [media.belowPhone]: 1 },
    height: { default: null, [media.belowPhone]: 1 },
    overflow: { default: null, [media.belowPhone]: "hidden" },
    clipPath: { default: null, [media.belowPhone]: "inset(50%)" },
    whiteSpace: { default: null, [media.belowPhone]: "nowrap" },
  },
});

/** A full-width button in a screen's column. */
export const fullWidth = stylex.create({ button: { width: "100%" } });
