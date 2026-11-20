// Page skeleton, setup: a guided setup that asks one large question at a time on the backdrop.
// A route's first paint, as the product's manual New agent draws it (its manual-agent.tsx and
// setup/question.tsx): the backdrop is the canvas and stands as it will; above the question the
// progress at its real place and the figure's spot, the page's aura with no figure in it; in the
// page's middle the question (the page's own words where it is given, else a quiet line) and its
// answer's empty field; under it the two arrows. Nothing moves when the setup arrives.
//
//   <PageSkeletonSetup question="What should we call your agent?"
//     progress={<Progress label="Step 1 of 9" value={11} layout={setupPageStyles.progress} />}
//     actions={<><Button aria-label="Back" icon={ArrowLeft} size="sm" variant="ghost" /><Button aria-label="Next" icon={ArrowRight} size="sm" variant="ink" disabled /></>} />
//
// The setup's measures are exported (`setupPageStyles`) so the loaded setup stands on the same boxes.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { AgentFigureAura } from "../../agent-figure";
import type { AgentFigureLook } from "../../agent-figure";
import { Backdrop } from "../../backdrop";
import type { BackdropLook } from "../../backdrop";
import { Heading } from "../../heading";
import { Skeleton } from "../../skeleton";
import { Text } from "../../text";
import { grasp } from "../../tokens/tokens.stylex";

/** The setup's boxes, shared by the loaded setup and its placeholder. */
export const setupPageStyles = stylex.create({
  // The backdrop is the canvas: the whole room, the setup straight on it.
  ground: {
    display: "grid",
    flexGrow: 1,
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    paddingInline: grasp.space6,
    paddingBlock: grasp.space6,
  },
  // Three rows round the question, so its answer stands in the room's very middle.
  stage: {
    display: "grid",
    gridTemplateRows: "1fr auto 1fr",
    justifyItems: "center",
    gap: grasp.space6,
    width: "100%",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  // Above the question: the progress, then the figure.
  top: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space6,
    width: "100%",
  },
  progress: { width: "100%", maxWidth: "14rem" },
  // The question's column, never wider than 40rem.
  middle: {
    boxSizing: "content-box",
    width: "100%",
    maxWidth: "40rem",
    minHeight: 0,
    padding: grasp.space3,
    margin: `calc(-1 * ${grasp.space3})`,
  },
  // The question: what it asks, its line, and its answer.
  question: { display: "grid", gap: grasp.space6 },
  asked: {
    display: "grid",
    justifyItems: "center",
    gap: grasp.space3,
    textAlign: "center",
  },
  // The two arrows together, right under the answer, at its end.
  foot: {
    display: "flex",
    alignSelf: "start",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: grasp.space2,
    width: "100%",
    maxWidth: "40rem",
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
  // The progress when the host gives none: its label's line over an empty track.
  progressWait: { display: "grid", gap: grasp.space2 },
  track: {
    height: grasp.progressMd,
    borderRadius: grasp.cornerCircle,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
  },
  // An arrow's own frame when the host gives none: a small square control.
  arrow: {
    boxSizing: "border-box",
    width: grasp.controlSm,
    height: grasp.controlSm,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
  },
});

const dots: BackdropLook = { backdrop: "dots", pattern: "bayer", tone: "mint" };
const unnamed: AgentFigureLook = { shape: "orb", palette: "evergreen" };

export interface PageSkeletonSetupProps {
  /** The question, when it is the page's own words (they need no data). Without it, a quiet line. */
  question?: string;
  /** A line under the question, where the page has one: its words, or `true` for a quiet line. */
  line?: string | boolean;
  /** The progress as the loaded setup has it (it needs no data), at `setupPageStyles.progress`. Without it, its label's line over an empty track. */
  progress?: ReactNode;
  /** The two arrows as the loaded setup has them (they need no data). Without them, their empty frames. */
  actions?: ReactNode;
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

/** A guided setup before it arrives: the backdrop, the progress, the aura's spot, the question and its empty answer. */
export const PageSkeletonSetup = ({
  question = "",
  line = false,
  progress,
  actions,
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
        {progress ?? (
          <span
            aria-hidden="true"
            data-slot="setup-progress"
            {...stylex.props(setupPageStyles.progress, waits.progressWait)}
          >
            <Skeleton layout={waits.line} />
            <span {...stylex.props(waits.track)} />
          </span>
        )}
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
          {...stylex.props(setupPageStyles.question)}
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
      <div data-slot="setup-foot" {...stylex.props(setupPageStyles.foot)}>
        {actions ?? (
          <>
            <span aria-hidden="true" {...stylex.props(waits.arrow)} />
            <span aria-hidden="true" {...stylex.props(waits.arrow)} />
          </>
        )}
      </div>
    </div>
  </Backdrop>
);
