import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { consent, fixture } from "./fixture.ts";

// CONCEPT ONLY: A's start, cleaned after Ruben's verdict ("so many fonts,
// so many sizes ... this is not clean at all"), three ways, at
// `?concept=a&start=1|2|3`. The rules for every one: two text styles (the
// serif title, and one Text size and tone for everything else), no icon on
// a plain statement, who asked in words, two real buttons of one height (a
// `default` and an `outline`, stacked full width on a phone) and the third
// choice a `link` on a line of its own, one left edge, one gap between
// blocks and a smaller one inside a block, as few words as honestly do.
//   1 · a sentence: the promises as one more paragraph;
//   2 · a short list: the promises as three plain lines in the same style;
//   3 · the least: the promises folded into one quiet Collapsible.

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "safe center",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    boxSizing: "border-box",
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
    paddingBlock: { default: space["6"], [media.sm]: space["10"] },
  },
  // One column, one edge; the gap between blocks.
  column: {
    display: "flex",
    flexDirection: "column",
    gap: space["8"],
    width: "100%",
    maxWidth: "28rem",
    marginInline: "auto",
  },
  // Inside a block: the smaller gap.
  block: { display: "flex", flexDirection: "column", gap: space["4"] },
  // The two buttons: side by side, one height; stacked full width on a phone, the main one first.
  buttons: {
    display: "flex",
    flexDirection: { default: "column", [media.sm]: "row" },
    gap: space["3"],
  },
  // The three lines read as one block: no gap inside it, the block's gap before it.
  lines: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
    margin: 0,
    padding: 0,
  },
  // Each button takes half the row beside the other; on a phone, the whole width.
  grow: { flexGrow: 1, flexBasis: 0 },
  decline: { display: "flex", alignItems: "flex-start" },
  // A large Button keeps its inset (space-4) as a link too: it stands out by as much, so its words start on the column's edge.
  flushLink: { marginInlineStart: `calc(-1 * ${space["4"]})` },
});

/** Which of the three. */
export type CleanStart = "1" | "2" | "3";

/** The one body style of these screens. */
const Body = ({ children }: { children: ReactNode }) => (
  <Text size="lg">{children}</Text>
);

/** The two buttons, one height. */
const Choices = ({
  onAgree,
  onNotNow,
}: {
  onAgree: () => void;
  onNotNow: () => void;
}) => (
  <div {...stylex.props(styles.block)}>
    <div {...stylex.props(styles.buttons)}>
      <Button onClick={onAgree} size="lg" style={styles.grow}>
        I agree, let’s start
      </Button>
      <Button
        onClick={onNotNow}
        size="lg"
        style={styles.grow}
        variant="outline"
      >
        Not now
      </Button>
    </div>
  </div>
);

/** The way to decline: the whole line is the link, alone, on the left edge. */
const Decline = ({ onRatherNot }: { onRatherNot: () => void }) => (
  <div {...stylex.props(styles.decline)}>
    <Button
      onClick={onRatherNot}
      size="lg"
      style={styles.flushLink}
      variant="link"
    >
      I’d rather not take part
    </Button>
  </div>
);

/** A's start, cleaned: `variant` 1, 2 or 3. */
export const ConsentClean = ({
  variant,
  onAgree,
  onNotNow,
  onRatherNot,
}: {
  variant: CleanStart;
  onAgree: () => void;
  onNotNow: () => void;
  onRatherNot: () => void;
}) => {
  const title = `Tell ${fixture.interviewer} how your work really goes`;
  let middle: ReactNode;
  if (variant === "1") {
    middle = (
      <div {...stylex.props(styles.block)}>
        <Body>{consent.who}</Body>
        <Body>{consent.promises.join(" ")}</Body>
      </div>
    );
  } else if (variant === "2") {
    middle = (
      <div {...stylex.props(styles.block)}>
        <Body>{consent.who}</Body>
        <ul
          aria-label="What happens with what you say"
          {...stylex.props(styles.lines)}
        >
          {consent.promises.map((promise) => (
            <li key={promise}>
              <Body>{promise}</Body>
            </li>
          ))}
        </ul>
      </div>
    );
  } else {
    middle = (
      <div {...stylex.props(styles.block)}>
        <Body>{consent.whoShort}</Body>
        <Collapsible>
          <CollapsibleTrigger>What happens with what I say</CollapsibleTrigger>
          <CollapsibleContent>{consent.promises.join(" ")}</CollapsibleContent>
        </Collapsible>
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.block)}>
          <Heading level={1} size="xl">
            {title}
          </Heading>
        </div>
        {middle}
        <Choices onAgree={onAgree} onNotNow={onNotNow} />
        <Decline onRatherNot={onRatherNot} />
      </div>
    </div>
  );
};
