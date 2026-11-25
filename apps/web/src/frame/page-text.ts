import { font } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// The text #2503's shell gives a page, which what isn't sized itself
// inherits: the frame's page here sets a larger one, so a page ported from
// #2503 sets it on its own box, as the workflows' settings do.

export const pageText = stylex.create({
  text: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: "inherit",
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
  },
});
