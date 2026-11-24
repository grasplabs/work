// What a Message hands its avatar: how far the rows under its surface (its actions, its footer)
// reach below it, each set by the Message when it holds that row, so the avatar stands level
// with the foot of the surface, not of the rows.
import * as stylex from "@stylexjs/stylex";

export const messageVars = stylex.defineVars({
  actions: "0px",
  footer: "0px",
});
