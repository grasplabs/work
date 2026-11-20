// Page skeleton, choice: a page that asks one question with a few picture cards to choose from.
// A route's first paint, as the product's New agent opens (its new-agent-start.tsx): a centred
// heading, a line under it, then the choices side by side (one above the other under 40rem), each
// a card whose picture stands as its stage, plain, on the page's own paper at its real ratio, with
// its title and its line as quiet lines under it. Words the page already knows (the question and
// its line) stand as words, so they wrap where they will; without them, quiet lines.
//
//   <PageSkeletonChoice heading="How do you want to make it?" line="You can change everything later." />
//
// The page's measures are exported (`choicePageStyles`) so the loaded page stands on the same boxes.
import * as stylex from "@stylexjs/stylex";

import { Card, CardMedia } from "../../card";
import { Heading } from "../../heading";
import { Skeleton } from "../../skeleton";
import { Text } from "../../text";
import { grasp } from "../../tokens/tokens.stylex";

/** The choice page's boxes, shared by the loaded page and its placeholder. */
export const choicePageStyles = stylex.create({
  // The question in the page's middle: it grows to fill the page's column and centres in it.
  middle: {
    display: "grid",
    flexGrow: 1,
    placeContent: "center",
    justifyItems: "center",
    gap: grasp.space4,
    textAlign: "center",
  },
  heading: { display: "grid", justifyItems: "center", gap: grasp.space2 },
  // The choices: cards of one width side by side, one above the other on a narrow screen.
  choices: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(var(--choices), minmax(0, 18rem))",
      "@media (width < 40rem)": "minmax(0, 18rem)",
    },
    gap: grasp.space4,
    marginBlockStart: grasp.space4,
    textAlign: "start",
  },
  // A choice's picture, the same size on every card.
  stage: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    aspectRatio: "4 / 3",
    isolation: "isolate",
    overflow: "hidden",
  },
  // The card's words under its picture.
  words: { display: "grid", gap: grasp.space1, marginBlockStart: grasp.space3 },
});

const waits = stylex.create({
  // How many choices stand side by side.
  count: (count: number) => ({ "--choices": String(count) }),
  // The stage waits as its own ground: the page's paper, plain.
  stage: { backgroundColor: grasp.paper },
  // The heading's line at a large title's height; the line under it at the text's.
  heading: { width: "20rem", maxWidth: "100%", height: grasp.titleLgLine },
  line: { width: "14rem", maxWidth: "100%" },
  // A card's title at a card title's height, and its lines at the description's.
  title: { width: "8rem", height: grasp.titleUiLine },
  // The description's lines run on with no gap, as its words' lines do.
  lines: { display: "grid" },
  description: { width: "100%", height: grasp.textMdTightLine },
  last: { width: "70%", height: grasp.textMdTightLine },
});

/** The line under the question: its words, a quiet line where they are not given, or none. */
const Line = ({ line }: { line: string | false }) => {
  if (line === false) {
    return null;
  }
  return line === "" ? (
    <Skeleton layout={waits.line} />
  ) : (
    <Text tone="muted">{line}</Text>
  );
};

export interface PageSkeletonChoiceProps {
  /** The question, when it is the page's own words (they need no data). Without it, a quiet line. */
  heading?: string;
  /** The line under the question, the page's own words. Without it, a quiet line; `false` for none. */
  line?: string | false;
  /** How many choices it offers. @default 2 */
  choices?: number;
  /** How many lines each card's description takes. @default 2 */
  cardLines?: number;
}

/** A choice page before it arrives: the question, then each choice's plain stage and quiet words. */
export const PageSkeletonChoice = ({
  heading = "",
  line = "",
  choices = 2,
  cardLines = 2,
}: PageSkeletonChoiceProps) => (
  <div
    data-slot="page-skeleton-choice"
    aria-busy="true"
    {...stylex.props(choicePageStyles.middle)}
  >
    <span
      data-slot="choice-heading"
      {...stylex.props(choicePageStyles.heading)}
    >
      {heading === "" ? (
        <Skeleton layout={waits.heading} />
      ) : (
        <Heading level={1}>{heading}</Heading>
      )}
      <Line line={line} />
    </span>
    <div
      aria-hidden="true"
      {...stylex.props(choicePageStyles.choices, waits.count(choices))}
    >
      {Array.from({ length: choices }, (_, index) => (
        <Card key={index}>
          <CardMedia>
            <span
              data-slot="choice-stage"
              {...stylex.props(choicePageStyles.stage, waits.stage)}
            />
          </CardMedia>
          <span
            data-slot="choice-words"
            {...stylex.props(choicePageStyles.words)}
          >
            <Skeleton layout={waits.title} />
            <span {...stylex.props(waits.lines)}>
              {Array.from({ length: cardLines }, (__, row) => (
                <Skeleton
                  key={row}
                  layout={
                    row === cardLines - 1 && cardLines > 1
                      ? waits.last
                      : waits.description
                  }
                />
              ))}
            </span>
          </span>
        </Card>
      ))}
    </div>
  </div>
);
