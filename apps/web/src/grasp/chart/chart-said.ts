// What the newer chart parts share with Chart's own figure: the figure itself. The box a screen
// reader hears and never sees is the one visuallyHidden (src/hidden).
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";

export const saidStyles = stylex.create({
  figure: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: grasp.space3,
    minWidth: 0,
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.text,
  },
});
