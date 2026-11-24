// The path's three inks, which a frame that stands on another ground sets to its own: an app
// shell's bar draws the path in the sidebar's neutral ink. Anywhere else they are the page's. And
// the room each side of a separator, which a frame that draws a slash sets: a slash is narrower
// than the chevron's box.
import * as stylex from "@stylexjs/stylex";

import { colors } from "../lib/tokens.stylex";

export const breadcrumbVars = stylex.defineVars({
  /** The page you are on, and a link under the pointer. */
  foreground: colors.foreground,
  /** A step that leads somewhere. */
  mutedForeground: colors.mutedForeground,
  /** What stands between two steps. */
  subtleForeground: colors.subtleForeground,
  /** The room each side of a separator, beyond the path's gap. */
  separatorInset: "0px",
});
