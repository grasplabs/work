import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  // One width through the admin, as Grasp Work's pages: a column as wide
  // as the card, its sides 24px in, so every page's edges stand under the
  // bar's and a banner's.
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    boxSizing: "border-box",
    width: "100%",
    paddingInline: space["6"],
    paddingBlockStart: space["7"],
    paddingBlockEnd: space["8"],
  },
  lines: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    width: "100%",
  },
  line: { width: "100%" },
  lastLine: { width: "66%" },
});

/**
 * The page body: a column as wide as the card, its sides 24px in, the gap
 * between its parts `space6`. What should stay narrower (a form, a line of
 * text) holds its own measure inside it.
 */
export const Page = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.page)}>{children}</div>
);

/** Skeleton lines where a list or text will be, announced once as loading. */
export const LoadingLines = ({ lines = 3 }: { lines?: number }) => (
  <output
    aria-busy="true"
    aria-label="Loading…"
    {...stylex.props(styles.lines)}
  >
    {Array.from({ length: lines }, (_, line) => (
      <Skeleton
        key={line}
        size="default"
        style={line === lines - 1 ? styles.lastLine : styles.line}
      />
    ))}
  </output>
);
