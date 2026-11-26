import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// A calm screen of the interview link, as every one but the start and the
// conversation stands: one column in the middle of the room under the
// header, on one centred axis, the serif title and one line of the body's
// words under it, then what there is to do.

const styles = stylex.create({
  // A screen of its own, its column in the middle of its room, scrolled in its own room when the window is low.
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "safe center",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    boxSizing: "border-box",
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
    paddingBlockStart: { default: space["6"], [media.sm]: space["10"] },
    // As much again under it as the header takes above it, so its middle is the window's middle,
    // not the middle of the room under the header.
    paddingBlockEnd: {
      default: `calc(4rem + ${space["6"]})`,
      [media.sm]: `calc(5rem + ${space["10"]})`,
    },
  },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: { default: space["6"], [media.sm]: space["8"] },
    width: "100%",
    maxWidth: "28rem",
    textAlign: "center",
  },
  wide: { maxWidth: "36rem" },
  words: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["3"],
  },
  actions: { display: "flex", flexDirection: "column", gap: space["3"] },
  quiet: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space["2"],
  },
});

/** A screen of its own: one column in the middle of its room; `wide` for one that holds a list to read. */
export const Page = ({
  wide = false,
  children,
}: {
  wide?: boolean;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.page)}>
    <div {...stylex.props(styles.column, wide && styles.wide)}>{children}</div>
  </div>
);

/** A screen's title, and a line under it. */
export const Words = ({
  title,
  line,
  live = false,
}: {
  title: string;
  line?: ReactNode;
  /** Said to a screen reader as it changes: the screen answers something just done. */
  live?: boolean;
}) => (
  <div aria-live={live ? "polite" : undefined} {...stylex.props(styles.words)}>
    <Heading level={1} size="xl">
      {title}
    </Heading>
    {line === undefined ? null : <Text size="lg">{line}</Text>}
  </div>
);

/** What there is to do on a screen: its one button, and what stands with it. */
export const Actions = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.actions)}>{children}</div>
);

/** The quiet ways to do something else: link buttons, side by side, centred. */
export const Quiet = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.quiet)}>{children}</div>
);
