// The edge line of a shell card (the page's card, the panels' card): 1px just inside its edge, round
// all four corners. Its own layer over what the card holds, so no bar, banner, head or scroller in the
// card paints over it (FRESH.md F89 drew it as the card's outline, and a bar's ground covered it across
// the card's top and round its two top corners). It takes the card's corner and lets every press
// through. The card says how wide it is (`cardLine.width`); in forced colours it is the system's ink.
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";
import { cardLine } from "./card-line.stylex";

const styles = stylex.create({
  line: {
    position: "absolute",
    inset: 0,
    // Above the page's own bar and the dock (shell-page-layer), under a folded sidebar's peek and the
    // buttons that float over the card (shell-layer).
    zIndex: `calc(${grasp.shellPageLayer} + 1)`,
    boxSizing: "border-box",
    borderRadius: "inherit",
    borderWidth: cardLine.width,
    borderStyle: "solid",
    borderColor: { default: grasp.shellCardLine, [media.forced]: "CanvasText" },
    pointerEvents: "none",
  },
  // While the panels' card lies over the page's card with a line of its own (crowded, or on its way
  // to full screen and back), the page's line goes under it: two lines in one place read as one
  // twice as dark.
  under: { zIndex: 0 },
});

interface CardLineProps {
  /** Under the panels' card while it lies over this one with a line of its own. */
  under?: boolean;
}

/** The card's edge line, drawn last in the card. */
export const CardLine = ({ under = false }: CardLineProps) => (
  <span
    aria-hidden="true"
    data-slot="app-shell-card-line"
    data-under={under ? "" : undefined}
    {...stylex.props(styles.line, under && styles.under)}
  />
);
