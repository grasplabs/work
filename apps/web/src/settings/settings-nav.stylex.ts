import * as stylex from "@stylexjs/stylex";

/**
 * Settings' layout widths, for its `stylex.create`s: `roomForList`, the
 * page wide enough for the list of sections beside a section's column (the
 * page's own width, which the Settings layout makes a container).
 */
export const settingsLayout = stylex.defineConsts({
  roomForList: "@container settings (width >= 48rem)",
});
