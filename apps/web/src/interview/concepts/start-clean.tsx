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

import { copy } from "./fixture.ts";

// CONCEPT ONLY: A's start, as Ruben chose it (24 November, "the least"),
// in his words (fixture.ts `copy.start`): the title, one paragraph, the
// promises behind "How your answers are handled", the two buttons, and the
// decline at the foot. One decision on the
// screen: agree and start. Two text styles (the serif title, one body
// Text), centred on one axis, calm: air round the title, one gap between
// blocks; the decline a link alone, centred at the foot of the screen,
// apart from the buttons.

const styles = stylex.create({
  // The page's room: the column in the middle, the decline at its foot.
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    boxSizing: "border-box",
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
    paddingBlockStart: { default: space["8"], [media.sm]: space["10"] },
    // The decline at the foot stays clear of a phone's home bar.
    paddingBlockEnd: {
      default: `max(${space["4"]}, env(safe-area-inset-bottom))`,
      [media.sm]: `max(${space["8"]}, env(safe-area-inset-bottom))`,
    },
    textAlign: "center",
  },
  // The column takes the room above the foot, and stands in its middle.
  column: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "safe center",
    flexGrow: 1,
    gap: space["8"],
    width: "100%",
    maxWidth: "26rem",
  },
  // Inside a block: the smaller gap.
  block: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["4"],
    width: "100%",
  },
  // The two buttons: one height; side by side from a tablet, stacked full width on a phone, the main one first.
  buttons: {
    display: "flex",
    flexDirection: { default: "column", [media.sm]: "row" },
    gap: space["3"],
    width: "100%",
  },
  grow: { flexGrow: 1, flexBasis: 0 },
  // Each promise a plain line of its own, in the panel's words.
  line: { display: "block" },
  // The fold-out as wide as its words, on the centre axis with the rest. Damsko's `fitContent`
  // trigger reports a width about 16px short of its label and chevron, so a box shrunk to it
  // wraps the label (reported to Damsko); until that is fixed, it stands at least this wide.
  fit: { width: "auto", minWidth: "15rem", alignSelf: "center" },
  foot: {
    display: "flex",
    justifyContent: "center",
    paddingBlockStart: space["6"],
  },
});

/** A's start: one decision, centred. */
export const ConsentClean = ({
  altTitle,
  onAgree,
  onNotNow,
  onRatherNot,
}: {
  /** Ruben's alternative title, to compare (`&title=alt`). */
  altTitle: boolean;
  onAgree: () => void;
  onNotNow: () => void;
  onRatherNot: () => void;
}) => (
  <div {...stylex.props(styles.page)}>
    <div {...stylex.props(styles.column)}>
      <Heading level={1} size="xl">
        {altTitle ? copy.start.titleAlt : copy.start.title}
      </Heading>
      <div {...stylex.props(styles.block)}>
        <Text size="lg">{copy.start.who}</Text>
        <Collapsible fitContent style={styles.fit}>
          <CollapsibleTrigger>{copy.start.more}</CollapsibleTrigger>
          <CollapsibleContent>
            {copy.start.promises.map((promise) => (
              <span key={promise} {...stylex.props(styles.line)}>
                {promise}
              </span>
            ))}
          </CollapsibleContent>
        </Collapsible>
      </div>
      <div {...stylex.props(styles.buttons)}>
        <Button onClick={onAgree} size="lg" style={styles.grow}>
          {copy.start.agree}
        </Button>
        <Button
          onClick={onNotNow}
          size="lg"
          style={styles.grow}
          variant="outline"
        >
          {copy.start.later}
        </Button>
      </div>
    </div>
    <div {...stylex.props(styles.foot)}>
      <Button onClick={onRatherNot} size="lg" variant="link">
        {copy.start.decline}
      </Button>
    </div>
  </div>
);
