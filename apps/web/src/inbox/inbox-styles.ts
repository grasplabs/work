import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// The Inbox's room, for the page and for the page while it loads, so the
// list waits where it will stand.

export const inboxStyles = stylex.create({
  // What the frame's card leaves under its banners, filled, so the list
  // scrolls on its own, apart from the panel the frame seats beside it.
  page: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 0,
  },
  // The page's own column: its bar, then the list under it.
  column: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
  },
  // The list, the page itself: the chat box floats over its foot, so the
  // last row can always be moved clear of it.
  list: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: space["3"],
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    paddingBlockStart: space["7"],
    paddingBlockEnd: space["24"],
    paddingInline: space["6"],
  },
  // Nothing in the list: its state in the middle of the page.
  listEmpty: { justifyContent: "center" },
});
