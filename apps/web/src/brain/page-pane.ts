import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// A page of the Brain beside its navigation: its own pane that scrolls
// inside the inset the Brain's layout gives every page (routes/_shell.brain.tsx),
// with room at its foot for the chat's bar.

export const paneStyles = stylex.create({
  pane: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    boxSizing: "border-box",
    paddingBlockEnd: space["24"],
  },
});
