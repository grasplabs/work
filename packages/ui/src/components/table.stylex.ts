// What a Table reads from what holds it.
import * as stylex from "@stylexjs/stylex";

import { radius, size } from "../lib/tokens.stylex";

export const tableVars = stylex.defineVars({
  /**
   * The corner of the table's box. A part that holds a Table flush to its own edges (a card's
   * flush body) sets it to 0, so the box is square there and its corners clip nothing of the part
   * around it (a soft head's grey was notched at both top corners).
   */
  corner: radius.mark,
  /** The words' size in its cells. An answer in a chat sets it to the chat's words (Markdown). */
  text: size.tableText,
  /** Their line height, with `text`. */
  line: size.tableTextLine,
});
