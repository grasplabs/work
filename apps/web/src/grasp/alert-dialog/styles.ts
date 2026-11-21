// What an alert dialog wears beyond Dialog's own look (src/components/dialog/styles.ts), which its
// parts take first: a title with no close button to clear, and a description that scrolls when it
// is longer than the window.
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";

export const alertDialogStyles = stylex.create({
  // No close button in the corner, so the title runs to the content's edge.
  title: {
    paddingInlineEnd: grasp.space6,
  },

  // The description is what the alert dialog is about, so it is the part that scrolls, on Dialog's
  // body (its hairlines and its scrollbar), and the title and actions stay put. It stands where
  // Dialog's description stands: space-4 under the title, less the room kept for its focus ring.
  scroller: {
    marginBlockStart: `calc(${grasp.space4} - ${grasp.space2})`,
  },
  // Inside the scroller, which holds its padding.
  description: {
    marginBlockStart: 0,
    paddingInline: 0,
  },
});
