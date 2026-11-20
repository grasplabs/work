// StepFoot: the foot of a guided flow, one question at a time (New agent's guided setup, a
// questionnaire): Back at the start, how far through in the middle (Progress, thin, said as
// "Step 3 of 7" and shown when asked), and Next at the end as the step's one action. On the last step
// Next says what it does ("Create agent"), with no arrow.
//
//   <StepFoot step={{ index: 2, count: 7 }} onBack={back} />                 Next submits its form
//   <StepFoot step={{ index: 6, count: 7 }} onBack={back} finishLabel="Create agent" loading={making} />
//   <StepFoot onBack={back} onNext={next} disabled disabledReason="Choose one to go on" />
//
// Back is hidden on the first step, its room kept, so the bar never jumps. On a phone it is the
// arrow alone, its word in a tip. The keys: Enter is Next where focus is not in a field of several
// lines or on another button; Mod+Enter is Next anywhere in the flow; Alt+← is Back (Alt+→ right to
// left). The flow is the form round it. Stepper is the list of named steps, for flows where people
// jump between them; a page may show a Stepper above and a StepFoot below.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import { useId, useRef } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";

import { Button } from "../button";
import { ArrowLeft, ArrowRight } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { Progress } from "../progress";
import { useStepKeys } from "../step-keys/step-keys";
import { grasp, media } from "../tokens/tokens.stylex";
import { WithTip } from "../tooltip/lazy-tip";
import { useWords } from "../words/words";
import { stepFootWords } from "./words";
import type { StepFootWords } from "./words";

/** What a caller may style: where the foot stands and how wide it is. */
export type StepFootLayoutStyle = LayoutStyle;

/** Every prop a StepFoot takes. */
export interface StepFootProps {
  /** Where the flow stands: the step's index (from 0) and how many there are. Without it, no bar. */
  step?: { index: number; count: number };
  /**
   * "Step 3 of 7" shown beside the bar, not only said with it.
   * @default false
   */
  showStep?: boolean;
  /** Goes back a step. Without it there is no Back; on the first step it is hidden, its room kept. */
  onBack?: () => unknown;
  /** Goes on. Without it, Next is its form's submit button (Enter in a field goes on, as a form's does). */
  onNext?: () => unknown;
  /**
   * What Next says on the last step: what it does ("Create agent"), with no arrow. The last step is
   * the step's last index, or this given with no `step`.
   */
  finishLabel?: string;
  /**
   * Next waits: for an answer, or a check. With `disabledReason` it keeps its place in the keys and
   * says why in its tip.
   * @default false
   */
  disabled?: boolean;
  /** Why Next waits, in a few words ("Choose one to go on"): its tip, and its description. */
  disabledReason?: string;
  /**
   * Next is working: Button's own spinner, its width held, and it cannot be pressed again. Give it (true
   * or false) on any step that may work, so Next keeps one width before and while it works.
   */
  loading?: boolean;
  /** More before Next, at the end (a Skip): small ghost buttons. */
  extra?: ReactNode;
  /** Quiet words at the foot's start, read with Next (why it waits, where there is no bar). */
  note?: ReactNode;
  /**
   * Before the flow's data (a page's first paint): the foot stands in its place, Back and Next as
   * their own empty frames (their size and corner, a hairline, nothing in them) and the bar's track
   * still and empty; nothing in it can be pressed, and it says it is busy. Not `loading`, which is
   * Next at work.
   * @default false
   */
  waiting?: boolean;
  /**
   * Its keys: Enter, Mod+Enter and Alt+←. Off where the host has its own.
   * @default true
   */
  keys?: boolean;
  /**
   * `md` for a page's flow; `sm` inside a card, as a card's quiet foot: Back a ghost with its word and
   * no arrow, the same on a phone (Question tool's).
   * @default "md"
   */
  size?: "sm" | "md";
  /** This instance's own words, over the catalogue's, key by key. */
  words?: Partial<StepFootWords>;
  /** Layout only: margins, alignment and width. */
  layout?: StepFootLayoutStyle;
}

const PHONE = media.belowPhone;

const styles = stylex.create({
  // A button waiting: its own frame (its corner, a hairline, no fill) round it, its words unseen, so
  // the frame is exactly the button's size.
  frame: {
    position: "relative",
    display: "inline-flex",
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))`,
    cornerShape: grasp.cornerShape,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
  },
  frameSm: {
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
  },
  // Opacity, not visibility: Button sets its own parts visible.
  unseen: { display: "inline-flex", opacity: 0 },
  // Three columns: Back's, the bar's (all the room), and Next's. Without a bar, Back at the start and
  // Next at the end, as a card's foot.
  foot: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    gap: { default: grasp.space4, [PHONE]: grasp.space3 },
    width: "100%",
    minWidth: 0,
  },
  start: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  end: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: grasp.space2,
  },
  // On the first step Back is not there to press, but its room is: the bar stays where it stands.
  kept: { visibility: "hidden", opacity: 0, pointerEvents: "none" },
  // Back with its word, and the arrow alone on a phone: one shows at a time.
  wide: { display: { default: "inline-flex", [PHONE]: "none" } },
  narrow: { display: { default: "none", [PHONE]: "inline-flex" } },
  // With no bar, a card's foot: one row that wraps, its parts at the end, the words at the start
  // taking a line of their own when long, Back after them pushing the rest to the end.
  noBar: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: grasp.space2,
  },
  flat: { display: "contents" },
  backPush: { marginInlineEnd: "auto" },
  bar: { minWidth: 0 },
  // In a card the words at the start take the room, Back after them.
  startGrows: { flexGrow: 1 },
  note: {
    margin: 0,
    minWidth: 0,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    overflowWrap: "anywhere",
  },
});

/** What Back needs: whether it may go, what it does, its words and its look. */
interface BackProps {
  here: boolean;
  go: () => void;
  label: string;
  size: "sm" | "md";
  /** A card's foot: a ghost with its word, the same on a phone. */
  card: boolean;
  /** On a phone: the arrow alone, its word its name and tip. */
  narrow: boolean;
}

/** Back: a quiet button with its word and the arrow before it; a ghost in a card; the arrow alone on a phone. */
const BackButton = ({ here, go, label, size, card, narrow }: BackProps) =>
  narrow ? (
    // The arrow alone: its tip outside the press, so the press's own handler is the one the button keeps.
    <WithTip
      tooltip={label}
      name
      render={(tip: Record<string, unknown>) => (
        <PressPrimitive
          {...tip}
          onClick={go}
          disabled={!here}
          pendingAnnouncement=""
          render={(props: Record<string, unknown>) => (
            <Button
              {...props}
              variant="quiet"
              size={size}
              icon={ArrowLeft}
              aria-label={label}
            />
          )}
        />
      )}
    />
  ) : (
    <PressPrimitive
      onClick={go}
      disabled={!here}
      pendingAnnouncement=""
      render={(props: Record<string, unknown>) =>
        card ? (
          <Button {...props} variant="ghost" size={size}>
            {label}
          </Button>
        ) : (
          <Button {...props} variant="quiet" size={size} icon={ArrowLeft}>
            {label}
          </Button>
        )
      }
    />
  );

/** What Next needs. */
interface NextProps {
  next: RefObject<HTMLButtonElement | null>;
  onNext: (() => unknown) | undefined;
  label: string;
  last: boolean;
  size: "sm" | "md";
  disabled: boolean;
  reachable: boolean;
  /** Its tip: why it waits, where no note says it. */
  tooltip: string | undefined;
  describedBy: string | undefined;
  loading: boolean | undefined;
}

/** Next: the step's one action, its word and the arrow after it; on the last step what it does, no arrow. */
const NextButton = ({
  next,
  onNext,
  label,
  last,
  size,
  disabled,
  reachable,
  tooltip,
  describedBy,
  loading,
}: NextProps) => {
  const look = {
    ref: next,
    type: onNext === undefined ? ("submit" as const) : ("button" as const),
    variant: "ink" as const,
    size,
    iconEnd: last ? undefined : ArrowRight,
    disabled,
    focusableWhenDisabled: reachable,
  };
  return (
    <WithTip
      tooltip={tooltip}
      render={(tip: Record<string, unknown>) => (
        <PressPrimitive
          onClick={onNext}
          disabled={disabled}
          focusableWhenDisabled={reachable}
          aria-describedby={describedBy}
          pendingAnnouncement=""
          render={(props: Record<string, unknown>) =>
            loading === undefined ? (
              <Button {...props} {...tip} {...look}>
                {label}
              </Button>
            ) : (
              // Where the host says it may work: idle or working, its width the same either way. The
              // step's flow shows what came of it, not the button.
              <Button
                {...props}
                {...tip}
                {...look}
                status={loading ? "working" : "idle"}
                doneLabel={label}
                failedLabel={label}
              >
                {label}
              </Button>
            )
          }
        />
      )}
    />
  );
};

/** Back, hidden on the first step with its room kept: neither seen, nor reached, nor read. */
const BackPlace = ({
  first,
  flat,
  card,
  back,
}: {
  first: boolean;
  flat: boolean;
  card: boolean;
  back: Omit<BackProps, "card" | "narrow">;
}) => (
  <span
    aria-hidden={first || undefined}
    inert={first || undefined}
    {...stylex.props(
      styles.start,
      first && styles.kept,
      flat && styles.backPush
    )}
  >
    {card ? (
      <BackButton {...back} card narrow={false} />
    ) : (
      <>
        <span {...stylex.props(styles.wide)}>
          <BackButton {...back} card={false} narrow={false} />
        </span>
        <span {...stylex.props(styles.narrow)}>
          <BackButton {...back} card={false} narrow />
        </span>
      </>
    )}
  </span>
);

/** The foot's marks while it waits: busy, inert, and a data mark a check can read. */
const waitingMarks = (waiting: boolean) =>
  waiting ? { inert: true, "aria-busy": true, "data-waiting": "" } : {};

/** Whether its keys are on: not while it waits. */
const keysOn = (keys: boolean, waiting: boolean) => keys && !waiting;

/** Whether Back draws its frame: only where it shows, never on the first step. */
const framesBack = (waiting: boolean, first: boolean) => waiting && !first;

/** A button waiting: its own empty frame round it, the button unseen inside so the frame keeps its size. */
const Framed = ({
  waiting,
  size,
  children,
}: {
  waiting: boolean;
  size: "sm" | "md";
  children: ReactElement;
}) =>
  waiting ? (
    <span
      data-slot="step-foot-frame"
      {...stylex.props(styles.frame, size === "sm" && styles.frameSm)}
    >
      <span {...stylex.props(styles.unseen)}>{children}</span>
    </span>
  ) : (
    children
  );

/** How far through: the thin bar, said as "Step 3 of 7". */
const Bar = ({
  step,
  showStep,
  words,
  empty,
}: {
  step: { index: number; count: number };
  showStep: boolean;
  words: StepFootWords;
  empty: boolean;
}) => {
  const said = words.step(step.index + 1, step.count);
  return (
    <span {...stylex.props(styles.bar)}>
      <Progress
        label={said}
        value={empty ? 0 : Math.round(((step.index + 1) / step.count) * 100)}
        size="sm"
        showLabel={showStep}
        valueText={() => said}
      />
    </span>
  );
};

/** Whether a note has words to show. */
const hasNote = (note: ReactNode) =>
  note !== undefined && note !== null && note !== false && note !== "";

/** Why Next waits, as its tip: only when it waits and the reason has words. */
const reasonOf = (disabled: boolean, reason: string | undefined) =>
  disabled && reason !== undefined && reason !== "" ? reason : undefined;

/** Whether this step is the last: its index is, or with no step, a finish label is given. */
const isLast = (step: StepFootProps["step"], finishLabel: string | undefined) =>
  finishLabel !== undefined &&
  (step === undefined || step.index === step.count - 1);

/** The foot of a guided flow: Back, how far through, and the step's one action. */
export const StepFoot = ({
  step,
  showStep = false,
  onBack,
  onNext,
  finishLabel,
  disabled = false,
  disabledReason,
  loading,
  extra,
  note,
  keys = true,
  size = "md",
  words: given,
  layout,
  waiting = false,
}: StepFootProps) => {
  const words = useWords("stepFoot", stepFootWords, given);
  const foot = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const first = step?.index === 0;
  const last = isLast(step, finishLabel);
  const backHere = onBack !== undefined && !first;
  const goBack = () => {
    if (backHere) {
      onBack();
    }
  };
  useStepKeys(keysOn(keys, waiting), foot, next, goBack);
  const reason = reasonOf(disabled, disabledReason);
  const noted = hasNote(note);
  // Held with a reason, Next keeps its place in the keys: the reason is its tip, or the note it is read with.
  const reachable = disabled && (reason !== undefined || noted);
  const flat = step === undefined;
  // Waiting: the foot says it is busy, and nothing in it can be pressed.
  const still = waitingMarks(waiting);
  return (
    <div
      ref={foot}
      data-slot="step-foot"
      {...still}
      {...stylex.props(styles.foot, flat && styles.noBar, layout)}
    >
      <span {...stylex.props(styles.start, flat && styles.flat)}>
        {noted ? (
          <p id={reasonId} {...stylex.props(styles.note, styles.startGrows)}>
            {note}
          </p>
        ) : null}
        {onBack === undefined ? null : (
          // On the first step Back is hidden with its room kept: no frame there either.
          <Framed waiting={framesBack(waiting, first)} size={size}>
            <BackPlace
              first={first}
              flat={flat}
              card={size === "sm"}
              back={{ here: backHere, go: goBack, label: words.back, size }}
            />
          </Framed>
        )}
      </span>
      {step === undefined ? null : (
        <Bar step={step} showStep={showStep} words={words} empty={waiting} />
      )}
      <span {...stylex.props(styles.end, flat && styles.flat)}>
        {extra}
        <Framed waiting={waiting} size={size}>
          <NextButton
            next={next}
            onNext={onNext}
            label={last ? (finishLabel ?? words.next) : words.next}
            last={last}
            size={size}
            disabled={disabled}
            reachable={reachable}
            tooltip={noted ? undefined : reason}
            describedBy={noted ? reasonId : undefined}
            loading={loading}
          />
        </Framed>
      </span>
    </div>
  );
};
