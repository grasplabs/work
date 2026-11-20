// Composer: where a person writes to an assistant, after Profound's Palermo, with Grasp's light.
// A card with the text on top and a footer of actions under it, send at the end. Enter sends and
// Shift+Enter starts a line. While the assistant works, Grasp's light travels round the card and
// send turns into Stop; when it is done, a halo of mint glows once.
//
//   <Composer label="Message" placeholder="Ask a question" failedLabel="Could not send" onSend={send} />
//   <Composer ... activity="working" onStop={stop} />            the assistant is working
//   <Composer ... start={<ComposerAction icon={Plus} label="Add a file" />} />
//   <Composer ... takeover={<QuestionTool embedded ... />} />     a question in place of the text
//
// The text is UI SDK's Textarea and send and Stop are UI SDK's Button, so an agent can write and
// send by name, and a send that fails fails for the agent too, with the words the person sees.
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Textarea as TextareaPrimitive } from "@ui-sdk/react/textarea";
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ClipboardEvent,
  CompositionEvent,
  ComponentProps,
  Dispatch,
  DragEvent,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactElement,
  ReactNode,
  Ref,
  RefObject,
  SetStateAction,
  SubmitEvent,
} from "react";
import { flushSync } from "react-dom";

import { AgentIndicator } from "../agent-indicator";
import { visuallyHidden } from "../hidden/hidden";
import { Alert, Icon, Listening, Mic } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { scroll } from "../scroll/scroll";
import { Shimmer } from "../shimmer";
import { grasp, media } from "../tokens/tokens.stylex";
import { ComposerAction } from "./action";
import type { ComposerActionPressedVariant } from "./action";
import type { ComposerKind } from "./add";
import { ChosenAgentContext, ComposerAgentChip } from "./agent-chip";
import type { ComposerChosenAgent } from "./agent-chip";
import type { ComposerAttachmentWords } from "./attachment";
import { ComposerAttachments } from "./attachments";
import type { ComposerFile } from "./attachments";
import {
  DisabledContext,
  LeaveContext,
  ListenContext,
  MentionContext,
  RowTallContext,
} from "./context";
import type { ComposerListener } from "./context";
import { ComposerGlow } from "./glow";
import type { ComposerAccent, ComposerEdge } from "./glow";
import { MentionMenu, caretPoint, mentionRows } from "./mention";
import type { ComposerMentionItem, MentionRow } from "./mention";
import { Kept, PendingText } from "./pending";
import {
  COMPOSER_CLIPBOARD,
  PictureChip,
  canonicalSlice,
  chipAt,
  wholeChips,
  composerPictureToken,
  composerUnreferenced,
  editField,
  isInlinePicture,
  mapBack,
  piecesOf,
  pictureToken,
  readableText,
  seenLength,
  showText,
  shownOf,
  useInlinePictures,
} from "./pictures";
import type { ComposerPicture, Insertion, Piece } from "./pictures";
import { rowMarker } from "./row.stylex";
import { ComposerSend } from "./send";
import { ComposerVoice, VoiceProblem, stoppedBy } from "./voice";
import type { ComposerVoiceProps } from "./voice";
import { useComposerWords } from "./words";
import type { ComposerWords } from "./words";

/** The field's name by its new name, else its deprecated old one (the breaking release's step 1). */
const nameOf = (props: { "aria-label"?: string; label?: string }) =>
  props["aria-label"] ?? props.label ?? "";

/** What a caller may style: where the composer sits and how wide it is. Never its look. */
export type ComposerLayoutStyle = LayoutStyle;

/** Where the assistant is: at rest, working, just done, or out of use. */
export type ComposerActivity = "idle" | "working" | "success" | "disabled";

type TextareaProps = ComponentProps<typeof TextareaPrimitive>;

/** What a send carries besides its text. */
export interface ComposerSendDetails {
  /** The attachments, in order: the pictures in the text and the files above it. */
  attachments: ComposerFile[];
}

/** Every prop a Composer takes. */
export interface ComposerProps {
  /** The name of the text, for a screen reader and an agent ("Message"). It is not shown. */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** An example of what to write ("Ask a question"). It goes when typing starts. */
  placeholder?: string;
  /**
   * Sends the text. Return a Promise and the composer waits: on success the text clears, on
   * failure it stays and `failedLabel` shows under the card. Each picture's chip in the text comes
   * as `@[Image 1](attachment:<id>)` (read it back with `composerTextParts`), and `details` has the
   * attachments in order.
   */
  onSend: (text: string, details: ComposerSendDetails) => unknown;
  /**
   * The words when a send failed, shown under the card and given to an agent.
   * @default "Could not send"
   */
  failedLabel?: string;
  /**
   * Whether the last send failed, set from outside: for a failure learned after `onSend` settled,
   * or a failed draft brought back (with its text in `value` or `defaultValue`). It shows as a send
   * that failed here does: `failedLabel` under the card, the words kept. Leave it unset and the
   * Composer keeps this itself; set it and call `onSendFailedChange` to follow its changes.
   */
  sendFailed?: boolean;
  /** Called when the Composer would change `sendFailed`: true when a send fails, false on typing or a new send. */
  onSendFailedChange?: (failed: boolean) => void;
  /**
   * Where the assistant is. `working`: the light travels round the card, send turns into Stop, and
   * the text can still be written. `success`: one halo of mint, then rest; set it again to play it
   * again. `disabled`: nothing can be written or pressed; the card takes the soft fill and its words
   * go muted. Say why in `note`.
   * @default "idle"
   */
  activity?: ComposerActivity;
  /**
   * The colour of the working light and the success halo: Grasp's light, or an agent's own colour.
   * @default "light"
   */
  accent?: ComposerAccent;
  /**
   * How the working light's edge is drawn: `smooth`, a soft glow, or `dither`, the same light as a
   * fine grid of dots that thins out where the glow fades.
   * @default "smooth"
   */
  edge?: ComposerEdge;
  /** Stops the assistant. Stop shows only while `working`. */
  onStop?: () => unknown;
  /**
   * The words said to a screen reader while working, and shown under the card with the working
   * mark when `showWorking` is set.
   * @default "Working"
   */
  workingLabel?: string;
  /**
   * While working, show the working mark and `workingLabel` under the card ("Searching the web"),
   * beside the light round it. Give `workingLabel` what the agent is doing now.
   * @default false
   */
  showWorking?: boolean;
  /**
   * The words said to a screen reader on success.
   * @default "Done"
   */
  successLabel?: string;
  /**
   * The send button's name.
   * @default "Send"
   */
  sendLabel?: string;
  /**
   * The stop button's name.
   * @default "Stop"
   */
  stopLabel?: string;
  /** Actions at the start of the footer: ComposerAction, such as Add a file. */
  start?: ReactNode;
  /** Actions at the end of the footer, before send. */
  end?: ReactNode;
  /**
   * The quiet controls after the start actions: ComposerModelEffort, the model and its effort as
   * one. ComposerModel, then ComposerReasoning, where they must stand apart.
   */
  controls?: ReactNode;
  /**
   * Voice input, at the end just before send: a ComposerAction (Dictate), quiet (bare) whether or not
   * anything is written. Send always stands last, off while there is nothing to send (Ruben,
   * 18 November). While it listens, give it `pressed` and the Listening icon.
   */
  voice?: ReactNode;
  /**
   * Dictation by default: the footer's microphone, in `voice`'s place, calls this to start
   * listening. The host listens and passes what it hears as `dictation`.
   */
  onDictate?: () => void;
  /**
   * The microphone's name.
   * @default "Dictate"
   */
  dictateLabel?: string;
  /**
   * The host is listening without a takeover (the Ask bar's dictation): the microphone shows as
   * pressed, with the Listening icon.
   * @default false
   */
  listening?: boolean;
  /**
   * The microphone's fill while `listening`: `ink`, or `quiet` as the Ask bar's buttons are.
   * @default "ink"
   */
  listeningVariant?: ComposerActionPressedVariant;
  /**
   * The microphone shows only while nothing is written: once there is text it goes, and send stands
   * alone at the end (the Ask bar, Sidekick's "typing swaps voice for send"). By default it stays.
   * @default false
   */
  dictateWhileEmpty?: boolean;
  /**
   * While given, a dictation takes the card over: ComposerVoice, drawn from these props (the
   * phase, the words, the time, the sound), with what was typed kept before its words. Escape
   * cancels it unless `onTakeoverDismiss` says otherwise. A `takeover` of the host's comes first.
   */
  dictation?: Omit<ComposerVoiceProps, "typed">;
  /**
   * After send, behind a short hairline: a control that is not about this message, such as the Ask
   * bar's Open the chat. In the compact row and in the full footer alike, it stands last.
   */
  footer?: ReactNode;
  /** @deprecated Use `footer`. */
  after?: ReactNode;
  /** Anything else inside the card above the text. Files go in `attachments`. */
  above?: ReactNode;
  /**
   * The files waiting to be sent. A picture (an image's `type`, with its `preview`) goes in the text
   * as a chip, "Image 1", at the caret where it was pasted or dropped; other files, and a picture
   * that failed, stand as cards in a strip above the text. The composer keeps none.
   */
  attachments?: ComposerFile[];
  /**
   * Called with files that were dropped on the composer or pasted into it. Without it, files cannot
   * be dropped or pasted.
   */
  onAttach?: (files: File[]) => void;
  /** Takes a file off the message. */
  onRemoveAttachment?: (id: string) => void;
  /** Tries a failed upload again. */
  onRetryAttachment?: (id: string) => void;
  /** Opens a file: a press on its card. */
  onOpenAttachment?: (id: string) => void;
  /** The attachment words, shared with File upload: Uploading, Uploaded, Could not upload, Try again, Remove. */
  attachmentWords?: Partial<ComposerAttachmentWords>;
  /**
   * The name of the list of files on the card, for a screen reader.
   * @default "Files to send"
   */
  attachmentsLabel?: string;
  /**
   * The kinds of thing that can be mentioned with @, in the menu's first level, each with its one
   * line of help (People: "Tag someone in the team").
   */
  mentionKinds?: ComposerKind[];
  /** The things that can be mentioned, each with its `kind`; commands for the / menu have kind "commands". */
  mentionItems?: ComposerMentionItem[];
  /** Called as the person types after @ or /, to look things up: update `mentionItems` with what is found. */
  onMentionQuery?: (query: string, kind: string | null) => void;
  /**
   * The mention menu is waiting for `onMentionQuery`'s results.
   * @default false
   */
  mentionsLoading?: boolean;
  /**
   * The page's data is not there yet (a frame's first paint): the bar stands still in its own box,
   * the same size it will be, with the plus, a quiet line where the text goes, and Send off. The
   * rest keeps its room but is not drawn, and the card is inert and hidden from a reader: nothing to
   * focus, nothing read out. No light. When it turns false the bar stands in the same box.
   * @default false
   */
  loading?: boolean;
  /** Called with each thing picked from the mention menu. */
  onMention?: (item: ComposerMentionItem) => void;
  /**
   * What is said when nothing matches what was typed.
   * @default "Nothing found"
   */
  mentionsEmptyLabel?: string;
  /**
   * What is said while the mention menu looks for matches (with `mentionsLoading`).
   * @default "Looking"
   */
  mentionsLoadingLabel?: string;
  /**
   * The mention menu's name for a screen reader, when it is not one level into a kind.
   * @default "Mention"
   */
  mentionsLabel?: string;
  /**
   * How many the mention menu found, as a screen reader hears it, with the plural the language
   * takes.
   * @default (count) => `${count} ${count === 1 ? "result" : "results"}`
   */
  mentionsFoundLabel?: (count: number) => string;
  /**
   * What the commands menu is called.
   * @default "Commands"
   */
  commandsLabel?: string;
  /**
   * What the composer says while a file is dragged over the page.
   * @default "Drop to add"
   */
  dropLabel?: string;
  /**
   * Why send waits while a file uploads, under the card.
   * @default "Sending waits for the files to upload"
   */
  uploadingLabel?: string;
  /**
   * The most characters the text takes. Typing stops there, a paste is cut there and that is
   * said, and a quiet count shows from 90% of it.
   */
  maxLength?: number;
  /**
   * The count near the limit, from how many are written and the limit.
   * @default (length, max) => `${length}/${max}`
   */
  maxLengthCountLabel?: (length: number, max: number) => string;
  /**
   * Said once, politely, as the text comes within 10% of the limit.
   * @default (max) => `Close to the limit of ${max} characters`
   */
  maxLengthNearLabel?: (max: number) => string;
  /**
   * Said once, politely, as the text reaches the limit.
   * @default (max) => `The limit of ${max} characters is reached`
   */
  maxLengthReachedLabel?: (max: number) => string;
  /**
   * Said when a paste was cut at the limit.
   * @default (max) => `The pasted text was cut at the limit of ${max} characters`
   */
  maxLengthCutLabel?: (max: number) => string;
  /** A band tucked under the top of the card: ComposerSurface, or ComposerQueue for waiting messages. */
  top?: ReactNode;
  /**
   * Takes the card's place for the text and footer while the assistant needs something first: a
   * QuestionTool with `embedded` (`variant="buttons"` for a line and a row of choices).
   */
  takeover?: ReactNode;
  /** Escape leaves the takeover. Without it, Escape does nothing there. */
  onTakeoverDismiss?: () => void;
  /** What is wrong with the text, in the danger colour under the card ("Add more detail before sending"). */
  validation?: string;
  /** A short line under the card, such as a note that answers can be wrong. */
  note?: ReactNode;
  /**
   * One row, as a chat's box at rest: the plus (`start`), the text, then `controls` (the model and
   * effort), `end`, dictation and send, one control tall. As the text no longer fits its line, the
   * text takes the whole width and the controls drop to a row under it. Files, the chosen agent and
   * `above` stand over the row, inside the card. For a chat's foot, a narrow panel or a reply.
   * @default false
   */
  compact?: boolean;
  /**
   * The text field (a <textarea>): `ref.current.focus()` puts the caret in it, in the full card,
   * `compact` and the one row alike. Null while a takeover holds the card without its text.
   */
  ref?: Ref<HTMLTextAreaElement>;
  /**
   * Puts the caret in the text as the composer appears, as a page whose one task is to write asks
   * (a new chat). Focus goes to the text, never to a chip or an action; with a takeover open (a
   * question, an approval) it goes to the takeover's own control instead.
   * @default false
   */
  autoFocus?: boolean;
  /** The text it starts with. */
  defaultValue?: string;
  /** The text, when you keep it in state. Pair it with `onValueChange`, and clear it in `onSend`. */
  value?: string;
  /** Called with the new text and why it changed. `details.source` is `"agent"` for an agent. */
  onValueChange?: TextareaProps["onValueChange"];
  /**
   * What the card is made of: `card`, the raised fill, or `glass` where it stands on a Backdrop, so
   * the backdrop shows through, blurred.
   * @default "card"
   */
  surface?: "card" | "glass";
  /** @deprecated Use `layout`. */
  style?: ComposerLayoutStyle;
  /** Layout only: margins, alignment and width. The look belongs to the composer. */
  layout?: ComposerLayoutStyle;
  /**
   * This instance's own words, over the catalogue's (GraspWords) `composer.composer` group, key by key
   * (`{ send: "Send it" }`). Any left out are the catalogue's, else English. A flat text prop given beside it
   * (`sendLabel`, `failedLabel` and the other text props) still wins until the release's step 5.
   */
  words?: Partial<ComposerWords["composer"]>;
}

// Where the mention menu stands: under the caret's line, or over it when the composer is low on
// the page.
type MenuPlace = { x: number; top: number } | { x: number; bottom: number };
const placeAt = (element: HTMLTextAreaElement, start: number): MenuPlace => {
  const point = caretPoint(element, start);
  const box = element.getBoundingClientRect();
  const computed = getComputedStyle(element);
  // A short line on purpose: a formatter that wraps it would leave the comment above the wrong line.
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- a line height reads "24px", which Number() makes NaN
  const lineHeight = Number.parseFloat(computed.lineHeight) || 24;
  const room = window.innerHeight - (box.top + point.y);
  const x = Math.min(point.x, box.width - 160);
  return room > 280
    ? { x, top: point.y + 4 }
    : { x, bottom: box.height - point.y + lineHeight + 4 };
};

// Runs a task; if it fails, throws what `failure` makes instead. Out here for the same reason.
const failingWith = async (
  task: () => Promise<void>,
  failure: () => Error
): Promise<void> => {
  try {
    await task();
  } catch {
    throw failure();
  }
};

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

const COARSE = media.coarse;
const FORCED = media.forced;
// The keyboard brought focus to the message field (src/focus/focus.ts tells a press apart).
const KEY_IN_TEXT = ":has(textarea:focus-visible:not([data-focus-pointer]))";

const styles = stylex.create({
  root: {
    display: "grid",
    width: "100%",
    maxWidth: grasp.composerWidth,
    minWidth: 0,
    margin: 0,
    fontFamily: grasp.fontSans,
  },
  // The card and its light share this box; the light sits under the card.
  stack: {
    position: "relative",
    isolation: "isolate",
    minWidth: 0,
  },
  // The band above the card: over the light, under the card.
  top: {
    position: "relative",
    zIndex: 1,
  },
  cardRoom: {
    position: "relative",
    borderRadius: grasp.composerCorner,
    cornerShape: grasp.cornerShape,
  },
  card: {
    position: "relative",
    zIndex: 2,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: grasp.space6,
    boxSizing: "border-box",
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: grasp.composerCorner,
    cornerShape: grasp.cornerShape,
    "--grasp-composer-nested": grasp.corner,
    "--grasp-composer-first": grasp.corner,
    "--grasp-composer-last": grasp.corner,
    backgroundColor: { default: grasp.raised, ":disabled": grasp.soft },
    boxShadow: {
      default: grasp.liftMedium,
      ":has(textarea:focus-visible)": `inset 0 0 0 1px ${grasp.composerEdgeFocus}, 0 0 0 3px ${grasp.fieldFocusHalo}, ${grasp.liftMedium}`,
      ":has(textarea[aria-invalid=true]:focus-visible)": `inset 0 0 0 1px ${grasp.fieldEdgeInvalid}, 0 0 0 3px ${grasp.fieldFocusHaloInvalid}, ${grasp.liftMedium}`,
    },
    color: grasp.ink,
    cursor: { default: "text", ":disabled": "not-allowed" },
    // In forced colours, where the edge and halo are dropped, a press keeps a thin line and the
    // keyboard the thick Highlight ring, just inside the card's edge.
    outline: {
      default: "none",
      [FORCED]: {
        default: "none",
        ":has(textarea:focus-visible)": `${grasp.ringWidth} solid`,
        [KEY_IN_TEXT]: `calc(2 * ${grasp.ringWidth}) solid Highlight`,
      },
    },
    outlineOffset: {
      default: `calc(-1 * ${grasp.ringWidth})`,
      [FORCED]: `calc(-2 * ${grasp.ringWidth})`,
    },
    transitionProperty: "box-shadow, background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  // On a Backdrop: the card's colour most of the way, over a blur of what is behind it.
  glass: {
    backgroundColor: { default: grasp.backdropGlass, ":disabled": grasp.soft },
    backdropFilter: grasp.backdropGlassBlur,
  },
  // The text over its chips: a positioned layer, transparent, so the chips show through.
  editor: {
    position: "relative",
    display: "grid",
    minWidth: 0,
  },
  overChips: {
    position: "relative",
    zIndex: 1,
    gridArea: "1 / 1",
  },
  chips: {
    gridArea: "1 / 1",
    color: "transparent",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    pointerEvents: "none",
  },
  // A file is being dragged over the page: the card is a target, tinted in the light, no dashes.
  target: {
    backgroundColor: `color-mix(in oklch, ${grasp.lightMint} 8%, ${grasp.raised})`,
    boxShadow: `inset 0 0 0 ${grasp.ringWidth} color-mix(in oklch, ${grasp.lightMint} 60%, transparent), ${grasp.liftLow}`,
  },
  targetOver: {
    backgroundColor: `color-mix(in oklch, ${grasp.lightMint} 16%, ${grasp.raised})`,
    boxShadow: `inset 0 0 0 ${grasp.ringWidth} ${grasp.lightMint}, ${grasp.fieldFocus}`,
  },
  drop: {
    position: "absolute",
    inset: 0,
    zIndex: 1,
    display: "grid",
    placeItems: "center",
    borderRadius: "inherit",
    // The card's own tint, over everything inside it, so the words stand alone.
    backgroundColor: "inherit",
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    pointerEvents: "none",
  },
  taken: {
    gap: 0,
    cursor: "default",
  },
  compactCard: {
    // The row answers to its own width: narrow, the level folds to the maker's mark (model-effort.tsx).
    containerType: "inline-size",
    containerName: "composer-row",
    // That makes its own width zero to whoever sizes to it (a centred flex row, an inline-flex): it
    // stood 24px wide there. It counts as composer-row-least instead; a holder narrower still gives
    // it the holder's width, as nothing sets a least.
    containIntrinsicInlineSize: `calc(${grasp.composerRowLeast} - 2 * ${grasp.space3})`,
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    gridTemplateAreas: '"above above above" "start field end"',
    alignItems: "center",
    columnGap: grasp.space2,
    rowGap: 0,
    padding: grasp.space3,
  },
  // The text no longer fits its line: it takes the row, and the controls drop under it.
  compactTall: {
    gridTemplateAreas: '"above above above" "field field field" "start . end"',
  },
  compactAbove: {
    gridArea: "above",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    // The strip and the row above the text keep their own inset; the card's 12px is already round them.
    marginInline: `calc(-1 * ${grasp.space3})`,
    marginBlockStart: `calc(-1 * ${grasp.space3})`,
    marginBlockEnd: { default: grasp.space1, ":empty": 0 },
  },
  compactStart: {
    gridArea: "start",
  },
  compactField: {
    gridArea: "field",
    // The text never gives: narrower, the level folds, then the row goes tall (useRowFit). At rest
    // the placeholder gives instead, cut with an ellipsis, so the row stays one line.
    minWidth: {
      default: grasp.composerFieldLeast,
      ":has(textarea:placeholder-shown)": 0,
    },
  },
  compactFieldTall: {
    // Its words stand where they stood in the row's text, over the foot row.
    paddingBlockStart: grasp.space1,
    paddingBlockEnd: grasp.space2,
  },
  compactEnd: {
    gridArea: "end",
    justifySelf: "end",
  },
  // The strip, the row above the text and the text: one row of the card, with no gap of its own.
  textRoom: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
  },
  // A row given nothing to hold (an empty fragment) takes no room at all.
  above: {
    display: { default: "flex", ":empty": "none" },
    flexWrap: "wrap",
    gap: grasp.space2,
    paddingInline: grasp.space4,
    paddingBlockStart: grasp.space4,
    // The text stands the card's gap under it, as before, now inside one row.
    marginBlockEnd: `calc(${grasp.space6} - ${grasp.space4})`,
  },
  text: {
    display: "block",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    // A finger needs 44px: on a touch screen the text is never shorter.
    minHeight: { default: 0, [COARSE]: grasp.tap },
    maxHeight: grasp.composerHeight,
    margin: 0,
    paddingInline: grasp.space4,
    paddingBlockStart: grasp.space4,
    paddingBlockEnd: 0,
    appearance: "none",
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    outline: "none",
    resize: "none",
    fieldSizing: "content",
    color: { default: grasp.ink, ":disabled": grasp.muted },
    caretColor: grasp.ink,
    fontFamily: grasp.fontSans,
    // 16px on a phone or a touch screen (media.typing), or Safari zooms the page in when the text takes focus.
    fontSize: { default: grasp.chatText, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.chatTextLine,
    letterSpacing: "normal",
    overflowWrap: "anywhere",
    cursor: { default: "text", ":disabled": "not-allowed" },
    "::placeholder": {
      color: grasp.muted,
      opacity: 1,
    },
  },
  compactText: {
    paddingInline: grasp.space1,
    paddingBlockStart: 0,
    alignSelf: "center",
    // The resting bar is one line at every width: an empty field takes its placeholder's size
    // (field-sizing), so a placeholder that wrapped made the bar a line taller on a phone (Ask
    // bar at 320). While it shows, the field holds one line, and the placeholder, drawn in a box of
    // its own inside the field, keeps to one line and ends in an ellipsis: both are needed (the
    // field's alone clips the words mid-letter; the placeholder's alone leaves the field two lines
    // tall). Typed words still grow the field as before.
    whiteSpace: { default: null, ":placeholder-shown": "nowrap" },
    overflow: { default: null, ":placeholder-shown": "hidden" },
    textOverflow: { default: null, ":placeholder-shown": "ellipsis" },
    "::placeholder": {
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
  },
  // One line, always: plus and settings, the model and reasoning, then voice and send at the end.
  // It answers to its own width: narrow, the model's name folds to its mark, then reasoning steps
  // aside (control.ts and below).
  footer: {
    containerType: "inline-size",
    containerName: "composer-footer",
    // The count stands over its end edge on a narrow footer (count, below).
    position: "relative",
    display: "flex",
    flexWrap: "nowrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
    minWidth: 0,
    // The footer's inset: 8px, so the card's corner is its buttons' plus 8 (composer-corner).
    paddingInline: grasp.space2,
    paddingBlockEnd: grasp.space2,
  },
  side: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    flexShrink: 0,
    // Every control in the footer has one corner: Button's own for its size (the card's nested
    // corner yields it, above). A focus ring is an outline, so it follows that corner plus its offset.
    "--grasp-composer-first": "var(--grasp-composer-nested)",
    "--grasp-composer-last": "var(--grasp-composer-nested)",
  },
  startSide: {
    flexShrink: 1,
    gap: grasp.space1,
  },
  // After send: a short hairline, then a control that is not about this message. A little closer
  // than the row's own gap on each side of the line, so the line reads as dividing two groups.
  after: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    marginInlineStart: `calc(${grasp.space1} - ${grasp.space2})`,
  },
  afterRow: {
    gap: grasp.space2,
    marginInlineStart: 0,
  },
  afterLine: {
    flexShrink: 0,
    width: grasp.hairline,
    height: grasp.iconSm,
    backgroundColor: { default: grasp.line, [media.forced]: "CanvasText" },
  },
  controls: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    // The footer's one corner for its controls (side, above), first or not.
    "--grasp-composer-first": "var(--grasp-composer-nested)",
    "--grasp-composer-last": "var(--grasp-composer-nested)",
  },
  // Lines under the card, on a band tucked under its foot, as Palermo's disclaimer.
  under: {
    display: "grid",
    gap: grasp.space1,
    paddingInline: grasp.space4,
    paddingBlockStart: `calc(${grasp.composerCorner} + ${grasp.space2})`,
    paddingBlockEnd: grasp.space2,
    marginBlockStart: `calc(-1 * ${grasp.composerCorner})`,
    marginInline: grasp.space2,
    borderEndStartRadius: grasp.composerCorner,
    borderEndEndRadius: grasp.composerCorner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
  },
  line: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space1,
    margin: 0,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    textAlign: "center",
    overflowWrap: "anywhere",
  },
  danger: {
    color: grasp.danger,
  },
  // Read by a screen reader, never seen.
  // The count near the limit: quiet, the small size, its figures of one width. On a footer with
  // room it keeps its room in the row, so nothing moves when it shows. On a narrow footer it takes
  // none from the controls: it stands over the row's end, on the field's bottom edge, above Send.
  count: {
    display: "inline-grid",
    flexShrink: 0,
    position: {
      default: "static",
      "@container composer-footer (width < 30rem)": "absolute",
    },
    insetInlineEnd: {
      default: null,
      "@container composer-footer (width < 30rem)": grasp.space2,
    },
    bottom: {
      default: null,
      "@container composer-footer (width < 30rem)": "100%",
    },
    paddingInline: grasp.space1,
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    textAlign: "end",
  },
  countLayer: {
    gridArea: "1 / 1",
  },
  countUnseen: {
    visibility: "hidden",
  },
  countAt: {
    color: grasp.ink,
  },
});

const kindTint = (
  kind: string
): "people" | "agents" | "skills" | "files" | "other" =>
  kind === "people" ||
  kind === "agents" ||
  kind === "skills" ||
  kind === "files"
    ? kind
    : "other";

// A tint per kind, so a person, an agent, a skill and a file each read as their own.
const chipStyles = stylex.create({
  chip: {
    color: "transparent",
    borderRadius: grasp.cornerMark,
    boxShadow: `0 0 0 ${grasp.hairline} ${grasp.line}`,
  },
  people: { backgroundColor: grasp.infoSoft },
  agents: {
    backgroundColor: `color-mix(in oklch, ${grasp.lavender} 22%, transparent)`,
  },
  skills: { backgroundColor: grasp.attentionSoft },
  files: { backgroundColor: grasp.quietFill },
  other: { backgroundColor: grasp.successSoft },
});

// A regular expression that matches the word as written.
const escape = (word: string) =>
  word.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The text with each picked mention and each picture marked, for the chip layer behind the text. */
const chipText = (
  text: string,
  picked: ComposerMentionItem[],
  pictures: ComposerPicture[]
) => {
  const labels = picked
    .map((item) => item.label)
    .toSorted((a, b) => b.length - a.length);
  const shots = pictures
    .map((picture) => pictureToken(picture.label))
    .toSorted((a, b) => b.length - a.length);
  if (labels.length === 0 && shots.length === 0) {
    return text;
  }
  const alternatives = [
    ...(labels.length === 0 ? [] : [`[@/](?:${labels.map(escape).join("|")})`]),
    ...shots.map(escape),
  ];
  const pattern = new RegExp(`(${alternatives.join("|")})`, "gu");
  return text.split(pattern).map((part, index) => {
    const picture = pictures.find((each) => part === pictureToken(each.label));
    if (picture !== undefined) {
      return (
        <PictureChip
          key={index}
          label={picture.label}
          preview={picture.preview}
        />
      );
    }
    const item = picked.find(
      (entry) => part === `@${entry.label}` || part === `/${entry.label}`
    );
    if (item === undefined) {
      return part;
    }
    return (
      <mark
        key={index}
        data-kind={item.kind}
        {...stylex.props(chipStyles.chip, chipStyles[kindTint(item.kind)])}
      >
        {part}
      </mark>
    );
  });
};

const noFiles: ComposerFile[] = [];
const noKinds: ComposerKind[] = [];
const noItems: ComposerMentionItem[] = [];

type TextChangeDetails = Parameters<
  NonNullable<TextareaProps["onValueChange"]>
>[1];

// What a change made by the composer itself reports: a mention picked, or one taken out whole.
const writtenDetails: TextChangeDetails = {
  reason: "input-change",
  source: "keyboard",
  cancel: () => {
    // Nothing to call off: the composer made this edit itself.
  },
  canceled: false,
};

// Sends with no rejection left to handle: a failure shows under the card, in the person's words.
const sendQuietly = async (send: () => Promise<void>) => {
  try {
    await send();
  } catch {
    // Shown under the card already.
  }
};

const hasFiles = (event: globalThis.DragEvent) =>
  [...(event.dataTransfer?.types ?? [])].includes("Files");

// Files dragged over the page make the composer a target. Dropped anywhere but on it, nothing
// happens (the browser would otherwise open the file). Returns the cleanup.
const listenForFileDrags = (
  setDragging: Dispatch<SetStateAction<boolean>>,
  setOver: Dispatch<SetStateAction<boolean>>
) => {
  let depth = 0;
  const enter = (event: globalThis.DragEvent) => {
    if (!hasFiles(event)) {
      return;
    }
    depth += 1;
    setDragging(true);
  };
  const leave = (event: globalThis.DragEvent) => {
    if (!hasFiles(event)) {
      return;
    }
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      setDragging(false);
    }
  };
  const finish = (event: globalThis.DragEvent) => {
    if (hasFiles(event)) {
      event.preventDefault();
    }
    depth = 0;
    setDragging(false);
    setOver(false);
  };
  const hold = (event: globalThis.DragEvent) => {
    if (hasFiles(event)) {
      event.preventDefault();
    }
  };
  window.addEventListener("dragenter", enter);
  window.addEventListener("dragleave", leave);
  window.addEventListener("dragover", hold);
  window.addEventListener("drop", finish);
  return () => {
    window.removeEventListener("dragenter", enter);
    window.removeEventListener("dragleave", leave);
    window.removeEventListener("dragover", hold);
    window.removeEventListener("drop", finish);
  };
};

/** Files dragged onto the card, dropped on it, or pasted into the text are attached. */
const useFileDrop = (
  onAttach: ((files: File[]) => void) | undefined,
  disabled: boolean
) => {
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  useEffect(
    () =>
      onAttach === undefined
        ? undefined
        : listenForFileDrags(setDragging, setOver),
    [onAttach]
  );
  const drop = (event: DragEvent<HTMLElement>) => {
    if (onAttach === undefined || disabled) {
      return;
    }
    const files = [...event.dataTransfer.files];
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    setOver(false);
    onAttach(files);
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (onAttach === undefined) {
      return;
    }
    const files = [...event.clipboardData.files];
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    onAttach(files);
  };
  const dragOver = (event: DragEvent<HTMLFormElement>) => {
    if (
      onAttach === undefined ||
      disabled ||
      ![...event.dataTransfer.types].includes("Files")
    ) {
      return;
    }
    event.preventDefault();
    setOver(true);
  };
  const dragLeave = (event: DragEvent<HTMLFormElement>) => {
    const to = event.relatedTarget;
    if (!(to instanceof Node) || !event.currentTarget.contains(to)) {
      setOver(false);
    }
  };
  return {
    dragging,
    over,
    handleDrop: drop,
    handlePaste: paste,
    handleDragOver: dragOver,
    handleDragLeave: dragLeave,
  };
};

/** A length in pixels as computed ("8px"), or 0 for one that is not ("normal"). */
// oxlint-disable-next-line unicorn/prefer-number-coercion -- a length reads "8px", which Number() makes NaN
const px = (value: string) => Number.parseFloat(value) || 0;

/** What an effect with nothing to undo returns. */
const holdNothing = () => {
  // Nothing was started.
};

/**
 * How the one row fits its room. `tall`: the text has outgrown its line (a line break, or words wider
 * than the room between the plus and the controls), or the field would go under its least width
 * (composer-field-least) even with the level folded; the text then takes the row and the controls drop
 * under it. `fold`: the model's level folds to its maker's mark, first, because with it the field would
 * go under that least width. The text never gives. Every width is read from the card and its two
 * sides, which stand alike in both forms, so the answer never depends on the form it changes: nothing
 * flickers at the edge. Read before paint as the text changes, and again as the card or a side changes
 * width (a chip laid out late, a level folded). While a takeover holds the card the answer stands
 * as it was, so a dictation keeps the row's form.
 */
const useRowFit = (
  on: boolean,
  text: string,
  card: RefObject<HTMLFieldSetElement | null>,
  area: RefObject<HTMLTextAreaElement | null>
) => {
  const [tall, setTall] = useState(false);
  const [fold, setFold] = useState(false);
  // What was last set, so a read that finds the same answer sets nothing. A set to the same value
  // can still cost a render of the whole card (React bails out late when the card has just updated
  // itself, as on a send that clears the text), and that render landed in the Enter key's frame.
  const last = useRef({ tall: false, fold: false });
  // The end side's width while the level shows: what unfolding would need again.
  const wideEnd = useRef(0);
  useLayoutEffect(() => {
    const box = card.current;
    if (!on || box === null) {
      // Off (a takeover holds the card), the row keeps the form it had: a dictation stands in it
      // (RowTallContext), and the row comes back as it went, read again before paint.
      return holdNothing;
    }
    const said = last.current;
    const putTall = (next: boolean) => {
      if (next !== said.tall) {
        said.tall = next;
        setTall(next);
      }
    };
    const putFold = (next: boolean) => {
      if (next !== said.fold) {
        said.fold = next;
        setFold(next);
      }
    };
    const pen = document.createElement("canvas").getContext("2d");
    const start = box.querySelector<HTMLElement>(
      ":scope > [data-slot=composer-start]"
    );
    const end = box.querySelector<HTMLElement>(
      ":scope > [data-slot=composer-end]"
    );
    const slot = box.querySelector<HTMLElement>(
      ":scope > [data-slot=composer-field]"
    );
    const read = () => {
      const field = area.current;
      if (field === null || start === null || end === null || slot === null) {
        return;
      }
      const look = getComputedStyle(box);
      const own = getComputedStyle(field);
      const level = end.querySelector<HTMLElement>(
        "[data-slot=composer-model-effort-level]"
      );
      const endWidth = end.getBoundingClientRect().width;
      if (!fold && level !== null && level.getClientRects().length > 0) {
        wideEnd.current = endWidth;
      }
      const inner =
        box.clientWidth -
        px(look.paddingInlineStart) -
        px(look.paddingInlineEnd);
      const sides =
        start.getBoundingClientRect().width + 2 * px(look.columnGap);
      const least = px(getComputedStyle(slot).minWidth);
      // Folded only while the level would leave the field under its least width.
      const folding =
        level !== null &&
        inner - sides - Math.max(wideEnd.current, endWidth) < least;
      putFold(folding);
      if (folding !== fold) {
        // The sides change width with the fold: read again once it is drawn.
        return;
      }
      const room = inner - sides - endWidth;
      const words = text;
      // At rest there are no words to keep whole: the placeholder ends in an ellipsis on one line.
      if (words === "") {
        putTall(false);
        return;
      }
      if (room < least || words.includes("\n")) {
        putTall(true);
        return;
      }
      if (pen !== null) {
        pen.font = own.font;
      }
      // A caret's width to spare, so the last letter is never under the controls.
      putTall(
        (pen?.measureText(words).width ?? 0) + 2 >
          room - px(own.paddingInlineStart) - px(own.paddingInlineEnd)
      );
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(box);
    for (const side of [start, end]) {
      if (side !== null) {
        observer.observe(side);
      }
    }
    return () => {
      observer.disconnect();
    };
  }, [on, text, card, area, fold]);
  return { tall, fold };
};

/** The card's look: its surface, the one row (and tall in it), a takeover, a file dragged over. */
const cardLook = ({
  glass,
  row,
  tall,
  taken,
  dragging,
  over,
}: {
  glass: boolean;
  row: boolean;
  tall: boolean;
  taken: boolean;
  dragging: boolean;
  over: boolean;
}) => [
  styles.card,
  glass && styles.glass,
  row && styles.compactCard,
  row && rowMarker,
  row && tall && styles.compactTall,
  taken && styles.taken,
  dragging && styles.target,
  over && styles.targetOver,
];

/** The caret, while the text has the focus; else nothing (a picture dropped then goes at the end). */
const caretIfFocused = (field: HTMLTextAreaElement | null) =>
  field !== null && document.activeElement === field
    ? field.selectionStart
    : null;

interface ShownInput {
  /** The canonical text. */
  text: string;
  value: string | undefined;
  setOwn: Dispatch<SetStateAction<string>>;
  onValueChange: TextareaProps["onValueChange"];
  attachments: ComposerFile[];
  area: RefObject<HTMLTextAreaElement | null>;
  imageLabel: (n: number) => string;
  onRemoveAttachment: ((id: string) => void) | undefined;
}

/**
 * The text in its two forms (pictures.tsx; handover/composer-inline-pictures/ARCHITECTURE.md): the
 * canonical one the host sees, and the shown one in the field, with each picture's reference drawn as
 * its chip. An edit of the field maps back to the canonical text; while an input method composes,
 * the field keeps what it shows and nothing is mapped until it ends. The clipboard carries the
 * canonical text in a type of its own, so a paste binds by id. Pictures the text no longer names are
 * let go when the draft ends: at send, when the host clears it, and when the composer leaves.
 */
const useShownText = ({
  text,
  value,
  setOwn,
  onValueChange,
  attachments,
  area,
  imageLabel,
  onRemoveAttachment,
}: ShownInput) => {
  // What the composer's own next edit puts in, and the last kind of input the browser said.
  const insertion = useRef<Insertion | null>(null);
  const inputType = useRef("");
  const caretAfter = useRef<number | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const composing = useRef(false);
  const putText = (next: string) => {
    if (value === undefined) {
      setOwn(next);
    }
    onValueChange?.(next, writtenDetails);
  };
  const expect = (next: Insertion) => {
    insertion.current = next;
  };
  const pictures = useInlinePictures({
    attachments,
    text,
    area,
    label: imageLabel,
    write: putText,
    expect: (canonical) => {
      expect({ canonical });
    },
  });
  const pieces = piecesOf(text, pictures.ids);
  const shown = shownOf(pieces);

  // The kind of each input, from the browser, before the change it makes: undo and redo put a chip's characters back.
  useEffect(() => {
    const field = area.current;
    if (field === null) {
      return holdNothing;
    }
    const heard = (event: Event) => {
      inputType.current = event instanceof InputEvent ? event.inputType : "";
    };
    field.addEventListener("beforeinput", heard);
    return () => {
      field.removeEventListener("beforeinput", heard);
    };
  }, [area]);

  // The caret where the composer's own rewrite of the field leaves it.
  useEffect(() => {
    const at = caretAfter.current;
    if (at !== null && area.current !== null) {
      area.current.setSelectionRange(at, at);
      caretAfter.current = null;
    }
  });

  /** A new shown string, from the field or the composer, as the canonical text and the caret in what will show. */
  const toCanonical = (whole: string) => {
    const said = insertion.current ?? {
      byLabel: inputType.current.startsWith("history"),
    };
    insertion.current = null;
    const { canonical, upToCaret } = mapBack(
      pieces,
      shown,
      whole,
      pictures.idOf,
      said
    );
    const reshown = showText(canonical, pictures.ids);
    const caret = showText(upToCaret, pictures.ids).length;
    if (reshown !== whole) {
      caretAfter.current = caret;
    }
    return { canonical, reshown, caret: reshown === whole ? null : caret };
  };

  // Let go, once each, of the pictures the text no longer names.
  const released = useRef(new Set<string>());
  const release = (from: string) => {
    for (const file of composerUnreferenced(from, attachments)) {
      if (!released.current.has(file.id)) {
        released.current.add(file.id);
        onRemoveAttachment?.(file.id);
      }
    }
  };
  // The host cleared the draft: what it set is empty, and not what the composer last said.
  const said = useRef(value);
  const latest = useRef({ text, release });
  useEffect(() => {
    latest.current = { text, release };
  });
  useEffect(() => {
    if (value === "" && said.current !== "" && said.current !== undefined) {
      latest.current.release("");
    }
    said.current = value;
  }, [value]);
  // The composer leaves: its draft ends.
  useEffect(
    () => () => {
      latest.current.release(latest.current.text);
    },
    []
  );

  /** Copy and cut: the person's words as text, the canonical text in the composer's own type. */
  const copy = (event: ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
    const field = event.currentTarget;
    const canonical = canonicalSlice(
      pieces,
      field.selectionStart,
      field.selectionEnd
    );
    if (
      canonical === "" ||
      !pieces.some(
        (piece) =>
          piece.chip &&
          piece.from < field.selectionEnd &&
          piece.to > field.selectionStart
      )
    ) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", readableText(canonical));
    event.clipboardData.setData(COMPOSER_CLIPBOARD, canonical);
    if (cut) {
      wholeChips(field, pieces);
      editField(field, null);
    }
  };
  /** A paste of the composer's own type puts its canonical text in, bound by id. True when it did. */
  const pasteOwn = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const canonical = event.clipboardData.getData(COMPOSER_CLIPBOARD);
    if (canonical === "") {
      return false;
    }
    event.preventDefault();
    expect({ canonical });
    editField(event.currentTarget, showText(canonical, pictures.ids));
    return true;
  };

  return {
    pieces,
    shown: raw ?? shown,
    pictures,
    /** While an input method composes, the field keeps what it shows. */
    composing: () => composing.current,
    handleCompositionStart: () => {
      composing.current = true;
    },
    endComposing: () => {
      composing.current = false;
    },
    setRaw,
    toCanonical,
    putText,
    expect,
    release,
    copy,
    pasteOwn,
    seen: seenLength(pieces),
    // The field's own limit, raised by each chip's extra characters, so a chip counts as one.
    extra: shown.length - seenLength(pieces),
  };
};

/** How many times the composer has arrived at success: each arrival plays the halo once more. */
const useSuccessCount = (activity: ComposerActivity) => {
  const [success, setSuccess] = useState(activity === "success" ? 1 : 0);
  const [seen, setSeen] = useState(activity);
  if (activity !== seen) {
    setSeen(activity);
    if (activity === "success") {
      setSuccess(success + 1);
    }
  }
  return success;
};

/** Gives the host's ref the text field: a callback is called, an object's `current` is set. */
const handTo = (
  target: Ref<HTMLTextAreaElement> | undefined,
  element: HTMLTextAreaElement | null
) => {
  if (typeof target === "function") {
    target(element);
  } else if (target) {
    target.current = element;
  }
};

/** Puts the focus on a takeover's own control: a choice already made, else its first control. */
const focusTakeover = (card: HTMLFieldSetElement | null) => {
  // A choice already made first (a question that comes back answered), else the first control.
  const room = card?.querySelector<HTMLElement>(
    "[data-slot=composer-takeover-room]"
  );
  // A dictation takes it with no ring: the person pressed the microphone, and its cancel shows
  // a ring only when the keyboard reaches it.
  const dictating =
    (room?.querySelector("[data-slot=composer-voice]") ?? null) !== null;
  // A text question's box comes before its buttons, so the caret lands in it, never on Skip.
  (
    room?.querySelector<HTMLElement>("[aria-checked=true]") ??
    room?.querySelector<HTMLElement>("textarea, button, input")
  )?.focus({ preventScroll: true, focusVisible: !dictating });
};

/**
 * `autoFocus`: as the composer appears, the caret in its text, or a takeover's own control when one
 * holds the card. Once, at first; never again on a later render.
 */
const useAutoFocus = (
  on: boolean,
  taken: boolean,
  card: RefObject<HTMLFieldSetElement | null>,
  area: RefObject<HTMLTextAreaElement | null>
) => {
  const place = useEffectEvent(() => {
    if (!on) {
      return;
    }
    if (taken) {
      focusTakeover(card.current);
    } else {
      area.current?.focus({ preventScroll: true });
    }
  });
  useEffect(() => {
    place();
  }, []);
};

/**
 * A takeover that arrives while the person is in the card takes the focus with it; when it goes,
 * the focus comes back to the text. Returns the form's focus handlers.
 */
const useTakeoverFocus = (
  taken: boolean,
  card: RefObject<HTMLFieldSetElement | null>,
  area: RefObject<HTMLTextAreaElement | null>
) => {
  const hadTakeover = useRef(false);
  // Whether focus was last inside the composer: read from focus events, since by the time the
  // takeover changes, the button that changed it may already be gone and focus with it.
  const focusInside = useRef(false);
  useEffect(() => {
    // Only focus that was in this composer moves: focus on the page's body belongs to no composer,
    // and taking it would pull a page of several composers to this one (and scroll it there).
    const here =
      focusInside.current ||
      (card.current?.contains(document.activeElement) ?? false);
    if (taken && !hadTakeover.current && here) {
      focusTakeover(card.current);
    }
    if (!taken && hadTakeover.current && here) {
      area.current?.focus({ preventScroll: true });
    }
    hadTakeover.current = taken;
  }, [taken, card, area]);
  // Said on the form too (data-focus-inside), so a part inside, such as a question arriving as a
  // takeover's next step, knows the person is here and may take the focus.
  const onFocus = (event: FocusEvent<HTMLFormElement>) => {
    focusInside.current = true;
    event.currentTarget.dataset.focusInside = "";
  };
  // Focus leaves the composer only when it goes to something outside it. Falling to the page's
  // body from inside (Safari never focuses a pressed button) it is still this composer's.
  const onBlur = (event: FocusEvent<HTMLFormElement>) => {
    if (
      event.relatedTarget !== null &&
      !event.currentTarget.contains(event.relatedTarget)
    ) {
      focusInside.current = false;
      delete event.currentTarget.dataset.focusInside;
    }
  };
  return { handleFocus: onFocus, handleBlur: onBlur };
};

interface SendInput {
  text: string;
  /** The text as the host gets it, and the attachments it names. */
  prepare: (text: string) => [string, ComposerSendDetails];
  /** After a send went: the draft ends, and the pictures it no longer names are let go. */
  onSent: (text: string) => void;
  value: string | undefined;
  setOwn: Dispatch<SetStateAction<string>>;
  validation: string | undefined;
  empty: boolean;
  disabled: boolean;
  working: boolean;
  onSend: ComposerProps["onSend"];
  failedLabel: string;
  sendFailed: boolean | undefined;
  onSendFailedChange: ((failed: boolean) => void) | undefined;
}

/**
 * One send for the button and for Enter. It rejects with the failure words, so an agent's press
 * fails with what the person reads; a person's press is settled by UI SDK and logs nothing. A
 * second press while a send runs waits for the same send, so an agent waits for the real result.
 * While `validation` is set nothing is sent, and an agent hears the validation's words.
 */
const useSend = ({
  text,
  prepare,
  onSent,
  value,
  setOwn,
  validation,
  empty,
  disabled,
  working,
  onSend,
  failedLabel,
  sendFailed,
  onSendFailedChange,
}: SendInput) => {
  const [ownFailed, setOwnFailed] = useState(false);
  // Set from outside (`sendFailed`), else kept here.
  const failed = sendFailed ?? ownFailed;
  // A send's own result: always told, since the caller may have cleared it while the send ran.
  const report = (next: boolean) => {
    setOwnFailed(next);
    onSendFailedChange?.(next);
  };
  // Typing clears it: told only when it was shown.
  const setFailed = (next: boolean) => {
    if (next !== failed) {
      report(next);
    }
  };
  // The text as it is now, for a send that ends after the person typed on.
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  }, [text]);
  const pending = useRef<Promise<void> | null>(null);
  const send = async (): Promise<void> => {
    if (pending.current !== null) {
      await pending.current;
      return;
    }
    if (validation !== undefined && validation !== "") {
      throw new Error(validation);
    }
    if (empty || disabled || working) {
      return;
    }
    const sent = text;
    setFailed(false);
    const run = settled(
      async () => {
        await failingWith(
          async () => {
            await onSend(...prepare(sent));
            onSent(sent);
            // Clear only what was sent: words typed while it went stay.
            if (value === undefined && latest.current === sent) {
              setOwn("");
            }
          },
          () => {
            report(true);
            return new Error(failedLabel);
          }
        );
      },
      () => {
        pending.current = null;
      }
    );
    pending.current = run;
    await run;
  };
  return { handleSend: send, failed, setFailed };
};

interface Menu {
  trigger: "@" | "/";
  start: number;
  level: string | null;
}

/** The menu a just-typed character opens: an @ after a space, or a / at a line's start. */
const openedAt = (
  next: string,
  at: number,
  items: ComposerMentionItem[]
): Menu | null => {
  const before = next.slice(0, at);
  const last = before.slice(-1);
  const prior = before.slice(-2, -1);
  if (last === "@" && (prior === "" || /\s/u.test(prior))) {
    return { trigger: "@", start: at - 1, level: null };
  }
  if (
    last === "/" &&
    (prior === "" || prior === "\n") &&
    items.some((item) => item.kind === "commands")
  ) {
    return { trigger: "/", start: at - 1, level: null };
  }
  return null;
};

/** The whole mention just before the caret, if there is one. */
const mentionBefore = (
  text: string,
  at: number,
  picked: ComposerMentionItem[]
) => {
  for (const item of picked) {
    for (const token of [
      `@${item.label} `,
      `@${item.label}`,
      `/${item.label} `,
      `/${item.label}`,
    ]) {
      if (text.slice(at - token.length, at) === token) {
        return token;
      }
    }
  }
  return null;
};

/** The menu's title: the commands' name, or the kind it is one level into. */
const titleOf = (
  menu: Menu | null,
  commandsLabel: string,
  kinds: ComposerKind[]
): string | undefined => {
  if (menu?.trigger === "/") {
    return commandsLabel;
  }
  const level = menu?.level ?? null;
  return level === null || level === ""
    ? undefined
    : kinds.find((kind) => kind.value === level)?.label;
};

/** The words a screen reader hears of the mention menu. */
interface MenuStatusWords {
  name: string;
  looking: string;
  found: (count: number) => string;
}

/** What a screen reader hears of the menu: its name and how many it found. */
const menuStatus = (
  menu: Menu | null,
  title: string | undefined,
  loading: boolean,
  count: number,
  words: MenuStatusWords
) => {
  if (menu === null) {
    return "";
  }
  return `${title ?? words.name}: ${loading ? words.looking : words.found(count)}`;
};

// The limit's words, in English.

/** Where the text stands against its limit: under 90%, near it, or at it. */
const stageOf = (length: number, max: number | undefined) => {
  if (max === undefined) {
    return "under";
  }
  if (length >= max) {
    return "at";
  }
  return length >= Math.ceil(max * 0.9) ? "near" : "under";
};

interface LimitWords {
  count: (length: number, max: number) => string;
  near: (max: number) => string;
  reached: (max: number) => string;
  cut: (max: number) => string;
}

/**
 * The count near the limit, in the footer before send. Its room is kept whenever there is a limit
 * (the widest it can read, unseen, in the same cell), so the footer never moves when it shows.
 * In the one row it takes no room until it shows: room held unseen there left the text under its
 * least width, and the row tall at rest (the product's maxLength of 100,000). Shown, it may tip the
 * row tall like any other width.
 * What a screen reader hears is apart (limitSaid): said only as the stage changes, never per key.
 */
const ComposerCount = ({
  length,
  max,
  words,
  row,
}: {
  length: number;
  max: number | undefined;
  words: LimitWords;
  row: boolean;
}) => {
  if (max === undefined) {
    return null;
  }
  const stage = stageOf(length, max);
  if (row && stage === "under") {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      data-slot="composer-count"
      data-limit={stage}
      {...stylex.props(styles.count)}
    >
      <span {...stylex.props(styles.countLayer, styles.countUnseen)}>
        {words.count(max, max)}
      </span>
      <span
        {...stylex.props(
          styles.countLayer,
          stage === "under" && styles.countUnseen,
          stage === "at" && styles.countAt
        )}
      >
        {words.count(Math.min(length, max), max)}
      </span>
    </span>
  );
};

/** What a screen reader hears of the limit: once near it, once at it, and a cut paste. */
const limitSaid = (
  stage: string,
  cut: boolean,
  max: number | undefined,
  words: LimitWords
) => {
  if (max === undefined) {
    return "";
  }
  if (cut) {
    return words.cut(max);
  }
  if (stage === "at") {
    return words.reached(max);
  }
  return stage === "near" ? words.near(max) : "";
};

/** The limit's live line, apart from the count: it changes only as the stage changes, or on a cut paste. */
const ComposerLimitSaid = ({
  length,
  max,
  cut,
  words,
}: {
  length: number;
  max: number | undefined;
  cut: boolean;
  words: LimitWords;
}) =>
  max === undefined ? null : (
    <p
      aria-live="polite"
      data-slot="composer-limit-said"
      {...stylex.props(visuallyHidden)}
    >
      {limitSaid(stageOf(length, max), cut, max, words)}
    </p>
  );

// How many the menu found, in English.

interface MentionsInput {
  text: string;
  /** The pictures the host holds: offered under Screenshots after @. */
  pictures: ComposerPicture[];
  /** The shown text's pieces: a chip is stepped over as one character. */
  pieces: Piece[];
  /** A picture's chip was taken out by Backspace or Delete, by its label. */
  onPictureRemoved: (label: string) => void;
  /** Says what canonical text the next edit puts in (a picture's chip picked from the menu). */
  expect: (insertion: Insertion) => void;
  area: RefObject<HTMLTextAreaElement | null>;
  kinds: ComposerKind[];
  items: ComposerMentionItem[];
  onMentionQuery: ((query: string, kind: string | null) => void) | undefined;
  onMention: ((item: ComposerMentionItem) => void) | undefined;
  commandsLabel: string;
  /** Puts new text in, as the composer's own edit. */
  setText: (next: string) => void;
}

/**
 * Backspace after a chip, or Delete before it, takes it out whole, through the browser's own editing
 * so undo puts it back. Its picture stays with the host until the draft ends. True when it did.
 */
const chipOut = (
  event: KeyboardEvent<HTMLTextAreaElement>,
  pieces: Piece[],
  removed: (label: string) => void
) => {
  const field = event.currentTarget;
  const chip = chipAt(
    pieces,
    field.selectionStart,
    event.key === "Backspace" ? "before" : "after"
  );
  if (chip === null) {
    return false;
  }
  event.preventDefault();
  field.setSelectionRange(chip.start, chip.end);
  editField(field, null);
  removed(chip.label);
  return true;
};

/** A key that edits a selection cutting into a chip widens it to the whole chip, so the browser makes the edit itself. */
const widened = (
  event: KeyboardEvent<HTMLTextAreaElement>,
  pieces: Piece[]
) => {
  const editing =
    event.key.length === 1 ||
    event.key === "Backspace" ||
    event.key === "Delete" ||
    event.key === "Enter";
  return (
    editing &&
    !event.metaKey &&
    !event.ctrlKey &&
    wholeChips(event.currentTarget, pieces)
  );
};

/**
 * A picture's chip is one character to the keys: the arrows step over it (Shift with them selects
 * it whole), Backspace and Delete take it out whole. True when the key was the chip's.
 */
const pictureKeys = (
  event: KeyboardEvent<HTMLTextAreaElement>,
  pieces: Piece[],
  removed: (label: string) => void
) => {
  const element = event.currentTarget;
  const { selectionStart: start, selectionEnd: end } = element;
  if (
    !pieces.some((piece) => piece.chip) ||
    widened(event, pieces) ||
    event.altKey ||
    event.metaKey ||
    event.ctrlKey
  ) {
    return false;
  }
  if (event.key === "Backspace" || event.key === "Delete") {
    return start === end && chipOut(event, pieces, removed);
  }
  if (
    (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
    (!event.shiftKey && start !== end)
  ) {
    return false;
  }
  // Right to left, the left arrow goes on through the text.
  const ahead =
    (event.key === "ArrowRight") ===
    (getComputedStyle(element).direction !== "rtl");
  const backward = element.selectionDirection === "backward";
  const moving = backward ? start : end;
  const anchor = backward ? end : start;
  const chip = chipAt(pieces, moving, ahead ? "after" : "before");
  if (chip === null) {
    return false;
  }
  event.preventDefault();
  const to = ahead ? chip.end : chip.start;
  if (event.shiftKey) {
    element.setSelectionRange(
      Math.min(anchor, to),
      Math.max(anchor, to),
      to < anchor ? "backward" : "forward"
    );
  } else {
    element.setSelectionRange(to, to);
  }
  return true;
};

/** A caret put inside a chip (by a press) goes to its end, so the chip stays one character. */
const outOfChip = (element: HTMLTextAreaElement, pieces: Piece[]) => {
  const { selectionStart: start, selectionEnd: end } = element;
  if (start !== end) {
    return start;
  }
  const chip = chipAt(pieces, start, "inside");
  if (chip !== null) {
    element.setSelectionRange(chip.end, chip.end);
    return chip.end;
  }
  return start;
};

/** Mentions: @ for people, agents, skills and files; / at a line's start for commands. */
const useMentions = ({
  text,
  pictures,
  pieces,
  onPictureRemoved,
  expect,
  area,
  kinds,
  items,
  onMentionQuery,
  onMention,
  commandsLabel,
  setText,
}: MentionsInput) => {
  const on = kinds.length > 0 || items.length > 0 || pictures.length > 0;
  const [picked, setPicked] = useState<ComposerMentionItem[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const nextCaret = useRef<number | null>(null);
  const id = useId();
  const query = menu === null ? "" : text.slice(menu.start + 1, caret);
  const rows: MentionRow[] =
    menu === null
      ? []
      : mentionRows(menu.trigger, query, menu.level, kinds, items, pictures);
  const title = titleOf(menu, commandsLabel, kinds);

  // A new menu, level or query starts the highlight at the top again.
  const highlightFor = JSON.stringify([menu?.trigger, menu?.level, query]);
  const [highlightKey, setHighlightKey] = useState(highlightFor);
  if (highlightKey !== highlightFor) {
    setHighlightKey(highlightFor);
    setHighlight(0);
  }

  // Put the caret where an edit left it, once the new text is in.
  useEffect(() => {
    const at = nextCaret.current;
    if (at === null || area.current === null) {
      return;
    }
    area.current.setSelectionRange(at, at);
    nextCaret.current = null;
  });

  // The caller hears each new query, by the handler it gave last.
  const queryHandler = useRef(onMentionQuery);
  useEffect(() => {
    queryHandler.current = onMentionQuery;
  });
  const trigger = menu?.trigger;
  const level = menu?.level ?? null;
  useEffect(() => {
    if (trigger !== undefined) {
      queryHandler.current?.(query, trigger === "/" ? "commands" : level);
    }
  }, [trigger, level, query]);

  const write = (next: string, at: number) => {
    setText(next);
    setCaret(at);
    nextCaret.current = at;
  };

  // After every edit: is the caret just after an @, or a / at a line's start? Is an open menu done?
  const watch = (next: string, at: number) => {
    setCaret(at);
    if (!on) {
      return;
    }
    if (menu !== null) {
      const typed = next.slice(menu.start + 1, at);
      if (
        at <= menu.start ||
        next[menu.start] !== menu.trigger ||
        /\n| {2}/u.test(typed)
      ) {
        setMenu(null);
      }
      return;
    }
    const opened = openedAt(next, at, items);
    if (opened !== null) {
      setMenu(opened);
    }
  };

  const pick = (index: number) => {
    const row = rows[index];
    if (menu === null || row === undefined) {
      return;
    }
    if (row.type === "kind") {
      // One level in: the @ stays, what was typed after it goes.
      write(
        `${text.slice(0, menu.start + 1)}${text.slice(caret)}`,
        menu.start + 1
      );
      setMenu({ ...menu, level: row.kind.value });
      return;
    }
    if (row.type === "picture") {
      // The same picture's chip again, in place of the @ and what was typed after it.
      const chip = `${pictureToken(row.picture.label)} `;
      expect({
        canonical: `${composerPictureToken(row.picture.id, row.picture.label)} `,
      });
      write(
        `${text.slice(0, menu.start)}${chip}${text.slice(caret)}`,
        menu.start + chip.length
      );
      setMenu(null);
      return;
    }
    const token = `${menu.trigger}${row.item.label} `;
    write(
      `${text.slice(0, menu.start)}${token}${text.slice(caret)}`,
      menu.start + token.length
    );
    setPicked((all) =>
      all.some((item) => item.value === row.item.value)
        ? all
        : [...all, row.item]
    );
    setMenu(null);
    onMention?.(row.item);
  };

  // Opened from the plus menu: an @ at the caret, one level in at that kind.
  const openMentions = (kind: string | null) => {
    const element = area.current;
    const at = element?.selectionStart ?? text.length;
    const space = at > 0 && !/\s/u.test(text[at - 1] ?? "") ? " " : "";
    write(
      `${text.slice(0, at)}${space}@${text.slice(at)}`,
      at + space.length + 1
    );
    setMenu({ trigger: "@", start: at + space.length, level: kind });
    element?.focus();
  };

  // The open menu's keys. True when the key was the menu's.
  const menuKeys = (event: KeyboardEvent<HTMLTextAreaElement>, open: Menu) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((now) =>
        rows.length === 0 ? 0 : (now + step + rows.length) % rows.length
      );
      return true;
    }
    if (
      ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") &&
      rows.length > 0
    ) {
      event.preventDefault();
      event.stopPropagation();
      pick(highlight);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      return true;
    }
    const inKind = open.level !== null && open.level !== "";
    if (
      event.key === "Backspace" &&
      inKind &&
      query === "" &&
      event.currentTarget.selectionStart === open.start + 1
    ) {
      // Back out of a kind, to the kinds.
      event.preventDefault();
      setMenu({ ...open, level: null });
      return true;
    }
    return false;
  };

  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu !== null && menuKeys(event, menu)) {
      return;
    }
    if (pictureKeys(event, pieces, onPictureRemoved)) {
      return;
    }
    // One Backspace takes a whole mention out.
    const element = event.currentTarget;
    if (
      event.key !== "Backspace" ||
      element.selectionStart !== element.selectionEnd ||
      picked.length === 0
    ) {
      return;
    }
    const at = element.selectionStart;
    const token = mentionBefore(text, at, picked);
    if (token !== null) {
      event.preventDefault();
      write(
        `${text.slice(0, at - token.length)}${text.slice(at)}`,
        at - token.length
      );
    }
  };

  // The menu stands at the caret: under its line, or over it when the composer is low on the page.
  // Measured after the text is laid out, never during render.
  const [place, setPlace] = useState<MenuPlace>({ x: 0, top: 0 });
  const menuStart = menu?.start;
  useLayoutEffect(
    () => {
      if (menuStart === undefined || area.current === null) {
        return;
      }
      // oxlint-disable-next-line react/set-state-in-effect -- the place is read from the laid-out text, which only an effect can see
      setPlace(placeAt(area.current, menuStart));
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- measured again as the caret and the text move, which it reads from the page
    [menuStart, caret, text, area]
  );

  return {
    on,
    id,
    menu,
    rows,
    title,
    highlight,
    handleHover: setHighlight,
    picked,
    pictures,
    pieces,
    place,
    setCaret,
    watch,
    handlePick: pick,
    openMentions,
    handleKeyDown: keys,
  };
};

type Mentions = ReturnType<typeof useMentions>;

interface FieldProps {
  area: (element: HTMLTextAreaElement | null) => void;
  label: string;
  placeholder: string | undefined;
  text: string;
  describedBy: string | undefined;
  invalid: boolean;
  disabled: boolean;
  compact: boolean;
  mentions: Mentions;
  onChange: TextareaProps["onValueChange"];
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onCopy: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onCut: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  maxLength: number | undefined;
}

/** The text itself: UI SDK's Textarea, a combobox while mentions are on. */
const ComposerField = ({
  area,
  label,
  placeholder,
  text,
  describedBy,
  invalid,
  disabled,
  compact,
  mentions,
  onChange,
  onPaste,
  onCopy,
  onCut,
  onCompositionStart,
  onCompositionEnd,
  onSubmit,
  maxLength,
}: FieldProps) => {
  const open = mentions.menu !== null;
  return (
    <TextareaPrimitive
      ref={area}
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid ? true : undefined}
      placeholder={placeholder}
      value={text}
      maxLength={maxLength}
      onValueChange={onChange}
      onPaste={onPaste}
      onCopy={onCopy}
      onCut={onCut}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      onKeyDown={mentions.handleKeyDown}
      onKeyUp={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        mentions.setCaret(event.currentTarget.selectionStart);
      }}
      onClick={(event: MouseEvent<HTMLTextAreaElement>) => {
        mentions.setCaret(outOfChip(event.currentTarget, mentions.pieces));
      }}
      aria-autocomplete={mentions.on ? "list" : undefined}
      aria-controls={open ? mentions.id : undefined}
      aria-expanded={mentions.on ? open : undefined}
      aria-activedescendant={
        open && mentions.rows.length > 0
          ? `${mentions.id}-${mentions.highlight}`
          : undefined
      }
      rows={1}
      autoResize
      submitShortcut="enter"
      onSubmit={onSubmit}
      disabled={disabled}
      render={(props: Record<string, unknown>) => (
        <textarea
          {...props}
          {...stylex.props(
            styles.text,
            compact && styles.compactText,
            mentions.on && styles.overChips,
            scroll.bar
          )}
        />
      )}
    />
  );
};

interface EditorProps {
  field: ReactElement;
  text: string;
  compact: boolean;
  mentions: Mentions;
  loading: boolean;
  emptyLabel: string;
  loadingLabel: string;
  statusWords: MenuStatusWords;
  picturesLabel: string;
  pictureTime: (at: Date) => string;
}

/**
 * The text, and with mentions on, the chips and the menu. The chips: a copy of the text behind it,
 * transparent but for a tint under each mention, so a mention reads as a chip while the text stays
 * a plain, editable text field.
 */
const ComposerEditor = ({
  field,
  text,
  compact,
  mentions,
  loading,
  emptyLabel,
  loadingLabel,
  statusWords,
  picturesLabel,
  pictureTime,
}: EditorProps) => {
  if (!mentions.on) {
    return field;
  }
  return (
    <div {...stylex.props(styles.editor)}>
      {(mentions.picked.length > 0 || mentions.pictures.length > 0) && (
        <div
          aria-hidden="true"
          data-slot="composer-chips"
          {...stylex.props(
            styles.text,
            compact && styles.compactText,
            styles.chips
          )}
        >
          {chipText(text, mentions.picked, mentions.pictures)}
        </div>
      )}
      {field}
      {mentions.menu !== null && (
        <MentionMenu
          id={mentions.id}
          rows={mentions.rows}
          highlight={mentions.highlight}
          title={mentions.title}
          loading={loading}
          loadingLabel={loadingLabel}
          emptyLabel={emptyLabel}
          place={mentions.place}
          picturesLabel={picturesLabel}
          pictureTime={pictureTime}
          onPick={mentions.handlePick}
          onHover={mentions.handleHover}
        />
      )}
      <span aria-live="polite" {...stylex.props(visuallyHidden)}>
        {menuStatus(
          mentions.menu,
          mentions.title,
          loading,
          mentions.rows.length,
          statusWords
        )}
      </span>
    </div>
  );
};

interface EndProps {
  voice: ReactNode;
  empty: boolean;
  working: boolean;
  disabled: boolean;
  onSend: () => Promise<void>;
  onStop: (() => unknown) | undefined;
  sendLabel: string;
  stopLabel: string;
}

/**
 * Voice, bare, then send, always last: bare and off with nothing to send, the strong ink with text. Send
 * never trades places with voice (Ruben, 18 November: "at most right side a grey out send button").
 */
const ComposerEnd = ({
  voice,
  empty,
  working,
  disabled,
  onSend,
  onStop,
  sendLabel,
  stopLabel,
}: EndProps) => (
  <>
    {voice}
    <ComposerSend
      working={working}
      empty={empty}
      disabled={disabled}
      onSend={onSend}
      onStop={onStop}
      sendLabel={sendLabel}
      stopLabel={stopLabel}
    />
  </>
);

/** After send: a short hairline, then the control. Nothing at all without one. */
const ComposerAfter = ({
  after,
  row = false,
}: {
  after: ReactNode;
  row?: boolean;
}) => {
  if (after === undefined || after === null || after === false) {
    return null;
  }
  // A short line sets it apart from Send; in the one row, the row's own gap stands either side.
  return (
    <div
      data-slot="composer-after"
      {...stylex.props(styles.after, row && styles.afterRow)}
    >
      <span aria-hidden="true" {...stylex.props(styles.afterLine)} />
      {after}
    </div>
  );
};

interface InsideProps {
  takeover: ReactNode;
  compact: boolean;
  /** In the one row, the text no longer fits its line: it takes the row, the controls go under it. */
  tall: boolean;
  start: ReactNode;
  end: ReactNode;
  last: ReactNode;
  after: ReactNode;
  /** What stands after send by its new name: it wins over `after`. */
  footer: ReactNode;
  editor: ReactNode;
  controls: ReactNode;
  above: ReactNode;
  chosenAgent: ComposerChosenAgent | null;
  attachments: ComposerFile[];
  onAttach: ComposerProps["onAttach"];
  onRemoveAttachment: ComposerProps["onRemoveAttachment"];
  onRetryAttachment: ComposerProps["onRetryAttachment"];
  onOpenAttachment: ComposerProps["onOpenAttachment"];
  attachmentWords: ComposerProps["attachmentWords"];
  attachmentsLabel: string;
  focusText: (event: PointerEvent<HTMLElement>) => void;
}

/** What the card holds: a takeover in place of the text, a single row, or the text over a footer. */
const ComposerInside = ({
  takeover,
  compact,
  tall,
  start,
  end,
  last,
  after: afterGiven,
  footer,
  editor,
  controls,
  above,
  chosenAgent,
  attachments,
  onAttach,
  onRemoveAttachment,
  onRetryAttachment,
  onOpenAttachment,
  attachmentWords,
  attachmentsLabel,
  focusText,
}: InsideProps) => {
  const after = footer ?? afterGiven;
  const taken = Boolean(takeover);
  if (taken) {
    return <div data-slot="composer-takeover-room">{takeover}</div>;
  }
  const strip =
    onAttach !== undefined || attachments.length > 0 ? (
      <ComposerAttachments
        files={attachments}
        onRemove={onRemoveAttachment}
        onRetry={onRetryAttachment}
        onOpen={onOpenAttachment}
        words={attachmentWords}
        label={attachmentsLabel}
      />
    ) : null;
  // The agent chosen in the plus menu, when it is not the default, stands first in the row.
  const aboveRow = (Boolean(above) || chosenAgent !== null) && (
    <div {...stylex.props(styles.above)}>
      {chosenAgent !== null && <ComposerAgentChip chosen={chosenAgent} />}
      {above}
    </div>
  );
  if (compact) {
    // In the DOM as it is read and tabbed: plus, text, controls, dictation, send. The grid places
    // the text over the controls once it no longer fits its line (compactTall).
    return (
      <>
        <div {...stylex.props(styles.compactAbove)}>
          {strip}
          {aboveRow}
        </div>
        <div
          data-slot="composer-start"
          onPointerDown={focusText}
          {...stylex.props(styles.side, styles.compactStart)}
        >
          {start}
        </div>
        <div
          data-slot="composer-field"
          {...stylex.props(
            styles.compactField,
            tall && styles.compactFieldTall
          )}
        >
          {editor}
        </div>
        <div
          data-slot="composer-end"
          onPointerDown={focusText}
          {...stylex.props(styles.side, styles.compactEnd)}
        >
          {Boolean(controls) && (
            <div
              data-slot="composer-controls"
              {...stylex.props(styles.controls)}
            >
              {controls}
            </div>
          )}
          {end}
          {last}
          <ComposerAfter after={after} row />
        </div>
      </>
    );
  }
  return (
    <>
      {/* The files, the row above the text and the text, as one of the card's rows: the card's gap
          never stands above an empty strip or an empty row, so the text starts where it would with
          neither; the strip carries its own room as it opens. */}
      <div {...stylex.props(styles.textRoom)}>
        {strip}
        {aboveRow}
        {editor}
      </div>
      <div
        data-slot="composer-footer"
        onPointerDown={focusText}
        {...stylex.props(styles.footer)}
      >
        <div {...stylex.props(styles.side, styles.startSide)}>
          {start}
          {Boolean(controls) && (
            <div
              data-slot="composer-controls"
              {...stylex.props(styles.controls)}
            >
              {controls}
            </div>
          )}
        </div>
        <div {...stylex.props(styles.side)}>
          {end}
          {last}
          <ComposerAfter after={after} />
        </div>
      </div>
    </>
  );
};

interface UnderProps {
  id: string;
  /** The working mark and its words, while working with `showWorking`. */
  workingLabel: string | null;
  failed: boolean;
  failedLabel: string;
  validation: string | undefined;
  waiting: boolean;
  uploadingLabel: string;
  note: ReactNode;
}

/** The lines under the card: a failed send, a validation, the wait for uploads, and a note. */
const ComposerUnder = ({
  id,
  workingLabel,
  failed,
  failedLabel,
  validation,
  waiting,
  uploadingLabel,
  note,
}: UnderProps) => {
  const invalid = validation !== undefined && validation !== "";
  const noted = Boolean(note);
  if (workingLabel === null && !failed && !invalid && !waiting && !noted) {
    return null;
  }
  return (
    <div id={id} {...stylex.props(styles.under)}>
      {/* Seen only: the status below says it to a screen reader. */}
      {workingLabel !== null && (
        <p
          aria-hidden="true"
          data-slot="composer-working"
          {...stylex.props(styles.line)}
        >
          <AgentIndicator />
          <Shimmer>{workingLabel}</Shimmer>
        </p>
      )}
      {failed && (
        <p role="alert" {...stylex.props(styles.line, styles.danger)}>
          <Icon icon={Alert} />
          {failedLabel}
        </p>
      )}
      {invalid && (
        <p {...stylex.props(styles.line, styles.danger)}>{validation}</p>
      )}
      {waiting && <p {...stylex.props(styles.line)}>{uploadingLabel}</p>}
      {noted && <p {...stylex.props(styles.line)}>{note}</p>}
    </div>
  );
};

/** What a screen reader hears of the assistant: working, then done. */
const statusWords = (
  activity: ComposerActivity,
  workingLabel: string,
  successLabel: string
) => {
  if (activity === "working") {
    return workingLabel;
  }
  return activity === "success" ? successLabel : "";
};

// The props with their defaults filled in, in two parts so neither grows too long to follow.
const lookDefaults = (props: ComposerProps) => ({
  activity: props.activity ?? "idle",
  accent: props.accent ?? "light",
  edge: props.edge ?? "smooth",
  compact: props.compact ?? false,
  surface: props.surface ?? "card",
  defaultValue: props.defaultValue ?? "",
  attachments: props.attachments ?? noFiles,
  mentionKinds: props.mentionKinds ?? noKinds,
  mentionItems: props.mentionItems ?? noItems,
  mentionsLoading: props.mentionsLoading ?? false,
});

// Its words: the caller's text prop where given, else the product's catalogue (GraspWords), else English.
const wordDefaults = (
  props: ComposerProps,
  words: ComposerWords["composer"]
) => ({
  failedLabel: props.failedLabel ?? words.failed,
  workingLabel: props.workingLabel ?? words.working,
  showWorking: props.showWorking ?? false,
  successLabel: props.successLabel ?? words.success,
  sendLabel: props.sendLabel ?? words.send,
  stopLabel: props.stopLabel ?? words.stop,
  dropLabel: props.dropLabel ?? words.drop,
  mentionsEmptyLabel: props.mentionsEmptyLabel ?? words.mentionsEmpty,
  mentionsLoadingLabel: props.mentionsLoadingLabel ?? words.mentionsLoading,
  maxLengthCountLabel: props.maxLengthCountLabel ?? words.count,
  maxLengthNearLabel: props.maxLengthNearLabel ?? words.near,
  maxLengthReachedLabel: props.maxLengthReachedLabel ?? words.reached,
  maxLengthCutLabel: props.maxLengthCutLabel ?? words.cut,
  mentionsLabel: props.mentionsLabel ?? words.mentions,
  mentionsFoundLabel: props.mentionsFoundLabel ?? words.mentionsFound,
  commandsLabel: props.commandsLabel ?? words.commands,
  uploadingLabel: props.uploadingLabel ?? words.uploading,
  attachmentsLabel: props.attachmentsLabel ?? words.attachments,
  dictateLabel: props.dictateLabel ?? words.dictate,
  // Pictures in the text: by the catalogue only (GraspWords), no text prop.
  imageLabel: words.image,
  screenshotsLabel: words.screenshots,
  pictureTime: words.pictureTime,
  pictureRemovedLabel: words.pictureRemoved,
});

type Resolved = Omit<ComposerProps, "ref"> &
  ReturnType<typeof lookDefaults> &
  ReturnType<typeof wordDefaults> & { hostField?: ComposerProps["ref"] };

/** The composer's own microphone, from `onDictate`: pressed while `listening`, gone once written with `dictateWhileEmpty`. */
const ownMicrophone = (props: Resolved, text: string) => {
  if (
    props.onDictate === undefined ||
    (props.dictateWhileEmpty === true && text.trim() !== "")
  ) {
    return null;
  }
  // Said as pressed only where the host says whether it listens.
  return (
    <ComposerAction
      icon={props.listening === true ? Listening : Mic}
      aria-label={props.dictateLabel}
      pressed={props.listening}
      pressedVariant={props.listeningVariant}
      onClick={props.onDictate}
    />
  );
};

/**
 * The footer's microphone and the dictation it hands the card to, from `onDictate` and
 * `dictation`; the host's own `voice` and `takeover` come first. A problem that stops the
 * dictation hands the card back to its text and stands in the band over it, in `top`'s place.
 * A cancelled dictation is the one kept as Cancel was pressed, until its words have dissolved.
 */
const dictationParts = (
  props: Resolved,
  gone: Resolved["dictation"] | null,
  text: string
) => {
  const dictation = gone ?? props.dictation;
  const problem = stoppedBy(dictation);
  return {
    voice: props.voice ?? ownMicrophone(props, text),
    takeover:
      props.takeover ??
      (dictation === undefined || problem !== undefined ? undefined : (
        <ComposerVoice typed={text} compact={props.compact} {...dictation} />
      )),
    top:
      dictation === undefined || problem === undefined ? (
        props.top
      ) : (
        <VoiceProblem {...dictation} problem={problem} />
      ),
    dismiss: props.onTakeoverDismiss ?? dictation?.onCancel,
  };
};

/** What the card draws while it is still (`loading`): each live part kept in its room, the text a quiet line, Send off. */
const stillOf = (
  pending: boolean,
  disabled: boolean,
  parts: {
    editor: ReactNode;
    voice: ReactNode;
    controls: ReactNode;
    end: ReactNode;
    empty: boolean;
    row: boolean;
  }
) =>
  pending
    ? {
        editor: <PendingText row={parts.row}>{parts.editor}</PendingText>,
        voice: <Kept>{parts.voice}</Kept>,
        controls: <Kept>{parts.controls}</Kept>,
        end: <Kept>{parts.end}</Kept>,
        empty: true,
        // Nothing to focus and nothing read out: the page's own busy state speaks.
        card: { inert: true, "aria-hidden": true } as const,
        // No light while it is still.
        light: false,
      }
    : { ...parts, card: {}, light: !disabled };

/** The composer, with every default in place. */
const ComposerForm = (props: Resolved) => {
  const { activity, value, onValueChange, attachments, validation, compact } =
    props;
  const label = nameOf(props);
  const [own, setOwn] = useState(props.defaultValue);
  const text = value ?? own;
  // A dictation cancelled: kept as it was while its words dissolve; what the host sends after is dropped.
  const [gone, setGone] = useState<Resolved["dictation"] | null>(null);
  // A dictation's typed words, as the person reads them: a picture by its label.
  const { voice, takeover, top, dismiss } = dictationParts(
    props,
    gone,
    readableText(text)
  );
  const area = useRef<HTMLTextAreaElement | null>(null);
  // The limit: where the text stands against it, and whether the last paste was cut there (set by
  // the paste, read by the change that follows it).
  const max = props.maxLength;
  const [cut, setCut] = useState(false);
  const cutting = useRef(false);
  const limitWords: LimitWords = {
    count: props.maxLengthCountLabel,
    near: props.maxLengthNearLabel,
    reached: props.maxLengthReachedLabel,
    cut: props.maxLengthCutLabel,
  };
  const card = useRef<HTMLFieldSetElement | null>(null);
  const underId = useId();
  // A file still uploading holds send, and the line under the card says why.
  const uploading = attachments.some((file) => file.status === "uploading");
  const empty = text.trim() === "" || uploading;
  const working = activity === "working";
  const disabled = activity === "disabled";
  const taken = Boolean(takeover);
  // The one row, while no takeover has the card.
  const row = compact && !taken;
  const invalid = validation !== undefined && validation !== "";
  // A dictation in the takeover hands the card its level, so the dithered edge listens with it.
  const [listener, setListener] = useState<ComposerListener | null>(null);
  // The agent the plus menu chose, while it is not the default: its chip stands above the text.
  const [chosenAgent, setChosenAgent] = useState<ComposerChosenAgent | null>(
    null
  );

  const words = useShownText({
    text,
    value,
    setOwn,
    onValueChange,
    attachments,
    area,
    imageLabel: props.imageLabel,
    onRemoveAttachment: props.onRemoveAttachment,
  });
  const { pictures } = words;
  // The row's fit reads the text as the field shows it (a chip by its characters).
  const { tall, fold } = useRowFit(row, words.shown, card, area);
  // Said when a chip is taken out.
  const [pictureSaid, setPictureSaid] = useState("");
  const files = useFileDrop(props.onAttach, disabled);
  const success = useSuccessCount(activity);
  const focusWatch = useTakeoverFocus(taken, card, area);
  useAutoFocus(props.autoFocus === true, taken, card, area);
  // The text field, for the composer's own work and the host's `ref`.
  const { hostField } = props;
  const attachField = (element: HTMLTextAreaElement | null) => {
    area.current = element;
    handTo(hostField, element);
  };
  const sending = useSend({
    text,
    prepare: (sent) => [
      sent,
      {
        attachments: attachments.filter(
          (file) => !composerUnreferenced(sent, [file]).includes(file)
        ),
      },
    ],
    onSent: words.release,
    value,
    setOwn,
    validation,
    empty,
    disabled,
    working,
    onSend: props.onSend,
    failedLabel: props.failedLabel,
    sendFailed: props.sendFailed,
    onSendFailedChange: props.onSendFailedChange,
  });
  const mentions = useMentions({
    text: words.shown,
    pictures: pictures.pictures,
    pieces: words.pieces,
    onPictureRemoved: (name) => {
      setPictureSaid(props.pictureRemovedLabel(name));
    },
    expect: words.expect,
    area,
    kinds: props.mentionKinds,
    items: props.mentionItems,
    onMentionQuery: props.onMentionQuery,
    onMention: props.onMention,
    commandsLabel: props.commandsLabel,
    setText: (next) => {
      words.putText(words.toCanonical(next).canonical);
    },
  });

  // Drawn now, in the same task as the change, not in a render React schedules for later: an
  // agent's plan writes and then presses Send, and between the two it waits only two frames, which
  // Firefox can run back to back before that render (Send was still off in 2 of 10 plans).
  const change: TextareaProps["onValueChange"] = (field, details) => {
    // While an input method composes, the field keeps what it shows; it is read when it ends.
    if (words.composing()) {
      flushSync(() => {
        words.setRaw(field);
      });
      return;
    }
    // A change from outside the keys (a mention picked near the limit) is cut there too.
    const room = max === undefined ? undefined : max + words.extra;
    const whole =
      room !== undefined && field.length > room ? field.slice(0, room) : field;
    const { canonical, reshown, caret } = words.toCanonical(whole);
    flushSync(() => {
      words.setRaw(null);
      setCut(cutting.current);
      cutting.current = false;
      if (value === undefined) {
        setOwn(canonical);
      }
      mentions.watch(
        reshown,
        caret ?? area.current?.selectionStart ?? reshown.length
      );
      sending.setFailed(false);
      onValueChange?.(canonical, details);
    });
  };

  // Send pressed: the field takes the focus first, since Send gives way to Stop (or turns off) as
  // the message goes, and the focus would fall to the page's body. Safari never focuses a pressed
  // button, so there the focus is on the body already: this composer's own Send was pressed, so it
  // is this composer's. Nothing scrolls.
  const sendHere = async () => {
    const mine =
      document.activeElement === document.body ||
      (card.current?.contains(document.activeElement) ?? false);
    if (mine && document.activeElement !== area.current) {
      area.current?.focus({ preventScroll: true });
    }
    await sending.handleSend();
  };

  const sendByKey = () => {
    // Enter picks from an open menu; it never sends past it.
    if (mentions.menu !== null && mentions.rows.length > 0) {
      mentions.handlePick(mentions.highlight);
      return;
    }
    void sendQuietly(sending.handleSend);
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    sendByKey();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const inTakeover =
      event.target instanceof Element &&
      event.target.closest("[data-slot=composer-takeover-room]") !== null;
    if (
      event.key === "Escape" &&
      taken &&
      dismiss !== undefined &&
      inTakeover &&
      !event.defaultPrevented
    ) {
      // One Escape does one thing: it leaves the takeover, and no listener of the host's (on the
      // document, natively) hears it and closes more (the product's row 52).
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  };

  // A press on the card's empty space puts the caret in the text.
  const focusText = (event: PointerEvent<HTMLElement>) => {
    if (taken || event.target !== event.currentTarget) {
      return;
    }
    event.preventDefault();
    area.current?.focus();
  };

  const field = (
    <ComposerField
      area={attachField}
      label={label}
      placeholder={props.placeholder}
      text={words.shown}
      describedBy={sending.failed || invalid ? underId : undefined}
      invalid={invalid}
      disabled={disabled}
      compact={compact}
      mentions={mentions}
      onChange={change}
      onCopy={(event: ClipboardEvent<HTMLTextAreaElement>) => {
        words.copy(event, false);
      }}
      onCut={(event: ClipboardEvent<HTMLTextAreaElement>) => {
        words.copy(event, true);
      }}
      onCompositionStart={words.handleCompositionStart}
      onCompositionEnd={(event: CompositionEvent<HTMLTextAreaElement>) => {
        words.endComposing();
        change(event.currentTarget.value, writtenDetails);
      }}
      onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
        // The composer's own copy binds by id; pictures pasted go in where the caret is.
        if (words.pasteOwn(event)) {
          return;
        }
        pictures.markAt(event.currentTarget.selectionStart);
        files.handlePaste(event);
        if (event.defaultPrevented || max === undefined) {
          return;
        }
        // The field takes what fits and drops the rest; that it was cut is said.
        const box = event.currentTarget;
        const room =
          max +
          words.extra -
          (box.value.length - (box.selectionEnd - box.selectionStart));
        cutting.current = event.clipboardData.getData("text").length > room;
      }}
      onSubmit={sendByKey}
      maxLength={max === undefined ? undefined : max + words.extra}
    />
  );
  const editor = (
    <ComposerEditor
      field={field}
      text={words.shown}
      compact={compact}
      mentions={mentions}
      loading={props.mentionsLoading}
      emptyLabel={props.mentionsEmptyLabel}
      loadingLabel={props.mentionsLoadingLabel}
      statusWords={{
        name: props.mentionsLabel,
        looking: props.mentionsLoadingLabel,
        found: props.mentionsFoundLabel,
      }}
      picturesLabel={props.screenshotsLabel}
      pictureTime={props.pictureTime}
    />
  );
  const still = stillOf(props.loading === true, disabled, {
    editor,
    voice,
    controls: props.controls,
    end: props.end,
    empty,
    row: compact,
  });
  const last = (
    <>
      <ComposerCount
        length={words.seen}
        max={max}
        words={limitWords}
        row={row}
      />
      <ComposerEnd
        voice={still.voice}
        empty={still.empty}
        working={working}
        disabled={disabled}
        onSend={sendHere}
        onStop={props.onStop}
        sendLabel={props.sendLabel}
        stopLabel={props.stopLabel}
      />
    </>
  );

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the form hears what happens in its controls: focus, Escape and files dropped
    <form
      data-slot="composer"
      data-activity={activity}
      aria-label={label}
      onFocus={focusWatch.handleFocus}
      onBlur={focusWatch.handleBlur}
      onSubmit={submit}
      onDragOver={files.handleDragOver}
      onDragLeave={files.handleDragLeave}
      onDrop={(event: DragEvent<HTMLFormElement>) => {
        // Pictures dropped go in at the caret, if the text has the focus; else at the end.
        pictures.markAt(caretIfFocused(area.current));
        files.handleDrop(event);
      }}
      onKeyDown={onKeyDown}
      {...stylex.props(styles.root, props.layout ?? props.style)}
    >
      {/* One stacking context, three layers: the light at the bottom, then a band above the card
          (so the light never paints over its rows), then the card, which tucks over the band. */}
      <div {...stylex.props(styles.stack)}>
        {Boolean(top) && <div {...stylex.props(styles.top)}>{top}</div>}
        <div data-slot="composer-card-room" {...stylex.props(styles.cardRoom)}>
          {still.light && (
            <ComposerGlow
              edge={props.edge}
              working={working}
              success={success}
              accent={props.accent}
              listener={listener}
            />
          )}
          <fieldset
            ref={card}
            disabled={disabled}
            {...still.card}
            data-tall={row ? tall : undefined}
            data-fold={row && fold ? "" : undefined}
            onPointerDown={focusText}
            {...stylex.props(
              ...cardLook({
                glass: props.surface === "glass",
                row,
                tall,
                taken,
                dragging: files.dragging,
                over: files.over,
              })
            )}
          >
            {files.dragging && (
              <span aria-hidden="true" {...stylex.props(styles.drop)}>
                {props.dropLabel}
              </span>
            )}
            <ListenContext.Provider value={setListener}>
              <LeaveContext.Provider value={setGone}>
                <RowTallContext.Provider value={compact && tall}>
                  <ChosenAgentContext.Provider value={setChosenAgent}>
                    <DisabledContext.Provider value={disabled}>
                      <MentionContext.Provider
                        value={mentions.on ? mentions.openMentions : null}
                      >
                        <ComposerInside
                          takeover={takeover}
                          compact={compact}
                          tall={tall}
                          start={props.start}
                          end={still.end}
                          last={last}
                          after={props.after}
                          footer={props.footer}
                          editor={still.editor}
                          controls={still.controls}
                          above={props.above}
                          chosenAgent={chosenAgent}
                          attachments={attachments.filter(
                            (file) => !isInlinePicture(file)
                          )}
                          onAttach={props.onAttach}
                          onRemoveAttachment={props.onRemoveAttachment}
                          onRetryAttachment={props.onRetryAttachment}
                          onOpenAttachment={props.onOpenAttachment}
                          attachmentWords={props.attachmentWords}
                          attachmentsLabel={props.attachmentsLabel}
                          focusText={focusText}
                        />
                      </MentionContext.Provider>
                    </DisabledContext.Provider>
                  </ChosenAgentContext.Provider>
                </RowTallContext.Provider>
              </LeaveContext.Provider>
            </ListenContext.Provider>
          </fieldset>
        </div>
      </div>
      <ComposerUnder
        id={underId}
        workingLabel={props.showWorking && working ? props.workingLabel : null}
        failed={sending.failed}
        failedLabel={props.failedLabel}
        validation={validation}
        waiting={uploading && text.trim() !== ""}
        uploadingLabel={props.uploadingLabel}
        note={props.note}
      />
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region; role="status" is */}
      <p role="status" {...stylex.props(visuallyHidden)}>
        {statusWords(activity, props.workingLabel, props.successLabel)}
      </p>
      <ComposerLimitSaid
        length={words.seen}
        max={max}
        cut={cut}
        words={limitWords}
      />
      <p
        aria-live="polite"
        data-slot="composer-pictures-said"
        {...stylex.props(visuallyHidden)}
      >
        {pictureSaid}
      </p>
    </form>
  );
};

/** Where a person writes to an assistant: the text, its actions, and send. */
export const Composer = ({ ref, ...props }: ComposerProps) => {
  const words = useComposerWords("composer", props.words);
  // The host's ref on the text, handed on by a name of its own: the form reads its props in render.
  return (
    <ComposerForm
      {...props}
      {...lookDefaults(props)}
      {...wordDefaults(props, words)}
      hostField={ref}
    />
  );
};
