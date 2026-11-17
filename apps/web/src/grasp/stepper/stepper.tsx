// Stepper: progress through named steps, across or down. Each step has a mark and a name: a number
// while it is coming, the ink fill on the step you are on, a tick once it is done, and a cross on a
// danger tint when it failed. Hairlines join the marks and stop short of them. Palermo has no
// stepper; this follows Grasp's tokens: the mark is a chip's height, the current step takes the
// main action's fill, and a failed one the danger tint, as an Alert does.
//
//   <Stepper
//     label="Setting up the workspace"
//     current={1}
//     steps={[{ label: "Details" }, { label: "Members" }, { label: "Billing" }]}
//   />
//
// On a phone, running across, only the current or a failed step shows its name; the others are
// still read.
// It shows progress; with `onSelect` a done step is also a way back to it. An ordered list, with the step you are
// on marked `aria-current="step"` and each step's state said in words. Every value is a token
// (src/tokens). A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Cross, Icon, Tick } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { LookStepper } from "./looks";

/** Where a step is: done, the one you are on, still to come, or failed. */
export type StepperState = "done" | "current" | "coming" | "failed";

/** One step. */
export interface StepperStep {
  /** Its name, in a word or two ("Members"). */
  label: string;
  /** A line under the name, shown when the stepper runs down. */
  description?: ReactNode;
  /**
   * Its state, when it is not what `current` says: `failed` for a step that stopped. Otherwise the
   * steps before `current` are done, and the ones after it are coming.
   */
  state?: StepperState;
}

/** What a caller may style: where the stepper sits, and how wide it is. Never its look. */
export type StepperLayoutStyle = LayoutStyle;

/** Every prop a Stepper takes. */
export interface StepperProps {
  /** The steps, in order. */
  steps: readonly StepperStep[];
  /**
   * The step you are on, counted from 0. Past the last step, every step is done.
   * @default 0
   */
  current?: number;
  /**
   * `horizontal` runs across, the names beside their marks; `vertical` runs down, with room for
   * each step's description.
   * @default "horizontal"
   */
  orientation?: "horizontal" | "vertical";
  /** What the steps are for, for a screen reader ("Setting up the workspace"). */
  label: string;
  /**
   * How each state is said to a screen reader, in the page's language.
   * @default { done: "done", current: "current step", coming: "not started", failed: "failed" }
   */
  stateLabels?: Partial<Record<StepperState, string>>;
  /** Layout only: where it sits, and how wide it is. */
  style?: StepperLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: StepperLayoutStyle;
  /**
   * How it is drawn. `light`: the light on the line: small dots on a quiet line, done solid in the
   * value colour, the current step a filled dot with one quiet ring, and while it is `working` the
   * working light travelling the line toward the next step. `dither`: tiles joined
   * by bands of dots that resolve from sparse to dense as a step is done. `serif`: large Geist
   * Serif numerals, a mint underline sliding from step to step. `classic`: the first design, a
   * ring of marks joined by hairlines. Provisional: Ruben chooses one.
   * @default "light"
   */
  look?: StepperLook;
  /**
   * The current step is in progress: its ring gives way to the working light, travelling the line
   * toward the next step (ambient and slow; still with reduced motion). Leave it out, or false, when
   * the step waits on the person. The light look only.
   * @default false
   */
  working?: boolean;
  /**
   * Called with a done step's index when the person presses it, to go back to it. Given, every done
   * step is a button (a 44px target); left out, the stepper only shows progress.
   */
  onSelect?: (index: number) => void;
  /**
   * The words for where the person is, said to a screen reader when the step changes and shown
   * across a phone in place of the names.
   * @default (step, total) => `Step ${step} of ${total}`
   */
  countLabel?: (step: number, total: number) => string;
  /**
   * Said when every step is done.
   * @default "All steps done"
   */
  finishedLabel?: string;
}

/** How a stepper is drawn: see `look`. */
export type StepperLook = "light" | "dither" | "serif" | "classic";

const REDUCED = media.reduced;
const FORCED = media.forced;

const styles = stylex.create({
  list: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    margin: 0,
    padding: 0,
    listStyle: "none",
    minWidth: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  across: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: grasp.stepperLineGap,
  },
  down: {
    flexDirection: "column",
  },
  // ---- A step running across: its mark and name, then a line to the next ----
  stepAcross: {
    display: "flex",
    alignItems: "center",
    columnGap: grasp.stepperLineGap,
    minWidth: 0,
  },
  // Every step but the last takes a share of the room, for its line to the next.
  grow: {
    flexGrow: 1,
  },
  // The mark never shrinks; on a narrow row the name wraps under itself instead of pushing the
  // row wider than what holds it.
  pair: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    flexShrink: 1,
    minWidth: 0,
  },
  lineAcross: {
    flexGrow: 1,
    flexShrink: 0,
    minWidth: grasp.space4,
    height: grasp.hairline,
    backgroundColor: { default: grasp.line, [FORCED]: "CanvasText" },
  },
  // A done step that can be gone back to (onSelect): its mark and name are one button, with an
  // unseen area that makes it a 44px target without making the row taller.
  press: {
    position: "relative",
    justifySelf: "start",
    margin: 0,
    marginInline: `calc(-1 * ${grasp.space1})`,
    paddingBlock: 0,
    paddingInline: grasp.space1,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: "transparent",
      ":hover": grasp.itemFillHighlight,
    },
    color: "inherit",
    font: "inherit",
    textAlign: "inherit",
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  target: {
    position: "absolute",
    insetInline: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    insetBlock: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
  },
  // Across a phone, once every step is done no name is left showing: the finished words stand
  // under the marks instead, as in Grasp's own looks.
  finished: {
    display: { default: "none", [media.belowPhone]: "block" },
    marginBlock: `${grasp.space2} 0`,
    marginInline: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
    textAlign: "center",
  },
  // ---- A step running down: the mark with a line under it, then the words ----
  stepDown: {
    display: "grid",
    gridTemplateColumns: `${grasp.stepperMark} minmax(0, 1fr)`,
    columnGap: grasp.space3,
  },
  rail: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    rowGap: grasp.stepperLineGap,
  },
  lineDown: {
    flexGrow: 1,
    width: grasp.hairline,
    minHeight: grasp.space4,
    marginBlockEnd: grasp.stepperLineGap,
    backgroundColor: { default: grasp.line, [FORCED]: "CanvasText" },
  },
  wordsDown: {
    display: "grid",
    alignContent: "start",
    rowGap: grasp.space1,
    minWidth: 0,
    // The name sits centred on the mark; the room under the words belongs to the line.
    paddingBlockStart: `calc((${grasp.stepperMark} - ${grasp.textSmLine}) / 2)`,
    paddingBlockEnd: grasp.space5,
  },
  lastDown: {
    paddingBlockEnd: 0,
  },
  // ---- The mark ----
  mark: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.stepperMark,
    height: grasp.stepperMark,
    borderRadius: grasp.cornerCircle,
    fontSize: grasp.textXs,
    lineHeight: 1,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
    // In forced colours the fills are dropped, so a ring draws every mark.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    transitionProperty: {
      default: "background-color, color, box-shadow",
      [REDUCED]: "none",
    },
    transitionDuration: grasp.durationMark,
    transitionTimingFunction: grasp.ease,
  },
  markComing: {
    color: grasp.muted,
    boxShadow: `inset 0 0 0 ${grasp.hairline} ${grasp.line}`,
  },
  markCurrent: {
    color: grasp.actionText,
    backgroundColor: grasp.actionFill,
  },
  markDone: {
    color: grasp.ink,
    backgroundColor: grasp.soft,
    boxShadow: `inset 0 0 0 ${grasp.hairline} ${grasp.line}`,
  },
  markFailed: {
    color: grasp.danger,
    backgroundColor: grasp.dangerSoft,
  },
  // ---- The words ----
  name: {
    minWidth: 0,
    overflowWrap: "break-word",
  },
  // On a phone a row has room for one name: across, only the current step and a failed one show
  // their own, and the others keep theirs for a screen reader.
  nameAside: {
    position: { default: null, [media.belowPhone]: "absolute" },
    width: { default: null, [media.belowPhone]: 1 },
    height: { default: null, [media.belowPhone]: 1 },
    margin: { default: null, [media.belowPhone]: -1 },
    overflow: { default: null, [media.belowPhone]: "hidden" },
    clipPath: { default: null, [media.belowPhone]: "inset(50%)" },
    whiteSpace: { default: null, [media.belowPhone]: "nowrap" },
  },
  nameComing: { color: grasp.muted },
  nameCurrent: { color: grasp.ink, fontWeight: grasp.weightMedium },
  nameDone: { color: grasp.text },
  nameFailed: { color: grasp.danger, fontWeight: grasp.weightMedium },
  description: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    textWrap: "pretty",
  },
});

const marks = {
  coming: styles.markComing,
  current: styles.markCurrent,
  done: styles.markDone,
  failed: styles.markFailed,
} as const;
const names = {
  coming: styles.nameComing,
  current: styles.nameCurrent,
  done: styles.nameDone,
  failed: styles.nameFailed,
} as const;
const defaultSaid: Record<StepperState, string> = {
  done: "done",
  current: "current step",
  coming: "not started",
  failed: "failed",
};

/** Where a step stands from `current`, when it says nothing of its own. */
const placeOf = (index: number, current: number): StepperState => {
  if (index < current) {
    return "done";
  }
  return index === current ? "current" : "coming";
};

/** A step's state: its own, or where it stands from `current`. */
const stateOf = (
  step: StepperStep,
  index: number,
  current: number
): StepperState => step.state ?? placeOf(index, current);

/** What a mark holds: a tick once done, a cross when failed, its number otherwise. */
const markContent = (state: StepperState, number: number) => {
  if (state === "done") {
    return <Icon icon={Tick} />;
  }
  return state === "failed" ? <Icon icon={Cross} /> : number;
};

const Mark = ({ state, number }: { state: StepperState; number: number }) => (
  <span
    aria-hidden="true"
    data-state={state}
    {...stylex.props(styles.mark, marks[state])}
  >
    {markContent(state, number)}
  </span>
);

/** A done step's mark and name as a button, when it can be gone back to; else as they are. */
/** What is drawn now: a ReactNode that is not a promise. */
type Drawn = Exclude<ReactNode, Promise<unknown>>;

// Its children are drawn now, never a promise (React 19's ReactNode may be one, which would make this
// function "return a promise" to the product's lint).
const Pressed = ({
  onSelect,
  index,
  pair,
  children,
}: {
  onSelect: ((index: number) => void) | undefined;
  index: number;
  pair: boolean;
  children: Drawn;
}) => {
  if (onSelect === undefined) {
    return pair ? (
      <span {...stylex.props(styles.pair)}>{children}</span>
    ) : (
      children
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        onSelect(index);
      }}
      {...stylex.props(pair && styles.pair, styles.press, focus.ring)}
    >
      <span aria-hidden="true" {...stylex.props(styles.target)} />
      {children}
    </button>
  );
};

const ClassicStepper = ({
  steps,
  current = 0,
  orientation = "horizontal",
  label,
  stateLabels,
  style: styleProp,
  layout,
  onSelect,
  finishedLabel = "All steps done",
}: StepperProps) => {
  const said = { ...defaultSaid, ...stateLabels };
  const across = orientation === "horizontal";
  const finished = across && current >= steps.length;
  return (
    <>
      <ol
        data-slot="stepper"
        aria-label={label}
        {...stylex.props(
          styles.list,
          across ? styles.across : styles.down,
          layout ?? styleProp
        )}
      >
        {steps.map((step, index) => {
          const state = stateOf(step, index, current);
          const last = index === steps.length - 1;
          const select = state === "done" ? onSelect : undefined;
          const name = (
            <span
              {...stylex.props(
                styles.name,
                names[state],
                across &&
                  state !== "current" &&
                  state !== "failed" &&
                  styles.nameAside
              )}
            >
              {step.label}
              <span {...stylex.props(visuallyHidden)}>, {said[state]}</span>
            </span>
          );
          if (across) {
            return (
              <li
                key={`${index}-${step.label}`}
                aria-current={state === "current" ? "step" : undefined}
                {...stylex.props(styles.stepAcross, !last && styles.grow)}
              >
                <Pressed onSelect={select} index={index} pair>
                  <Mark state={state} number={index + 1} />
                  {name}
                </Pressed>
                {!last && (
                  <span
                    aria-hidden="true"
                    {...stylex.props(styles.lineAcross)}
                  />
                )}
              </li>
            );
          }
          return (
            <li
              key={`${index}-${step.label}`}
              aria-current={state === "current" ? "step" : undefined}
              {...stylex.props(styles.stepDown)}
            >
              <span {...stylex.props(styles.rail)}>
                <Mark state={state} number={index + 1} />
                {!last && (
                  <span aria-hidden="true" {...stylex.props(styles.lineDown)} />
                )}
              </span>
              <span
                {...stylex.props(styles.wordsDown, last && styles.lastDown)}
              >
                <Pressed onSelect={select} index={index} pair={false}>
                  {name}
                </Pressed>
                {step.description !== undefined && (
                  <span {...stylex.props(styles.description)}>
                    {step.description}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {finished && (
        <p aria-hidden="true" {...stylex.props(styles.finished)}>
          {finishedLabel}
        </p>
      )}
    </>
  );
};

/** A Stepper: classic, or one of Grasp's own looks (./looks.tsx). */
export const Stepper = (props: StepperProps) => {
  if (props.look === "classic") {
    return <ClassicStepper {...props} />;
  }
  return <LookStepper {...props} />;
};
