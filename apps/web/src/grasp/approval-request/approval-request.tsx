"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  ComponentProps,
  KeyboardEvent,
  ReactNode,
  RefObject,
} from "react";

import { announce } from "../announce/announce";
import { Button, useAction } from "../button";
import type { Action } from "../button";
import { focus } from "../focus/focus";
import {
  Agent,
  Clock,
  Cross,
  Done,
  Edit,
  File,
  Icon,
  Money,
  Person,
  Replaced,
  System,
} from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { Textarea } from "../textarea";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { approvalRequestWords } from "./words";

/** Where a request stands. */
export type ApprovalStatus =
  | "waiting"
  | "approved"
  | "declined"
  | "changes"
  | "expired"
  | "superseded";

/** What kind of thing an action touches; it picks the icon. */
export type ApprovalKind = "file" | "person" | "money" | "system" | "other";

/** How the card looks: the default, Bare, or the Ledger. */
export type ApprovalVariant = "slip" | "bare" | "ledger";

/** One thing the action touches. */
export interface ApprovalEffect {
  /** What kind of thing it is. */
  kind: ApprovalKind;
  /** Its name, as a person knows it ("Archive/2023-report.pdf", "Amara Okafor", "£1,200"). */
  label: string;
  /** One quiet line about what happens to it ("Deleted", "Gets edit access"). */
  detail?: string;
  /** It cannot be undone: the card says so once, in words, in the danger tone. */
  irreversible?: boolean;
}

/** What was decided, by whom and when. */
export interface ApprovalDecision {
  /** Where it stands now. */
  status: ApprovalStatus;
  /** Who answered ("Amara Okafor", "You"). */
  by?: string;
  /** Their portrait. Kept with the decision; the settled line is words only. */
  portrait?: string;
  /** When: a Date, shown as the time of day, or words ("14:02", "yesterday at 16:20"). */
  at?: Date | string;
  /** The changes asked for, in the person's words. */
  note?: string;
}

/** Every word the card shows, so a product can translate it. */
export interface ApprovalWords {
  /** Who asks, when no agent is named. */
  theAgent: string;
  details: string;
  askForChanges: string;
  whatShouldChange: string;
  back: string;
  send: string;
  decline: string;
  /** Said once after what it touches when any of it cannot be undone. */
  final: string;
  /** The question a grave approval asks in place. */
  sure: string;
  /** The same, when it cannot be undone. */
  sureFinal: string;
  notYet: string;
  /** Before the approve words on the second ask ("Yes, pay £1,240"). */
  yes: string;
  /**
   * The second ask's button, written from `yes` and the approve words. A language that does not
   * join them with a comma and a small letter says it its own way here.
   * @default (yes, approve) => "Yes, pay £1,240" from "Yes" and "Pay £1,240"
   */
  confirm: (yes: string, approve: string) => string;
  /**
   * The settled line, from the decision's word and who gave it.
   * @default (decided, by) => "Approved by you"
   */
  signed: (decided: string, by: string) => string;
  /** The person answering here, in the settled line ("Approved by you"). */
  you: string;
  undo: string;
  approving: string;
  declining: string;
  sending: string;
  couldNotApprove: string;
  couldNotDecline: string;
  couldNotSend: string;
  approved: string;
  declined: string;
  changes: string;
  expired: string;
  superseded: string;
  /** Said when an answer is undone. */
  undone: string;
}

/** What a caller may style: where the request sits and how wide it is. Never its look. */
export type ApprovalRequestLayoutStyle = LayoutStyle;

/** Every prop an ApprovalRequest takes. */
export interface ApprovalRequestProps {
  /** What the agent wants to do, in one plain sentence, a verb first ("Send the invoice to Northwind."). */
  title: string;
  /**
   * How it looks: `slip`, the default; `bare`, the sentence and the two answers;
   * `ledger`, the default on a faint dither that clears once decided.
   * @default "slip"
   */
  variant?: ApprovalVariant;
  /** Who asks: the agent's name ("Research agent"). */
  agent?: string;
  /** An icon for the agent. Kept for the agent's own record; the calm card names the agent in words. */
  agentIcon?: IconData;
  /**
   * The one fact that decides it, in the quiet line ("£1,240 from the operations account").
   * Leave it out and the names in `affects` stand there.
   */
  summary?: string;
  /** What the action touches: the files, people, money or systems, listed under Details. */
  affects?: readonly ApprovalEffect[];
  /** More to look at before answering, under Details: the command, a diff, a draft. */
  children?: ReactNode;
  /**
   * The words on Approve, when they can say what it does ("Pay £1,240", "Run the migration").
   * @default "Approve"
   */
  approveLabel?: string;
  /**
   * Holds Approve back until the host clears it, with the reason ("Read what will be sent first"):
   * Approve is drawn out of use but stays in the Tab order, the reason is its description (shown
   * under the answers and said), and Decline and Ask for changes stay usable.
   */
  approveHeld?: string;
  /**
   * Matters enough to ask twice: Approve asks in place first, unless `confirmApproval` asks in
   * its own way.
   * @default false
   */
  grave?: boolean;
  /** The whole action cannot be undone: said once, in words, after the fact. @default false */
  irreversible?: boolean;
  /**
   * Your own last check before a grave approval: an Alert dialog, a hold-to-confirm. Resolve
   * `true` to go on. Leave it out for the built-in check in place.
   */
  confirmApproval?: () => boolean | Promise<boolean>;
  /**
   * Records the person's yes, for the agent to act on: return a Promise and the button works until
   * it is recorded. It is not the action itself, so a failed run later is the agent's to report.
   */
  onApprove?: () => unknown;
  /** Records the person's no. */
  onDecline?: () => unknown;
  /** Sends the person's words when they ask for changes, offered under Details. Leave it out to offer none. */
  onRequestChanges?: (note: string) => unknown;
  /**
   * Takes an answer back while the agent has not acted on it. Pass it and the settled line offers
   * Undo on an answer given here; the card waits again.
   */
  onUndo?: () => unknown;
  /**
   * An example of the changes someone might ask for, in the field.
   * @default "Say what should change"
   */
  changesPlaceholder?: string;
  /**
   * What was decided, when you keep it (from the server). An answer given here shows at once and
   * holds until this changes. Leave it out and the card keeps its own.
   */
  decision?: ApprovalDecision;
  /** The name the card gives the person who answers here. @default "You" */
  viewer?: string;
  /** Their portrait, kept with the decision made here. */
  viewerPortrait?: string;
  /** How long it has waited, at the end of the quiet line ("Waiting 2 min", "2 min ago"). */
  askedAt?: string;
  /** When it runs out, when that is near: it takes `askedAt`'s place ("Expires in 10 min"). */
  expiresIn?: string;
  /** Every word the card shows, for a product that translates them. English by default. */
  words?: Partial<ApprovalWords>;
  /** The level of its heading, so the page's outline stays in order. @default 3 */
  headingLevel?: 2 | 3 | 4;
  /** @deprecated Use `layout`. */
  style?: ApprovalRequestLayoutStyle;
  /** Layout only: where it sits and how wide it is. It stands at most `approval-width` wide. */
  layout?: ApprovalRequestLayoutStyle;
}

const REDUCED = media.reduced;
const FORCED = media.forced;
// On a phone the card tightens: less room, a smaller sentence.
const NARROW = media.belowPhone;
// A narrow card by its own width, not the window's: Details stands over the answers, which share
// their row equally. A button is as wide as its widest words ("Could not approve"), so two of them
// beside Details do not fit a phone.
const NARROW_CARD = "@container approval (width < 26rem)";

// The settled line comes in where the answers stood: a fade, no travel.
const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

const styles = stylex.create({
  root: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    isolation: "isolate",
    display: "grid",
    width: "100%",
    maxWidth: grasp.approvalWidth,
    boxSizing: "border-box",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
    outline: { default: "none", [FORCED]: "1px solid CanvasText" },
    overflow: "clip",
    fontFamily: grasp.fontSans,
    color: grasp.ink,
  },
  body: {
    containerType: "inline-size",
    containerName: "approval",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: grasp.space4,
    paddingBlock: { default: grasp.space5, [NARROW]: grasp.space4 },
    paddingInline: { default: grasp.space5, [NARROW]: grasp.space4 },
  },
  // The ask and the quiet line under it: one object.
  // Details folds open inside it, so a shut Details adds no room.
  head: { display: "grid", minWidth: 0 },

  // The ask: the card's one focus.
  sentence: {
    margin: 0,
    fontFamily: grasp.fontSerif,
    fontWeight: grasp.weightRegular,
    fontSize: { default: grasp.titleMd, [NARROW]: grasp.titleSm },
    lineHeight: { default: grasp.titleMdLine, [NARROW]: grasp.titleSmLine },
    letterSpacing: grasp.trackingTitle,
    color: grasp.ink,
    textWrap: "pretty",
    overflowWrap: "anywhere",
  },
  // Who asks, the fact that decides it, how long it has waited: one quiet line.
  meta: {
    margin: 0,
    paddingBlockStart: grasp.space1,
    minWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    overflowWrap: "anywhere",
    fontVariantNumeric: "tabular-nums",
  },
  fact: { color: grasp.ink },
  // Cannot be undone: the danger colour on the same words, nothing else.
  final: { color: { default: grasp.danger, [FORCED]: "CanvasText" } },

  // Details: folds open by height under the quiet line.
  fold: {
    display: "grid",
    gridTemplateRows: "1fr",
    minWidth: 0,
    opacity: 1,
    transitionProperty: {
      default: "grid-template-rows, opacity",
      [REDUCED]: "opacity",
    },
    transitionDuration: simply.appear,
    transitionTimingFunction: grasp.easeInOut,
  },
  foldShut: { gridTemplateRows: "0fr", opacity: 0, visibility: "hidden" },
  foldInner: { minHeight: 0, overflow: "hidden" },
  details: {
    display: "grid",
    gap: grasp.space3,
    justifyItems: "start",
    paddingBlockStart: grasp.space4,
  },
  effects: {
    display: "grid",
    gap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
    justifySelf: "stretch",
  },
  effect: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: grasp.space2,
    alignItems: "start",
  },
  effectIcon: {
    display: "inline-flex",
    alignItems: "center",
    height: grasp.textSmLine,
    color: grasp.muted,
  },
  effectWords: {
    display: "grid",
    minWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    overflowWrap: "anywhere",
  },
  effectDetail: { color: grasp.muted },
  more: { minWidth: 0, justifySelf: "stretch" },

  // The row: Details at the start; at the end, the answers, or the settled line in their place.
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignItems: "center",
    columnGap: grasp.space3,
    minHeight: grasp.controlMd,
  },
  rowWithDetails: {
    gridTemplateColumns: {
      default: "auto minmax(0, 1fr)",
      [NARROW_CARD]: "minmax(0, 1fr)",
    },
    rowGap: grasp.space3,
    justifyItems: "start",
  },
  rowStack: { justifySelf: "stretch" },
  // One cell holding the answers and the settled line, so the row never changes height.
  stack: {
    display: "grid",
    minWidth: 0,
    alignItems: "center",
  },
  cell: { gridArea: "1 / 1", minWidth: 0 },
  // The settled line stands at the end, where Approve was.
  cellEnd: {
    justifySelf: { default: "end", [NARROW_CARD]: "start" },
    maxWidth: "100%",
  },
  answers: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: grasp.space2,
  },
  answersShared: {
    display: { default: "flex", [NARROW_CARD]: "grid" },
    gridTemplateColumns: {
      default: null,
      [NARROW_CARD]: "repeat(2, minmax(0, 1fr))",
    },
  },
  // Why Approve is held: one quiet line under the row, at its end.
  held: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    textAlign: { default: "end", [NARROW_CARD]: "start" },
    textWrap: "pretty",
  },
  // The answer not pressed fades where it stands while the other works: its room stays.
  away: {
    opacity: 0,
    visibility: "hidden",
    transitionProperty: "opacity, visibility",
    transitionDuration: simply.leave,
  },
  answer: {
    display: "grid",
    minWidth: 0,
    opacity: 1,
    transitionProperty: "opacity, visibility",
    transitionDuration: simply.leave,
  },
  // Once settled, the answers stand hidden in their cell, keeping the row's height.
  // Opacity too: a button's own layers set their visibility, so hiding the parent alone left words showing.
  settledAway: { opacity: 0, visibility: "hidden", pointerEvents: "none" },

  // A text action: the card's quiet words, a button only in what it does.
  textAction: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    backgroundColor: "transparent",
    color: { default: grasp.muted, ":hover": grasp.ink },
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightRegular,
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: grasp.linkUnderlineOffset,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    transitionProperty: "color",
    transitionDuration: grasp.durationHover,
    "::before": {
      content: "''",
      position: "absolute",
      insetBlock: {
        default: 0,
        [media.coarse]: `calc((100% - ${grasp.tap}) / 2)`,
      },
      insetInline: 0,
    },
  },
  textActionOff: {
    opacity: grasp.dim,
    cursor: "not-allowed",
    textDecorationLine: "none",
  },
  changes: { display: "grid", gap: grasp.space3 },
  sure: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  sureWords: { minWidth: 0, color: grasp.danger },

  // The Ledger's dither: very faint dots, lit at the top, clearing once decided.
  dither: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    backgroundImage: `radial-gradient(color-mix(in oklch, ${grasp.ink} 9%, transparent) 0.6px, transparent 0.8px)`,
    backgroundSize: "3px 3px",
    maskImage: "linear-gradient(to bottom, black, transparent 70%)",
    pointerEvents: "none",
    transitionProperty: "opacity",
    transitionDuration: simply.settle,
    display: { default: "block", [FORCED]: "none" },
  },
  gone: { opacity: 0 },

  // The settled line, where the answers stood: the mark, who decided, when, and Undo.
  line: {
    display: "inline-flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    columnGap: grasp.space2,
    rowGap: grasp.space1,
    margin: 0,
    minWidth: 0,
    borderRadius: grasp.cornerMark,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    animationName: { default: fadeIn, [REDUCED]: "none" },
    animationDuration: simply.swap,
    animationTimingFunction: grasp.ease,
  },
  lineMark: { display: "inline-flex", color: grasp.muted },
  lineApproved: { color: { default: grasp.mintDeep, [FORCED]: "CanvasText" } },
  lineDecided: { color: grasp.ink },
  lineWords: { minWidth: 0, overflowWrap: "anywhere" },

  // A card drawn decided: the one line alone, with the ask.
  compact: {
    display: "grid",
    gridTemplateColumns: {
      default: "auto minmax(0, 1fr) auto",
      [NARROW]: "auto minmax(0, 1fr)",
    },
    alignItems: "start",
    columnGap: grasp.space3,
    rowGap: grasp.space1,
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  compactMark: {
    display: "inline-flex",
    paddingBlockStart: `calc((${grasp.textSmLine} - ${grasp.iconSm}) / 2)`,
    color: grasp.muted,
  },
  compactAsk: {
    minWidth: 0,
    color: grasp.ink,
    overflowWrap: "anywhere",
    textWrap: "pretty",
  },
  compactEnd: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    gridColumn: { default: "auto", [NARROW]: "2" },
  },
});

const kinds: Record<ApprovalKind, IconData> = {
  file: File,
  person: Person,
  money: Money,
  system: System,
  other: Agent,
};
const marks: Record<Exclude<ApprovalStatus, "waiting">, IconData> = {
  approved: Done,
  declined: Cross,
  changes: Edit,
  expired: Clock,
  superseded: Replaced,
};

const headings: Record<2 | 3 | 4, "h2" | "h3" | "h4"> = {
  2: "h2",
  3: "h3",
  4: "h4",
};

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** A Date in words: the time of day, with the date when it was not today. */
const clockOf = (at: Date) => {
  const clock = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return sameDay(at, new Date())
    ? clock
    : `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clock}`;
};

/** When, in words: words as given, a Date as its time. */
const time = (at: Date | string | undefined): string | undefined =>
  at instanceof Date ? clockOf(at) : at;

/** Your own check first, as a plain yes or no: a check that fails is a no. Kept out of the component. */
const ask = async (check: () => boolean | Promise<boolean>) => {
  try {
    return await check();
  } catch {
    return false;
  }
};

/** Nothing touched: a stable empty list for the default. */
const nothing: readonly ApprovalEffect[] = [];

/** Any of it cannot be undone. */
const isFinal = (irreversible: boolean, affects: readonly ApprovalEffect[]) =>
  irreversible || affects.some((effect) => effect.irreversible === true);

/** The decision in words: "Approved by you", or the word alone when no one is named. */
const signedWords = (
  decision: ApprovalDecision,
  words: ApprovalWords,
  viewer: string
) => {
  const { status } = decision;
  if (status === "waiting") {
    return "";
  }
  const word = words[status];
  const named =
    decision.by !== undefined &&
    decision.by !== "" &&
    status !== "expired" &&
    status !== "superseded";
  if (!named || decision.by === undefined) {
    return word;
  }
  return words.signed(word, decision.by === viewer ? words.you : decision.by);
};

const Effect = ({ effect }: { effect: ApprovalEffect }) => (
  <li {...stylex.props(styles.effect)}>
    <span aria-hidden="true" {...stylex.props(styles.effectIcon)}>
      <Icon icon={kinds[effect.kind]} />
    </span>
    <span {...stylex.props(styles.effectWords)}>
      {effect.label}
      {effect.detail !== undefined && effect.detail !== "" && (
        <span {...stylex.props(styles.effectDetail)}>{effect.detail}</span>
      )}
    </span>
  </li>
);

/** A quiet action in the card's own words: Details, Ask for changes, Undo. */
const TextAction = ({
  disabled = false,
  ...rest
}: Omit<ComponentProps<"button">, "className" | "style" | "type">) => (
  <button
    type="button"
    disabled={disabled}
    {...rest}
    {...stylex.props(
      styles.textAction,
      disabled && styles.textActionOff,
      focus.ring
    )}
  />
);

interface SettledLineProps {
  decision: ApprovalDecision;
  words: ApprovalWords;
  viewer: string;
  onUndo?: () => void;
  lineRef: RefObject<HTMLParagraphElement | null>;
}

/** The settled line where the answers stood: "Approved by you · 14:02", and Undo where it can be. */
const SettledLine = ({
  decision,
  words,
  viewer,
  onUndo,
  lineRef,
}: SettledLineProps) => {
  const { status } = decision;
  if (status === "waiting") {
    return null;
  }
  const at = time(decision.at);
  const note =
    decision.note !== undefined && decision.note !== ""
      ? ` “${decision.note}”`
      : "";
  return (
    <p
      ref={lineRef}
      tabIndex={-1}
      data-approval-line=""
      {...stylex.props(styles.cell, styles.cellEnd, styles.line, focus.ring)}
    >
      <span
        aria-hidden="true"
        {...stylex.props(
          styles.lineMark,
          status === "approved" && styles.lineApproved
        )}
      >
        <Icon icon={marks[status]} />
      </span>
      <span {...stylex.props(styles.lineWords)}>
        <span {...stylex.props(styles.lineDecided)}>
          {signedWords(decision, words, viewer)}
        </span>
        {note}
        {at === undefined ? "" : ` · ${at}`}
      </span>
      {onUndo !== undefined && (
        <TextAction onClick={onUndo}>{words.undo}</TextAction>
      )}
    </p>
  );
};

interface CompactProps extends SettledLineProps {
  title: string;
}

/** A card drawn decided: the mark, the ask, then who decided and when. */
const Compact = ({
  title,
  decision,
  words,
  viewer,
  onUndo,
  lineRef,
}: CompactProps) => {
  const { status } = decision;
  if (status === "waiting") {
    return null;
  }
  const at = time(decision.at);
  const note =
    decision.note !== undefined && decision.note !== ""
      ? ` “${decision.note}”`
      : "";
  return (
    <p
      ref={lineRef}
      tabIndex={-1}
      data-approval-line=""
      {...stylex.props(styles.compact, focus.inside)}
    >
      <span
        aria-hidden="true"
        {...stylex.props(
          styles.compactMark,
          status === "approved" && styles.lineApproved
        )}
      >
        <Icon icon={marks[status]} />
      </span>
      <span {...stylex.props(styles.compactAsk)}>
        {title}
        {note}
      </span>
      <span {...stylex.props(styles.compactEnd)}>
        <span>
          <span {...stylex.props(styles.lineDecided)}>
            {signedWords(decision, words, viewer)}
          </span>
          {at === undefined ? "" : ` · ${at}`}
        </span>
        {onUndo !== undefined && (
          <TextAction onClick={onUndo}>{words.undo}</TextAction>
        )}
      </span>
    </p>
  );
};

/** The changes asked for: the words, then send them or go back. Escape goes back too. */
const ChangesForm = ({
  words,
  placeholder,
  note,
  setNote,
  onBack,
  send,
  answering,
}: {
  words: ApprovalWords;
  placeholder: string;
  note: string;
  setNote: (note: string) => void;
  onBack: () => void;
  send: Action<[], unknown>;
  answering: boolean;
}) => {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  return (
    <form
      {...stylex.props(styles.changes)}
      onSubmit={(event) => {
        event.preventDefault();
        if (note.trim() !== "" && !answering) {
          void send.run();
        }
      }}
    >
      <Textarea
        ref={field}
        aria-label={words.whatShouldChange}
        placeholder={placeholder}
        rows={2}
        value={note}
        onValueChange={(value: string) => {
          setNote(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // One Escape does one thing: back, and no listener of the host's hears it.
            event.preventDefault();
            event.stopPropagation();
            onBack();
          }
        }}
        required
      />
      <div {...stylex.props(styles.answers)}>
        <Button type="button" variant="ghost" onClick={onBack}>
          {words.back}
        </Button>
        <Button
          type="submit"
          variant="ink"
          {...send.status}
          disabled={note.trim() === "" || answering}
        >
          {words.send}
        </Button>
      </div>
    </form>
  );
};

/** A grave approval asks once more, in place: Not yet, or yes. Escape is Not yet. */
const SureGroup = ({
  words,
  approveLabel,
  finals,
  onBack,
  approve,
  answering,
}: {
  words: ApprovalWords;
  approveLabel: string;
  finals: boolean;
  onBack: () => void;
  approve: Action<[], unknown>;
  answering: boolean;
}) => {
  const notYet = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    notYet.current?.focus();
  }, []);
  const escape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      // One Escape does one thing: Not yet, and no listener of the host's hears it.
      event.preventDefault();
      event.stopPropagation();
      onBack();
    }
  };
  return (
    <fieldset aria-label={words.sure} {...stylex.props(styles.sure)}>
      <span {...stylex.props(styles.sureWords)}>
        {finals ? words.sureFinal : words.sure}
      </span>
      <span
        {...stylex.props(
          styles.answer,
          approve.state === "working" && styles.away
        )}
      >
        <Button
          ref={notYet}
          variant="ghost"
          disabled={answering}
          onClick={onBack}
          onKeyDown={escape}
        >
          {words.notYet}
        </Button>
      </span>
      <Button variant="approve" {...approve.props} onKeyDown={escape}>
        {words.confirm(words.yes, approveLabel)}
      </Button>
    </fieldset>
  );
};

type Step = "answers" | "changes" | "sure";

/** What the body needs beyond the card's own props. */
interface BodyProps extends Omit<
  ApprovalRequestProps,
  "words" | "style" | "variant" | "decision"
> {
  words: ApprovalWords;
  /** Resolved by ApprovalRequest: the caller's, else the catalogue's. */
  approveLabel: string;
  changesPlaceholder: string;
  titleId: string;
  bare: boolean;
  decision: ApprovalDecision;
  viewer: string;
  decide: (status: ApprovalStatus, note?: string) => void;
  /** Undo on the settled line, when the answer given here can be taken back. */
  onTakeBack?: () => void;
  lineRef: RefObject<HTMLParagraphElement | null>;
}

/** The ask, in one sentence: the card's heading and its one focus. */
const Sentence = ({
  title,
  titleId,
  headingLevel = 3,
}: {
  title: string;
  titleId: string;
  headingLevel?: 2 | 3 | 4;
}) => {
  const Heading = headings[headingLevel];
  return (
    <Heading id={titleId} {...stylex.props(styles.sentence)}>
      {title}
    </Heading>
  );
};

const Dot = () => <span aria-hidden="true"> · </span>;

interface MetaProps {
  agent: string;
  words: ApprovalWords;
  fact: string;
  finals: boolean;
  waited: string | undefined;
  /** Answered: how long it waited is no longer true, so it goes, keeping its room so nothing moves. */
  settled: boolean;
}

/** Who asks, the one fact that decides it, how long it has waited: one quiet line. */
const Meta = ({ agent, words, fact, finals, waited, settled }: MetaProps) => (
  <p {...stylex.props(styles.meta)}>
    <span>{agent}</span>
    {fact !== "" && (
      <>
        <Dot />
        <span {...stylex.props(styles.fact)}>{fact}</span>
      </>
    )}
    {finals && (
      <>
        {fact === "" ? <Dot /> : ", "}
        <span {...stylex.props(styles.final)}>{words.final}</span>
      </>
    )}
    {waited !== undefined && waited !== "" && (
      <span
        aria-hidden={settled ? true : undefined}
        data-approval-waited=""
        {...stylex.props(settled && styles.settledAway)}
      >
        <Dot />
        <span>{waited}</span>
      </span>
    )}
  </p>
);

/** Details, open: the full list of what it touches, anything more to look at, and Ask for changes. */
const DetailsPanel = ({
  id,
  open,
  affects,
  children,
  changes,
}: {
  id: string;
  open: boolean;
  affects: readonly ApprovalEffect[];
  children?: ReactNode;
  changes: ReactNode;
}) => (
  <div
    id={id}
    inert={!open}
    {...stylex.props(styles.fold, !open && styles.foldShut)}
  >
    <div {...stylex.props(styles.foldInner)}>
      <div {...stylex.props(styles.details)}>
        {affects.length > 0 && (
          <ul {...stylex.props(styles.effects)}>
            {affects.map((effect, index) => (
              <Effect
                key={`${effect.kind}-${effect.label}-${String(index)}`}
                effect={effect}
              />
            ))}
          </ul>
        )}
        {children !== undefined && children !== null && (
          <div {...stylex.props(styles.more)}>{children}</div>
        )}
        {changes}
      </div>
    </div>
  </div>
);

interface AnswersProps {
  words: ApprovalWords;
  approveLabel: string;
  finals: boolean;
  step: Step;
  approve: Action<[], unknown>;
  decline: Action<[], unknown>;
  answering: boolean;
  settled: boolean;
  onApprovePress: () => void;
  onBack: () => void;
  /** Why Approve is held, while it is, and the id of the line that says it. */
  held?: string;
  heldId: string;
}

/** Decline and Approve, or the grave question in their place. The one not pressed fades where it stands. */
const Answers = ({
  words,
  approveLabel,
  finals,
  step,
  approve,
  decline,
  answering,
  settled,
  onApprovePress,
  onBack,
  held,
  heldId,
}: AnswersProps) => {
  if (step === "sure") {
    return (
      <div
        inert={settled}
        {...stylex.props(styles.cell, settled && styles.settledAway)}
      >
        <SureGroup
          words={words}
          approveLabel={approveLabel}
          finals={finals}
          onBack={onBack}
          approve={approve}
          answering={answering}
        />
      </div>
    );
  }
  return (
    <div
      inert={settled}
      {...stylex.props(
        styles.cell,
        styles.answers,
        styles.answersShared,
        settled && styles.settledAway
      )}
    >
      <span
        {...stylex.props(
          styles.answer,
          approve.state === "working" && styles.away
        )}
      >
        <Button
          variant="quiet"
          {...decline.props}
          disabled={answering && decline.state !== "working"}
        >
          {words.decline}
        </Button>
      </span>
      <span
        {...stylex.props(
          styles.answer,
          decline.state === "working" && styles.away
        )}
      >
        <Button
          variant="approve"
          type="button"
          {...approve.status}
          disabled={
            (answering && approve.state !== "working") || held !== undefined
          }
          // Held: out of use but still reached by Tab, so its reason can be heard from it.
          focusableWhenDisabled={held !== undefined}
          aria-describedby={held === undefined ? undefined : heldId}
          data-approval-opens="approve"
          data-held={held === undefined ? undefined : ""}
          onClick={onApprovePress}
        >
          {approveLabel}
        </Button>
      </span>
    </div>
  );
};

/** The three answers' lives, one at a time. */
const useAnswers = (props: BodyProps, note: string, onSent: () => void) => {
  const { words, onApprove, onDecline, onRequestChanges, decide } = props;
  const approve = useAction(
    async () => {
      await onApprove?.();
      decide("approved");
    },
    {
      working: words.approving,
      done: words.approved,
      failed: words.couldNotApprove,
    }
  );
  const decline = useAction(
    async () => {
      await onDecline?.();
      decide("declined");
    },
    {
      working: words.declining,
      done: words.declined,
      failed: words.couldNotDecline,
    }
  );
  const send = useAction(
    async () => {
      await onRequestChanges?.(note.trim());
      decide("changes", note.trim());
      onSent();
    },
    { working: words.sending, done: words.changes, failed: words.couldNotSend }
  );
  const answering = [approve, decline, send].some(
    (action) => action.state === "working"
  );
  return { approve, decline, send, answering };
};

/** Why Approve is held: one quiet line under the row, while it is held and nothing is decided. */
const HeldLine = ({ id, held }: { id: string; held: string | undefined }) =>
  held === undefined ? null : (
    <p id={id} data-slot="approval-held" {...stylex.props(styles.held)}>
      {held}
    </p>
  );

/** The card's waiting body: the ask, the quiet line, Details, and the row of answers. */
const Body = (props: BodyProps) => {
  const {
    words,
    bare,
    decision,
    viewer,
    affects = nothing,
    irreversible = false,
    approveLabel,
    grave = false,
    changesPlaceholder,
    confirmApproval,
    onRequestChanges,
  } = props;
  const [step, setStep] = useState<Step>("answers");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const holder = useRef<HTMLDivElement>(null);
  const confirming = useRef(false);
  const detailsId = useId();
  const heldId = useId();
  const { approve, decline, send, answering } = useAnswers(props, note, () => {
    setStep("answers");
  });
  const settled = decision.status !== "waiting";
  const finals = isFinal(irreversible, affects);
  const fact =
    props.summary ?? affects.map((effect) => effect.label).join(", ");
  const showDetails =
    !bare &&
    (affects.length > 0 ||
      props.children !== undefined ||
      onRequestChanges !== undefined);

  /** Back from a step: to the button that opened it. */
  const back = (from: "changes" | "sure") => {
    setStep("answers");
    requestAnimationFrame(() => {
      holder.current
        ?.querySelector<HTMLElement>(
          `[data-approval-opens="${from === "sure" ? "approve" : "changes"}"]`
        )
        ?.focus();
    });
  };

  /** Your own check first; only a yes starts the approval, and a second press waits for it. */
  const confirmThenApprove = async (
    check: () => boolean | Promise<boolean>
  ) => {
    if (confirming.current) {
      return;
    }
    confirming.current = true;
    const yes = await ask(check);
    confirming.current = false;
    if (yes) {
      void approve.run();
    }
  };

  const pressApprove = () => {
    if (!grave) {
      void approve.run();
    } else if (confirmApproval === undefined) {
      setStep("sure");
    } else {
      void confirmThenApprove(confirmApproval);
    }
  };

  // Out of an agent's sight, and once settled hidden where it stands, so Details keeps its height.
  const changes = onRequestChanges !== undefined && (
    <span
      data-agent-hidden=""
      inert={settled}
      {...stylex.props(settled && styles.settledAway)}
    >
      <TextAction
        disabled={answering}
        data-approval-opens="changes"
        onClick={() => {
          setStep("changes");
        }}
      >
        {words.askForChanges}
      </TextAction>
    </span>
  );

  return (
    <div ref={holder} {...stylex.props(styles.body)}>
      <div {...stylex.props(styles.head)}>
        <Sentence
          title={props.title}
          titleId={props.titleId}
          headingLevel={props.headingLevel}
        />
        <Meta
          agent={props.agent ?? words.theAgent}
          words={words}
          fact={bare ? "" : fact}
          finals={!bare && finals}
          waited={props.expiresIn ?? props.askedAt}
          settled={settled}
        />
        {showDetails && (
          <DetailsPanel
            id={detailsId}
            open={open}
            affects={affects}
            changes={changes}
          >
            {props.children}
          </DetailsPanel>
        )}
      </div>
      {step === "changes" ? (
        <div data-agent-hidden="">
          <ChangesForm
            words={words}
            placeholder={changesPlaceholder}
            note={note}
            setNote={setNote}
            onBack={() => {
              back("changes");
            }}
            send={send}
            answering={answering}
          />
        </div>
      ) : (
        <div
          {...stylex.props(styles.row, showDetails && styles.rowWithDetails)}
          data-agent-hidden=""
        >
          {showDetails && (
            <TextAction
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => {
                setOpen((was) => !was);
              }}
            >
              {words.details}
            </TextAction>
          )}
          <div {...stylex.props(styles.stack, styles.rowStack)}>
            <Answers
              words={words}
              approveLabel={approveLabel}
              finals={finals}
              step={step}
              approve={approve}
              decline={decline}
              answering={answering}
              settled={settled}
              onApprovePress={pressApprove}
              held={props.approveHeld}
              heldId={heldId}
              onBack={() => {
                back("sure");
              }}
            />
            <SettledLine
              decision={decision}
              words={words}
              viewer={viewer}
              onUndo={props.onTakeBack}
              lineRef={props.lineRef}
            />
          </div>
        </div>
      )}
      <HeldLine
        id={heldId}
        held={settled || step !== "answers" ? undefined : props.approveHeld}
      />
    </div>
  );
};

interface DecisionSetup {
  given: ApprovalDecision | undefined;
  viewer: string;
  viewerPortrait: string | undefined;
  title: string;
  words: ApprovalWords;
  onUndo: (() => unknown) | undefined;
  card: RefObject<HTMLElement | null>;
}

/**
 * Where the request stands: your decision when you keep one, else the card's own; an answer given
 * here, held while yours still says waiting; said once, and focus kept on the settled line.
 */
const useDecision = ({
  given,
  viewer,
  viewerPortrait,
  title,
  words,
  onUndo,
  card,
}: DecisionSetup) => {
  const [own, setOwn] = useState<ApprovalDecision>({ status: "waiting" });
  const [held, setHeld] = useState<ApprovalDecision | null>(null);
  const [round, setRound] = useState(0);
  const line = useRef<HTMLParagraphElement>(null);
  const answeredHere = useRef(false);
  // Your decision moving on (from the server) replaces the answer held here, so an Undo of yours
  // that returns it to waiting is not undone by an old answer.
  const [lastGiven, setLastGiven] = useState(given?.status);
  if (given?.status !== lastGiven) {
    setLastGiven(given?.status);
    if (given !== undefined && given.status !== "waiting") {
      setHeld(null);
    }
  }
  const kept = given ?? own;
  const decision: ApprovalDecision =
    kept.status === "waiting" && given !== undefined && held !== null
      ? held
      : kept;
  const settled = useRef(decision.status);
  const by = signedWords(decision, words, viewer);
  const announcement = decision.status === "waiting" ? "" : `${by}: ${title}`;

  // Before the frame is painted: the answers just went inert, so focus moves to the line at once
  // and never rests on the page.
  useLayoutEffect(() => {
    if (settled.current === decision.status) {
      return;
    }
    settled.current = decision.status;
    if (announcement === "") {
      return;
    }
    announce(announcement);
    const inside =
      card.current?.contains(document.activeElement) === true ||
      document.activeElement === document.body;
    if (answeredHere.current || inside) {
      line.current?.focus({ preventScroll: true });
    }
    answeredHere.current = false;
  }, [decision.status, announcement, card]);

  const decide = (status: ApprovalStatus, note?: string) => {
    answeredHere.current = true;
    const made: ApprovalDecision = {
      status,
      by: viewer,
      portrait: viewerPortrait,
      at: new Date(),
      note,
    };
    if (given === undefined) {
      setOwn(made);
    } else {
      setHeld(made);
    }
  };

  const undo = () => {
    setOwn({ status: "waiting" });
    setHeld(null);
    setRound((count) => count + 1);
    void onUndo?.();
    announce(`${words.undone}: ${title}`);
    // The answers come back where the line stood: focus goes to Approve, never to the page.
    requestAnimationFrame(() => {
      card.current
        ?.querySelector<HTMLElement>('[data-approval-opens="approve"]')
        ?.focus({ preventScroll: true });
    });
  };

  // Undo only for an answer given here, while the caller can take it back.
  const undoable =
    onUndo !== undefined &&
    decision.by === viewer &&
    decision.status !== "expired" &&
    decision.status !== "superseded";
  return {
    decision,
    decide,
    handleUndo: undoable ? undo : undefined,
    round,
    line,
  };
};

/** The card an agent shows when it needs a person's yes; once answered, one line stands where the answers were. */
export const ApprovalRequest = (props: ApprovalRequestProps) => {
  const {
    title,
    variant = "slip",
    decision: given,
    viewerPortrait,
    onUndo,
    words: givenWords,
    style: styleProp,
    layout,
  } = props;
  // Its words: the product's, by its catalogue, else English; the caller's words and text props win.
  const words = withGiven(useWords("approvalRequest", approvalRequestWords), {
    ...givenWords,
    approve: props.approveLabel,
    changesPlaceholder: props.changesPlaceholder,
    viewer: props.viewer,
  });
  const { viewer } = words;
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  const life = useDecision({
    given,
    viewer,
    viewerPortrait,
    title,
    words,
    onUndo,
    card,
  });
  const waiting = life.decision.status === "waiting";
  // Drawn decided, it is the one line alone; once it has waited here, it keeps its full height.
  const [compact, setCompact] = useState(!waiting);
  if (compact && waiting) {
    setCompact(false);
  }

  return (
    <section
      ref={card}
      aria-labelledby={compact ? undefined : titleId}
      aria-label={compact ? title || undefined : undefined}
      data-slot="approval-request"
      data-variant={variant}
      data-status={life.decision.status}
      // For a person only: an agent asked to act inside it must ask the person first.
      data-agent-confirm={`Answers the request "${title}", which only a person may do`}
      {...stylex.props(styles.root, layout ?? styleProp)}
    >
      {variant === "ledger" && (
        <span
          aria-hidden="true"
          {...stylex.props(styles.dither, !waiting && styles.gone)}
        />
      )}
      {compact ? (
        <Compact
          title={title}
          decision={life.decision}
          words={words}
          viewer={viewer}
          onUndo={life.handleUndo}
          lineRef={life.line}
        />
      ) : (
        <Body
          key={life.round}
          {...props}
          words={words}
          approveLabel={words.approve}
          changesPlaceholder={words.changesPlaceholder}
          titleId={titleId}
          bare={variant === "bare"}
          decision={life.decision}
          viewer={viewer}
          decide={life.decide}
          onTakeBack={life.handleUndo}
          lineRef={life.line}
        />
      )}
    </section>
  );
};
