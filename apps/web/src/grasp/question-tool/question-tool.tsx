// QuestionTool: an assistant asks the person something and waits, after Profound's Palermo. A
// raised card with the question, its choices or a text box, and Skip and Send answer. One choice, several
// choices, or free text; a choice question has an Other row for an answer of the person's own.
//
//   <QuestionTool kind="single" question="Which report should I start with?" options={reports}
//     failedLabel="Could not send the answer" onSubmit={answer} onSkip={skip} />
//   <QuestionTool kind="multi" ... />        several choices
//   <QuestionTool kind="text" ... />         free text
//
// The choices are UI SDK's RadioGroup and CheckboxGroup, the text UI SDK's Input and Textarea, and
// Send answer UI SDK's Button, so an agent can answer by name, and an answer that fails to send fails for
// the agent too, with the words the person sees. Keys: arrows move, 1 to 9 choose, Enter submits.
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import {
  Checkbox as CheckboxPrimitive,
  CheckboxGroup as CheckboxGroupPrimitive,
} from "@ui-sdk/react/checkbox";
import { Input as InputPrimitive } from "@ui-sdk/react/input";
import {
  Radio as RadioPrimitive,
  RadioGroup as RadioGroupPrimitive,
} from "@ui-sdk/react/radio";
import { useEffect, useId, useRef, useState } from "react";
import type {
  KeyboardEvent,
  ReactElement,
  ReactNode,
  SubmitEvent,
} from "react";

import { Button } from "../button";
import { focus } from "../focus/focus";
import { Alert, Done, Icon, Plus, Tick } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { scroll } from "../scroll/scroll";
import { Textarea } from "../textarea";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { rowMarker } from "./markers.stylex";
import { questionToolWords } from "./words";
import type { QuestionToolWords } from "./words";

/** What a caller may style: where the card sits and how wide it is. Never its look. */
export type QuestionToolLayoutStyle = LayoutStyle;

/** One choice in a question. */
export interface QuestionOption {
  /** What is sent when it is chosen. */
  value: string;
  /** Its words, short ("Quarterly summary"). */
  label: string;
  /** One line under the words, when the choice needs it. */
  description?: string;
  /**
   * The choice the assistant recommends: a quiet mark after its words (`recommendedLabel`), said
   * with its name. Mark one choice at most.
   * @default false
   */
  recommended?: boolean;
}

/**
 * A question's answer while the person gives it, before it is sent: what the caller holds to keep
 * it across steps (Back) or a change of kind.
 */
export interface QuestionAnswer {
  /** The chosen choices' values, in the order chosen; for `single`, one at most. */
  values: string[];
  /** Whether the Other row is chosen. */
  other: boolean;
  /** The words written: in the Other row, or the answer itself for `text`. Kept while Other is not chosen. */
  words: string;
}

/** What kind of answer the question takes. */
export type QuestionKind = "single" | "multi" | "text";

/** Every prop a QuestionTool takes. */
export interface QuestionToolProps {
  /** The question, as a full sentence ("Which report should I start with?"). It names the answer. */
  question: string;
  /** `single` for one choice, `multi` for several, `text` for the person's own words. */
  kind: QuestionKind;
  /** The choices, for `single` and `multi`. Up to nine can be chosen with a number key. */
  options?: QuestionOption[];
  /**
   * An Other row, where the person writes an answer of their own. For `single` and `multi`.
   * @default true
   */
  other?: boolean;
  /**
   * The Other row's words.
   * @default "Other"
   */
  otherLabel?: string;
  /**
   * The choices in two columns, filled top to bottom, for short choices with no description.
   * @default 1
   */
  columns?: 1 | 2;
  /** An example of the answer, for `text` ("The spring launch"). */
  placeholder?: string;
  /**
   * The small word over the question.
   * @default "Question"
   */
  label?: string;
  /**
   * Sends the answer: the chosen values, with the Other words or the text last. Return a Promise and
   * the card waits; on success it shows the answer, on failure `failedLabel` shows under it.
   */
  onSubmit: (answer: string[]) => unknown;
  /** The words when the answer could not be sent, shown under the card and given to an agent. */
  failedLabel: string;
  /** Skips the question. Without it, there is no Skip. */
  onSkip?: () => unknown;
  /**
   * The submit button's words.
   * @default "Send answer"
   */
  submitLabel?: string;
  /**
   * Send is held: it stays where it is and can still be reached, but does not send, and
   * `submitDisabledReason` says why beside it (the host has no assistant connected, say).
   * @default false
   */
  submitDisabled?: boolean;
  /** Why Send is held, beside it and said with it. Give it with `submitDisabled`. */
  submitDisabledReason?: string;
  /**
   * The skip button's words.
   * @default "Skip"
   */
  skipLabel?: string;
  /**
   * Inside a Composer's `takeover`: no card of its own, the composer's card holds it.
   * @default false
   */
  embedded?: boolean;
  /**
   * One of several questions asked in turn: its place ("2 of 3") shows at the head's end. Set
   * `submitLabel` to "Next" on all but the last, and drive the steps from `onSubmit`.
   */
  step?: { index: number; count: number };
  /**
   * A step's place as it is written, from its number (from 1) and how many there are.
   * @default (step, count) => `${step} of ${count}`
   */
  stepLabel?: (step: number, count: number) => string;
  /** Goes back to the question before. Without it, there is no Back. */
  onBack?: () => unknown;
  /**
   * The back button's words.
   * @default "Back"
   */
  backLabel?: string;
  /**
   * The answer, when it was already given: the card shows it in one line, as after a send. For a
   * question kept in a transcript.
   */
  answered?: string[];
  /**
   * The answer being given, when the caller holds it (with `onValueChange`), so Back, or a change
   * of kind and back, shows what was chosen and written. Without it the card holds its own.
   */
  value?: QuestionAnswer;
  /** The answer the card starts with, when it holds its own. */
  defaultValue?: QuestionAnswer;
  /** Called with the whole answer each time a choice or a word changes. */
  onValueChange?: (value: QuestionAnswer) => void;
  /**
   * The words of the mark on a recommended choice.
   * @default "Recommended"
   */
  recommendedLabel?: string;
  /** @deprecated Use `layout`. */
  style?: QuestionToolLayoutStyle;
  /** Layout only: margins, alignment and width. The look belongs to the card. */
  layout?: QuestionToolLayoutStyle;
}

// Runs a task, then `after` whether it worked or failed. The React Compiler cannot compile a
// try with a finally inside a component, so it lives out here.
const settled = async <T,>(
  task: () => Promise<T>,
  after: () => void
): Promise<T> => {
  try {
    return await task();
  } finally {
    after();
  }
};

const HOVER = media.hover;
const FORCED = media.forced;
const COARSE = media.coarse;

const styles = stylex.create({
  root: {
    display: "grid",
    gap: grasp.space2,
    width: "100%",
    maxWidth: grasp.composerWidth,
    minWidth: 0,
    margin: 0,
    fontFamily: grasp.fontSans,
  },
  // Embedded, it fills what holds it (a composer may be wider than the composer's own width).
  rootEmbedded: { maxWidth: "none" },
  bare: {
    borderWidth: 0,
    backgroundColor: "transparent",
    boxShadow: "none",
  },
  card: {
    display: "grid",
    gap: grasp.space4,
    boxSizing: "border-box",
    minWidth: 0,
    // As Palermo's card: 12px above and below, 16px at the sides.
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftMedium,
    color: grasp.ink,
  },
  head: {
    display: "grid",
    gap: grasp.space1,
    minWidth: 0,
  },
  eyebrow: {
    margin: 0,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  // A step's place ("2 of 3") at the head's end.
  eyebrowRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
  step: {
    fontVariantNumeric: "tabular-nums",
  },
  // Back stands apart at the footer's start; Skip and Send answer stay at its end.
  back: {
    marginInlineEnd: "auto",
  },
  question: {
    margin: 0,
    color: grasp.ink,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    fontWeight: grasp.weightMedium,
    overflowWrap: "anywhere",
  },
  list: {
    display: "grid",
    gap: grasp.space1,
    maxHeight: grasp.questionHeight,
    overflowY: "auto",
    overscrollBehavior: "auto",
    // Room inside the scroll for the cards' lift and focus ring, so neither is cut off.
    padding: grasp.space1,
    margin: `calc(-1 * ${grasp.space1})`,
    // A list taller than its cap scrolls with no bar: the edge with more beyond it fades out over
    // space-6 instead, so a choice is never cut off in silence (watchEdges marks the edges).
    maskImage: {
      default: null,
      ":is([data-under-end]:not([data-under-start]))": `linear-gradient(to bottom, black calc(100% - ${grasp.space6}), transparent)`,
      ":is([data-under-start]:not([data-under-end]))": `linear-gradient(to top, black calc(100% - ${grasp.space6}), transparent)`,
      ":is([data-under-start][data-under-end])": `linear-gradient(to bottom, transparent, black ${grasp.space6}, black calc(100% - ${grasp.space6}), transparent)`,
    },
  },
  // Every card in a question as tall as the tallest, so none looks weightier than its neighbours.
  choices: {
    display: "grid",
    gridAutoRows: "1fr",
    gap: grasp.space2,
    minWidth: 0,
  },
  twoColumns: {
    gridTemplateColumns: {
      default: "1fr",
      [media.fromPhone]: "repeat(2, minmax(0, 1fr))",
    },
  },
  // On a phone the two columns stand as one, twice as many rows: the cap doubles with them, so the
  // same choices still show whole, not half of them under a fade.
  twoColumnList: {
    maxHeight: {
      default: `calc(2 * ${grasp.questionHeight})`,
      [media.fromPhone]: grasp.questionHeight,
    },
  },
  // A choice is a card: its own surface with the edge and low lift, our corner, a gap between
  // cards. Under a pointer its edge strengthens; pressed, the shared press scale; chosen, an ink
  // edge, a faint tint and a tick at its end, so it never rests on colour alone.
  row: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: grasp.tap,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space3,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: grasp.raised,
      ":has([data-checked])": grasp.itemFillHighlight,
    },
    boxShadow: {
      default: grasp.liftLow,
      ":hover": {
        default: null,
        [HOVER]: `inset 0 0 0 ${grasp.hairline} ${grasp.fieldEdgeHover}, ${grasp.liftLow}`,
      },
    },
    transform: {
      default: "none",
      ":active:not(:has(input:focus))": `scale(${grasp.pressScale})`,
    },
    cursor: "pointer",
    transitionProperty: "box-shadow, background-color, transform",
    transitionDuration: { default: grasp.durationHover, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  // The tick at a chosen card's end. Its room is kept at rest, so choosing never moves the words
  // or wraps them: chosen is the card's fill, its mark filled and this tick, never a new size.
  check: {
    display: "flex",
    flexShrink: 0,
    marginInlineStart: "auto",
    color: grasp.ink,
  },
  checkOff: {
    visibility: "hidden",
  },
  mark: {
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.kbdHeight,
    height: grasp.kbdHeight,
    margin: 0,
    padding: 0,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: grasp.cornerMark,
    // A pointer anywhere on the row lifts the mark a step, as a quiet button's hover.
    backgroundColor: {
      default: grasp.quietFill,
      [stylex.when.ancestor(":hover", rowMarker)]: {
        default: null,
        [HOVER]: grasp.quietFillHover,
      },
    },
    boxShadow: grasp.edge,
    // Its number in ink on the deeper hover fill, as a quiet button's words: muted on it fell to
    // 3.5:1 in dark.
    color: {
      default: grasp.muted,
      [stylex.when.ancestor(":hover", rowMarker)]: {
        default: null,
        [HOVER]: grasp.ink,
      },
    },
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: 1,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
  },
  // A finger needs 44px: on a touch screen an unseen area round the mark makes it up (the row
  // round it is a label, so a press anywhere on the row chooses too).
  reach: {
    position: "absolute",
    inset: {
      default: 0,
      [COARSE]: `calc((${grasp.kbdHeight} - ${grasp.tap}) / 2)`,
    },
  },
  markOn: {
    backgroundColor: grasp.actionFill,
    color: grasp.actionText,
  },
  // The mark's first line stands level with the words' first line.
  markLine: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    height: grasp.textSmLine,
  },
  words: {
    display: "grid",
    minWidth: 0,
  },
  label: {
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    overflowWrap: "anywhere",
  },
  // The assistant's recommended choice: a quiet word after its label, on the quiet fill, never a
  // coloured badge. Its words read with the choice's name.
  // When the mark runs onto a line of its own (a narrow card), it starts that line, with no gap.
  labelLine: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: grasp.space2,
    minWidth: 0,
  },
  recommended: {
    paddingInline: grasp.space1,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: grasp.cornerMark,
    backgroundColor: grasp.quietFill,
    boxShadow: grasp.edge,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightRegular,
    whiteSpace: "nowrap",
  },
  description: {
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    overflowWrap: "anywhere",
  },
  // The still drawing's chosen row and Other words (still.tsx): what `:has([data-checked])` and
  // the Other field's placeholder draw in the live tool.
  otherWords: {
    color: grasp.muted,
  },
  otherInput: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: { default: 0, [COARSE]: grasp.tap },
    margin: 0,
    padding: 0,
    appearance: "none",
    borderWidth: 0,
    backgroundColor: "transparent",
    outline: "none",
    color: grasp.ink,
    caretColor: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    "::placeholder": { color: grasp.muted, opacity: 1 },
  },
  // Why Send is held: quiet words at the footer's start, read with Send.
  held: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    overflowWrap: "anywhere",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: grasp.space2,
  },
  answer: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "flex-start",
    gap: grasp.space2,
    margin: 0,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    overflowWrap: "anywhere",
  },
  answerIcon: {
    display: "flex",
    alignItems: "center",
    height: grasp.textSmLine,
    color: grasp.success,
  },
  failed: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space1,
    margin: 0,
    paddingInline: grasp.space4,
    color: grasp.danger,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});

// The value of the Other card: never a caller's value, which is a plain string.
const OTHER = "\u0000other";

const noOptions: QuestionOption[] = [];

const noAnswer: QuestionAnswer = { values: [], other: false, words: "" };

const typing = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

// Submits with no rejection left to handle: a failure shows under the card, in the person's words.
const submitQuietly = async (submit: () => Promise<void>) => {
  try {
    await submit();
  } catch {
    // Shown under the card already.
  }
};

/** The choices' own controls (UI SDK's radios or checkboxes), in order. */
const controlsIn = (root: HTMLElement | null) => [
  ...(root?.querySelectorAll<HTMLElement>("[role=radio], [role=checkbox]") ??
    []),
];

/** Whether the target is one of UI SDK's radios or checkboxes, drawn as a button with its role. */
const onChoiceOf = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  /^(?:radio|checkbox)$/u.test(target.getAttribute("role") ?? "");

/** Embedded it fills what holds it; standing alone it keeps the composer's width. */
const rootWidth = (embedded: boolean) =>
  embedded ? styles.rootEmbedded : null;

/**
 * Whether Enter submits from here: from a choice, the Other field or (embedded) the text, never
 * from a real button, which Enter presses.
 */
const enterSubmits = (event: KeyboardEvent<HTMLElement>, embedded: boolean) => {
  const { target } = event;
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    !(target instanceof HTMLElement)
  ) {
    return false;
  }
  const pressable = target.tagName === "BUTTON" && !onChoiceOf(target);
  return !pressable && (target.tagName !== "TEXTAREA" || embedded);
};

/** What a choice's mark holds: a plus for Other, its number up to nine, then a tick. */
const markOf = (value: string, index: number): ReactNode => {
  if (value === OTHER) {
    return <Icon icon={Plus} />;
  }
  return index < 9 ? String(index + 1) : <Icon icon={Tick} />;
};

// Marks which ends of a list have choices scrolled past them, as attributes its fade reads, so a
// scroll never renders. The observer reports once when it starts, after the page is laid out.
const watchEdges = (element: HTMLElement) => {
  const mark = () => {
    element.toggleAttribute("data-under-start", element.scrollTop > 1);
    element.toggleAttribute(
      "data-under-end",
      element.scrollTop < element.scrollHeight - element.clientHeight - 1
    );
  };
  const observer = new ResizeObserver(mark);
  observer.observe(element);
  if (element.firstElementChild !== null) {
    observer.observe(element.firstElementChild);
  }
  element.addEventListener("scroll", mark, { passive: true });
  return () => {
    observer.disconnect();
    element.removeEventListener("scroll", mark);
  };
};

/** The box round the choices: capped at the question's height, it scrolls and fades at an edge with more. */
const ChoiceList = ({
  children,
  columns,
}: {
  children: ReactNode;
  columns: 1 | 2;
}) => {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = box.current;
    return element === null ? undefined : watchEdges(element);
  }, []);
  return (
    // Out of the tab order (Q1, PROOF-2026-11-17.md): Firefox makes a list that scrolls a Tab stop
    // of its own, with no ring; each answer takes the keys and scrolls into view.
    <div
      ref={box}
      tabIndex={-1}
      {...stylex.props(
        styles.list,
        columns === 2 && styles.twoColumnList,
        scroll.bar
      )}
    >
      {children}
    </div>
  );
};

const markStyle = (on: boolean) =>
  stylex.props(styles.mark, on && styles.markOn).className ?? "";

interface BodyProps {
  sent: string[] | null;
  kind: QuestionKind;
  cards: QuestionOption[];
  chosen: string[];
  columns: 1 | 2;
  questionId: string;
  otherLabel: string;
  placeholder: string | undefined;
  own: string;
  embedded: boolean;
  labelOf: (value: string) => string;
  card: (
    option: QuestionOption,
    index: number,
    control: (mark: ReactElement) => ReactElement
  ) => ReactElement;
  onChoose: (values: string[]) => void;
  onOwn: (next: string) => void;
}

/** The answer once sent; before, the choices or the text. */
const QuestionBody = ({
  sent,
  kind,
  cards,
  chosen,
  columns,
  questionId,
  otherLabel,
  placeholder,
  own,
  embedded,
  labelOf,
  card,
  onChoose,
  onOwn,
}: BodyProps) => {
  const choicesClass =
    stylex.props(styles.choices, columns === 2 && styles.twoColumns)
      .className ?? "";
  if (sent !== null) {
    return (
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region; role="status" is
      <p role="status" {...stylex.props(styles.answer)}>
        <span {...stylex.props(styles.answerIcon)}>
          <Icon icon={Done} />
        </span>
        <span>{sent.map(labelOf).join(", ")}</span>
      </p>
    );
  }
  if (kind === "single") {
    return (
      <ChoiceList columns={columns}>
        <RadioGroupPrimitive
          aria-labelledby={questionId}
          value={chosen[0] ?? ""}
          onValueChange={(value: string | null) => {
            onChoose(value === null || value === "" ? [] : [value]);
          }}
          className={choicesClass}
        >
          {cards.map((option, index) =>
            card(option, index, (mark) => (
              <RadioPrimitive
                value={option.value}
                aria-label={option.value === OTHER ? otherLabel : undefined}
                className={(state: { checked: boolean }) =>
                  markStyle(state.checked)
                }
              >
                {() => mark}
              </RadioPrimitive>
            ))
          )}
        </RadioGroupPrimitive>
      </ChoiceList>
    );
  }
  if (kind === "multi") {
    return (
      <ChoiceList columns={columns}>
        <CheckboxGroupPrimitive
          aria-labelledby={questionId}
          value={chosen}
          onValueChange={onChoose}
          className={choicesClass}
        >
          {cards.map((option, index) =>
            card(option, index, (mark) => (
              <CheckboxPrimitive
                value={option.value}
                aria-label={option.value === OTHER ? otherLabel : undefined}
                className={(state: { checked: boolean }) =>
                  markStyle(state.checked)
                }
              >
                {() => mark}
              </CheckboxPrimitive>
            ))
          )}
        </CheckboxGroupPrimitive>
      </ChoiceList>
    );
  }
  return (
    <Textarea
      aria-labelledby={questionId}
      placeholder={placeholder}
      value={own}
      onValueChange={onOwn}
      rows={2}
      // Alone, the text sends its own form. Embedded, there is no form of its own (a form cannot
      // hold another), so Enter is caught by the keys below.
      submitShortcut={embedded ? undefined : "enter"}
    />
  );
};

interface FooterProps {
  empty: boolean;
  held: boolean;
  heldReason: string | undefined;
  heldId: string;
  onSubmit: () => Promise<void>;
  submitLabel: string;
  onSkip: (() => unknown) | undefined;
  skipLabel: string;
  onBack: (() => unknown) | undefined;
  backLabel: string;
}

/** Back, Skip and Submit. */
const QuestionFooter = ({
  empty,
  held,
  heldReason,
  heldId,
  onSubmit,
  submitLabel,
  onSkip,
  skipLabel,
  onBack,
  backLabel,
}: FooterProps) => (
  <div {...stylex.props(styles.footer)}>
    {held && heldReason !== undefined && heldReason !== "" ? (
      <p
        id={heldId}
        data-slot="question-tool-held"
        {...stylex.props(styles.held)}
      >
        {heldReason}
      </p>
    ) : null}
    {onBack !== undefined && (
      <PressPrimitive
        onClick={() => {
          onBack();
        }}
        pendingAnnouncement=""
        render={(props: Record<string, unknown>) => (
          <Button {...props} variant="ghost" size="sm" layout={styles.back}>
            {backLabel}
          </Button>
        )}
      />
    )}
    {onSkip !== undefined && (
      <PressPrimitive
        onClick={() => {
          onSkip();
        }}
        pendingAnnouncement=""
        render={(props: Record<string, unknown>) => (
          <Button {...props} variant="ghost" size="sm">
            {skipLabel}
          </Button>
        )}
      />
    )}
    {/* Held, Send keeps its place in the keys' order (aria-disabled), so its reason is reached. */}
    <PressPrimitive
      onClick={onSubmit}
      disabled={empty || held}
      focusableWhenDisabled={held}
      aria-describedby={
        held && heldReason !== undefined && heldReason !== ""
          ? heldId
          : undefined
      }
      pendingAnnouncement=""
      render={(props: Record<string, unknown>) => (
        <Button
          {...props}
          variant="ink"
          size="sm"
          disabled={empty || held}
          focusableWhenDisabled={held}
        >
          {submitLabel}
        </Button>
      )}
    />
  </div>
);

// The props with their defaults filled in: the caller's words, else the catalogue's, else English.
const withDefaults = (props: QuestionToolProps, words: QuestionToolWords) => ({
  options: props.options ?? noOptions,
  other: props.other ?? true,
  otherLabel: props.otherLabel ?? words.other,
  stepLabel: props.stepLabel ?? words.step,
  columns: props.columns ?? 1,
  label: props.label ?? words.name,
  submitLabel: props.submitLabel ?? words.submit,
  skipLabel: props.skipLabel ?? words.skip,
  backLabel: props.backLabel ?? words.back,
  recommendedLabel: props.recommendedLabel ?? words.recommended,
  embedded: props.embedded ?? false,
});

type Resolved = QuestionToolProps & ReturnType<typeof withDefaults>;

/** The question, with every default in place. */
const QuestionCard = (props: Resolved) => {
  const {
    question,
    kind,
    options,
    otherLabel,
    onSubmit,
    failedLabel,
    answered,
    embedded,
  } = props;
  const [failed, setFailed] = useState(false);
  // The answer as it is given: the caller's when it holds it, else the card's own.
  const [held, setHeld] = useState<QuestionAnswer>(
    props.defaultValue ?? noAnswer
  );
  const given = props.value ?? held;
  const chosen = given.other ? [...given.values, OTHER] : given.values;
  const own = given.words;
  const change = (next: QuestionAnswer) => {
    if (props.value === undefined) {
      setHeld(next);
    }
    props.onValueChange?.(next);
  };
  const choose = (values: string[]) => {
    change({
      values: values.filter((value) => value !== OTHER),
      other: values.includes(OTHER),
      words: own,
    });
    setFailed(false);
  };
  const write = (next: string) => {
    change({ values: given.values, other: given.other, words: next });
    setFailed(false);
  };
  const [sentNow, setSentNow] = useState<string[] | null>(null);
  const sent = sentNow ?? answered ?? null;
  const busy = useRef(false);
  const questionId = useId();
  const heldId = useId();
  const onHold = props.submitDisabled === true;
  const root = useRef<HTMLElement | null>(null);
  const failedId = useId();
  const choice = kind !== "text";

  // Other is a card like the rest; chosen, its words are what it sends.
  const cards: QuestionOption[] =
    choice && props.other
      ? [...options, { value: OTHER, label: otherLabel }]
      : options;
  const otherChosen = chosen.includes(OTHER);
  const answer =
    kind === "text"
      ? [own.trim()].filter(Boolean)
      : [
          ...chosen.filter((value) => value !== OTHER),
          ...(otherChosen ? [own.trim()] : []),
        ].filter(Boolean);
  const empty = answer.length === 0;

  // One submit for the button and the keys. It rejects with the failure words, so an agent's press
  // fails with what the person reads; a person's press is settled by UI SDK and logs nothing.
  const submit = async () => {
    if (empty || onHold || busy.current) {
      return;
    }
    busy.current = true;
    setFailed(false);
    await settled(
      async () => {
        try {
          await onSubmit(answer);
          setSentNow(answer);
        } catch {
          setFailed(true);
          throw new Error(failedLabel);
        }
      },
      () => {
        busy.current = false;
      }
    );
  };

  const onFormSubmit = (event: SubmitEvent<HTMLElement>) => {
    event.preventDefault();
    void submitQuietly(submit);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    // UI SDK's radio marks Enter as handled (it chooses); on a choice, Enter still submits.
    if (
      event.defaultPrevented &&
      !(event.key === "Enter" && onChoiceOf(event.target))
    ) {
      return;
    }
    if (enterSubmits(event, embedded)) {
      event.preventDefault();
      void submitQuietly(submit);
      return;
    }
    // 1 to 9 choose a choice, while the keys are not typing words.
    if (!choice || typing(event.target) || !/^[1-9]$/u.test(event.key)) {
      return;
    }
    const option = cards[Number(event.key) - 1];
    if (option === undefined) {
      return;
    }
    event.preventDefault();
    if (kind === "single") {
      choose([option.value]);
    } else {
      choose(
        chosen.includes(option.value)
          ? chosen.filter((value) => value !== option.value)
          : [...chosen, option.value]
      );
    }
    // The focus goes with the choice, so the arrows go on from there.
    controlsIn(root.current)[Number(event.key) - 1]?.focus();
  };

  const labelOf = (value: string) =>
    cards.find((option) => option.value === value)?.label ?? value;

  // The Other card's field opens in place when it is chosen, and takes the focus. A card that
  // comes back with Other already chosen (Back) leaves the focus where it is.
  const otherField = useRef<HTMLInputElement | null>(null);
  const wasOther = useRef(otherChosen);
  useEffect(() => {
    if (otherChosen && !wasOther.current) {
      otherField.current?.focus();
    }
    wasOther.current = otherChosen;
  }, [otherChosen]);

  // Shown as a Composer's takeover while the person is in it (the composer says so with
  // data-focus-inside), the question takes the focus as it arrives: on the chosen choice, else the
  // first. Not on a render after, not on a page that just loaded, and not when it comes back with
  // Other chosen (the focus stays where it is, as above).
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) {
      return;
    }
    arrived.current = true;
    const composer = root.current?.closest<HTMLElement>("[data-slot=composer]");
    const here =
      composer !== null &&
      composer !== undefined &&
      (composer.dataset.focusInside !== undefined ||
        composer.contains(document.activeElement));
    if (!embedded || !here || sent !== null || wasOther.current) {
      return;
    }
    const controls = controlsIn(root.current);
    (
      controls.find(
        (control) => control.getAttribute("aria-checked") === "true"
      ) ?? controls[0]
    )?.focus({ preventScroll: true });
  }, [embedded, sent]);

  const words = (option: QuestionOption) => {
    if (option.value === OTHER && otherChosen) {
      return (
        <InputPrimitive
          ref={otherField}
          aria-label={`${otherLabel}: ${question}`}
          placeholder={otherLabel}
          value={own}
          onValueChange={write}
          render={(inputProps: Record<string, unknown>) => (
            <input {...inputProps} {...stylex.props(styles.otherInput)} />
          )}
        />
      );
    }
    return (
      <span {...stylex.props(styles.words)}>
        {option.recommended === true ? (
          <span {...stylex.props(styles.labelLine)}>
            <span {...stylex.props(styles.label)}>{option.label}</span>
            <span {...stylex.props(styles.recommended)}>
              {props.recommendedLabel}
            </span>
          </span>
        ) : (
          <span
            {...stylex.props(
              styles.label,
              option.value === OTHER && styles.otherWords
            )}
          >
            {option.label}
          </span>
        )}
        {option.description !== undefined && option.description !== "" && (
          <span {...stylex.props(styles.description)}>
            {option.description}
          </span>
        )}
      </span>
    );
  };

  // One choice as a card: the whole card is the target; the number chip at its start, a tick at
  // its end when chosen.
  const card = (
    option: QuestionOption,
    index: number,
    control: (mark: ReactElement) => ReactElement
  ) => {
    const on = chosen.includes(option.value);
    const mark = (
      <>
        <span aria-hidden="true" {...stylex.props(styles.reach)} />
        {markOf(option.value, index)}
      </>
    );
    return (
      <label
        key={option.value}
        data-chosen={on || undefined}
        {...stylex.props(rowMarker, styles.row, focus.within)}
      >
        <span {...stylex.props(styles.markLine)}>{control(mark)}</span>
        {words(option)}
        <span
          aria-hidden="true"
          {...stylex.props(styles.check, !on && styles.checkOff)}
        >
          <Icon icon={Done} />
        </span>
      </label>
    );
  };

  // Alone it is a form; inside a Composer, whose card is already a form, a group.
  const Root = embedded ? "div" : "form";
  return (
    <Root
      ref={(element: HTMLElement | null) => {
        root.current = element;
        return () => {
          root.current = null;
        };
      }}
      data-slot="question-tool"
      role={embedded ? "group" : undefined}
      aria-labelledby={questionId}
      aria-describedby={failed ? failedId : undefined}
      onSubmit={embedded ? undefined : onFormSubmit}
      onKeyDown={onKeyDown}
      {...stylex.props(
        styles.root,
        rootWidth(embedded),
        props.layout ?? props.style
      )}
    >
      <div {...stylex.props(styles.card, embedded && styles.bare)}>
        <div {...stylex.props(styles.head)}>
          <p {...stylex.props(styles.eyebrow, props.step && styles.eyebrowRow)}>
            <span>{props.label}</span>
            {props.step && (
              <span {...stylex.props(styles.step)}>
                {props.stepLabel(props.step.index + 1, props.step.count)}
              </span>
            )}
          </p>
          <p id={questionId} {...stylex.props(styles.question)}>
            {question}
          </p>
        </div>
        <QuestionBody
          sent={sent}
          kind={kind}
          cards={cards}
          chosen={chosen}
          columns={props.columns}
          questionId={questionId}
          otherLabel={otherLabel}
          placeholder={props.placeholder}
          own={own}
          embedded={embedded}
          labelOf={labelOf}
          card={card}
          onChoose={choose}
          onOwn={write}
        />
        {sent === null && (
          <QuestionFooter
            empty={empty}
            held={onHold}
            heldReason={props.submitDisabledReason}
            heldId={heldId}
            onSubmit={submit}
            submitLabel={props.submitLabel}
            onSkip={props.onSkip}
            skipLabel={props.skipLabel}
            onBack={props.onBack}
            backLabel={props.backLabel}
          />
        )}
      </div>
      {failed && (
        <p id={failedId} role="alert" {...stylex.props(styles.failed)}>
          <Icon icon={Alert} />
          {failedLabel}
        </p>
      )}
    </Root>
  );
};

/** An assistant's question, answered by a choice, several choices or the person's own words. */
export const QuestionTool = (props: QuestionToolProps) => {
  const words = useWords("questionTool", questionToolWords);
  return <QuestionCard {...props} {...withDefaults(props, words)} />;
};

/** The look of a question's parts, for its docs-only still drawing (still.tsx). */
export const questionStyles = styles;
