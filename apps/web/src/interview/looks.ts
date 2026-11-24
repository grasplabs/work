import { colors, font, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// What the interview's screens share, built on Damsko's tokens: the column
// a screen stands in, the line the interviewer says (in the serif, as a
// title is), and the quiet lines under it.

export const looks = stylex.create({
  // A screen: whoever holds the interview over what it says, in one column in the middle.
  screen: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["6"],
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
    gap: space["6"],
    width: "100%",
  },
  // A title and the sentence under it.
  words: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["2"],
  },
  // What the interviewer says, in the serif, as large as a section's title.
  said: {
    margin: 0,
    maxWidth: "32rem",
    fontFamily: font.serif,
    fontSize: font.headingMd,
    lineHeight: font.headingMdLine,
    fontWeight: font.weightNormal,
    letterSpacing: font.trackingTitle,
    color: colors.foreground,
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
  // One screen of several, faded in as it comes.
  stage: { display: "flex", justifyContent: "center", width: "100%" },
  // The one action of a screen, and what stands with it.
  actions: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["3"],
    width: "100%",
    maxWidth: "24rem",
  },
  // A row of quiet ways to do something else.
  quietRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    columnGap: space["4"],
    rowGap: space["2"],
  },
  // Words a phone hides, so a button there is its sign alone; still its name.
  wideOnly: {
    position: { default: null, [media.maxSm]: "absolute" },
    width: { default: null, [media.maxSm]: 1 },
    height: { default: null, [media.maxSm]: 1 },
    overflow: { default: null, [media.maxSm]: "hidden" },
    clipPath: { default: null, [media.maxSm]: "inset(50%)" },
    whiteSpace: { default: null, [media.maxSm]: "nowrap" },
  },
});

/** Round a button that takes the whole width of a screen's column: it stretches to fill it. */
export const fullWidth = stylex.create({
  button: { display: "grid", width: "100%" },
});
