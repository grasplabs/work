import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// The Brain's room in the card, for its layout and for the page that waits
// for the brain to be read, so nothing moves when it arrives.

export const brainStyles = stylex.create({
  // The page, filling the card under its bar in the room a page keeps
  // (#2503's padded App shell): its sides, the bar's gap above it, and
  // a page's usual room below, so its panes scroll inside it.
  body: {
    display: "flex",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 0,
    paddingBlockStart: space["7"],
    paddingBlockEnd: space["8"],
    paddingInline: size.appShellPageInline,
  },
  // While the chat's bar stands at the card's foot, room for it below
  // (#2503's shell, `roomForChat`); docked or floating, the chat leaves
  // the page its usual room.
  underChatBar: { paddingBlockEnd: space["24"] },
  // The brain, a part or a note, over which a note's dots are carried in.
  // Its words, where a part sets none, and the atlas's dots take the
  // card's own ink, as #2503's App shell gives its card (the shell's
  // text): the frame here leaves the old kit's foreground on it.
  page: {
    color: colors.sidebarForeground,
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
  },
});
