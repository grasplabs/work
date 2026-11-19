// The Composer's still form while the page's data is not there yet (`loading`, composer.tsx): the bar
// stands in its own box, drawn from its own parts, so the box is exactly the one that will come (the
// same 56px row, or the same tall form, as the same width decides). What would answer is kept in its
// room but not drawn (the controls, the host's end, Dictate); the text's box shows a quiet line in its
// place; the plus and an off Send stay, as at rest. The card is inert and hidden from a reader, so
// nothing is focused or read out: the page's own busy state speaks for it.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Skeleton } from "../skeleton";
import { grasp } from "../tokens/tokens.stylex";

const styles = stylex.create({
  // Its room kept, nothing drawn. Not by visibility: a Button's own layers set theirs back to
  // visible. A box that hugs the part, fully clear, so its room is the part's own.
  kept: { display: "inline-flex", alignItems: "center", opacity: 0 },
  // The text keeps its room the same way, as a block (the field is one).
  keptText: { display: "block", opacity: 0 },
  text: { position: "relative", minWidth: 0 },
  // The text's line, where the placeholder's words would start: on the one row's centre line, or at
  // the full card's text inset.
  line: {
    position: "absolute",
    insetInlineStart: grasp.space1,
    insetInlineEnd: 0,
    top: "50%",
    display: "flex",
    transform: "translateY(-50%)",
    pointerEvents: "none",
  },
  width: { width: "min(12rem, 60%)" },
  lineCard: {
    insetInlineStart: grasp.space4,
    top: grasp.space4,
    transform: "none",
  },
});

/** A part kept in its room but not drawn, while the bar is still. */
export const Kept = ({ children }: { children: ReactNode }) =>
  children === undefined || children === null || children === false ? (
    children
  ) : (
    <span data-slot="composer-kept" {...stylex.props(styles.kept)}>
      {children}
    </span>
  );

/** The text's box, its words not drawn, a quiet line in their place. */
export const PendingText = ({
  children,
  row,
}: {
  children: ReactNode;
  row: boolean;
}) => (
  <div data-slot="composer-pending-text" {...stylex.props(styles.text)}>
    <div {...stylex.props(styles.keptText)}>{children}</div>
    <span {...stylex.props(styles.line, !row && styles.lineCard)}>
      <Skeleton text="sm" layout={styles.width} />
    </span>
  </div>
);
