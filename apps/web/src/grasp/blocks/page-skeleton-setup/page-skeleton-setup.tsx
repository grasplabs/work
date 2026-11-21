// Page skeleton, setup: a guided setup that asks one large question at a time on the backdrop.
// A route's first paint, as the product's guided New agent draws it (its manual-agent.tsx and
// setup/question.tsx, its Back and Next the library's StepBar at the top): the backdrop is the canvas and stands as it
// will; above the question the figure's spot, the page's aura with no figure in it; in the page's
// middle the question (the page's own words where it is given, else a quiet line) and its answer's
// empty field. At the top of the question's column, StepBar `waiting` at the step it opens on: Back
// and Next their empty frames, the bar's track still. Nothing stands under the answer.
// Nothing moves when the setup arrives.
//
//   <PageSkeletonSetup question="What should we call your agent?" step={{ index: 0, count: 7 }} />
//
// The setup's measures are exported (`setupPageStyles`) so the loaded setup stands on the same boxes.
import * as stylex from "@stylexjs/stylex";

import { AgentFigureAura } from "../../agent-figure";
import type { AgentFigureLook } from "../../agent-figure";
import { Backdrop } from "../../backdrop";
import type { BackdropLook } from "../../backdrop";
import { Heading } from "../../heading";
import { Skeleton } from "../../skeleton";
import { StepBar } from "../../step-bar";
import { Text } from "../../text";
import { grasp } from "../../tokens/tokens.stylex";

/** The setup's boxes, shared by the loaded setup and its placeholder. */
export const setupPageStyles = stylex.create({
  // The backdrop is the canvas: it grows into the room under the page's bar and may shrink, never
  // taller than that room (a height of 100% would overshoot it by the bar's own height).
  ground: {
    display: "grid",
    flexGrow: 1,
    boxSizing: "border-box",
    width: "100%",
    minHeight: 0,
    paddingInline: grasp.space6,
    paddingBlock: grasp.space6,
  },
  // Three rows round the question, so its answer stands in the room's very middle: the figure and
  // the foot keep their room, and a question taller than what is left scrolls in its own row.
  stage: {
    display: "grid",
    gridTemplateRows:
      "minmax(min-content, 1fr) minmax(0, auto) minmax(min-content, 1fr)",
    justifyItems: "center",
    gap: grasp.space6,
    width: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  // Above the question: StepBar at the row's top, the figure at its foot.
  top: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space6,
    width: "100%",
  },
  // StepBar at the top of the question's column, at its width.
  bar: { width: "100%", maxWidth: "40rem" },
  // The question's row, never wider than 40rem: it scrolls, not the page, with room for a ring on
  // its edge taken back outside.
  middle: {
    boxSizing: "content-box",
    width: "100%",
    maxWidth: "40rem",
    minHeight: 0,
    overflowY: "auto",
    scrollbarWidth: "none",
    padding: grasp.space3,
    margin: `calc(-1 * ${grasp.space3})`,
  },
  // The question: what it asks, its line, and its answer.
  column: { display: "grid", gap: grasp.space6 },
  asked: {
    display: "grid",
    justifyItems: "center",
    gap: grasp.space3,
    textAlign: "center",
  },
});

const waits = stylex.create({
  // The figure's spot: a large figure's box, holding the page's aura with no figure.
  figure: {
    position: "relative",
    display: "block",
    width: "128px",
    height: "128px",
    overflow: "hidden",
    borderRadius: grasp.cornerCircle,
    isolation: "isolate",
  },
  // The question's line at the page title's height.
  question: { width: "22rem", maxWidth: "100%", height: grasp.titleLgLine },
  line: { width: "14rem", maxWidth: "100%" },
  // The answer: a large field's own empty frame (its height, corner and hairline, no fill).
  answer: {
    boxSizing: "border-box",
    width: "100%",
    height: grasp.controlLg,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlLg} / 2))`,
    cornerShape: grasp.cornerShape,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
  },
});

const dots: BackdropLook = { backdrop: "dots", pattern: "bayer", tone: "mint" };
const unnamed: AgentFigureLook = { shape: "orb", palette: "evergreen" };
const firstOfSeven = { index: 0, count: 7 };

export interface PageSkeletonSetupProps {
  /** The question, when it is the page's own words (they need no data). Without it, a quiet line. */
  question?: string;
  /** A line under the question, where the page has one: its words, or `true` for a quiet line. */
  line?: string | boolean;
  /** The step the setup opens on, for StepBar's progress (and Back, hidden on the first). @default the first of seven */
  step?: { index: number; count: number };
  /** The look the figure's aura takes before it has a name. @default orb, evergreen */
  look?: AgentFigureLook;
  /** The backdrop the setup stands on, as the loaded setup has it. @default dots, bayer, mint */
  backdrop?: BackdropLook;
}

/** The question's line under it: its words, a quiet line, or none. */
const Line = ({ line }: { line: string | boolean }) => {
  if (line === false || line === "") {
    return null;
  }
  return line === true ? (
    <Skeleton layout={waits.line} />
  ) : (
    <Text tone="muted">{line}</Text>
  );
};

const stay = () => null;

/** A guided setup before it arrives: the backdrop, the aura's spot, StepBar waiting at the top, the question and its empty answer. */
export const PageSkeletonSetup = ({
  question = "",
  line = false,
  step = firstOfSeven,
  look = unnamed,
  backdrop = dots,
}: PageSkeletonSetupProps) => (
  <Backdrop variant={backdrop} fadeFoot layout={setupPageStyles.ground}>
    <div
      data-slot="page-skeleton-setup"
      aria-busy="true"
      {...stylex.props(setupPageStyles.stage)}
    >
      <div {...stylex.props(setupPageStyles.top)}>
        {/* StepBar waiting at the step the setup opens on: Back and Next their empty frames, the track still. */}
        <StepBar
          step={step}
          onBack={stay}
          onNext={stay}
          waiting
          layout={setupPageStyles.bar}
        />
        <span
          aria-hidden="true"
          data-slot="setup-figure"
          {...stylex.props(waits.figure)}
        >
          <AgentFigureAura ground="page" look={look} />
        </span>
      </div>
      <div {...stylex.props(setupPageStyles.middle)}>
        <div
          data-slot="setup-question"
          {...stylex.props(setupPageStyles.column)}
        >
          <span {...stylex.props(setupPageStyles.asked)}>
            {question === "" ? (
              <Skeleton layout={waits.question} />
            ) : (
              <Heading level={1}>{question}</Heading>
            )}
            <Line line={line} />
          </span>
          <span
            aria-hidden="true"
            data-slot="setup-answer"
            {...stylex.props(waits.answer)}
          />
        </div>
      </div>
    </div>
  </Backdrop>
);
