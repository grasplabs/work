// Questionnaire: an assistant asks the person one question or several in turn and waits,
// built on RadioGroup, Checkbox, Textarea, InputGroup's input and
// Button. Each item is one choice, several, or the person's own words; a choice item may take
// words of the person's own as well (QuestionnaireInput, "Other").
//
//   <Questionnaire onSubmit={(answers) => answer(answers)}>
//     <QuestionnaireItem name="report">
//       <QuestionnaireTitle>Which report should I start with?</QuestionnaireTitle>
//       <QuestionnaireDescription>I can do the others after.</QuestionnaireDescription>
//       <QuestionnaireChoices>
//         <QuestionnaireChoice value="quarterly" recommended>
//           Quarterly summary
//           <QuestionnaireChoiceDescription>Sales, costs and hiring</QuestionnaireChoiceDescription>
//         </QuestionnaireChoice>
//         <QuestionnaireChoice value="suppliers">Supplier review</QuestionnaireChoice>
//       </QuestionnaireChoices>
//       <QuestionnaireInput />
//       <QuestionnaireError />
//     </QuestionnaireItem>
//     <QuestionnaireActions>
//       <QuestionnaireSkip onClick={skip} />
//       <QuestionnaireSubmit />
//     </QuestionnaireActions>
//   </Questionnaire>
//
// It is a group, not a form, so it may stand inside one (a PromptInput's). One item shows at a
// time, in the page's order: QuestionnairePrevious and QuestionnaireNext move between them, and
// QuestionnaireProgress says where the person is. Each item is a fieldset named by its title; its
// choices are radios, or checkboxes with `multiple`, each named by its words and described by its
// description. A choice is a card: the key that picks it stands boxed at its start, where the
// control is (RadioGroup's or Checkbox's own, unseen under it), and chosen the box fills and a tick
// stands at the card's end. Beside choices the QuestionnaireInput is one more card, a plus at its
// start. 1 to 9 pick the first nine (or A to Z, `shortcuts="letters"`), the key after the last
// choice the words of one's own; Enter on a choice
// or in the words goes on, as Next or Submit does; Cmd or Ctrl+Enter goes on from anywhere in it;
// the left and right arrows go back and on, away from a radio or the words. Next and Submit wait
// until the item is answered, or skipped. `onSubmit` may return a Promise: Submit works until it
// settles; if it rejects, the questionnaire says it could not send and can be sent again; once
// sent, the answers stand in one line in the choices' place. A page that cannot take the answers
// yet holds QuestionnaireSubmit (`disabled`); with `disabledReason` the button stays a Tab stop and
// the reason stands beside it. Every value is a token. A caller may set layout only (the `style`
// prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  isValidElement,
  use,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  Icon,
  PlusIcon,
} from "../lib/icons";
import { focusRingText, focusWithin } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import { listOf, textOf } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import { Button } from "./button";
import type { ButtonVariant } from "./button";
import { Checkbox, CheckboxGroup } from "./checkbox";
import { InputGroupInput } from "./input-group";
import { RadioGroup, RadioGroupItem } from "./radio-group";
import { Textarea } from "./textarea";

/** Where an item stands: not yet answered, answered, or skipped on purpose. */
export type QuestionnaireItemStatus = "unanswered" | "answered" | "skipped";

/**
 * One item's answer, as `onSubmit` receives it: the chosen values in the page's order, and the
 * person's own words (the QuestionnaireInput's), trimmed, empty when none were written.
 */
export interface QuestionnaireAnswer {
  /** The chosen choices' values, in the page's order. */
  values: string[];
  /** The person's own words, trimmed. */
  text: string;
}

/** An item, as `items` gives it before the items are drawn: its order, and whether it counts. */
export interface QuestionnaireItemDefinition {
  /** Its name, as its QuestionnaireItem's. */
  name: string;
  /** Whether it must be answered. */
  required?: boolean;
  /** Left out of the run. */
  disabled?: boolean;
}

/** Every prop a Questionnaire takes. */
export interface QuestionnaireProps {
  /** Its QuestionnaireProgress, QuestionnaireItem parts in order, and QuestionnaireActions. */
  children: ReactNode;
  /**
   * Sends the answers, by item name, in the items' order; a skipped item is left out. Return a
   * Promise and Submit works until it settles; if it rejects, the questionnaire says it could not
   * send (`questionnaire.error`) and can be sent again. Once sent, the answers stand in one line in
   * the choices' place.
   */
  onSubmit: (answers: Record<string, QuestionnaireAnswer>) => unknown;
  /** The item shown, by name, when you hold it (with `onItemChange`). */
  item?: string;
  /**
   * The item shown at first.
   * @default the first item that is not disabled
   */
  defaultItem?: string;
  /** Runs with an item's name when the person moves to it. */
  onItemChange?: (item: string) => void;
  /**
   * The items, in order, before they are drawn: the server's first draw then shows the right item
   * and progress. Leave it out and the order is the page's.
   */
  items?: readonly QuestionnaireItemDefinition[];
  /**
   * The keys that pick a choice: `numbers` 1 to 9, `letters` A to Z. Each choice shows its key
   * boxed at its start.
   * @default "numbers"
   */
  shortcuts?: "letters" | "numbers";
  /** Its name, when the questionnaire as a whole needs one; each item is named by its title. */
  "aria-label"?: string;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a QuestionnaireProgress takes. */
export interface QuestionnaireProgressProps {
  /** What the run is, in a word or two at the head's start ("Questions"). */
  children?: ReactNode;
  /**
   * Its name for a screen reader.
   * @default "Progress" (`questionnaire.progressLabel`)
   */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a QuestionnaireItem takes. */
export interface QuestionnaireItemProps {
  /** Its QuestionnaireTitle, QuestionnaireDescription, QuestionnaireChoices, QuestionnaireInput and QuestionnaireError. */
  children: ReactNode;
  /** Its name, unique in the questionnaire: the key of its answer. */
  name: string;
  /**
   * It must be answered: there is no Skip for it.
   * @default false
   */
  required?: boolean;
  /**
   * Several choices: checkboxes, in place of radios.
   * @default false
   */
  multiple?: boolean;
  /**
   * Left out of the run: not shown, counted or sent. For an item that does not apply to the
   * answers before it.
   * @default false
   */
  disabled?: boolean;
  /**
   * Marked wrong by a check of yours: its QuestionnaireError shows, and Submit goes to it.
   * @default false
   */
  invalid?: boolean;
  /** Runs when it becomes answered, skipped or unanswered. */
  onStatusChange?: (status: QuestionnaireItemStatus) => void;
}

/** Every prop a QuestionnaireTitle takes. */
export interface QuestionnaireTitleProps {
  /** The question, as a full sentence ("Which report should I start with?"). It names the item. */
  children: ReactNode;
}

/** Every prop a QuestionnaireDescription takes. */
export interface QuestionnaireDescriptionProps {
  /** A line under the question: why it is asked, or what happens next. */
  children: ReactNode;
}

/** Every prop a QuestionnaireChoices takes. */
export interface QuestionnaireChoicesProps {
  /** Its QuestionnaireChoice parts, in order. The first nine (or 26) are picked by their keys. */
  children: ReactNode;
  /**
   * Two columns for short choices with no description; one on a phone.
   * @default 1
   */
  columns?: 1 | 2;
}

/** Every prop a QuestionnaireChoice takes. */
export interface QuestionnaireChoiceProps {
  /** What is sent when it is chosen. Unique in its item. */
  value: string;
  /** Its words, short ("Quarterly summary"), which name it; and a QuestionnaireChoiceDescription, which describes it. */
  children: ReactNode;
  /** Whether it is chosen, when you hold it (with `onCheckedChange`). */
  checked?: boolean;
  /**
   * Chosen at first.
   * @default false
   */
  defaultChecked?: boolean;
  /** Runs with whether it is chosen, when the person chooses it or lets it go. */
  onCheckedChange?: (checked: boolean) => void;
  /**
   * The choice the assistant recommends: a quiet mark after its words
   * (`questionnaire.recommended`), said with its name. Mark one at most.
   * @default false
   */
  recommended?: boolean;
  /**
   * Out of use: it cannot be chosen.
   * @default false
   */
  disabled?: boolean;
}

/** Every prop a QuestionnaireChoiceDescription takes. */
export interface QuestionnaireChoiceDescriptionProps {
  /** One quiet line under its choice's words. */
  children: ReactNode;
}

/** Every prop a QuestionnaireInput takes. */
export interface QuestionnaireInputProps {
  /**
   * An example of the answer ("The spring launch"). Beside choices, the field's name ("Other")
   * when left out.
   */
  placeholder?: string;
  /**
   * Its name, beside choices.
   * @default "Other" (`questionnaire.other`); alone, the item's title names it
   */
  "aria-label"?: string;
  /** The words, when you hold them (with `onValueChange`). */
  value?: string;
  /** The words it starts with. */
  defaultValue?: string;
  /** Runs with the words as the person writes them. */
  onValueChange?: (value: string) => void;
}

/** Every prop a QuestionnaireError takes. */
export interface QuestionnaireErrorProps {
  /**
   * What is wrong, when the item is invalid.
   * @default "Answer this question to go on" (`questionnaire.required`)
   */
  children?: ReactNode;
}

/** Every prop a QuestionnaireActions takes. */
export interface QuestionnaireActionsProps {
  /** QuestionnairePrevious, QuestionnaireSkip, QuestionnaireNext and QuestionnaireSubmit; each shows only where it applies. */
  children: ReactNode;
}

/** Every prop a QuestionnairePrevious, QuestionnaireSkip, QuestionnaireNext or QuestionnaireSubmit takes. */
export interface QuestionnaireNavigationProps {
  /**
   * Its words, when they should say more ("Send answers").
   * @default "Previous", "Skip", "Next" or "Send answer" (`questionnaire.previous`, `.skip`, `.next`, `.submit`)
   */
  children?: ReactNode;
  /**
   * The button's look.
   * @default "outline" for Previous, "ghost" for Skip, "default" for Next and Submit
   */
  variant?: ButtonVariant;
  /**
   * The button's size.
   * @default "sm"
   */
  size?: "xs" | "sm" | "default" | "lg";
  /** Runs first when it is pressed; `event.preventDefault()` keeps it from doing its own work. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}

/** Every prop a QuestionnaireSubmit takes: a navigation button's, and the page's hold on it. */
export interface QuestionnaireSubmitProps extends QuestionnaireNavigationProps {
  /**
   * Held by the page: the answers cannot be sent yet (nothing is there to receive them), from the
   * button or from Enter. The person can still choose.
   * @default false
   */
  disabled?: boolean;
  /**
   * Why it is held, as a sentence ("No assistant is connected, so the answer cannot be sent
   * yet."): shown at the start of the actions' row and read with the button, which then keeps its
   * place in the Tab order.
   */
  disabledReason?: string;
}

const FORCED = media.forcedColors;
const HOVER = media.hover;

// Two columns of choices from this width of the question's own box. A container query cannot read
// a variable, so the width is written here.
const TWO = "@container questionnaire (width >= 24rem)";

const styles = stylex.create({
  root: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "grid",
    rowGap: space["4"],
    boxSizing: "border-box",
    width: "100%",
    containerType: "inline-size",
    containerName: "questionnaire",
    minWidth: 0,
    margin: 0,
    paddingBlock: space["3"],
    paddingInline: space["4"],
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.md,
    color: colors.foreground,
    fontFamily: font.sans,
  },
  // The head's first line: what the run is at its start, the person's place at its end. It stands
  // a small step over the question, not the root's whole gap.
  progress: {
    display: "flex",
    justifyContent: "space-between",
    gap: space["2"],
    margin: 0,
    marginBlockEnd: `calc(${space["1"]} - ${space["4"]})`,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  place: {
    marginInlineStart: "auto",
    fontVariantNumeric: "tabular-nums",
  },
  // One item: the root's rhythm inside it. Hidden while another item shows.
  item: {
    display: "grid",
    rowGap: space["4"],
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    outline: "none",
  },
  itemHidden: {
    display: "none",
  },
  // Before the items are counted, the first one shows: the server's draw.
  itemPending: {
    display: { default: "none", ":first-of-type": "grid" },
  },
  title: {
    margin: 0,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    overflowWrap: "anywhere",
    textWrap: "pretty",
  },
  description: {
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  // The box round the group gives back the step a RadioGroup or CheckboxGroup named by a label
  // above it reaches up by, so the cards stand at the item's own gap under the question.
  group: { display: "grid", marginBlockStart: `calc(-1 * ${space["1"]})` },
  // The choices, every card as tall as the tallest; numbered or lettered for their keys.
  choices: {
    display: "grid",
    gridAutoRows: "1fr",
    gap: space["2"],
    minWidth: 0,
    counterReset: "questionnaire-choice",
  },
  // Two columns while the question itself is wide enough for two, whatever the page's width.
  twoColumns: {
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [TWO]: "repeat(2, minmax(0, 1fr))",
    },
  },
  // A choice is a card: its own surface with a low lift, the whole card the target, at least a
  // finger tall. Under a pointer its edge strengthens; pressed, the shared press scale; chosen, the
  // quiet fill, its mark filled and a tick at its end, so it never rests on colour alone. Every
  // card is as tall as the tallest: a card of one line stands its words in the middle.
  choice: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    columnGap: space["3"],
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: size.tapTarget,
    padding: space["3"],
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: {
      default: colors.card,
      ":has([aria-checked=true])": colors.accent,
    },
    boxShadow: {
      default: shadow.sm,
      ":hover": {
        default: null,
        [HOVER]: `inset 0 0 0 ${size.hairline} ${colors.controlBorderHover}, ${shadow.sm}`,
      },
    },
    transform: {
      default: "none",
      ":active:not(:has(input:focus))": `scale(${size.buttonPressScale})`,
    },
    cursor: "pointer",
    counterIncrement: "questionnaire-choice",
    transitionProperty: "box-shadow, background-color, transform",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  choiceOff: {
    opacity: size.opacityDisabled,
    cursor: "not-allowed",
  },
  // The words of one's own, beside choices: one more card of their grid, as tall as they are;
  // filled like a chosen one while it holds words.
  own: {
    backgroundColor: {
      default: colors.card,
      ":has(input[type=text]:not(:placeholder-shown))": colors.accent,
    },
    cursor: "text",
  },
  // The mark's line, the height of the words' first line.
  control: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    height: font.textSmLine,
  },
  // The mark: the key that picks the choice, boxed as a Kbd is, where the control stands. A pointer
  // anywhere on the card lifts it a step; chosen, it takes the main fill, under a pointer too (so
  // written under the hover's media query as well, which would outrank it).
  mark: {
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: size.kbdHeight,
    height: size.kbdHeight,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    backgroundColor: {
      default: colors.control,
      [stylex.when.ancestor(":hover")]: {
        default: null,
        [HOVER]: colors.controlHover,
      },
      [stylex.when.ancestor(
        ":has(:is([aria-checked=true], input[type=text]:not(:placeholder-shown)))"
      )]: { default: colors.primary, [HOVER]: colors.primary },
    },
    boxShadow: size.borderStrong,
    color: {
      default: colors.mutedForeground,
      [stylex.when.ancestor(":hover")]: {
        default: null,
        [HOVER]: colors.foreground,
      },
      [stylex.when.ancestor(
        ":has(:is([aria-checked=true], input[type=text]:not(:placeholder-shown)))"
      )]: {
        default: colors.primaryForeground,
        [HOVER]: colors.primaryForeground,
      },
    },
    fontSize: font.textXs,
    lineHeight: 1,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  // RadioGroup's or Checkbox's own control, unseen over the mark: it keeps the role, the state,
  // the keys and the press; the mark is what it looks like here.
  unseen: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    opacity: 0,
  },
  words: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
  },
  labelLine: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space["2"],
    minWidth: 0,
  },
  label: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    overflowWrap: "anywhere",
  },
  // The assistant's recommended choice: a quiet word after its label, on the quiet fill with the
  // system's edge, never a coloured badge.
  recommended: {
    paddingInline: space["1"],
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    backgroundColor: colors.control,
    boxShadow: size.borderStrong,
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightNormal,
    whiteSpace: "nowrap",
  },
  choiceDescription: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  // The key in the mark: its number or letter while there is a key for it, a tick past the last.
  numbers: {
    display: {
      default: null,
      [stylex.when.ancestor(":nth-child(n + 10)")]: "none",
    },
    "::before": {
      content: "counter(questionnaire-choice)",
    },
  },
  letters: {
    display: {
      default: null,
      [stylex.when.ancestor(":nth-child(n + 27)")]: "none",
    },
    "::before": {
      content: "counter(questionnaire-choice, upper-alpha)",
    },
  },
  pastNumbers: {
    display: {
      default: "none",
      [stylex.when.ancestor(":nth-child(n + 10)")]: "flex",
    },
  },
  pastLetters: {
    display: {
      default: "none",
      [stylex.when.ancestor(":nth-child(n + 27)")]: "flex",
    },
  },
  // The tick at a chosen card's end. Its room is kept at rest, so choosing never moves the words.
  tick: {
    display: "flex",
    flexShrink: 0,
    marginInlineStart: "auto",
    color: colors.foreground,
    visibility: {
      default: "hidden",
      [stylex.when.ancestor(":has([aria-checked=true])")]: "visible",
    },
  },
  // The words of one's own, written in their card: bare, as the choices' words are.
  // InputGroup's bare input takes its words' look from here, the choices' own (16px on a phone or
  // a touch screen, or Safari zooms the page in when the field takes focus), and gives back its
  // inset, so its words start where a choice's do.
  ownWords: {
    display: "flex",
    flexGrow: 1,
    minWidth: 0,
    marginInline: `calc(-1 * ${space["3"]})`,
    fontFamily: font.sans,
    fontSize: {
      default: font.textSm,
      [media.maxSmOrCoarse]: size.inputTextTouch,
    },
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: space["2"],
    minWidth: 0,
  },
  // Previous stands at the start of the row, the others at its end.
  previous: {
    marginInlineEnd: "auto",
  },
  // The answers once sent, in one line, a tick before it.
  answer: {
    display: "flex",
    alignItems: "flex-start",
    columnGap: space["2"],
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  answerMark: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    height: font.textSmLine,
    color: colors.success,
  },
  // Why Submit is held: quiet words at the start of the row, which take its room.
  reason: {
    order: -1,
    flexGrow: 1,
    flexBasis: 0,
    minWidth: "10rem",
    margin: 0,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  failed: {
    display: "flex",
    alignItems: "center",
    columnGap: space["1"],
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.destructive,
  },
});

interface ItemAnswer {
  values: string[];
  text: string;
  skipped: boolean;
}

interface ItemEntry {
  required: boolean;
  disabled: boolean;
  invalid: boolean;
  element: HTMLElement;
}

interface QuestionnaireState {
  /** The item shown, or null before the items are counted. */
  active: string | null;
  /** The items that count, in order. */
  order: string[];
  answerOf: (name: string) => ItemAnswer;
  statusOf: (name: string) => QuestionnaireItemStatus;
  answer: (name: string, change: Partial<ItemAnswer>) => void;
  /** Items marked wrong by the questionnaire's own check. */
  flagged: ReadonlySet<string>;
  register: (name: string, entry: ItemEntry) => () => void;
  label: (item: string, value: string, words: string) => () => void;
  /** A choice the page holds: chosen or not, whatever was pressed. */
  holdChoice: (
    item: string,
    value: string,
    hold: { checked: boolean; multiple: boolean }
  ) => () => void;
  /** Words the page holds. */
  holdText: (item: string, text: string) => () => void;
  /** What runs when a choice is chosen or let go. */
  listenChoice: (
    item: string,
    value: string,
    listener: (checked: boolean) => void
  ) => () => void;
  /** What runs when the words change. */
  listenText: (item: string, listener: (text: string) => void) => () => void;
  /** Sending held by the page (QuestionnaireSubmit's `disabled`), until what it returns runs. */
  holdSubmit: () => () => void;
  requiredOf: (name: string) => boolean;
  previous: () => void;
  forward: () => void;
  skip: () => void;
  submit: () => void;
  shortcuts: "letters" | "numbers";
  sending: boolean;
  sent: boolean;
}

interface ItemState {
  name: string;
  multiple: boolean;
  titleId: string;
  descriptionId: string;
  errorId: string;
  hasChoices: boolean;
  setHasChoices: (has: boolean) => void;
  hasDescription: boolean;
  setHasDescription: (has: boolean) => void;
  invalid: boolean;
  /** The item's QuestionnaireInput, when it stands beside choices: drawn as the last of their cards. */
  own: ReactNode;
}

const QuestionnaireContext = createContext<QuestionnaireState | null>(null);
const ItemContext = createContext<ItemState | null>(null);
// A choice's description's id, while its choice draws it.
const ChoiceDescriptionContext = createContext<string | undefined>(undefined);
// Whether a QuestionnaireInput is drawn among the choices' cards.
const AmongChoices = createContext(false);

const useQuestionnaire = (part: string): QuestionnaireState => {
  const state = use(QuestionnaireContext);
  if (state === null) {
    throw new Error(`${part} must be inside a Questionnaire.`);
  }
  return state;
};

const useItem = (part: string): ItemState => {
  const state = use(ItemContext);
  if (state === null) {
    throw new Error(`${part} must be inside a QuestionnaireItem.`);
  }
  return state;
};

/** Runs the host's send and says whether it went through. */
const sends = async (send: () => unknown) => {
  try {
    await send();
    return true;
  } catch {
    return false;
  }
};

const isTyping = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable);

const roleOf = (target: EventTarget) =>
  target instanceof HTMLElement ? (target.getAttribute("role") ?? "") : "";

const noAnswer: ItemAnswer = { values: [], text: "", skipped: false };

/** The choices of an item, as drawn, in the page's order. */
const choicesIn = (item: Element | null | undefined) => [
  ...(item?.querySelectorAll<HTMLElement>("[data-slot=questionnaire-choice]") ??
    []),
];

/** The items registered, in the page's order. Reads the page: for effects, never a render. */
const inPageOrder = (all: ReadonlyMap<string, ItemEntry>) =>
  new Map(
    [...all].toSorted(([, a], [, b]) =>
      a.element.compareDocumentPosition(b.element) ===
      Node.DOCUMENT_POSITION_PRECEDING
        ? 1
        : -1
    )
  );

/** An assistant's questions: a group that shows one item at a time and sends every answer. */
export const Questionnaire = ({
  children,
  onSubmit,
  item,
  defaultItem,
  onItemChange,
  items,
  shortcuts = "numbers",
  "aria-label": named,
  style,
}: QuestionnaireProps) => {
  const words = useI18n().questionnaire;
  const [entries, setEntries] = useState<ReadonlyMap<string, ItemEntry>>(
    () => new Map()
  );
  const [answers, setAnswers] = useState<ReadonlyMap<string, ItemAnswer>>(
    () => new Map()
  );
  const [held, setHeld] = useState<string | undefined>(defaultItem);
  const [flagged, setFlagged] = useState<ReadonlySet<string>>(() => new Set());
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sentLine, setSentLine] = useState<string | null>(null);
  const busy = useRef(false);
  const group = useRef<HTMLDivElement | null>(null);
  const said = useRef<HTMLParagraphElement | null>(null);
  const labels = useRef(new Map<string, string>());
  const registry = useRef(new Map<string, ItemEntry>());
  const [heldChoices, setHeldChoices] = useState<
    ReadonlyMap<string, { checked: boolean; multiple: boolean }>
  >(() => new Map());
  const [heldTexts, setHeldTexts] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  const checkedListeners = useRef(
    new Map<string, (checked: boolean) => void>()
  );
  const textListeners = useRef(new Map<string, (text: string) => void>());
  const [onHold, setOnHold] = useState(false);
  const failedId = useId();

  // The items that count, in the page's order once drawn (`entries` is kept in it); `items`' order
  // before.
  const order =
    entries.size > 0
      ? [...entries]
          .filter(([, entry]) => !entry.disabled)
          .map(([name]) => name)
      : (items ?? [])
          .filter((each) => each.disabled !== true)
          .map((each) => each.name);
  const wanted = item ?? held;
  const active =
    wanted !== undefined && (order.length === 0 || order.includes(wanted))
      ? wanted
      : (order[0] ?? null);
  const at = active === null ? -1 : order.indexOf(active);

  // What the page holds wins over what was pressed: a held choice is chosen or not as its
  // `checked` says (in a single choice, the one held chosen is the answer), held words are its own.
  const answerOf = (name: string): ItemAnswer => {
    const own = answers.get(name) ?? noAnswer;
    let { values } = own;
    for (const [key, hold] of heldChoices) {
      const [owner, value = ""] = key.split("\u0000");
      if (owner !== name) {
        continue;
      }
      if (hold.checked && !hold.multiple) {
        values = [value];
      } else if (hold.checked) {
        values = values.includes(value) ? values : [...values, value];
      } else {
        values = values.filter((each) => each !== value);
      }
    }
    return { ...own, values, text: heldTexts.get(name) ?? own.text };
  };
  const statusOf = (name: string): QuestionnaireItemStatus => {
    const { values, text, skipped } = answerOf(name);
    if (skipped) {
      return "skipped";
    }
    return values.length > 0 || text.trim() !== "" ? "answered" : "unanswered";
  };
  const requiredOf = (name: string) =>
    entries.get(name)?.required ??
    items?.find((each) => each.name === name)?.required === true;
  const unflag = (name: string) => {
    if (flagged.has(name)) {
      setFlagged(new Set([...flagged].filter((each) => each !== name)));
    }
  };
  const answer = (name: string, change: Partial<ItemAnswer>) => {
    const was = answerOf(name);
    const { values, text } = change;
    if (values !== undefined) {
      for (const value of new Set([...was.values, ...values])) {
        const now = values.includes(value);
        if (now !== was.values.includes(value)) {
          checkedListeners.current.get(`${name}\u0000${value}`)?.(now);
        }
      }
    }
    if (text !== undefined && text !== was.text) {
      textListeners.current.get(name)?.(text);
    }
    setAnswers(
      (all) =>
        new Map([...all, [name, { ...(all.get(name) ?? noAnswer), ...change }]])
    );
    unflag(name);
    setFailed(false);
  };

  // Focus goes to the item shown, once it is drawn.
  const focusItem = (name: string) => {
    requestAnimationFrame(() => {
      entries.get(name)?.element.focus();
    });
  };
  const go = (name: string) => {
    if (item === undefined) {
      setHeld(name);
    }
    onItemChange?.(name);
    focusItem(name);
  };
  // An item that cannot go on yet: marked, and focus on its first answer.
  const stop = (name: string) => {
    setFlagged(new Set([...flagged, name]));
    const element = entries.get(name)?.element;
    if (element !== undefined && !element.contains(document.activeElement)) {
      requestAnimationFrame(() => {
        element
          .querySelector<HTMLElement>("[role=radio], [role=checkbox], textarea")
          ?.focus();
      });
    }
  };

  const send = async () => {
    if (busy.current || sentLine !== null || onHold) {
      return;
    }
    const wrong = order.find(
      (name) =>
        statusOf(name) === "unanswered" || entries.get(name)?.invalid === true
    );
    if (wrong !== undefined) {
      if (wrong !== active) {
        go(wrong);
      }
      stop(wrong);
      return;
    }
    busy.current = true;
    setSending(true);
    setFailed(false);
    // Keyed by item names a model may write (`__proto__`): built from a Map, each name is an own
    // key, never the object's prototype.
    const sent = new Map<string, QuestionnaireAnswer>();
    const line: string[] = [];
    for (const name of order) {
      const { values, text, skipped } = answerOf(name);
      if (skipped) {
        continue;
      }
      // The values in the page's order, whatever order they were chosen in.
      const page = choicesIn(entries.get(name)?.element).map(
        (choice) => choice.dataset.value
      );
      const chosen = [...values].toSorted(
        (a, b) => page.indexOf(a) - page.indexOf(b)
      );
      sent.set(name, { values: chosen, text: text.trim() });
      line.push(
        ...chosen.map(
          (each) => labels.current.get(`${name}\u0000${each}`) ?? each
        ),
        text.trim()
      );
    }
    const ok = await sends(() => onSubmit(Object.fromEntries(sent)));
    busy.current = false;
    setSending(false);
    if (!ok) {
      setFailed(true);
      return;
    }
    // Focus that was on Submit, which goes, lands on the answers' line.
    const inside = group.current?.contains(document.activeElement) === true;
    setSentLine(line.filter((each) => each !== "").join(", "));
    if (inside) {
      requestAnimationFrame(() => {
        said.current?.focus();
      });
    }
  };

  const forward = () => {
    if (active === null) {
      return;
    }
    if (statusOf(active) === "unanswered") {
      stop(active);
      return;
    }
    const following = order[at + 1];
    if (following === undefined) {
      void send();
    } else {
      go(following);
    }
  };
  const previous = () => {
    const before = order[at - 1];
    if (before !== undefined) {
      go(before);
    }
  };
  const skip = () => {
    if (active === null || requiredOf(active)) {
      return;
    }
    answer(active, { values: [], text: "", skipped: true });
    const following = order[at + 1];
    if (following !== undefined) {
      go(following);
    }
  };

  // A choice picked by its key: chosen (or, among checkboxes, chosen or let go), and focus with
  // it, so the arrows go on from there.
  const pick = (event: KeyboardEvent<HTMLDivElement>, shown: string) => {
    const keys =
      shortcuts === "letters" ? "abcdefghijklmnopqrstuvwxyz" : "123456789";
    const index =
      event.key.length === 1 ? keys.indexOf(event.key.toLowerCase()) : -1;
    const choices = choicesIn(entries.get(shown)?.element);
    const choice = choices[index];
    const picked = choice?.dataset.value;
    if (index === choices.length) {
      // The key after the last choice: the words of one's own, beside them.
      const own = entries
        .get(shown)
        ?.element.querySelector<HTMLElement>(
          "[data-slot=questionnaire-input] input"
        );
      if (own !== null && own !== undefined) {
        event.preventDefault();
        own.focus();
      }
      return;
    }
    if (index === -1 || choice === undefined || picked === undefined) {
      return;
    }
    event.preventDefault();
    const control = choice.querySelector<HTMLElement>(
      "[role=radio], [role=checkbox]"
    );
    if (control?.matches(":disabled, [data-disabled]") === true) {
      return;
    }
    const { values } = answerOf(shown);
    answer(
      shown,
      choice.dataset.multiple === undefined
        ? { values: [picked], text: "", skipped: false }
        : {
            values: values.includes(picked)
              ? values.filter((each) => each !== picked)
              : [...values, picked],
            skipped: false,
          }
    );
    control?.focus();
  };

  // The arrows: up and down between checkboxes; left and right back and on, away from a radio.
  const arrow = (event: KeyboardEvent<HTMLDivElement>, shown: string) => {
    const { key, target } = event;
    const role = roleOf(target);
    if (
      role === "checkbox" &&
      target instanceof HTMLElement &&
      (key === "ArrowUp" || key === "ArrowDown")
    ) {
      const boxes = [
        ...(entries
          .get(shown)
          ?.element.querySelectorAll<HTMLElement>("[role=checkbox]") ?? []),
      ];
      boxes[boxes.indexOf(target) + (key === "ArrowDown" ? 1 : -1)]?.focus();
      event.preventDefault();
      return;
    }
    if (role === "radio" || (key !== "ArrowLeft" && key !== "ArrowRight")) {
      return;
    }
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    if ((key === "ArrowLeft") !== rtl) {
      previous();
      return;
    }
    if (statusOf(shown) !== "unanswered" && at < order.length - 1) {
      forward();
    }
  };

  // The keys: Enter on a choice goes on, as Cmd or Ctrl+Enter does from anywhere in it; the
  // arrows move; a choice's key picks it. None while the keys write words.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (sentLine !== null || active === null) {
      return;
    }
    const role = roleOf(event.target);
    const mod = event.metaKey || event.ctrlKey;
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      (mod || role === "radio" || role === "checkbox")
    ) {
      // Not also the form round it (a PromptInput's).
      event.preventDefault();
      event.stopPropagation();
      forward();
      return;
    }
    if (event.altKey || mod || isTyping(event.target)) {
      return;
    }
    arrow(event, active);
    if (!event.defaultPrevented) {
      pick(event, active);
    }
  };

  const state: QuestionnaireState = {
    active,
    order,
    answerOf,
    statusOf,
    answer,
    flagged,
    // Called from an item's effect, once it is on the page: the items are put in the page's order
    // there, never while drawing.
    register: (name, entry) => {
      registry.current.set(name, entry);
      setEntries(inPageOrder(registry.current));
      return () => {
        registry.current.delete(name);
        setEntries(inPageOrder(registry.current));
      };
    },
    holdChoice: (owner, value, hold) => {
      const key = `${owner}\u0000${value}`;
      setHeldChoices((all) => new Map([...all, [key, hold]]));
      return () => {
        setHeldChoices(
          (all) => new Map([...all].filter(([each]) => each !== key))
        );
      };
    },
    holdText: (owner, text) => {
      setHeldTexts((all) => new Map([...all, [owner, text]]));
      return () => {
        setHeldTexts(
          (all) => new Map([...all].filter(([each]) => each !== owner))
        );
      };
    },
    listenChoice: (owner, value, listener) => {
      const key = `${owner}\u0000${value}`;
      checkedListeners.current.set(key, listener);
      return () => {
        checkedListeners.current.delete(key);
      };
    },
    holdSubmit: () => {
      setOnHold(true);
      return () => {
        setOnHold(false);
      };
    },
    listenText: (owner, listener) => {
      textListeners.current.set(owner, listener);
      return () => {
        textListeners.current.delete(owner);
      };
    },
    label: (owner, value, text) => {
      const key = `${owner}\u0000${value}`;
      labels.current.set(key, text);
      return () => {
        labels.current.delete(key);
      };
    },
    requiredOf,
    previous,
    forward,
    skip,
    submit: () => {
      void send();
    },
    shortcuts,
    sending,
    sent: sentLine !== null,
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the group hears its choices' keys (a key picks, Enter goes on, the arrows move)
    <div
      ref={group}
      role="group"
      data-slot="questionnaire"
      aria-label={named}
      aria-describedby={failed ? failedId : undefined}
      aria-busy={sending || undefined}
      onKeyDown={onKeyDown}
      {...stylex.props(styles.root, style)}
    >
      {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
      <QuestionnaireContext value={state}>{children}</QuestionnaireContext>
      {sentLine === null ? null : (
        <p
          ref={said}
          role="status"
          tabIndex={-1}
          {...stylex.props(styles.answer, focusRingText)}
        >
          <span aria-hidden="true" {...stylex.props(styles.answerMark)}>
            <Icon icon={CircleCheckIcon} />
          </span>
          <span>{sentLine}</span>
        </p>
      )}
      {failed && (
        <p id={failedId} role="alert" {...stylex.props(styles.failed)}>
          <Icon icon={CircleAlertIcon} />
          {words.error}
        </p>
      )}
    </div>
  );
};

/**
 * The head's first line: what the run is at its start ("Questions"), and at its end where the
 * person is in it ("2 of 3"), a progress bar to a screen reader ("Question 2 of 3"). A run of one
 * question shows no place. Gone once sent.
 */
export const QuestionnaireProgress = ({
  children,
  "aria-label": named,
  style,
}: QuestionnaireProgressProps) => {
  const { order, active, sent } = useQuestionnaire("QuestionnaireProgress");
  const words = useI18n().questionnaire;
  if (sent || active === null || order.length === 0) {
    return null;
  }
  const current = order.indexOf(active) + 1;
  const total = order.length;
  return (
    <p
      role="progressbar"
      aria-label={named ?? words.progressLabel}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-valuetext={words.progress(current, total)}
      data-slot="questionnaire-progress"
      {...stylex.props(styles.progress, style)}
    >
      {children !== undefined && <span>{children}</span>}
      {total > 1 && (
        <span {...stylex.props(styles.place)}>
          {words.step(current, total)}
        </span>
      )}
    </p>
  );
};

/** The question. It names its item. */
export const QuestionnaireTitle = ({ children }: QuestionnaireTitleProps) => {
  const { titleId } = useItem("QuestionnaireTitle");
  return (
    <p
      id={titleId}
      data-slot="questionnaire-title"
      {...stylex.props(styles.title)}
    >
      {children}
    </p>
  );
};

/** A quiet line under the question. It describes its item. */
export const QuestionnaireDescription = ({
  children,
}: QuestionnaireDescriptionProps) => {
  const { descriptionId, setHasDescription } = useItem(
    "QuestionnaireDescription"
  );
  useEffect(() => {
    setHasDescription(true);
    return () => {
      setHasDescription(false);
    };
  }, [setHasDescription]);
  return (
    <p
      id={descriptionId}
      data-slot="questionnaire-description"
      {...stylex.props(styles.description)}
    >
      {children}
    </p>
  );
};

/** The choices: radios for one, checkboxes for several, named by the question. Gone once sent. */
export const QuestionnaireChoices = ({
  children,
  columns = 1,
}: QuestionnaireChoicesProps) => {
  const { answerOf, answer, sent } = useQuestionnaire("QuestionnaireChoices");
  const { name, multiple, titleId, setHasChoices, own } = useItem(
    "QuestionnaireChoices"
  );
  useEffect(() => {
    setHasChoices(true);
    return () => {
      setHasChoices(false);
    };
  }, [setHasChoices]);
  if (sent) {
    return null;
  }
  const { values } = answerOf(name);
  // The group holds its state; the grid inside it lays the cards out, one or two columns.
  const grid = (
    <div {...stylex.props(styles.choices, columns === 2 && styles.twoColumns)}>
      {children}
      <AmongChoices value>{own}</AmongChoices>
    </div>
  );
  return (
    <div data-slot="questionnaire-choices" {...stylex.props(styles.group)}>
      {multiple ? (
        <CheckboxGroup
          aria-labelledby={titleId}
          value={values}
          onValueChange={(next: string[]) => {
            answer(name, { values: next, skipped: false });
          }}
        >
          {grid}
        </CheckboxGroup>
      ) : (
        <RadioGroup
          aria-labelledby={titleId}
          value={values[0] ?? null}
          onValueChange={(next: string | null) => {
            answer(name, {
              values: next === null || next === "" ? [] : [next],
              text: "",
              skipped: false,
            });
          }}
        >
          {grid}
        </RadioGroup>
      )}
    </div>
  );
};

/** One quiet line under a choice's words. It describes the choice. */
export const QuestionnaireChoiceDescription = ({
  children,
}: QuestionnaireChoiceDescriptionProps) => (
  <span
    id={use(ChoiceDescriptionContext)}
    data-slot="questionnaire-choice-description"
    {...stylex.props(styles.choiceDescription)}
  >
    {children}
  </span>
);

/** One choice: a card the whole of which chooses it, its key boxed at the start, a tick at the end once chosen. */
export const QuestionnaireChoice = ({
  value,
  children,
  checked,
  defaultChecked = false,
  onCheckedChange,
  recommended = false,
  disabled = false,
}: QuestionnaireChoiceProps) => {
  const { label, answerOf, answer, shortcuts, holdChoice, listenChoice } =
    useQuestionnaire("QuestionnaireChoice");
  const { name, multiple } = useItem("QuestionnaireChoice");
  const words = useI18n().questionnaire;
  const labelId = useId();
  const markId = useId();
  const descriptionId = useId();
  // Its words name it; a QuestionnaireChoiceDescription among them describes it.
  const parts = listOf(children);
  const description = parts.filter(
    (part) =>
      isValidElement(part) && part.type === QuestionnaireChoiceDescription
  );
  const own = parts.filter((part) => !description.includes(part));
  const text = textOf(own).trim();
  useEffect(() => label(name, value, text), [label, name, value, text]);
  // Held by the page: chosen as `checked` says.
  useEffect(
    () =>
      checked === undefined
        ? undefined
        : holdChoice(name, value, { checked, multiple }),
    [holdChoice, name, value, checked, multiple]
  );
  useEffect(
    () =>
      onCheckedChange === undefined
        ? undefined
        : listenChoice(name, value, onCheckedChange),
    [listenChoice, name, value, onCheckedChange]
  );
  // Chosen once, as it is first drawn.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !defaultChecked) {
      return;
    }
    seeded.current = true;
    const { values } = answerOf(name);
    if (!values.includes(value)) {
      answer(name, { values: multiple ? [...values, value] : [value] });
    }
  }, [defaultChecked, answerOf, answer, name, value, multiple]);
  const described = description.length > 0;
  const wiring = {
    "aria-labelledby": recommended ? `${labelId} ${markId}` : labelId,
    "aria-describedby": described ? descriptionId : undefined,
  };
  return (
    <label
      data-slot="questionnaire-choice"
      data-value={value}
      data-multiple={multiple || undefined}
      {...stylex.props(
        stylex.defaultMarker(),
        styles.choice,
        disabled && styles.choiceOff,
        focusWithin
      )}
    >
      <span {...stylex.props(styles.control)}>
        <span
          data-slot="questionnaire-choice-mark"
          {...stylex.props(styles.mark)}
        >
          <span {...stylex.props(styles.unseen)}>
            {multiple ? (
              <Checkbox value={value} disabled={disabled} {...wiring} />
            ) : (
              <RadioGroupItem value={value} disabled={disabled} {...wiring} />
            )}
          </span>
          <span
            aria-hidden="true"
            {...stylex.props(
              shortcuts === "letters" ? styles.letters : styles.numbers
            )}
          />
          <span
            aria-hidden="true"
            {...stylex.props(
              shortcuts === "letters" ? styles.pastLetters : styles.pastNumbers
            )}
          >
            <Icon icon={CheckIcon} />
          </span>
        </span>
      </span>
      <span {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.labelLine)}>
          <span id={labelId} {...stylex.props(styles.label)}>
            {own}
          </span>
          {recommended && (
            <span id={markId} {...stylex.props(styles.recommended)}>
              {words.recommended}
            </span>
          )}
        </span>
        {described && (
          <ChoiceDescriptionContext value={descriptionId}>
            {description}
          </ChoiceDescriptionContext>
        )}
      </span>
      <span aria-hidden="true" {...stylex.props(styles.tick)}>
        <Icon icon={CircleCheckIcon} />
      </span>
    </label>
  );
};

/**
 * The person's own words: alone in its item the answer itself, named by the title; beside choices
 * an answer of their own, named Other, one more card under them with a plus at its start, which
 * takes a single choice's place. Enter goes on; alone, Shift+Enter starts a line. Put it after the
 * QuestionnaireChoices. Gone once sent.
 */
export const QuestionnaireInput = ({
  placeholder,
  "aria-label": named,
  value: given,
  defaultValue,
  onValueChange,
}: QuestionnaireInputProps) => {
  const { answerOf, answer, forward, sent, holdText, listenText } =
    useQuestionnaire("QuestionnaireInput");
  const { name, multiple, titleId, hasChoices } = useItem("QuestionnaireInput");
  const words = useI18n().questionnaire;
  const among = use(AmongChoices);
  const ownId = useId();
  // Written once, as it is first drawn.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || defaultValue === undefined || defaultValue === "") {
      return;
    }
    seeded.current = true;
    answer(name, { text: defaultValue });
  }, [defaultValue, answer, name]);
  // Held by the page: its words are `value`.
  useEffect(
    () => (given === undefined ? undefined : holdText(name, given)),
    [holdText, name, given]
  );
  useEffect(
    () =>
      onValueChange === undefined ? undefined : listenText(name, onValueChange),
    [listenText, name, onValueChange]
  );
  if (sent) {
    return null;
  }
  const { values, text } = answerOf(name);
  const write = (written: string) => {
    // One choice is one answer: words of one's own take the chosen choice's place.
    const clear = !multiple && written.trim() !== "" && values.length > 0;
    answer(name, {
      text: written,
      skipped: false,
      ...(clear ? { values: [] } : {}),
    });
  };
  if (among || hasChoices) {
    return (
      <label
        htmlFor={ownId}
        data-slot="questionnaire-input"
        {...stylex.props(
          stylex.defaultMarker(),
          styles.choice,
          styles.own,
          focusWithin
        )}
      >
        <span aria-hidden="true" {...stylex.props(styles.control)}>
          <span {...stylex.props(styles.mark)}>
            <Icon icon={PlusIcon} />
          </span>
        </span>
        <span {...stylex.props(styles.ownWords)}>
          <InputGroupInput
            id={ownId}
            aria-label={named ?? words.other}
            // Always some: the card reads its placeholder to know it is empty.
            placeholder={placeholder ?? words.other}
            value={text}
            onValueChange={write}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                // Not also the form round it (a PromptInput's).
                event.preventDefault();
                event.stopPropagation();
                forward();
              }
            }}
          />
        </span>
      </label>
    );
  }
  return (
    <div data-slot="questionnaire-input">
      <Textarea
        aria-label={named}
        aria-labelledby={named === undefined ? titleId : undefined}
        placeholder={placeholder}
        rows={2}
        value={text}
        onValueChange={write}
        submitShortcut="enter"
        onSubmit={forward}
      />
    </div>
  );
};

/** Whether a child is this part. */
const isPart = (part: ReactNode, type: unknown) =>
  isValidElement(part) && part.type === type;

/**
 * A QuestionnaireInput beside QuestionnaireChoices is the last of their cards: the choices draw it
 * in their grid, as tall as the rest, and it leaves its own place among the item's parts.
 */
const ownAmong = (children: ReactNode) => {
  const parts = listOf(children);
  const own = parts.some((part) => isPart(part, QuestionnaireChoices))
    ? parts.find((part) => isPart(part, QuestionnaireInput))
    : undefined;
  return {
    own,
    rest: own === undefined ? children : parts.filter((part) => part !== own),
  };
};

/** One question of the run: a fieldset named by its title, shown while it is the current one. */
export const QuestionnaireItem = ({
  children,
  name,
  required = false,
  multiple = false,
  disabled = false,
  invalid = false,
  onStatusChange,
}: QuestionnaireItemProps) => {
  const { active, register, flagged, statusOf, sent } =
    useQuestionnaire("QuestionnaireItem");
  const element = useRef<HTMLFieldSetElement | null>(null);
  const [hasChoices, setHasChoices] = useState(false);
  const [hasDescription, setHasDescription] = useState(false);
  const titleId = useId();
  const errorId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const node = element.current;
    return node === null
      ? undefined
      : register(name, { required, disabled, invalid, element: node });
  }, [register, name, required, disabled, invalid]);
  const status = statusOf(name);
  const told = useRef<QuestionnaireItemStatus>("unanswered");
  useEffect(() => {
    if (told.current !== status) {
      told.current = status;
      onStatusChange?.(status);
    }
  }, [status, onStatusChange]);
  const wrong = invalid || flagged.has(name);
  const shown = !disabled && active === name;
  const described = [hasDescription && descriptionId, wrong && errorId]
    .filter(Boolean)
    .join(" ");
  const { own, rest } = ownAmong(children);
  return (
    <fieldset
      ref={element}
      // A fieldset's own name is its legend; the title stands as a line of the grid instead.
      aria-labelledby={titleId}
      aria-describedby={described === "" ? undefined : described}
      aria-invalid={wrong || undefined}
      hidden={disabled || (active !== null && !shown)}
      inert={!shown && active !== null}
      tabIndex={-1}
      data-slot="questionnaire-item"
      data-status={status}
      data-active={shown || undefined}
      data-sent={sent || undefined}
      {...stylex.props(
        styles.item,
        active === null && styles.itemPending,
        (disabled || (active !== null && !shown)) && styles.itemHidden
      )}
    >
      <ItemContext
        // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
        value={{
          name,
          multiple,
          titleId,
          descriptionId,
          errorId,
          hasChoices,
          setHasChoices,
          hasDescription,
          setHasDescription,
          invalid: wrong,
          own,
        }}
      >
        {rest}
      </ItemContext>
    </fieldset>
  );
};

/** Why the item cannot go on: shown while it is invalid, said at once. */
export const QuestionnaireError = ({ children }: QuestionnaireErrorProps) => {
  const { sent } = useQuestionnaire("QuestionnaireError");
  const { errorId, invalid } = useItem("QuestionnaireError");
  const words = useI18n().questionnaire;
  if (sent || !invalid) {
    return null;
  }
  return (
    <p
      id={errorId}
      role="alert"
      data-slot="questionnaire-error"
      {...stylex.props(styles.failed)}
    >
      <Icon icon={CircleAlertIcon} />
      {children ?? words.required}
    </p>
  );
};

/** The row of actions at the foot: Previous at its start, then Skip, Next or Submit. Gone once sent. */
export const QuestionnaireActions = ({
  children,
}: QuestionnaireActionsProps) => {
  const { sent } = useQuestionnaire("QuestionnaireActions");
  if (sent) {
    return null;
  }
  return (
    <div data-slot="questionnaire-actions" {...stylex.props(styles.actions)}>
      {children}
    </div>
  );
};

/** Goes back to the item before, its answer kept. Not on the first item. */
export const QuestionnairePrevious = ({
  children,
  variant = "outline",
  size: sized = "sm",
  onClick,
}: QuestionnaireNavigationProps) => {
  const { order, active, previous } = useQuestionnaire("QuestionnairePrevious");
  const words = useI18n().questionnaire;
  if (active === null || order.indexOf(active) <= 0) {
    return null;
  }
  return (
    <span data-slot="questionnaire-previous" {...stylex.props(styles.previous)}>
      <Button
        type="button"
        variant={variant}
        size={sized}
        onClick={(event: MouseEvent<HTMLElement>) => {
          onClick?.(event);
          if (event.defaultPrevented) {
            return;
          }
          previous();
        }}
      >
        {children ?? words.previous}
      </Button>
    </span>
  );
};

/** Skips the item: it is left out of the answers, and the next item shows. Only on an item not required. */
export const QuestionnaireSkip = ({
  children,
  variant = "ghost",
  size: sized = "sm",
  onClick,
}: QuestionnaireNavigationProps) => {
  const { active, requiredOf, skip } = useQuestionnaire("QuestionnaireSkip");
  const words = useI18n().questionnaire;
  if (active === null || requiredOf(active)) {
    return null;
  }
  return (
    <span data-slot="questionnaire-skip">
      <Button
        type="button"
        variant={variant}
        size={sized}
        onClick={(event: MouseEvent<HTMLElement>) => {
          onClick?.(event);
          if (event.defaultPrevented) {
            return;
          }
          skip();
        }}
      >
        {children ?? words.skip}
      </Button>
    </span>
  );
};

/** Goes on to the next item. It waits until this one is answered or skipped. Not on the last item. */
export const QuestionnaireNext = ({
  children,
  variant = "default",
  size: sized = "sm",
  onClick,
}: QuestionnaireNavigationProps) => {
  const { order, active, statusOf, forward } =
    useQuestionnaire("QuestionnaireNext");
  const words = useI18n().questionnaire;
  if (
    active === null ||
    order.length === 0 ||
    order.indexOf(active) >= order.length - 1
  ) {
    return null;
  }
  return (
    <span data-slot="questionnaire-next">
      <Button
        type="button"
        variant={variant}
        size={sized}
        disabled={statusOf(active) === "unanswered"}
        onClick={(event: MouseEvent<HTMLElement>) => {
          onClick?.(event);
          if (event.defaultPrevented) {
            return;
          }
          forward();
        }}
      >
        {children ?? words.next}
      </Button>
    </span>
  );
};

/**
 * Sends the answers. It waits until the item is answered or skipped, and works while it sends. On
 * the last item. `disabled` holds it for the page; with `disabledReason` it stays a Tab stop that
 * says why.
 */
export const QuestionnaireSubmit = ({
  children,
  variant = "default",
  size: sized = "sm",
  onClick,
  disabled = false,
  disabledReason,
}: QuestionnaireSubmitProps) => {
  const { order, active, statusOf, submit, sending, holdSubmit } =
    useQuestionnaire("QuestionnaireSubmit");
  const words = useI18n().questionnaire;
  const reasonId = useId();
  useEffect(
    () => (disabled ? holdSubmit() : undefined),
    [disabled, holdSubmit]
  );
  if (
    active !== null &&
    order.length > 0 &&
    order.indexOf(active) < order.length - 1
  ) {
    return null;
  }
  const waiting = active === null || statusOf(active) === "unanswered";
  const reason =
    disabled && disabledReason !== undefined && disabledReason !== ""
      ? disabledReason
      : undefined;
  return (
    <>
      {reason !== undefined && (
        <p
          id={reasonId}
          data-slot="questionnaire-submit-reason"
          {...stylex.props(styles.reason)}
        >
          {reason}
        </p>
      )}
      <span data-slot="questionnaire-submit">
        <Button
          type="button"
          variant={variant}
          size={sized}
          disabled={waiting || sending || disabled}
          focusableWhenDisabled={sending || reason !== undefined}
          aria-busy={sending || undefined}
          aria-describedby={reason === undefined ? undefined : reasonId}
          onClick={(event: MouseEvent<HTMLElement>) => {
            onClick?.(event);
            if (event.defaultPrevented) {
              return;
            }
            submit();
          }}
        >
          {children ?? words.submit}
        </Button>
      </span>
    </>
  );
};
