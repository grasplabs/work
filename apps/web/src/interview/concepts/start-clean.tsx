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

// CONCEPT ONLY: A's start, as Ruben shaped it (24 November), in his words
// (fixture.ts `copy.start`): the title on two lines, one short paragraph
// (B: and the promises behind "How your answers are handled"), the one
// button, and "Not right now" and "I'd rather skip this" as two quiet
// links at the foot. One decision on the
// screen: agree and start. Two text styles (the serif title, one body
// Text), centred on one axis, calm: air round the title, one gap between
// blocks; the decline a link alone, centred at the foot of the screen,
// apart from the buttons.

const styles = stylex.create({
  // The page's room: the column under the header, the two quiet links at its foot.
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
    // The links at the foot stay clear of a phone's home bar.
    paddingBlockEnd: {
      default: `max(${space["4"]}, env(safe-area-inset-bottom))`,
      [media.sm]: `max(${space["8"]}, env(safe-area-inset-bottom))`,
    },
    textAlign: "center",
  },
  // The column: on a phone in the middle of its room; on a laptop wide (about 720px of text) and
  // in the upper middle of the page, under the header, with presence (Ruben: "why do we have to
  // push everything so small").
  column: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: { default: "safe center", [media.lg]: "flex-start" },
    flexGrow: 1,
    gap: { default: space["8"], [media.lg]: space["10"] },
    width: "100%",
    maxWidth: { default: "26rem", [media.lg]: "45rem" },
    paddingBlockStart: { default: 0, [media.lg]: "14vh" },
  },
  // Inside a block: the smaller gap.
  block: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["4"],
    width: "100%",
  },
  // Each of the title's two lines a line of its own.
  titleLine: { display: "block" },
  // The one button: the whole width on a phone, its own width on a wider window.
  agree: { width: { default: "100%", [media.sm]: "auto" } },
  // Each promise a plain line of its own, in the panel's words.
  line: { display: "block" },
  // The fold-out as wide as its words, on the centre axis with the rest. Damsko's `fitContent`
  // trigger reports a width about 16px short of its label and chevron, so a box shrunk to it
  // wraps the label (fixed on Damsko's feat/onboarding-parts, not pushed); until then it stands
  // at least this wide.
  fit: { width: "auto", minWidth: "15rem", alignSelf: "center" },
  // The two quiet ways out, side by side at the foot, apart.
  foot: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    columnGap: space["8"],
    paddingBlockStart: space["6"],
  },
});

/** Which body Ruben is comparing: A the short paragraph alone, B the same with the fold-out. */
export type StartBody = "a" | "b";

/** A's start: one decision, centred. */
export const ConsentClean = ({
  altTitle,
  body,
  name,
  onAgree,
  onNotNow,
  onRatherNot,
}: {
  /** Ruben's alternative title, to compare (`&title=alt`). */
  altTitle: boolean;
  body: StartBody;
  /** The person's name in the title (`&name=` tries a long one). */
  name: string;
  onAgree: () => void;
  onNotNow: () => void;
  onRatherNot: () => void;
}) => (
  <div {...stylex.props(styles.page)}>
    <div {...stylex.props(styles.column)}>
      <Heading level={1} size="xl">
        {altTitle
          ? copy.start.titleAlt
          : copy.start.titleLines.map((line) => (
              <span key={line} {...stylex.props(styles.titleLine)}>
                {line.replace("{name}", name)}
              </span>
            ))}
      </Heading>
      <div {...stylex.props(styles.block)}>
        <Text size="lg">{copy.start.whoShort}</Text>
        {body === "b" ? (
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
        ) : null}
      </div>
      <Button onClick={onAgree} size="lg" style={styles.agree}>
        {copy.start.agree}
      </Button>
    </div>
    <div {...stylex.props(styles.foot)}>
      <Button onClick={onNotNow} size="lg" variant="link">
        {copy.start.later}
      </Button>
      <Button onClick={onRatherNot} size="lg" variant="link">
        {copy.start.decline}
      </Button>
    </div>
  </div>
);
