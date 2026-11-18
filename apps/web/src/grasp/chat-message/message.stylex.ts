// The message's marker: its time shows while the message is hovered or holds the focus
// (stylex.when.ancestor), without a selector that reaches into children.
import * as stylex from "@stylexjs/stylex";

export const messageMarker = stylex.defineMarker();
