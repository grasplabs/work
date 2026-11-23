import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// The Inbox's room, for the page and for the page while it loads, so the
// list waits where it will stand.

export const inboxStyles = stylex.create({
  // The window under the site header, inside the frame's margins, so the
  // list and the panel each scroll on their own.
  page: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: space["4"],
    height: "calc(100svh - var(--header-height) - 1rem)",
    minHeight: 0,
  },
  pageBeside: {
    gridTemplateColumns: `minmax(0, 1fr) ${size.sidePanelWidth}`,
    paddingInlineEnd: space["2"],
    paddingBlockEnd: space["2"],
  },
  // The list, the page itself: the chat box floats over its foot, so the
  // last row can always be moved clear of it.
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    paddingBlockStart: space["6"],
    paddingBlockEnd: space["24"],
    paddingInline: space["6"],
  },
  // Nothing in the list: its state in the middle of the page.
  listEmpty: { justifyContent: "center" },
});
