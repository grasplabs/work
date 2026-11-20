// StepBar: the quiet bar at the top of a guided flow, one question at a time (New agent's guided
// setup): Back at the start and Next at the end as ghost arrow buttons, each named in its tip, and
// between them the thin progress, said as "Step 3 of 7" (shown small and muted with `showCount`).
// On the last step Next is a quiet word that says what it does ("Create agent"), in the same place.
// Nothing stands under the answer: the answer has the page to itself.
//
//   <StepBar step={{ index: 2, count: 7 }} onBack={back} />                  Next submits its form
//   <StepBar step={{ index: 6, count: 7 }} onBack={back} finishLabel="Create agent" loading={making} />
//   <StepBar step={{ index: 2, count: 7 }} onBack={back} disabled disabledReason="Give it a name to go on" />
//
// Back is hidden on the first step, its room kept, so the bar never moves. The keys are StepFoot's:
// Enter is Next where focus is not in a field of several lines or on another button; Mod+Enter is
// Next anywhere in the flow; Alt+← is Back (Alt+→ right to left). The flow is the form round it.
// StepFoot is the foot with a filled action, for forms that need one at their end.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import { useId, useRef } from "react";
import type { ReactElement, RefCallback, RefObject } from "react";

import { Button } from "../button";
import { ArrowLeft, ArrowRight } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { Progress } from "../progress";
import { useStepKeys } from "../step-foot/keys";
import { grasp } from "../tokens/tokens.stylex";
import { Tip } from "../tooltip/tip";
import { useWords } from "../words/words";
import { stepBarWords } from "./words";
import type { StepBarWords } from "./words";

/** What a caller may style: where the bar stands and how wide it is. */
export type StepBarLayoutStyle = LayoutStyle;

/** Every prop a StepBar takes. */
export interface StepBarProps {
  /** Where the flow stands: the step's index (from 0) and how many there are. */
  step: { index: number; count: number };
  /**
   * "Step 3 of 7" shown at the bar's end, small and muted, not only said with it.
   * @default false
   */
  showCount?: boolean;
  /** Goes back a step. Without it there is no Back; on the first step it is hidden, its room kept. */
  onBack?: () => unknown;
  /** Goes on. Without it, Next is its form's submit button (Enter in a field goes on, as a form's does). */
  onNext?: () => unknown;
  /** What Next says on the last step, a quiet word for what it does ("Create agent"). */
  finishLabel?: string;
  /**
   * Next waits: for an answer, or a check. With `disabledReason` it keeps its place in the keys and
   * says why in its tip.
   * @default false
   */
  disabled?: boolean;
  /** Why Next waits, in a few words ("Give it a name to go on"): its tip, and its description. */
  disabledReason?: string;
  /**
   * Next is working: Button's own spinner, its width held, and it cannot be pressed again. Give it (true
   * or false) on any step that may work, so Next keeps one width before and while it works.
   */
  loading?: boolean;
  /**
   * Before the flow's data (a page's first paint): the bar stands in its place, Back and Next as
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
  /** This instance's own words, over the catalogue's, key by key. */
  words?: Partial<StepBarWords>;
  /** Layout only: margins, alignment and width. */
  layout?: StepBarLayoutStyle;
}

const styles = stylex.create({
  // Three columns: Back's, the bar's (all the room), and Next's.
  bar: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    gap: grasp.space3,
    width: "100%",
    minWidth: 0,
  },
  // On the first step Back is not there to press, but its room is: the bar stays where it stands.
  kept: { visibility: "hidden", opacity: 0, pointerEvents: "none" },
  // The progress takes the room; the count, when shown, at its end.
  middle: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minWidth: 0,
  },
  progress: { flexGrow: 1, minWidth: 0 },
  count: {
    flexShrink: 0,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  end: { display: "flex", justifyContent: "flex-end" },
  // A button waiting: its own frame (its corner, a hairline, no fill) round it, the button unseen
  // inside, so the frame is exactly the button's size.
  frame: {
    display: "inline-flex",
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
  },
  // Opacity, not visibility: Button sets its own parts visible.
  unseen: { display: "inline-flex", opacity: 0 },
});

/** A button waiting: its own empty frame round it, the button unseen inside so the frame keeps its size. */
const Framed = ({
  waiting,
  children,
}: {
  waiting: boolean;
  children: ReactElement;
}) =>
  waiting ? (
    <span data-slot="step-bar-frame" {...stylex.props(styles.frame)}>
      <span {...stylex.props(styles.unseen)}>{children}</span>
    </span>
  ) : (
    children
  );

/** The bar's marks while it waits: busy, inert, and a data mark a check can read. */
const waitingMarks = (waiting: boolean) =>
  waiting ? { inert: true, "aria-busy": true, "data-waiting": "" } : {};

/** Whether its keys are on: not while it waits. */
const keysOn = (keys: boolean, waiting: boolean) => keys && !waiting;

/** Whether this is the last step. */
const isLast = (step: { index: number; count: number }) =>
  step.index >= step.count - 1;

/** Why Next waits, as its tip: only when it waits and the reason has words. */
const reasonOf = (disabled: boolean, reason: string | undefined) =>
  disabled && reason !== undefined && reason !== "" ? reason : undefined;

/** Back: a ghost arrow, named Back in its tip; hidden on the first step, its room kept. */
const BackArrow = ({
  first,
  go,
  label,
}: {
  first: boolean;
  go: () => void;
  label: string;
}) => (
  <span
    aria-hidden={first || undefined}
    inert={first || undefined}
    {...stylex.props(first && styles.kept)}
  >
    {/* The tip outside the press, so the press's own handler is the one the button keeps. Imported,
        not loaded late: a late swap of the element would drop its focus. */}
    <Tip
      tooltip={label}
      name
      render={(tip: Record<string, unknown>) => (
        <PressPrimitive
          {...tip}
          onClick={go}
          disabled={first}
          pendingAnnouncement=""
          render={(props: Record<string, unknown>) => (
            <Button
              {...props}
              variant="ghost"
              size="sm"
              icon={ArrowLeft}
              aria-label={label}
            />
          )}
        />
      )}
    />
  </span>
);

/** What Next needs. */
interface NextProps {
  next: RefObject<HTMLButtonElement | null>;
  onNext: (() => unknown) | undefined;
  label: string;
  last: boolean;
  disabled: boolean;
  reason: string | undefined;
  reasonId: string;
  loading: boolean | undefined;
}

/** Whether a tip's ref is a callback. */
const isRefCallback = (ref: unknown): ref is RefCallback<HTMLButtonElement> =>
  typeof ref === "function";
/** Whether a tip's ref is an object holding the element. */
const isRefObject = (
  ref: unknown
): ref is RefObject<HTMLButtonElement | null> =>
  typeof ref === "object" && ref !== null && "current" in ref;

/** One ref for Next that is both the bar's own (for its keys) and its tip's (for the tip's anchor). */
const bothRefs =
  (own: RefObject<HTMLButtonElement | null>, tip: unknown) =>
  (element: HTMLButtonElement | null) => {
    own.current = element;
    if (isRefCallback(tip)) {
      tip(element);
    } else if (isRefObject(tip)) {
      tip.current = element;
    }
  };

/** Next's working state, where the host says it may work: idle or working, its width the same. */
const statusOf = (loading: boolean | undefined, label: string) =>
  loading === undefined
    ? {}
    : {
        status: loading ? ("working" as const) : ("idle" as const),
        doneLabel: label,
        failedLabel: label,
      };

/** Next: a ghost arrow named in its tip; on the last step a quiet word for what it does. */
const NextArrow = ({
  next,
  onNext,
  label,
  last,
  disabled,
  reason,
  reasonId,
  loading,
}: NextProps) => {
  const look = {
    type: onNext === undefined ? ("submit" as const) : ("button" as const),
    variant: "ghost" as const,
    size: "sm" as const,
    disabled,
    focusableWhenDisabled: reason !== undefined,
    ...statusOf(loading, label),
  };
  return (
    <Tip
      tooltip={reason ?? label}
      name={!last && reason === undefined}
      render={(tip: Record<string, unknown>) => (
        <PressPrimitive
          {...tip}
          ref={bothRefs(next, tip.ref)}
          onClick={onNext}
          disabled={disabled}
          focusableWhenDisabled={reason !== undefined}
          aria-describedby={reason === undefined ? undefined : reasonId}
          pendingAnnouncement=""
          render={(props: Record<string, unknown>) =>
            last ? (
              <Button {...props} {...look}>
                {label}
              </Button>
            ) : (
              <Button
                {...props}
                {...look}
                icon={ArrowRight}
                aria-label={label}
              />
            )
          }
        />
      )}
    />
  );
};

/** The quiet bar at the top of a guided flow: Back, how far through, Next. */
export const StepBar = ({
  step,
  showCount = false,
  onBack,
  onNext,
  finishLabel,
  disabled = false,
  disabledReason,
  loading,
  keys = true,
  words: given,
  layout,
  waiting = false,
}: StepBarProps) => {
  const words = useWords("stepBar", stepBarWords, given);
  const bar = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const first = step.index === 0;
  const last = isLast(step);
  const backHere = onBack !== undefined && !first;
  const goBack = () => {
    if (backHere) {
      onBack();
    }
  };
  useStepKeys(keysOn(keys, waiting), bar, next, goBack);
  const reason = reasonOf(disabled, disabledReason);
  const said = words.step(step.index + 1, step.count);
  return (
    <div
      ref={bar}
      data-slot="step-bar"
      {...waitingMarks(waiting)}
      {...stylex.props(styles.bar, layout)}
    >
      {onBack === undefined ? (
        <span />
      ) : (
        // On the first step Back is hidden with its room kept: no frame there either.
        <Framed waiting={waiting && !first}>
          <BackArrow first={first} go={goBack} label={words.back} />
        </Framed>
      )}
      <span {...stylex.props(styles.middle)}>
        <Progress
          label={said}
          value={
            waiting ? 0 : Math.round(((step.index + 1) / step.count) * 100)
          }
          size="sm"
          showLabel={false}
          valueText={() => said}
          layout={styles.progress}
        />
        {showCount ? (
          <span aria-hidden="true" {...stylex.props(styles.count)}>
            {said}
          </span>
        ) : null}
      </span>
      <span {...stylex.props(styles.end)}>
        <Framed waiting={waiting}>
          <NextArrow
            next={next}
            onNext={onNext}
            label={last ? (finishLabel ?? words.next) : words.next}
            last={last}
            disabled={disabled}
            reason={reason}
            reasonId={reasonId}
            loading={loading}
          />
        </Framed>
        {reason === undefined ? null : (
          <span id={reasonId} hidden>
            {reason}
          </span>
        )}
      </span>
    </div>
  );
};
