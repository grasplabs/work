import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// One question of New agent's guided setup: what it asks, as the page's
// h1 in the middle, a line under it only where it helps, and its answer.
// The question takes focus as it comes in where it has no field of its
// own to (manual-agent.tsx), so Enter goes on and Tab leads into it.

const styles = stylex.create({
  question: { display: "grid", gap: space["6"] },
  asked: {
    display: "grid",
    justifyItems: "center",
    gap: space["3"],
    textAlign: "center",
    // Focused only as the question comes in, never by Tab: no ring.
    outline: "none",
  },
});

/** One question: what it asks, a line under it, and its answer. */
export const Question = ({
  title,
  line,
  children,
}: {
  title: string;
  line?: string | undefined;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.question)}>
    <span data-question tabIndex={-1} {...stylex.props(styles.asked)}>
      {/* The page's h1, at its own size. */}
      <Heading level={1}>{title}</Heading>
      {line === undefined ? null : <Text color="muted">{line}</Text>}
    </span>
    {children}
  </div>
);
