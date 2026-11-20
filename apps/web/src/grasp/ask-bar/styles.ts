// Ask bar's look: the resting bar's width, and the panel's three rows (its head, the conversation,
// the composer at its foot). The bar itself is the library's compact Composer and the panel's parts
// are Button, Thread and Composer: only their placing is drawn here.
//
// Every value is a token (src/tokens), but for the bar's width and the chip's (below).
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";

export const styles = stylex.create({
  bar: {
    width: 560,
    maxWidth: "100%",
    minWidth: "min(400px, 100%)",
  },
  // The target's chip at the bar's start: short, cut with an ellipsis, so the words keep their room.
  // 160px has no token: about two words of small type with the mark and the cross.
  target: {
    display: "flex",
    minWidth: 0,
    maxWidth: 160,
  },
  // The panel: its head, the conversation, the box at its foot. It fills the place it is given.
  panel: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    minWidth: 0,
    minHeight: 0,
    height: "100%",
  },
  // The head: the conversation's name as far in as the page's own words, the buttons at its end.
  head: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    minHeight: grasp.shellBar,
    paddingInlineStart: grasp.shellPageInline,
    paddingInlineEnd: grasp.space3,
  },
  // The name: one line, cut with an ellipsis when it is longer than its room.
  title: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
  },
  // The conversation: the host's Thread, which scrolls itself.
  body: {
    minWidth: 0,
    minHeight: 0,
  },
  // Nothing asked yet: one quiet line in the middle.
  empty: {
    display: "grid",
    placeItems: "center",
    height: "100%",
    margin: 0,
    paddingInline: grasp.space6,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    textAlign: "center",
  },
  // The composer at the foot, as far in as the conversation, a little closer to it above.
  foot: {
    minWidth: 0,
    padding: grasp.space4,
    paddingBlockStart: grasp.space2,
  },
});
