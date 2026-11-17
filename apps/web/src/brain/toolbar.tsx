import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// What the transcript's filter takes from the prototype's Landscape toolbar
// (`components/landscape/toolbar.tsx`): the label of a toolbar button, and how
// long the pointer rests before a hover menu opens or closes.

const styles = stylex.create({
  label: { whiteSpace: "nowrap" },
});

/**
 * The label of a toolbar button, on one line. The library's buttons keep their words in view, so
 * the label no longer folds away until the button is hovered: a toolbar button says what it does.
 */
export const ToolbarLabel = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.label)}>{children}</span>
);

/** How long the pointer rests before a toolbar menu opens, and before it closes after leaving, in ms. */
export const hoverDelay = { open: 75, close: 150 };
