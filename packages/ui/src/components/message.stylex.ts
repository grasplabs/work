// What a Message hands its parts, each set by the Message from what it holds: how far the rows
// under its surface (its actions, its footer) reach below it, so the avatar stands level with the
// foot of the surface, not of the rows; and whether a stopped answer's Stopped stands under its
// words (`stoppedUnder`), which it does only when the Message holds no actions to say it on their
// row, however deep the answer and the actions sit in the Message.
import * as stylex from "@stylexjs/stylex";

export const messageVars = stylex.defineVars({
  actions: "0px",
  footer: "0px",
  stoppedUnder: "inline-flex",
});
