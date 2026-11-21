// Page skeleton, question: a page that asks one question at a time under what it is making.
// A route's first paint, as the product's New agent page draws it (its new-agent.tsx): the page's
// header, then one centred column of at most 44rem holding a preview card and the question under
// it. The card's picture is the stage at its real ratio (16:7, 4:3 under 40rem), plain, on the
// page's own paper, so what is made arrives into a stage already there; the question is QuestionTool's own `loading`, the question line and
// each choice's row in their boxes, Back and Next standing still. Nothing moves when it arrives.
//
//   <PageSkeletonQuestion question="What should the agent do?" choices={5} step={{ index: 0, count: 7 }} submitLabel="Next" />
//
// The column's and the picture's measures are exported (`questionPageStyles`) so the loaded page
// stands on the same boxes.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Card, CardMedia } from "../../card";
import { PageHeader } from "../../page-header";
import { QuestionTool, QuestionToolSubmit } from "../../question-tool";
import type { QuestionOption } from "../../question-tool";
import { grasp } from "../../tokens/tokens.stylex";

/** The question page's boxes, shared by the loaded page and its placeholder. */
export const questionPageStyles = stylex.create({
  // The page: its header, then the column, as the product's Page lays them.
  page: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.pageGap,
    width: "100%",
  },
  // One centred column: the preview card, then the question.
  column: {
    display: "grid",
    gap: grasp.space5,
    width: "100%",
    maxWidth: "44rem",
    marginInline: "auto",
  },
  // The preview's picture: 16:7, and 4:3 on a narrow screen.
  picture: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    aspectRatio: { default: "16 / 7", "@media (width < 40rem)": "4 / 3" },
    isolation: "isolate",
  },
  // The question as wide as the card above it.
  question: { width: "100%", maxWidth: "none" },
});

const waits = stylex.create({
  // The stage waits as its own ground: the page's paper, plain, with nothing drawn on it.
  stage: { backgroundColor: grasp.paper },
});

// It waits, so nothing is ever sent from it.
const noAnswer = () => null;

export interface PageSkeletonQuestionProps {
  /** The first question, when it is the page's own words (they need no data): it stands as words, so it wraps where it will. Without it, a quiet line. */
  question?: string;
  /** How many choices the first question offers (its Other row comes after them). @default 4 */
  choices?: number;
  /** Whether each choice has a line under its words, as the first question's do. @default true */
  described?: boolean;
  /** Whether the question has an Other row, for an answer of the person's own. @default true */
  other?: boolean;
  /** The question's place, when it is one of several asked in turn ("1 of 7"). */
  step?: { index: number; count: number };
  /** Send's words, as the loaded question has them ("Next"). */
  submitLabel?: string;
  /** The page's actions, as the loaded page has them (they need no data): drawn in their place. */
  actions?: ReactNode;
}

/** A question page before it arrives: the header's placeholder, the preview's still picture, and the question waiting. */
export const PageSkeletonQuestion = ({
  question = "",
  choices = 4,
  described = true,
  other = true,
  step,
  submitLabel,
  actions,
}: PageSkeletonQuestionProps) => {
  // Rows to wait in: as many as the question will offer, each with its line under the words.
  const options: QuestionOption[] = Array.from(
    { length: choices },
    (_, index) => ({
      value: String(index),
      label: "",
      ...(described ? { description: " " } : {}),
    })
  );
  return (
    <div
      data-slot="page-skeleton-question"
      {...stylex.props(questionPageStyles.page)}
    >
      <PageHeader title="" actions={actions} loading />
      <div {...stylex.props(questionPageStyles.column)}>
        <Card>
          <CardMedia>
            <span
              data-slot="question-page-picture"
              {...stylex.props(questionPageStyles.picture, waits.stage)}
            />
          </CardMedia>
        </Card>
        <QuestionTool
          loading
          kind="single"
          question={question}
          options={options}
          other={other}
          onSubmit={noAnswer}
          layout={questionPageStyles.question}
          {...(step === undefined ? {} : { step })}
        >
          {submitLabel === undefined ? null : (
            <QuestionToolSubmit>{submitLabel}</QuestionToolSubmit>
          )}
        </QuestionTool>
      </div>
    </div>
  );
};
