// PromptInput: where a person writes to an assistant, in StyleX on UI SDK's Token Input and Trigger
// Menu. A card with the files on top (Attachment), then the text, then a footer of tools (Button,
// DropdownMenu), Submit at the end. Enter sends and Shift+Enter starts a line; an input method's
// Enter never sends, and Enter in an open suggestion menu chooses the suggestion.
//
//   <PromptInput onSubmit={({ text, files, tokens }) => send(text, files, tokens)} status={status}>
//     <PromptInputHeader>
//       <PromptInputAttachments />
//     </PromptInputHeader>
//     <PromptInputBody>
//       <PromptInputTextarea aria-label="Message" placeholder="Ask anything" />
//     </PromptInputBody>
//     <PromptInputFooter>
//       <PromptInputTools>
//         <PromptInputActionMenu>
//           <PromptInputActionMenuTrigger />
//           <PromptInputActionMenuContent>
//             <PromptInputActionAddAttachments />
//           </PromptInputActionMenuContent>
//         </PromptInputActionMenu>
//         <PromptInputSpeechButton listening={listening} onListeningChange={setListening} />
//       </PromptInputTools>
//       <PromptInputSubmit onStop={stop} />
//     </PromptInputFooter>
//     <PromptInputNote>{working && <Shimmer>Searching the web</Shimmer>}</PromptInputNote>
//     <PromptInputMention triggers={[{ char: "@", type: "person", items: loadPeople }]} />
//   </PromptInput>
//
// A spoken conversation stands in the card's parts' place: PromptInputVoice, the words of the turn
// over the voice's level, the microphone and a close button, where the body and the footer were.
//
// While the answer comes a soft light travels along the card's top edge. PromptInputNote is the
// band tucked under the card's foot: it says what the assistant is doing, in the caller's words,
// and that a send failed, in the catalogue's, until the person types again.
//
// A mention is a real token in the text: it moves, deletes and copies as one piece, and reads as its
// label and kind. The caller says which characters open a menu, where each one's items come from,
// and how a picked item becomes a token; nothing here knows what the items are.
//
// The files are the prompt input's own: picked, pasted or dropped, it keeps them,
// PromptInputAttachments shows them (as an AttachmentGroup), and they go with the message to `onSubmit`;
// `usePromptInputAttachments()` reads and changes them from a part of the caller's. The body is a
// slot: in place of the text the caller may put a question or a dictation, and focus follows it
// there and back. Every value is a token.
//
// The card is not an InputGroup with addons above and below a textarea: Damsko's InputGroup is a
// field's box (an input's hairline and corner, no room inside, its addons padded as a field's), so
// the card here keeps the composer's own look, and its tools are Buttons, not InputGroupButtons
// (which set themselves in from a field's edge). The text is Token Input's editor, not a textarea,
// so a mention is a token; the length limit's sums are in prompt-input-limit.ts.
"use client";

import * as stylex from "@stylexjs/stylex";
import { formatFileSize } from "@ui-sdk/react/file-input";
import {
  TokenInput,
  TokenInputEditor,
  TokenInputToken,
  TokenInputTokenRemove,
  createTokenInputController,
  toLabel,
  toText,
} from "@ui-sdk/react/token-input";
import type {
  Token,
  TokenCodec,
  TokenInputController,
  TokenInputTokenState,
  TokenInputValue,
  TokenInputValueChangeDetails,
} from "@ui-sdk/react/token-input";
import {
  TriggerMenu,
  TriggerMenuContent,
  TriggerMenuEmpty,
  TriggerMenuGroup,
  TriggerMenuGroupLabel,
  TriggerMenuItem,
  TriggerMenuItemIcon,
  TriggerMenuList,
  TriggerMenuStatus,
} from "@ui-sdk/react/trigger-menu";
import type {
  TriggerBoundary,
  TriggerMenuContentState,
  TriggerMenuData,
  TriggerMenuItemState,
  TriggerMenuStatusState,
} from "@ui-sdk/react/trigger-menu";
import {
  Fragment,
  createContext,
  isValidElement,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useReducer,
  useState,
} from "react";
import type {
  ClipboardEvent,
  DragEvent,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
  Ref,
} from "react";
import { createPortal, flushSync } from "react-dom";

import { useI18n, useLocale } from "../lib/i18n";
import type { I18nCatalog } from "../lib/i18n";
import {
  ArrowUpIcon,
  AudioWaveformIcon,
  CheckIcon,
  ChevronRightIcon,
  Icon,
  InfoIcon,
  LoaderIcon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
  TriangleAlertIcon,
  XIcon,
} from "../lib/icons";
import type { IconData } from "../lib/icons";
import { menuStyles, scrollbarHidden, visuallyHidden } from "../lib/styles";
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
import { popup } from "../lib/tokens.values";
import {
  announce,
  assignRef,
  className,
  isBlank,
  isDevelopment,
  isThenable,
  listOf,
  nothing,
} from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import {
  iconVars,
  pixel,
  promptInputRowMarker,
  ringInsetMarker,
} from "../lib/vars.stylex";
import { Alert, AlertAction, AlertTitle } from "./alert";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "./attachment";
import type { AttachmentState } from "./attachment";
import { Button } from "./button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import type {
  DropdownMenuContentProps,
  DropdownMenuItemProps,
  DropdownMenuProps,
} from "./dropdown-menu";
import { refitOf, stageOf } from "./prompt-input-limit";
import type { VoiceField, VoiceFieldMode } from "./prompt-input-voice-field";
import type { VoiceReading } from "./prompt-input-voice-motion";
import { Skeleton } from "./skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * Where the answer to the last message is: the AI SDK's chat status (`ready`, `submitted`,
 * `streaming`, `error`), and `success`, the moment a product marks an answer as done.
 */
type Status = "ready" | "submitted" | "streaming" | "error" | "success";

/** The colour of the working light and the success halo: the brand's light, or one colour. */
type Accent =
  | "default"
  | "mint"
  | "lavender"
  | "info"
  | "warning"
  | "destructive";

/** What a submit hands the caller. */
export interface PromptInputMessage {
  /** The text, each token written by the codec (`[@Ada](person:ada)` by default). */
  text: string;
  /** The files attached to it, in the order they came. */
  files: File[];
  /** The tokens in it, in order: what each mention stands for. */
  tokens: Token[];
  /** The value itself: text and tokens, as the editor holds it. */
  value: TokenInputValue;
}

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the types below, so they cannot drift from what the code accepts.

/** Every prop a PromptInput takes. */
export interface PromptInputProps {
  /**
   * Its parts: a PromptInputHeader, a PromptInputBody, a PromptInputFooter, and any PromptInputNote
   * and PromptInputMention.
   */
  children: ReactNode;
  /**
   * Sends the message, its text and files: on Enter, or Submit. Return a Promise that settles when
   * the message is taken (not when the whole answer has come, as the AI SDK's `sendMessage` does)
   * and the words and files stay until it resolves, then clear (the text unless you keep `value`
   * yourself, or more was typed meanwhile); a second Enter waits for it. When it rejects, the
   * failure is said, PromptInputNote shows it, and nothing was lost. Return nothing and they clear
   * at once.
   */
  onSubmit?: (message: PromptInputMessage) => unknown;
  /**
   * Where the answer is: `ready` to send, `submitted` sent and waiting, `streaming` while the
   * answer comes (Submit turns into Stop), `error` when it failed (said once, and shown by
   * PromptInputNote until the person types; Submit sends again). While it is `submitted` or
   * `streaming` a soft light travels along the card's top edge. `success` is a moment the product
   * marks: one halo round the card, said once, and Submit as at `ready`; set it again to play it
   * again. Set on the form as `data-status`, for a layer of the product's own.
   * @default "ready"
   */
  status?: Status;
  /**
   * The colour of the working light and the success halo: `default` the brand's light (lime, sea
   * and mint), or one colour, such as an assistant's own, or `warning` while it works on something
   * that needs care.
   * @default "default"
   */
  accent?: Accent;
  /**
   * How the working light's edge is drawn: `smooth`, a soft glow, or `dither`, the same light seen
   * through the system's pixels, thinning outwards, as the light stands while a voice is heard.
   * @default "smooth"
   */
  edge?: "smooth" | "dither";
  /**
   * The card's surface: `glass` where the page scrolls behind it (a chat's foot), the card's colour
   * most of the way over a blur of what is behind.
   * @default "default"
   */
  variant?: "default" | "glass";
  /**
   * The page's data is not there yet: the card stands in the box it will have, a quiet line where
   * the text goes, Submit off, its other tools kept in their room but not drawn; nothing in it can
   * be focused or read, so say that the page loads where the page says it.
   * @default false
   */
  loading?: boolean;
  /** The text and its tokens, when you keep them in state. Pair it with `onValueChange`. */
  value?: TokenInputValue;
  /** The text and tokens it starts with. */
  defaultValue?: TokenInputValue;
  /**
   * Runs on every change: typing, a paste, a picked mention, undo. `details.reason` says why and
   * `details.cancel()` keeps the value as it was.
   */
  onValueChange?: (
    value: TokenInputValue,
    details: TokenInputValueChangeDetails
  ) => void;
  /**
   * How tokens are written as text, for `text`, the clipboard and a draft, and read back.
   * @default `[@label](type:value)`
   */
  codec?: TokenCodec;
  /**
   * Reads and writes the text from outside: an agent's words, a dictation's, a draft brought back.
   * Make one with `createTokenInputController()` from `@ui-sdk/react/token-input`.
   */
  controller?: TokenInputController;
  /**
   * The kinds of file it takes, as an `<input type="file">`'s `accept` ("image/*,.pdf"): the picker
   * offers only these, and others pasted or dropped are left out.
   */
  accept?: string;
  /**
   * Takes files dropped anywhere on the page, not only on the card. Either way the card is tinted
   * and says so while a file is dragged over the page.
   * @default false
   */
  globalDrop?: boolean;
  /**
   * The most characters the text may hold, a token counting as its label. A count shows from 90%,
   * and nearing and reaching it are said. What is added past it at once (a paste, a drop, an input
   * method's phrase, a dictation, a mention) is cut there, a token whole or not at all, and that is
   * said.
   */
  maxLength?: number;
  /**
   * Out of use: nothing can be typed or pressed.
   * @default false
   */
  disabled?: boolean;
  /**
   * One row: the tools, the text and Submit side by side. Once the words no longer fit their line
   * the text takes the card's whole width and the tools and Submit go under it.
   * @default false
   */
  compact?: boolean;
  /** The form's name, said as the person enters it ("Message the assistant"). */
  "aria-label"?: string;
  /** Layout only: where it sits and how wide it is. It stands at most `prompt-input-width` wide. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputHeader takes. */
export interface PromptInputHeaderProps {
  /** What stands above the text: PromptInputAttachments, a notice. Takes no room while empty. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputBody takes. */
export interface PromptInputBodyProps {
  /**
   * A PromptInputTextarea; or, in its place for a while, a question or a dictation of the
   * product's. Focus goes to its first control as it comes, and back to the text as it goes.
   */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputTextarea takes. */
export interface PromptInputTextareaProps {
  /** Its name, for a screen reader and an agent ("Message"). */
  "aria-label"?: string;
  /** The id of the element that names it, in place of `aria-label`. */
  "aria-labelledby"?: string;
  /** An example of what to write, shown while it is empty ("Ask anything"). */
  placeholder?: string;
  /**
   * Takes focus as it appears.
   * @default false
   */
  autoFocus?: boolean;
  /** Runs on each key, after the editor's own handling: Enter, the arrows and Backspace are its. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** The editor's element, to focus it or measure it. */
  ref?: Ref<HTMLDivElement>;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputFooter takes. */
export interface PromptInputFooterProps {
  /** A PromptInputTools at the start and a PromptInputSubmit at the end. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputTools takes. */
export interface PromptInputToolsProps {
  /** The tools before Submit: the action menu, a model selector, the speech button. */
  children: ReactNode;
  /**
   * Which end of the footer they stand at: `start`, a space-1 apart (the action menu, the model);
   * `end`, at the footer's end a space-2 apart, Submit among them last (the model, the speech
   * button, Submit).
   * @default "start"
   */
  align?: "start" | "end";
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputButton takes. */
export interface PromptInputButtonProps {
  /** An `<Icon />`, with words beside it or alone. */
  children: ReactNode;
  /** Its name, when it is an icon alone ("Search the web"). Without it the words name it. */
  "aria-label"?: string;
  /** A few words that add to its name, in a tooltip. */
  tooltip?: ReactNode;
  /** On or off, for a tool that stays on ("Search the web" while it searches); said as pressed. */
  pressed?: boolean;
  /** What a press does. Return a Promise and an agent waits for it. */
  onClick?: () => unknown;
  /**
   * Out of use. A disabled PromptInput turns its tools off too.
   * @default false
   */
  disabled?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputSubmit takes. */
export interface PromptInputSubmitProps {
  /**
   * Where the answer is, when this Submit says it apart from its PromptInput.
   * @default the PromptInput's `status`
   */
  status?: Status;
  /**
   * Stops the answer while it is `submitted` or `streaming`: Submit is Stop then. Without it, Submit
   * is out of use until the answer is in.
   */
  onStop?: () => unknown;
  /** Its name, in place of `promptInput.submit` ("Send") or `promptInput.stop` ("Stop"). */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputActionMenu takes: DropdownMenu's. */
export type PromptInputActionMenuProps = DropdownMenuProps;

/** Every prop a PromptInputActionMenuTrigger takes. */
export interface PromptInputActionMenuTriggerProps {
  /**
   * The icon.
   * @default a plus
   */
  children?: ReactNode;
  /** Its name, in place of `promptInput.add` ("Add to message"). */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputActionMenuContent takes: DropdownMenuContent's. */
export type PromptInputActionMenuContentProps = DropdownMenuContentProps;

/** Every prop a PromptInputActionMenuItem takes: DropdownMenuItem's. */
export type PromptInputActionMenuItemProps = DropdownMenuItemProps;

/** Every prop a PromptInputActionAddAttachments takes. */
export interface PromptInputActionAddAttachmentsProps {
  /** Its words, in place of `promptInput.addAttachments` ("Add files"). */
  children?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** A file attached to the message: what an Attachment shows of it, and the file itself. */
export interface PromptInputFile {
  /** Its own key, kept while it is there. */
  id: string;
  /** Its name, as the person knows it ("brief.pdf"). */
  name: string;
  /** Its size in bytes, shown as people say it ("1.4 MB"). */
  size: number;
  /** Its media type ("image/png", "application/pdf"): it chooses the mark a file without a picture wears. */
  type?: string;
  /** The address of a picture of it: an image's own, or a video's. */
  preview?: string;
  /** The file, as picked, pasted or dropped. */
  file: File;
}

/** Every prop a PromptInputAttachments takes. */
export interface PromptInputAttachmentsProps {
  /**
   * How each file shows.
   * @default a PromptInputAttachment
   */
  children?: (file: PromptInputFile) => ReactNode;
  /** The list's name, in place of `promptInput.attachments` ("Files to send"). */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputAttachment takes. */
export interface PromptInputAttachmentProps {
  /** The file, as PromptInputAttachments or `usePromptInputAttachments()` hands it. */
  data: PromptInputFile;
  /**
   * Where the file is on its way, when the product uploads it as it is attached: Attachment's
   * `state`. While it is `uploading`, `processing` or `error` the message cannot be sent: the
   * file is not there yet, or never will be, and its remove action takes it off.
   * @default "done"
   */
  state?: AttachmentState;
  /**
   * The line under its name, in place of its size: how far it is ("Uploading 40%"), or why it was
   * refused ("Larger than 20 MB"), which is said once as `state` comes to `error`.
   * @default its size
   */
  description?: string;
  /**
   * Its parts: AttachmentMedia, AttachmentContent and AttachmentActions, in place of its own;
   * keep a remove action among them in every state.
   * @default its picture or mark, its name and the line under it, and a remove action
   */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputBanner takes. */
export interface PromptInputBannerProps {
  /** The notice, in one short line ("You have used this month's questions"). */
  children: ReactNode;
  /**
   * The mark before the words, or `false` for none.
   * @default the variant's
   */
  icon?: IconData | false;
  /**
   * What it means: `default` a plain note (what the prompt is about), read where it stands and
   * never said as it appears, and it describes the text; `warning` or `destructive` when it stops
   * work, said at once as it appears. The strip is the same quiet one for each: the mark takes the
   * colour.
   * @default "default"
   */
  variant?: "default" | "warning" | "destructive";
  /** One action at the end, such as a small Button ("See usage"). On a narrow card it stands under the words. */
  action?: ReactNode;
  /**
   * Shows a close button at the end, named by the I18nProvider (`alert.close`), and runs as it
   * is pressed: the product takes the banner away, and focus goes to the text.
   */
  onClose?: () => void;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputQueue takes. */
export interface PromptInputQueueProps {
  /** Its PromptInputQueueTrigger, then its PromptInputQueueContent. */
  children: ReactNode;
  /**
   * Whether it starts open.
   * @default true
   */
  defaultOpen?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputQueueTrigger takes. */
export interface PromptInputQueueTriggerProps {
  /** The words on its fold, with the count ("2 queued"). */
  children: ReactNode;
}

/** Every prop a PromptInputQueueContent takes. */
export interface PromptInputQueueContentProps {
  /** Its PromptInputQueueItems: the messages written while an answer was still coming, the next one first. */
  children: ReactNode;
}

/** Every prop a PromptInputQueueItem takes. */
export interface PromptInputQueueItemProps {
  /** The message, as written. */
  children: ReactNode;
  /**
   * Its actions at the row's end, each a PromptInputButton named from the message ("Edit: …",
   * "Send now: …", "Remove: …").
   */
  actions?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputNote takes. */
export interface PromptInputNoteProps {
  /**
   * A quiet line on the band under the card: what the assistant is doing (an `<AgentIndicator />`
   * and a `<Shimmer>` of words), or a note. With nothing to say, and no failed send, there is no
   * band.
   */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** One item a mention menu suggests. */
export interface PromptInputMentionData {
  /** What it stands for: the token's value, and its key in the menu. */
  value: string;
  /** Its name, shown, matched by typing and written as the token's label. */
  label: string;
  /** A quiet line after its name ("Design lead"). */
  description?: string;
  /** A mark before its name. */
  icon?: IconData;
  /** The heading it stands under; items of one group stand together, in the order given. */
  group?: string;
  /** More words typing finds it by. */
  keywords?: string[];
  /** Shown, but cannot be picked. */
  disabled?: boolean;
}

/** The token a picked item becomes. */
interface MentionToken {
  /** Its kind. @default the trigger's `type` */
  type?: string;
  value: string;
  label: string;
  /** What the token keeps for its own use; never written into the text. */
  data?: Record<string, unknown>;
}

/** One character (or more) that opens a menu, and what that menu suggests. */
export interface PromptInputMentionTrigger {
  /** What opens it: `"@"`, `"/"`, `"#"`. */
  char: string;
  /**
   * Where it may start: `word` after a space or at the start, `line` only at a line's start (for
   * commands), `start` only at the very start, `anywhere`.
   * @default "word"
   */
  boundary?: TriggerBoundary;
  /** The kind of token a picked item becomes ("person", "file", "command"). */
  type: string;
  /**
   * What a token of this trigger says after its label, for a screen reader ("person").
   * @default `type`
   */
  description?: string;
  /**
   * The items, or a loader given what was typed after the character and an AbortSignal; a newer
   * query aborts the older load. Items given as a list are filtered as the person types; loaded
   * ones are the loader's to filter. With `kinds`, the loader is also told the kind the person
   * went into (`context.kind`, its `value`), to load only that.
   */
  items:
    | readonly PromptInputMentionData[]
    | ((
        query: string,
        context: { signal: AbortSignal; kind?: string }
      ) =>
        | Promise<readonly PromptInputMentionData[]>
        | readonly PromptInputMentionData[]);
  /**
   * The kinds of thing it suggests ("People", "Files"), as a first level: while nothing is typed
   * the menu lists these, each with its name, a quiet line and a mark, and picking one lists the
   * items whose `group` is its `label`. Typing at the first level searches every kind at once.
   */
  kinds?: readonly PromptInputMentionData[];
  /**
   * Makes the token a picked item becomes.
   * @default the item's value and label, of the trigger's type
   */
  toToken?: (item: PromptInputMentionData) => MentionToken;
}

/** Every prop a PromptInputMention takes. */
export interface PromptInputMentionProps {
  /** The characters that open a menu, with each one's items and tokens. */
  triggers: readonly PromptInputMentionTrigger[];
  /**
   * Runs as an item is picked, with the trigger it came from. Return a Promise and its token waits,
   * marked as pending, until it settles; it goes again if it rejects.
   */
  onSelect?: (
    item: PromptInputMentionData,
    trigger: string
  ) => void | Promise<void>;
  /** How an item shows in the menu, in place of its icon, name and description. */
  renderItem?: (item: PromptInputMentionData) => ReactNode;
  /**
   * The menu, when it needs its own: a PromptInputMentionContent.
   * @default a PromptInputMentionContent
   */
  children?: ReactNode;
}

/** Every prop a PromptInputMentionContent takes. */
export interface PromptInputMentionContentProps {
  /**
   * Rows of your own, as PromptInputMentionItems, drawn in place of the rows of the trigger's
   * `items` (which every trigger has), and a PromptInputMentionEmpty for what it says while nothing
   * matches. Without rows it draws the trigger's items.
   */
  children?: ReactNode;
  /**
   * The words when the items could not be loaded.
   * @default `promptInput.mentionsError`
   */
  errorText?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputMentionEmpty takes. */
export interface PromptInputMentionEmptyProps {
  /**
   * The words while nothing matches.
   * @default `promptInput.mentionEmpty`
   */
  children?: ReactNode;
}

/** Every prop a PromptInputMentionItem takes. */
export interface PromptInputMentionItemProps {
  /** What it stands for. */
  value: string;
  /** Its name, matched by typing and written as the token's label. */
  label: string;
  /** A quiet line after its name. */
  description?: string;
  /** A mark before its name. */
  icon?: IconData;
  /**
   * Shown, but cannot be picked.
   * @default false
   */
  disabled?: boolean;
  /**
   * What shows, in place of its name and description.
   * @default its name and description
   */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputSpeechButton takes. */
export interface PromptInputSpeechButtonProps {
  /** Listening now. Pass it with `onListeningChange` to keep it in state. */
  listening?: boolean;
  /**
   * The product is writing down what it heard, after Done: the bar stays for that moment, its
   * field drains to its middle, and "Writing it down" is said once.
   * @default false
   */
  settling?: boolean;
  /**
   * Runs as a press turns listening on or off. The product listens, and writes the words through
   * the PromptInput's `controller`.
   */
  onListeningChange?: (listening: boolean) => void;
  /**
   * Runs as Cancel is pressed, before `onListeningChange(false)`: the product takes out what it
   * wrote. Done only stops listening.
   */
  onCancel?: () => void;
  /** The microphone is off for a moment. Pass it with `onMutedChange` to keep it in state. */
  muted?: boolean;
  /** Runs as the bar's microphone turns it off or on again. */
  onMutedChange?: (muted: boolean) => void;
  /**
   * How loud the voice is now, from 0 to 1, as the product reads it from its microphone many
   * times a second: the bar's field of light swells with it.
   * @default 0
   */
  level?: number;
  /**
   * The sound now, read at each frame in place of `level`, with no render: its `level` from 0 to
   * 1 and, for more, its energy in `bands` from low to high.
   */
  sample?: () => VoiceReading | undefined;
  /**
   * The words heard but not yet final, shown lighter after the text until the product writes
   * them through the `controller`. Not part of the message.
   */
  interim?: string;
  /** Its name, in place of `promptInput.speechButton.label` ("Dictate"). */
  "aria-label"?: string;
  /**
   * Out of use.
   * @default false
   */
  disabled?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PromptInputVoice takes. */
export interface PromptInputVoiceProps {
  /**
   * Whose turn it is, said once as it starts: the person's, or the other voice's.
   * @default "listening"
   */
  status?: "listening" | "speaking";
  /** The words of this turn so far. */
  children?: ReactNode;
  /** The words heard but not yet final, shown lighter after them. */
  interim?: string;
  /**
   * How loud the voice of this turn is now, from 0 to 1: the field swells with it.
   * @default 0
   */
  level?: number;
  /**
   * The sound now, read at each frame in place of `level`, with no render: its `level` from 0 to
   * 1 and, for more, its energy in `bands` from low to high.
   */
  sample?: () => VoiceReading | undefined;
  /** A quiet line under the words while the voice goes on, said once; the field thins. */
  note?: string;
  /** The other voice's mark, in the time's place while it speaks. */
  speaker?: ReactNode;
  /** The microphone is off for a moment. Pair it with `onMutedChange`. */
  muted?: boolean;
  /** Runs as the microphone button turns it off or on again. */
  onMutedChange?: (muted: boolean) => void;
  /** Runs as the close button is pressed, or Escape: the product draws the text again. */
  onClose: () => void;
  /** Its name, in place of `promptInput.voice.label` ("Voice conversation"). */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

// ---- The look ------------------------------------------------------------------------------------

const FORCED = media.forcedColors;
const REDUCED = media.reducedMotion;
const TYPING = media.maxSmOrCoarse;
const COARSE = media.pointerCoarse;
// A footer too narrow to keep the count beside Submit: under 30rem. A container query cannot read
// a variable, so the width is written here.
const NARROW = "@container prompt-input (width < 30rem)";
// Inside an Alert, where its action stands beside its words: its body 24rem wide or more. For the
// banner's own box that is the form at 26.5rem (the body and the strip's insets).
const WIDE = "@container (width >= 24rem)";
const BANNER_WIDE = "@container prompt-input (width >= 26.5rem)";
// How bright the light over the card is while a voice is heard, set on the light at each frame.
const LISTEN = "--prompt-input-listen";
// Which way the working light travels: with the reading direction.
const WAY = "--prompt-input-light-way";

const spin = stylex.keyframes({ to: { transform: "rotate(360deg)" } });
// Success: the halo gathers and fades, once.
const glow = stylex.keyframes({
  "0%": { opacity: 0 },
  "20%": { opacity: 1 },
  "100%": { opacity: 0 },
});
// A heard word resolves out of the system's pixels: seen through the grid, then whole.
const resolve = stylex.keyframes({
  "0%": { opacity: 0, maskImage: pixel.mask, maskSize: "3px 3px" },
  "60%": { opacity: 1, maskImage: pixel.mask, maskSize: "3px 3px" },
  "100%": { opacity: 1, maskImage: "none" },
});
// With reduced motion the halo stands still for its moment and is gone: a mark, no movement.
const stay = stylex.keyframes({
  "0%": { opacity: 1 },
  "99%": { opacity: 1 },
  "100%": { opacity: 0 },
});
// A beam's strip slides by half its width, where its light starts over: a loop with no seam.
const travel = stylex.keyframes({
  from: { transform: "translateX(0)" },
  to: { transform: `translateX(calc(-50% * var(${WAY}, 1)))` },
});

const styles = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    width: "100%",
    maxWidth: size.promptInputWidth,
    minWidth: 0,
    margin: 0,
    containerType: "inline-size",
    containerName: "prompt-input",
    fontFamily: font.sans,
  },
  // The card and its light share this box: the light under the card, and both over the band that
  // is tucked under the card's foot.
  stack: {
    position: "relative",
    zIndex: 1,
    isolation: "isolate",
    minWidth: 0,
  },
  // What stands above the card (a banner, the queue): over the light, under the card, which
  // tucks over its foot so the two read as one piece.
  above: {
    position: "relative",
    zIndex: 1,
  },
  // The card's own box, which the light and the halo are placed against, with the card's corner
  // so the halo rings its rounded shape. No stacking context of its own: the light, what stands
  // above the card and the card share the stack's.
  room: {
    position: "relative",
    borderRadius: radius.promptInputRadius,
    cornerShape: radius.shape,
  },
  // The working light, behind the card so only what reaches past its top edge shows: three soft
  // beams travelling along the edge at three speeds, light moving and never a spinner. Its layer
  // reaches past the card's top and foot, not its sides, so it never widens the page. Only
  // transform and opacity move. With reduced motion the beams stand still and the light comes and
  // goes without a fade; in forced colours there is none, and Stop says the answer comes.
  light: {
    position: "absolute",
    insetBlock: `calc(-1 * ${space["8"]})`,
    insetInline: 0,
    zIndex: 0,
    display: { default: "block", [FORCED]: "none" },
    opacity: 0,
    pointerEvents: "none",
    transitionProperty: "opacity",
    transitionDuration: {
      default: duration.promptInputLightIn,
      [REDUCED]: "0s",
    },
    transitionTimingFunction: duration.ease,
  },
  lightOn: { opacity: size.promptInputLightOpacity },
  // While a voice is heard: the same light seen through the system's pixels, its ends faded, as
  // bright as the voice is loud (the field sets LISTEN at each frame), and never travelling.
  lightListening: {
    opacity: `var(${LISTEN}, 0.2)`,
    transitionDuration: "0s",
  },
  // The dithered edge: the working light seen through the system's pixels, as while a voice is
  // heard, its ends faded so the pixels never stop on a hard line; through the pixels it is drawn
  // at full strength, as the original's.
  lightDither: {
    maskImage: `${pixel.mask}, linear-gradient(90deg, transparent, #000 ${space["8"]}, #000 calc(100% - ${space["8"]}), transparent)`,
    maskSize: "3px 3px, 100% 100%",
    maskRepeat: "repeat, no-repeat",
    maskComposite: "intersect",
  },
  lightDitherOn: { opacity: 1 },
  // The card's own box inside the layer: the beams are placed against it.
  lightFrame: {
    position: "absolute",
    insetBlock: space["8"],
    insetInline: 0,
  },
  // A beam's room, centred just inside the top edge so about half its glow shows above the card.
  // It clips its moving strip, then blurs, so the glow spreads past the room, softly.
  beam: {
    position: "absolute",
    top: space["1"],
    overflow: "hidden",
    // A pill, not an ellipse: the light is as strong at the card's ends as at its middle, and its
    // glow reaches past them.
    borderRadius: radius.full,
    transform: "translateY(-50%)",
  },
  beamWide: {
    insetInline: space["1"],
    height: space["3"],
    filter: `blur(${space["3"]})`,
  },
  beamMid: {
    insetInlineStart: "8%",
    insetInlineEnd: "12%",
    height: space["4"],
    filter: `blur(calc(${space["3"]} - ${space["1"]} / 2))`,
  },
  beamTight: {
    insetInlineStart: "38%",
    insetInlineEnd: "7%",
    height: space["2"],
    filter: `blur(${space["2"]})`,
  },
  // The strip: twice the room, its light repeating once across it.
  strip: {
    [WAY]: { default: "1", ":dir(rtl)": "-1" },
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    width: "200%",
    backgroundImage: colors.promptInputLight,
    backgroundSize: "50% 100%",
    backgroundRepeat: "repeat-x",
    animationName: { default: travel, [REDUCED]: "none" },
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationPlayState: "paused",
  },
  // In one accent colour, the colour set on the light's layer.
  stripTint: { backgroundImage: colors.promptInputTint },
  stripRunning: { animationPlayState: "running", willChange: "transform" },
  stripWide: { animationDuration: duration.promptInputBeam },
  stripMid: {
    animationDuration: duration.promptInputBeamFast,
    animationDelay: `calc(-1 * ${duration.promptInputBeamFast} / 3)`,
  },
  stripTight: {
    animationDuration: duration.promptInputBeamSlow,
    animationDelay: `calc(-1 * ${duration.promptInputBeamSlow} / 2)`,
  },
  // Success: one soft halo round the card, in the accent, gathering and fading once. With reduced
  // motion it stands still for that moment; in forced colours there is none: the words say it is
  // done.
  halo: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    display: { default: "block", [FORCED]: "none" },
    borderRadius: "inherit",
    cornerShape: radius.shape,
    boxShadow: shadow.promptInputHalo,
    opacity: 0,
    pointerEvents: "none",
    animationName: { default: glow, [REDUCED]: stay },
    animationDuration: duration.promptInputHaloTime,
    animationTimingFunction: {
      default: duration.easeInOut,
      [REDUCED]: "linear",
    },
    animationFillMode: "forwards",
  },
  mint: { color: colors.mint },
  lavender: { color: colors.lavender },
  info: { color: colors.info },
  warning: { color: colors.warning },
  destructive: { color: colors.destructive },
  // The card: text over the footer, the one corner of the prompt input, at medium lift. Its parts
  // keep their own insets (the text 16px, the footer's buttons 8px, which the card's corner nests
  // round). While the text has focus the edge goes a step stronger with a faint halo: no ring, the
  // caret says where the words go.
  card: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    zIndex: 1,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    boxSizing: "border-box",
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: { default: 0, [FORCED]: size.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: radius.promptInputRadius,
    cornerShape: radius.shape,
    backgroundColor: { default: colors.card, ":disabled": colors.muted },
    boxShadow: {
      default: shadow.md,
      ":has([contenteditable=true]:focus)": `inset 0 0 0 ${size.hairline} ${colors.promptInputBorderFocus}, 0 0 0 3px ${colors.inputFocusHalo}, ${shadow.md}`,
    },
    color: colors.foreground,
    cursor: { default: "text", ":disabled": "not-allowed" },
    // In forced colours, where the edge and halo drop, the system's highlight rings the card.
    outline: {
      default: "none",
      [FORCED]: {
        default: "none",
        ":has([contenteditable=true]:focus)": `${size.lineStrong} solid Highlight`,
      },
    },
    transitionProperty: "box-shadow, background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // Over what scrolls behind it: the card's colour most of the way, over a blur.
  glass: {
    backgroundColor: {
      default: colors.promptInputGlass,
      ":disabled": colors.muted,
    },
    backdropFilter: size.promptInputGlassBlur,
  },
  // One row: the tools, the text and Submit, 12px in from the card's edge, so the row of 32px
  // controls is 56px tall. The rows are named, so the text can take the whole width over a foot
  // row of the tools and Submit (compactTall) with nothing moved in the page.
  compact: {
    // The row answers to its own width: on a phone's, a model chip's level folds to the maker's
    // mark (model-selector.tsx).
    containerType: "inline-size",
    containerName: "prompt-input-row",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    gridTemplateAreas: '"header header header" "start field end"',
    alignItems: "center",
    columnGap: space["2"],
    padding: space["3"],
  },
  // The words no longer fit their line: the text takes the row, the tools and Submit go under it.
  compactTall: {
    gridTemplateAreas:
      '"header header header" "field field field" "start . end"',
  },
  // A file is dragged over the page: the card is a target, tinted in mint, its words say what a
  // drop does. Over the card itself the tint and the edge go a step stronger.
  dragging: {
    backgroundColor: `color-mix(in oklch, ${colors.mint} 8%, ${colors.card})`,
    boxShadow: `inset 0 0 0 ${size.lineStrong} color-mix(in oklch, ${colors.mint} 60%, transparent), ${shadow.sm}`,
  },
  over: {
    backgroundColor: `color-mix(in oklch, ${colors.mint} 16%, ${colors.card})`,
    boxShadow: `inset 0 0 0 ${size.lineStrong} ${colors.mint}, ${shadow.md}`,
  },
  // The card's own tint over the text and the footer, so the words stand alone; the files stay in
  // sight above it.
  drop: {
    position: "absolute",
    inset: 0,
    zIndex: 1,
    display: "grid",
    placeItems: "center",
    borderRadius: "inherit",
    backgroundColor: "inherit",
    color: colors.foreground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    pointerEvents: "none",
  },
  header: {
    display: { default: "flex", ":empty": "none" },
    flexWrap: "wrap",
    gap: space["2"],
    minWidth: 0,
    paddingInline: space["4"],
    paddingBlockStart: space["4"],
  },
  // In one row the card's 12px is already round the header, which keeps its own inset.
  compactHeader: {
    gridArea: "header",
    marginInline: `calc(-1 * ${space["3"]})`,
    marginBlockStart: `calc(-1 * ${space["3"]})`,
    marginBlockEnd: space["1"],
  },
  // The files take the header's whole line, their cards 16px from the card's top and side (the
  // row keeps 4px of its own round them for a focus ring), so a row with more files than room
  // fades out 16px in from the card's edge; and the text stands 12px under them: the text's own
  // top room is for a card with no files, so the row takes it back. Above the drop words, and
  // above the text's top room its foot lies over, so a press there is the file's.
  attachments: {
    position: "relative",
    zIndex: 2,
    flexBasis: `calc(100% + 2 * ${space["1"]})`,
    flexShrink: 0,
    minWidth: 0,
    marginInline: `calc(-1 * ${space["1"]})`,
    marginBlockStart: `calc(-1 * ${space["1"]})`,
    marginBlockEnd: `calc(${space["3"]} - ${space["1"]} - ${space["4"]})`,
  },
  body: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
  },
  // The text never gives in the row: with less room than its least, the card goes tall. At rest
  // the placeholder gives instead, cut with an ellipsis, so the row stays one line.
  compactBody: {
    gridArea: "field",
    minWidth: {
      default: size.promptInputFieldMin,
      ":has([data-empty])": 0,
    },
  },
  // Tall, the words stand over the foot row where they stood in the row.
  compactBodyTall: {
    paddingBlockStart: space["1"],
    paddingBlockEnd: space["2"],
  },
  // The text: one line at rest, grows with its lines to prompt-input-height, then scrolls inside.
  editor: {
    display: "block",
    boxSizing: "border-box",
    minWidth: 0,
    // A finger needs 44px: on a touch screen the text is never shorter.
    minHeight: { default: 0, [COARSE]: size.tapTarget },
    maxHeight: size.promptInputHeight,
    overflowY: "auto",
    margin: 0,
    paddingInline: space["4"],
    paddingBlockStart: space["4"],
    paddingBlockEnd: 0,
    color: colors.foreground,
    caretColor: colors.foreground,
    // 16px on a phone or a touch screen, or Safari zooms the page in when the text takes focus.
    fontSize: { default: size.messageText, [TYPING]: size.inputTextTouch },
    lineHeight: size.messageTextLine,
    textAlign: "start",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    outline: "none",
    "::selection": {
      backgroundColor: colors.inputSelection,
      color: colors.foreground,
    },
  },
  compactEditor: {
    paddingInline: space["1"],
    paddingBlockStart: 0,
  },
  placeholder: {
    "::before": {
      content: "attr(aria-placeholder)",
      color: colors.mutedForeground,
      pointerEvents: "none",
    },
  },
  // While a dictation listens, the words that were there before it step back (the form marks
  // them, `useTypedQuiet`); what the dictation settles is ink.
  typedQuiet: {
    "::highlight(prompt-input-typed)": { color: colors.mutedForeground },
  },
  // What a dictation has heard but not yet settled on: lighter, after the words, never part of
  // them, and after it the mark of where the next word lands.
  interim: {
    "::after": {
      content: "' ' attr(data-interim)",
      paddingInlineEnd: "1px",
      borderInlineEndWidth: "2px",
      borderInlineEndStyle: "solid",
      borderInlineEndColor: colors.foreground,
      color: `color-mix(in oklch, ${colors.mutedForeground} 60%, transparent)`,
    },
  },
  // The resting row is one line at every width: a placeholder too long for it ends in an ellipsis.
  compactPlaceholder: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // A token in the text: its label on a quiet ground, a cross under a pointer.
  token: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: space["1"],
    marginInline: "1px",
    paddingInline: space["1"],
    borderRadius: `calc(${radius.xl} / 2)`,
    cornerShape: radius.shape,
    backgroundColor: colors.muted,
    boxShadow: size.borderStrong,
    color: colors.foreground,
    fontWeight: font.weightMedium,
    whiteSpace: "nowrap",
    outline: { default: "none", [FORCED]: `${size.hairline} solid` },
  },
  tokenSelected: {
    backgroundColor: colors.inputSelection,
  },
  tokenPending: {
    opacity: size.opacityDisabled,
  },
  tokenRemove: {
    display: "inline-flex",
    alignSelf: "center",
    color: colors.mutedForeground,
    cursor: "pointer",
    opacity: {
      default: 1,
      [media.hover]: {
        default: 0,
        [stylex.when.ancestor(":hover")]: 1,
      },
    },
  },
  // The footer stands 24px under the text, its buttons 8px from the card's sides and foot.
  footer: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["2"],
    minWidth: 0,
    marginBlockStart: space["6"],
    paddingInline: space["2"],
    paddingBlockEnd: space["2"],
  },
  // In one row the footer gives its tools and Submit to the card's own columns.
  compactFooter: { display: "contents" },
  // What the footer holds, given straight to its row; away while a dictation's bar stands there.
  through: { display: "contents" },
  away: { display: "none" },
  tools: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["1"],
    minWidth: 0,
  },
  compactTools: { gridArea: "start" },
  // The tools at the footer's end, with Submit: a space-2 apart, as the original's end side.
  toolsEnd: { gap: space["2"], marginInlineStart: "auto" },
  compactToolsEnd: { gridArea: "end", justifySelf: "end" },
  end: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
    marginInlineStart: "auto",
  },
  compactEnd: { gridArea: "end", justifySelf: "end" },
  count: {
    paddingInline: space["1"],
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  // On a narrow footer the count takes no room from the row: it stands above Submit.
  countAbove: {
    position: { default: "static", [NARROW]: "absolute" },
    insetInlineEnd: { default: null, [NARROW]: 0 },
    bottom: { default: null, [NARROW]: "100%" },
  },
  // At the limit the count goes from quiet to ink: nothing is wrong, there is no more room.
  countAt: { color: colors.foreground },
  // The band under the card, tucked under its foot: its lines say what the assistant is doing, or
  // that the send failed. Nothing in it, no band.
  under: {
    display: { default: "grid", ":empty": "none" },
    gap: space["1"],
    marginBlockStart: `calc(-1 * ${radius.promptInputRadius})`,
    marginInline: space["2"],
    paddingInline: space["4"],
    paddingBlockStart: `calc(${radius.promptInputRadius} + ${space["2"]})`,
    paddingBlockEnd: space["2"],
    borderEndStartRadius: radius.promptInputRadius,
    borderEndEndRadius: radius.promptInputRadius,
    cornerShape: radius.shape,
    backgroundColor: colors.muted,
    boxShadow: size.borderStrong,
    // Forced colours drop the fill and the shadow: a real line draws the band.
    outline: { default: "none", [FORCED]: `${size.hairline} solid CanvasText` },
  },
  note: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space["1"],
    margin: 0,
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    textAlign: "center",
    overflowWrap: "anywhere",
  },
  noteFailed: { color: colors.destructive },
  // A banner above the card: the quiet strip, in from the card's sides so its side lies inside the
  // card's rounded corner, its foot behind the card's top so the two read as one piece. An Alert
  // stands in it without a fill of its own: what the notice means is in its mark's colour, and in
  // how the Alert says it. In from its sides by the card's text inset less its own, so the mark
  // starts where the card's words and its first tool do.
  banner: {
    position: "relative",
    zIndex: 1,
    marginInline: space["2"],
    marginBlockEnd: `calc(-1 * ${radius.xl})`,
    paddingBlockStart: space["3"],
    paddingInline: `calc(${space["4"]} - ${space["2"]})`,
    // Room for the card's corner to lie over its foot.
    paddingBlockEnd: `calc(${space["3"]} + ${radius.xl})`,
    borderStartStartRadius: radius.xl,
    borderStartEndRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.muted,
    boxShadow: size.borderStrong,
    // Forced colours drop the fill and the shadow: a real line draws the strip.
    outline: { default: "none", [FORCED]: `${size.hairline} solid CanvasText` },
  },
  // The mark and the words, a space-2 apart.
  bannerLine: {
    display: "flex",
    alignItems: "flex-start",
    gap: space["2"],
    minWidth: 0,
  },
  // Level with the action's button, or the close button, where one stands beside them; with
  // neither, no room is kept, so a note alone is as tall as its line.
  bannerLineBesideAction: {
    marginBlockStart: {
      default: 0,
      [WIDE]: `calc((${size.controlSm} - ${font.textSmLine}) / 2)`,
    },
  },
  // Room at the words' end for the close button, which stands in the strip's corner.
  bannerLineClosable: {
    paddingInlineEnd: { default: size.controlXs, [WIDE]: 0 },
  },
  bannerMark: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    flexShrink: 0,
    marginBlockStart: `calc((${font.textSmLine} - ${size.iconSm}) / 2)`,
    color: colors.mutedForeground,
  },
  bannerWords: { minWidth: 0 },
  // The action: at the row's top beside the words, and under them where they start, past the mark.
  bannerAction: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: space["2"],
    marginInlineStart: {
      default: `calc(${size.iconSm} + ${space["2"]})`,
      [WIDE]: 0,
    },
  },
  bannerActionClosable: {
    marginInlineEnd: { default: 0, [WIDE]: size.controlXs },
  },
  // The close button, in the strip's end corner.
  bannerClose: {
    position: "absolute",
    top: { default: space["2"], [BANNER_WIDE]: `calc(${space["3"]} + 2px)` },
    insetInlineEnd: space["1"],
    display: "flex",
  },
  // The queue's panel above the card: raised as the card is, its rows starting where the card's
  // words do, their actions ending where Submit ends, its foot behind the card.
  queue: {
    marginInline: space["2"],
    marginBlockEnd: `calc(-1 * ${radius.promptInputRadius})`,
    paddingInlineStart: `calc(${space["4"]} - ${space["2"]})`,
    paddingBlockStart: space["1"],
    paddingBlockEnd: radius.promptInputRadius,
    borderStartStartRadius: radius.xl,
    borderStartEndRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
    // Forced colours drop the fill and the shadow: a real line draws the panel.
    outline: { default: "none", [FORCED]: `${size.hairline} solid CanvasText` },
  },
  queueList: {
    display: "grid",
    gap: space["1"],
    margin: 0,
    padding: 0,
    paddingBlockEnd: space["2"],
    listStyle: "none",
  },
  queueItem: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    minWidth: 0,
  },
  queueText: {
    flexGrow: 1,
    minWidth: 0,
    color: colors.foreground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    overflowWrap: "anywhere",
  },
  queueActions: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    gap: space["1"],
  },
  // While the page loads: a part kept in its room but not drawn, and the text's quiet line.
  kept: { display: "inline-flex", opacity: 0 },
  pending: { position: "relative", minWidth: 0 },
  pendingLine: {
    position: "absolute",
    insetInlineStart: space["4"],
    insetInlineEnd: 0,
    top: space["4"],
    display: "flex",
    pointerEvents: "none",
  },
  // In one row the line stands on the row's centre line.
  compactPendingLine: {
    insetInlineStart: space["1"],
    top: "50%",
    transform: "translateY(-50%)",
  },
  pendingWidth: { display: "grid", width: "min(12rem, 60%)" },
  spinner: {
    display: "inline-flex",
    animationName: { default: spin, [REDUCED]: "none" },
    animationDuration: duration.spin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  // A dictation's bar, in the footer's place while it listens: Cancel, the time, the voice's level
  // as a field of pixels, the microphone, and Done where Submit stood.
  dictation: {
    display: "flex",
    alignItems: "center",
    flexGrow: 1,
    gap: space["2"],
    minWidth: 0,
  },
  // In one row it is the foot row, under the words.
  compactDictation: {
    gridRow: "start",
    gridColumn: "start-start / end-end",
  },
  time: {
    flexShrink: 0,
    color: colors.foreground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  // The voice's field, on the bar's centre line between the time and the controls: one canvas
  // (prompt-input-voice-field.ts). Its colour is the ink, which the field reads to know the
  // ground it draws on, and draws in where colours are forced.
  level: {
    display: "grid",
    alignItems: "center",
    flexGrow: 1,
    minWidth: 0,
    height: size.controlSm,
    color: { default: colors.foreground, [FORCED]: "CanvasText" },
  },
  canvas: { display: "block", width: "100%", height: size.controlSm },
  // A spoken conversation, in the body's and the footer's place: its two rows are the card's own.
  conversation: { display: "contents" },
  // The words of the turn, where the text's words stand, in the text's size and line.
  spoken: {
    boxSizing: "border-box",
    minWidth: 0,
    maxHeight: size.promptInputHeight,
    overflowY: "auto",
    margin: 0,
    paddingInline: space["4"],
    paddingBlockStart: space["4"],
    color: colors.foreground,
    fontSize: { default: size.messageText, [TYPING]: size.inputTextTouch },
    lineHeight: size.messageTextLine,
    minHeight: `calc(${size.messageTextLine} + ${space["4"]})`,
    overflowWrap: "anywhere",
  },
  spokenInterim: { color: colors.mutedForeground },
  // A word as it is heard: it comes out of the dither, a few pixels of it first, then whole. With
  // reduced motion it is simply there.
  word: {
    animationName: { default: resolve, [REDUCED]: "none" },
    animationDuration: duration.hover,
    animationTimingFunction: "steps(3, end)",
    animationFillMode: "backwards",
  },
  // The words' box, which the note is placed against.
  spokenRoom: { position: "relative", minWidth: 0 },
  // Where the next word lands: a fine upright mark after the words.
  spokenCaret: {
    display: "inline-block",
    width: "2px",
    height: "1em",
    marginInlineStart: "2px",
    borderRadius: radius.full,
    backgroundColor: "currentColor",
    verticalAlign: "text-bottom",
  },
  // A note while the voice goes on: a quiet line in the room between the words and the foot row,
  // which it never grows.
  voiceNote: {
    [iconVars.size]: size.iconSm,
    position: "absolute",
    top: "100%",
    insetInline: space["4"],
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    height: space["6"],
    overflow: "hidden",
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    whiteSpace: "nowrap",
  },
  // The other voice's mark, in the time's place: as wide as a tool, so the field starts where it
  // does beside the time.
  speaker: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    minWidth: size.controlSm,
    height: size.controlSm,
  },
  // The time starts where the words do: there is no Cancel before it.
  voiceTime: { paddingInlineStart: space["2"] },
  // The mention menu: a menu's panel under the caret, items with a mark, a name and a quiet line
  // under it.
  mentionPanel: {
    width: `min(${size.promptInputMentionWidth}, 100vw - 2 * ${space.popupGutter})`,
  },
  mentionList: {
    opacity: { default: 1, ":is([aria-busy=true])": size.opacityDisabled },
    transitionProperty: "opacity",
    transitionDuration: duration.hover,
  },
  // Two lines in a row: the name in the text's size, a quiet line under it, 4px above and below.
  mentionItem: {
    paddingBlock: space["1"],
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
  },
  mentionText: { display: "grid" },
  mentionDescription: {
    color: { default: colors.mutedForeground, [FORCED]: "inherit" },
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightNormal,
  },
  // The chevron at a kind's end; it turns with the reading direction itself (Icon).
  mentionInto: {
    display: "flex",
    marginInlineStart: "auto",
    color: colors.mutedForeground,
  },
  // The menu's words when it has no rows. It stays in the menu, wordless, while there are rows,
  // and takes no room then.
  mentionEmpty: {
    display: { default: "block", ":empty": "none" },
    paddingBlock: space["2"],
    paddingInline: space.menuItemPadding,
    color: colors.mutedForeground,
  },
});

// ---- The form's own state ------------------------------------------------------------------------

interface PromptInputContextValue {
  controller: TokenInputController;
  status: Status;
  disabled: boolean;
  compact: boolean;
  /** Nothing to send: no words and no token. */
  empty: boolean;
  /** The last send failed, and nothing has been typed since. */
  failed: boolean;
  /** The page's data is not there yet: the card stands still. */
  loading: boolean;
  /** In one row, the text has the card's whole width and the tools stand under it. */
  tall: boolean;
  /** A send of the form's own is out: its Promise has not settled. */
  sending: boolean;
  /** A file is on its way or was refused: nothing is sent until it is there or taken off. */
  held: boolean;
  /** Holds the send for one such file (`1`), and lets it go again (`-1`). */
  changeHolds: (by: number) => void;
  /** What a dictation has heard but not settled on, shown lighter after the text. */
  interim: string;
  setInterim: (interim: string) => void;
  /** Counts an outside part as written in the card, or as drawn by the form (development only). */
  changeWritten: (by: number) => void;
  changeDrawn: (by: number) => void;
  /** The id of the band under the card, which describes the text while it says a send failed. */
  noteId: string;
  /** The ids of the plain banners' words above the card, which describe the text. */
  bannerIds: readonly string[];
  /** Adds a plain banner's words to what describes the text (`true`), or takes them off. */
  changeBannerIds: (change: readonly [string, boolean]) => void;
  /** The footer's element, where a dictation's bar is drawn, and what says it is there. */
  footer: HTMLElement | null;
  setFooter: (footer: HTMLElement | null) => void;
  dictating: boolean;
  setDictating: (dictating: boolean) => void;
  /** Tells the light over the card how loud the voice is now, 0 to 1 (at each frame, no render). */
  heardAt: (level: number) => void;
  /** Sets what cancels the dictation that listens now: Escape anywhere in the form runs it. */
  setCancelDictation: (cancel: (() => void) | null) => void;
  /** The text's length now, a token as its label, and the most it may be. */
  length: number;
  maxLength: number | undefined;
  /** Sends what is written now; rejects when the caller's send does. */
  submit: () => Promise<void>;
  /** Opens the file picker, while the form is in use. */
  openFiles: (() => void) | undefined;
  /** The text says it is there, or gone (a takeover in its place). */
  setEditorShown: (shown: boolean) => void;
}

const PromptInputContext = createContext<PromptInputContextValue | null>(null);

/** The form's state, for a part inside it. A part outside one draws as if it were at rest. */
const usePromptInput = () => use(PromptInputContext);

// A part that stands outside the card (a banner or the queue above it, the note under it) is
// written among the card's parts and drawn by the form where it belongs: in the card it draws
// nothing, and the form draws it again above or under, where this says it may. The form finds
// these parts among its own children (through a Fragment or a list, not inside another
// component: a portal would not draw on the server, and the parts are few), as CardHeader finds
// its action.
const OutsideContext = createContext(false);

const isPart = (child: ReactNode, part: unknown) =>
  isValidElement(child) && child.type === part;

/**
 * Whether an outside part is drawn where it belongs (true) or only written in the card (false),
 * and, in development, the count of each kept for the form: one written but never drawn stands
 * inside a component of the caller's, where the form cannot find it.
 */
const useOutside = () => {
  const outside = use(OutsideContext);
  const form = use(PromptInputContext);
  const change = outside ? form?.changeDrawn : form?.changeWritten;
  useEffect(() => {
    if (!isDevelopment || change === undefined) {
      return nothing;
    }
    change(1);
    return () => {
      change(-1);
    };
  }, [change]);
  return outside;
};

/** The files attached to the message, and what changes them. */
interface PromptInputAttachmentsValue {
  /** The files, in the order they came. */
  files: PromptInputFile[];
  /** Attaches files: those `accept` takes. */
  add: (files: readonly File[]) => void;
  /** Takes one off, by its `id`. */
  remove: (id: string) => void;
  /** Takes them all off. */
  clear: () => void;
  /** Opens the file picker. */
  openFileDialog: () => void;
}

const AttachmentsContext = createContext<PromptInputAttachmentsValue | null>(
  null
);

/**
 * The files attached to the PromptInput around it, and what attaches and takes them off, for a part
 * of the product's own (a list of its own look, a button that attaches a screenshot).
 */
export const usePromptInputAttachments = (): PromptInputAttachmentsValue => {
  const attachments = use(AttachmentsContext);
  if (attachments === null) {
    throw new Error("usePromptInputAttachments goes inside a PromptInput.");
  }
  return attachments;
};

/** The tokens of a value, in order. */
const tokensOf = (value: TokenInputValue): Token[] =>
  value.filter((segment): segment is Token => typeof segment !== "string");

/** Whether there are no words to send: no token, and no words but spaces. */
const emptyOf = (value: TokenInputValue) =>
  tokensOf(value).length === 0 && toLabel(value).trim() === "";

/** Says `words` once, until `said` is let go again. */
const sayOnce = (said: { current: boolean }, words: string) => {
  if (!said.current) {
    said.current = true;
    announce(words);
  }
};

/** Runs `send`, and lets `running` go once it is done, however it ends. */
const settle = async (
  running: { current: Promise<void> | null },
  send: () => Promise<void>
) => {
  try {
    await send();
  } finally {
    running.current = null;
  }
};

/** Adds `by` to a count: the reducer of a count its parts change (`change(1)`, then `change(-1)`). */
const countBy = (now: number, by: number) => now + by;
const listBy = (
  now: readonly string[],
  [id, on]: readonly [string, boolean]
): readonly string[] => (on ? [...now, id] : now.filter((each) => each !== id));

/** Says `on(true)` while `send` runs, and `on(false)` once it is done, however it ends. */
const during = async (
  on: (running: boolean) => void,
  send: () => Promise<void>
) => {
  on(true);
  try {
    await send();
  } finally {
    on(false);
  }
};

/** Runs `send` one at a time: a second call while one runs waits for that one, and sends nothing. */
const oneAtATime = async (
  running: { current: Promise<void> | null },
  send: () => Promise<void>
) => {
  running.current ??= settle(running, send);
  await running.current;
};

/** What the live region says of the limit: that a change was cut, that it is reached, or near. */
const limitWords = (
  words: I18nCatalog["promptInput"],
  length: number,
  maxLength: number | undefined,
  cut: boolean
) => {
  if (maxLength === undefined) {
    return "";
  }
  if (cut) {
    return words.cut(maxLength);
  }
  const stage = stageOf(length, maxLength);
  if (stage === "at") {
    return words.reached(maxLength);
  }
  return stage === "near" ? words.near(maxLength) : "";
};

const hasFiles = (transfer: DataTransfer | null) =>
  [...(transfer?.types ?? [])].includes("Files");

/**
 * The card's handlers for files: pasted into the text (before the editor reads the clipboard) or
 * dropped on it, they go to `take`; dragged over it, `setOver` deepens its tint. A paste that
 * holds words as well keeps both: the files are attached and the words go into the text.
 */
const fileHandlers = (
  take: ((files: File[]) => void) | undefined,
  setOver: (over: boolean) => void
) => ({
  onPasteCapture: (event: ClipboardEvent<HTMLFormElement>) => {
    const pasted = [...event.clipboardData.files];
    if (take === undefined || pasted.length === 0) {
      return;
    }
    take(pasted);
    if (event.clipboardData.getData("text/plain") === "") {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  onDragOver: (event: DragEvent<HTMLFormElement>) => {
    if (take === undefined || !hasFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    setOver(true);
  },
  onDragLeave: (event: DragEvent<HTMLFormElement>) => {
    const to = event.relatedTarget;
    if (!(to instanceof Node) || !event.currentTarget.contains(to)) {
      setOver(false);
    }
  },
  onDropCapture: (event: DragEvent<HTMLFormElement>) => {
    const dropped = [...event.dataTransfer.files];
    if (take === undefined || dropped.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    take(dropped);
  },
});

// ---- Files ---------------------------------------------------------------------------------------

/** Whether `accept` ("image/*,.pdf") takes the file; every file, without it. */
const accepts = (file: File, accept: string | undefined) => {
  const kinds = (accept ?? "")
    .split(",")
    .map((kind) => kind.trim().toLowerCase())
    .filter((kind) => kind !== "");
  if (kinds.length === 0) {
    return true;
  }
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return kinds.some((kind) => {
    if (kind.startsWith(".")) {
      return name.endsWith(kind);
    }
    return kind.endsWith("/*")
      ? type.startsWith(kind.slice(0, -1))
      : type === kind;
  });
};

/** A picture of the file to show while it is attached: an image's or a video's own. */
const previewOf = (file: File) =>
  file.type.startsWith("image/") || file.type.startsWith("video/")
    ? URL.createObjectURL(file)
    : undefined;

/** Lets the files' pictures go, as they are taken off. */
const letGo = (files: readonly PromptInputFile[]) => {
  for (const { preview } of files) {
    if (preview !== undefined) {
      URL.revokeObjectURL(preview);
    }
  }
};

/**
 * The attached files: what comes in through the picker, a paste or a drop, and what goes with a
 * send. Each picture is let go as its file is taken off, and all of them as the form goes. A form
 * hidden and shown again (`<Activity>`) goes and comes back with its files: their pictures are made
 * again as it comes back.
 */
const useAttachments = (
  accept: string | undefined,
  picker: { current: HTMLInputElement | null }
) => {
  const prefix = useId();
  const count = useRef(0);
  const [files, setFiles] = useState<PromptInputFile[]>([]);
  // The files as they are now, ahead of the render: two changes before one never read stale files.
  const latest = useRef(files);
  const change = (update: (all: PromptInputFile[]) => PromptInputFile[]) => {
    const now = update(latest.current);
    latest.current = now;
    setFiles(now);
  };
  const hidden = useRef(false);
  useEffect(() => {
    if (hidden.current) {
      hidden.current = false;
      const shown = latest.current.map((attached) => ({
        ...attached,
        preview: previewOf(attached.file),
      }));
      latest.current = shown;
      setFiles(shown);
    }
    return () => {
      hidden.current = true;
      letGo(latest.current);
    };
  }, []);
  const value: PromptInputAttachmentsValue = {
    files,
    add: (added) => {
      const taken = added
        .filter((file) => accepts(file, accept))
        .map((file) => {
          count.current += 1;
          return {
            id: `${prefix}${count.current}`,
            name: file.name,
            size: file.size,
            type: file.type === "" ? undefined : file.type,
            preview: previewOf(file),
            file,
          };
        });
      if (taken.length > 0) {
        change((all) => [...all, ...taken]);
      }
    },
    remove: (id) => {
      letGo(latest.current.filter((file) => file.id === id));
      change((all) => all.filter((file) => file.id !== id));
    },
    clear: () => {
      letGo(latest.current);
      change(() => []);
    },
    openFileDialog: () => {
      picker.current?.click();
    },
  };
  /** The files were sent: they go, and their pictures; any attached while they went stay. */
  const sent = (gone: readonly PromptInputFile[]) => {
    letGo(gone);
    change((all) => all.filter((file) => !gone.includes(file)));
  };
  return { value, sent };
};

/** What a token says after its label to a screen reader: its trigger's word, else its kind. */
const describeToken = (token: Token) => {
  const said = token.data?.description;
  return typeof said === "string" ? said : token.type;
};

/** A token in the text: its label, and a cross that takes it out (Backspace does, for the keys). */
const Chip = () => (
  <TokenInputToken
    render={(props: Record<string, unknown>, state: TokenInputTokenState) => (
      <span
        {...props}
        {...stylex.props(
          styles.token,
          state.selected && styles.tokenSelected,
          state.pending && styles.tokenPending
        )}
      >
        {state.token.label}
        {!(state.disabled || state.readOnly) && (
          <TokenInputTokenRemove {...stylex.props(styles.tokenRemove)}>
            <Icon icon={XIcon} />
          </TokenInputTokenRemove>
        )}
      </span>
    )}
  />
);

/** The focus is in the form, or on the page's body after a press in it (Safari never focuses a button). */
const focusHere = (form: HTMLFormElement | null) =>
  document.activeElement === document.body ||
  (form?.contains(document.activeElement) ?? false);

/** Puts focus on what stands in the text's place: a choice already made, else its first control. */
const focusTakeover = (form: HTMLFormElement | null) => {
  const body = form?.querySelector<HTMLElement>(
    '[data-slot="prompt-input-voice"], [data-slot="prompt-input-body"]'
  );
  (
    body?.querySelector<HTMLElement>("[aria-checked=true]") ??
    body?.querySelector<HTMLElement>(
      "textarea, input, button, [contenteditable=true]"
    )
  )?.focus({ preventScroll: true });
};

/**
 * A file dragged over the page makes the card a target (`setDragging`), until it is dropped or
 * leaves. Dropped anywhere but on the card nothing happens (the browser would otherwise open the
 * file), unless `take` is given (`globalDrop`), which attaches it. Heard as the event goes down,
 * before the card's own drop ends it.
 */
const listenForFileDrags = (
  form: { current: HTMLFormElement | null },
  setDragging: (dragging: boolean) => void,
  setOver: (over: boolean) => void,
  take: ((files: File[]) => void) | undefined
) => {
  let depth = 0;
  const enter = (event: globalThis.DragEvent) => {
    if (hasFiles(event.dataTransfer)) {
      depth += 1;
      setDragging(true);
    }
  };
  const leave = (event: globalThis.DragEvent) => {
    if (!hasFiles(event.dataTransfer)) {
      return;
    }
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      setDragging(false);
    }
  };
  const hold = (event: globalThis.DragEvent) => {
    if (hasFiles(event.dataTransfer)) {
      event.preventDefault();
    }
  };
  const drop = (event: globalThis.DragEvent) => {
    depth = 0;
    setDragging(false);
    setOver(false);
    if (!hasFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    const onCard =
      event.target instanceof Node &&
      form.current?.contains(event.target) === true;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!onCard && files.length > 0) {
      take?.(files);
    }
  };
  window.addEventListener("dragenter", enter, true);
  window.addEventListener("dragleave", leave, true);
  window.addEventListener("dragover", hold);
  window.addEventListener("drop", drop, true);
  return () => {
    window.removeEventListener("dragenter", enter, true);
    window.removeEventListener("dragleave", leave, true);
    window.removeEventListener("dragover", hold);
    window.removeEventListener("drop", drop, true);
  };
};

/**
 * Once a change has drawn: when the caret stands at the end of a text that scrolls, the text
 * scrolls to its end. A line started with Shift+Enter in a full text is empty, and the browser
 * brings no caret into view until a letter is typed there.
 */
const keepCaretInView = (card: HTMLElement | null) => {
  requestAnimationFrame(() => {
    const editor = card?.querySelector<HTMLElement>(
      '[data-slot="prompt-input-textarea"]'
    );
    const caret = getSelection();
    if (
      editor === null ||
      editor === undefined ||
      caret === null ||
      !caret.isCollapsed ||
      caret.focusNode === null ||
      !editor.contains(caret.focusNode)
    ) {
      return;
    }
    const rest = document.createRange();
    rest.selectNodeContents(editor);
    rest.setStart(caret.focusNode, caret.focusOffset);
    if (rest.toString().trim() === "") {
      editor.scrollTop = editor.scrollHeight;
    }
  });
};

// The name the typed words are marked under while a dictation listens (CSS Custom Highlights).
const TYPED = "prompt-input-typed";

/** Where character `at` of `editor`'s text stands, through its tokens too. */
const placeOf = (editor: HTMLElement, at: number): [Node, number] => {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let left = at;
  let last: [Node, number] = [editor, 0];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (left <= length) {
      return [node, left];
    }
    left -= length;
    last = [node, length];
  }
  return last;
};

/**
 * Where a place in a text stands after an edit: `before` and `after` are the text on either side
 * of it. A place before the edit stays, one after it moves with it, one inside what was taken out
 * goes to the edit's start. Text put in exactly at the place goes before it when `leading`
 * (the start of a range, which the new text is then outside) and after it otherwise (its end).
 */
const moved = (
  place: number,
  before: string,
  after: string,
  leading: boolean
) => {
  const most = Math.min(before.length, after.length);
  let head = 0;
  while (head < most && before[head] === after[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < most - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const end = before.length - tail;
  if (place < head || (place === head && !leading)) {
    return place;
  }
  return place >= end ? place + after.length - before.length : head;
};

/**
 * While a dictation listens, the words that stood in the text as it began are marked, so they
 * draw quiet and what the dictation settles draws in ink. The marked stretch moves with every
 * edit: words typed before it push it on, and it never takes in what is written at its ends. A
 * browser without CSS Custom Highlights draws them all in ink.
 */
const useTypedQuiet = (
  card: { current: HTMLElement | null },
  dictating: boolean,
  value: TokenInputValue
) => {
  // The marked stretch, and the text it was last placed in.
  const typed = useRef<{ start: number; end: number; text: string } | null>(
    null
  );
  useEffect(() => {
    const editor = card.current?.querySelector<HTMLElement>(
      '[data-slot="prompt-input-textarea"]'
    );
    if (
      !dictating ||
      editor === null ||
      editor === undefined ||
      typeof Highlight === "undefined"
    ) {
      typed.current = null;
      return nothing;
    }
    // Read from the value's own change: the text as the page holds it now.
    const text = value.length === 0 ? "" : (editor.textContent ?? "");
    const was = typed.current;
    typed.current =
      was === null
        ? { start: 0, end: text.length, text }
        : {
            start: moved(was.start, was.text, text, true),
            end: moved(was.end, was.text, text, false),
            text,
          };
    const range = document.createRange();
    range.setStart(...placeOf(editor, typed.current.start));
    range.setEnd(...placeOf(editor, typed.current.end));
    const marked = CSS.highlights.get(TYPED) ?? new Highlight();
    marked.add(range);
    CSS.highlights.set(TYPED, marked);
    return () => {
      marked.delete(range);
    };
  }, [card, dictating, value]);
};

/** A length as computed ("8px"), in pixels; 0 for one that is not ("normal"). */
// oxlint-disable-next-line unicorn/prefer-number-coercion -- a length reads "8px", which Number() makes NaN
const px = (value: string) => Number.parseFloat(value) || 0;

/** A length token ("var(--damsko-…)", set in rem or px) as the browser resolves it on `element`, in px. */
const tokenPx = (element: Element, token: string) => {
  const value = getComputedStyle(element)
    .getPropertyValue(token.slice("var(".length, -1))
    .trim();
  return value.endsWith("rem")
    ? px(value) * px(getComputedStyle(document.documentElement).fontSize)
    : px(value);
};

/** What the one row decides about its room (`rowFit`), as the original's composer does. */
interface RowFit {
  /** The text has the card's whole width, the tools and Submit under it. */
  tall: boolean;
  /** A model chip's level folds to its maker's mark. */
  fold: boolean;
  /** At rest, the model chips are away until something is typed. */
  away: boolean;
}

/** What the row keeps between reads: the room the chips need to come back, and to unfold. */
interface RowRoom {
  /** The chips' width and the gap each keeps, while they show. */
  chips: number;
  /** The sides' width while a level shows. */
  wide: number;
}

/** Every group of tools in the one row, and Submit where it stands apart from them. */
const sidesOf = (card: HTMLElement) =>
  [
    ...card.querySelectorAll<HTMLElement>(
      '[data-slot="prompt-input-tools"], [data-slot="prompt-input-end"]'
    ),
  ].filter(
    (side) =>
      side.parentElement?.closest('[data-slot="prompt-input-tools"]') === null
  );

/**
 * A model chip's width in its row and the gap it keeps there, and its step's (the empty box after
 * it in a one-row prompt input: model-selector.tsx): what it takes while it shows.
 */
const chipRoom = (chip: HTMLElement) => {
  const drawn = [...chip.children].filter(
    (part) =>
      part.getClientRects().length > 0 &&
      !["absolute", "fixed"].includes(getComputedStyle(part).position)
  );
  const width = drawn
    .map((part) => part.getBoundingClientRect().width)
    .reduce((sum, each) => sum + each, 0);
  const step = !["none", "normal"].includes(
    getComputedStyle(chip, "::after").content
  );
  const gaps = (drawn.length > 0 ? 1 : 0) + (step ? 1 : 0);
  return (
    width + gaps * px(getComputedStyle(chip.parentElement ?? chip).columnGap)
  );
};

/**
 * How the one row fits its room, step for step as the original's composer decides it. The text
 * never gives. First a model chip's level (its words, where they are the level: ModelSelectorName
 * in a trigger with a tooltip) folds to the maker's mark, while with it the text would go under
 * its least width (`prompt-input-field-min`; at rest the placeholder's,
 * `prompt-input-placeholder-min`); a model's name never folds. On a phone's row the level is
 * folded by a container query alone (model-selector.tsx). Then, at rest, the chips are away while
 * the placeholder would still be under its least, and come back once something is typed; only
 * where nothing is left to fold is the placeholder cut. With words, they outgrow their line when
 * they take two lines, or one wider than the room between the tools and Submit, or that room is
 * under the text's least: the text then takes the card's whole width and the tools go under it.
 * Every width is read from the card and its sides, which stand alike in both forms, so the answer
 * never depends on the form it changes and nothing flickers at the edge. A fold or an away that
 * changes is drawn before the rest is read.
 */
const rowFit = (
  card: HTMLElement,
  was: RowFit,
  room: RowRoom
): RowFit | null => {
  const editor = card.querySelector<HTMLElement>(
    '[data-slot="prompt-input-textarea"]'
  );
  if (editor === null) {
    return null;
  }
  const look = getComputedStyle(card);
  const sides = sidesOf(card);
  const chips = sides.flatMap((side) => [
    ...side.querySelectorAll<HTMLElement>('[data-slot="model-selector"]'),
  ]);
  if (!was.away) {
    room.chips = chips.map(chipRoom).reduce((sum, width) => sum + width, 0);
  }
  // The sides as they stand with the chips in sight, away or not.
  const sidesWidth =
    sides
      .map((side) => side.getBoundingClientRect().width)
      .reduce((sum, width) => sum + width, 0) + (was.away ? room.chips : 0);
  const levels = chips
    .map((chip) => chip.querySelector("[data-level]"))
    .filter((level) => level !== null);
  if (!was.fold && levels.some((level) => level.getClientRects().length > 0)) {
    room.wide = sidesWidth;
  }
  const beside =
    card.clientWidth -
    px(look.paddingInlineStart) -
    px(look.paddingInlineEnd) -
    2 * px(look.columnGap);
  const resting = editor.dataset.empty !== undefined;
  const least = resting
    ? tokenPx(card, size.promptInputPlaceholderMin)
    : px(getComputedStyle(editor.parentElement ?? editor).minWidth);
  // Folded only while the level would leave the text under its least width.
  const fold =
    levels.length > 0 && beside - Math.max(room.wide, sidesWidth) < least;
  if (fold !== was.fold) {
    // The sides change width with the fold: the rest is read once it is drawn.
    return { ...was, fold };
  }
  // At rest, after the level, the chips are away while the placeholder would be under its least.
  const away = resting && chips.length > 0 && beside - sidesWidth < least;
  if (away !== was.away) {
    return { ...was, away };
  }
  if (resting) {
    return { tall: false, fold, away };
  }
  const text = beside - sidesWidth;
  const own = getComputedStyle(editor);
  const lines =
    (editor.scrollHeight - px(own.paddingBlockStart)) / px(own.lineHeight);
  if (lines > 1.5 || text < least) {
    return { tall: true, fold, away };
  }
  const typed = document.createRange();
  typed.selectNodeContents(editor);
  // A caret's width to spare, so the last letter is never under Submit.
  return {
    tall:
      typed.getBoundingClientRect().width + 2 >
      text - px(own.paddingInlineStart) - px(own.paddingInlineEnd),
    fold,
    away,
  };
};

const ROW_AT_REST: RowFit = { tall: false, fold: false, away: false };

/**
 * In one row, how it fits its room (`rowFit`): read as the card comes, and again, before paint,
 * as anything in it changes (the words, a choice in a chip, a tool that comes or goes, a fold),
 * as the card or one of its sides changes width (a chip laid out late, its font come in). While
 * something stands in the text's place the answer stays as it was.
 */
const useRowFit = (
  on: boolean,
  card: { current: HTMLElement | null },
  dictating: boolean
): { tall: boolean; fold: true | undefined; away: true | undefined } => {
  const [fit, setFit] = useState(ROW_AT_REST);
  const room = useRef<RowRoom>({ chips: 0, wide: 0 });
  useLayoutEffect(() => {
    const box = card.current;
    if (!on || box === null) {
      return nothing;
    }
    const read = () => {
      const next = rowFit(box, fit, room.current);
      if (
        next !== null &&
        (next.tall !== fit.tall ||
          next.fold !== fit.fold ||
          next.away !== fit.away)
      ) {
        setFit(next);
      }
    };
    read();
    const resized = new ResizeObserver(read);
    for (const part of [box, ...sidesOf(box)]) {
      resized.observe(part);
    }
    const changed = new MutationObserver(read);
    changed.observe(box, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  }, [on, card, fit]);
  if (!on) {
    return { tall: false, fold: undefined, away: undefined };
  }
  // A dictation's bar is the foot row, so the words stand over it. The fold and the away are the
  // card's marks (`data-fold`, `data-away`), there only while they hold.
  return {
    tall: fit.tall || dictating,
    fold: fit.fold || undefined,
    away: fit.away || undefined,
  };
};

/**
 * How many times the status has come to `success`: the halo plays again each time, and each time
 * it is said once.
 */
const useSuccessCount = (status: Status, said: string) => {
  const [count, setCount] = useState(status === "success" ? 1 : 0);
  const [seen, setSeen] = useState(status);
  if (status !== seen) {
    setSeen(status);
    if (status === "success") {
      setCount(count + 1);
    }
  }
  useEffect(() => {
    if (count > 0) {
      announce(said);
    }
  }, [count, said]);
  return count;
};

/**
 * Whether a failed send shows: from a send of the form's own that rejected, or the status, until
 * the person types or sends again.
 */
const useFailure = (status: Status) => {
  const [rejected, setRejected] = useState(false);
  const [typedSince, setTypedSince] = useState(false);
  const [seen, setSeen] = useState(status);
  if (seen !== status) {
    setSeen(status);
    setTypedSince(false);
  }
  return {
    shown: (status === "error" || rejected) && !typedSince,
    /** Typing takes the failure's line away: the person has read it and gone on. */
    typed: () => {
      setRejected(false);
      setTypedSince(true);
    },
    /** A send starts, or its words were cleared: no typing, so a failure said next shows. */
    fresh: () => {
      setRejected(false);
      setTypedSince(false);
    },
    rejected: () => {
      setRejected(true);
      setTypedSince(false);
    },
  };
};

/** Whether a file is dragged over the page, and over the card itself (`listenForFileDrags`). */
const useFileDrags = (
  form: { current: HTMLFormElement | null },
  take: ((files: File[]) => void) | undefined,
  globalDrop: boolean
) => {
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  useEffect(
    () =>
      take === undefined
        ? undefined
        : listenForFileDrags(
            form,
            setDragging,
            setOver,
            globalDrop ? take : undefined
          ),
    [form, take, globalDrop]
  );
  return { dragging, over, setOver };
};

/** The card's look: its surface, the one row (and tall in it), a file dragged over the page. */
const cardLook = ({
  glass,
  compact,
  tall,
  dragging,
  over,
}: {
  glass: boolean;
  compact: boolean;
  tall: boolean;
  dragging: boolean;
  over: boolean;
}) => [
  styles.card,
  glass && styles.glass,
  compact && styles.compact,
  // A model chip in one row answers what the row decides about its room (`useRowFit`).
  compact && promptInputRowMarker,
  tall && styles.compactTall,
  dragging && styles.dragging,
  over && styles.over,
];

/**
 * The working light and the success halo, behind the card: three beams along its top edge while
 * the answer comes, one halo each time it succeeds.
 */
const Light = ({
  on,
  listening,
  dither,
  still,
  accent,
  success,
  ref,
}: {
  on: boolean;
  /** A voice is heard: the light stands dithered over the card, and follows it. */
  listening: boolean;
  /** The working light's edge drawn through the system's pixels (`edge="dither"`). */
  dither: boolean;
  ref: Ref<HTMLSpanElement>;
  /** No light while the page loads. */
  still: boolean;
  accent: Accent;
  success: number;
}) => {
  if (still) {
    return null;
  }
  const colour = [
    accent === "mint" && styles.mint,
    accent === "lavender" && styles.lavender,
    accent === "info" && styles.info,
    accent === "warning" && styles.warning,
    accent === "destructive" && styles.destructive,
    accent === "default" && styles.mint,
  ];
  const strip = [
    styles.strip,
    accent !== "default" && styles.stripTint,
    on && styles.stripRunning,
  ];
  return (
    <>
      <span
        aria-hidden="true"
        ref={ref}
        data-slot="prompt-input-light"
        {...stylex.props(
          styles.light,
          colour,
          on && styles.lightOn,
          (dither || listening) && styles.lightDither,
          dither && on && styles.lightDitherOn,
          listening && !on && styles.lightListening
        )}
      >
        <span {...stylex.props(styles.lightFrame)}>
          <span {...stylex.props(styles.beam, styles.beamWide)}>
            <span {...stylex.props(strip, styles.stripWide)} />
          </span>
          <span {...stylex.props(styles.beam, styles.beamMid)}>
            <span {...stylex.props(strip, styles.stripMid)} />
          </span>
          <span {...stylex.props(styles.beam, styles.beamTight)}>
            <span {...stylex.props(strip, styles.stripTight)} />
          </span>
        </span>
      </span>
      {success > 0 && (
        <span
          key={success}
          aria-hidden="true"
          data-slot="prompt-input-halo"
          {...stylex.props(styles.halo, colour)}
        />
      )}
    </>
  );
};

/**
 * Focus follows what the body holds: to a takeover's first control as it comes, back to the text
 * as it goes; only when the person is in the form (focus went into it, or a press or a key did),
 * so nothing takes the focus as a page comes and a page of several forms never jumps.
 */
const useTakeoverFocus = (
  shown: boolean,
  form: { current: HTMLFormElement | null },
  controller: TokenInputController
) => {
  // Unknown until the form has drawn once: what it starts with is no change, whether the text
  // or something in its place (a conversation that is already running).
  const before = useRef<boolean | null>(null);
  const inside = useRef(false);
  useEffect(() => {
    const was = before.current;
    before.current = shown;
    if (was === null || was === shown) {
      return;
    }
    // Only for the person who is in this form: never as the page comes, nor for a change made
    // from outside while they are elsewhere.
    if (!(inside.current && focusHere(form.current))) {
      return;
    }
    if (shown) {
      controller.focus({ at: "end" });
    } else {
      focusTakeover(form.current);
    }
  }, [shown, form, controller]);
  return {
    handleFocus: () => {
      inside.current = true;
    },
    // Focus leaves the form only for something outside it: falling to the body from inside (a
    // button that went away) it is still this form's.
    handleBlur: (event: FocusEvent<HTMLFormElement>) => {
      if (
        event.relatedTarget !== null &&
        !event.currentTarget.contains(event.relatedTarget)
      ) {
        inside.current = false;
      }
    },
  };
};

/**
 * Sends for the keys: a failure is already said, and the text stays, so nothing more is done with
 * it. Submit's press keeps the rejection, so an agent's press fails with it.
 */
const sendQuietly = async (send: () => Promise<void>) => {
  try {
    await send();
  } catch {
    // Said by the send itself; the text stays to try again.
  }
};

// The parts a press on empty room in the card goes through to the text from.
const ROOM = new Set([
  "prompt-input-header",
  "prompt-input-body",
  "prompt-input-footer",
  "prompt-input-tools",
]);

/**
 * The band under the card, tucked under its foot: what the assistant is doing, in the caller's
 * words, and that the last send failed, in the catalogue's (said once by the form, and taken away
 * as the person types). With neither, no band. Written straight in the PromptInput.
 */
export const PromptInputNote = ({ children, style }: PromptInputNoteProps) => {
  const words = useI18n().promptInput;
  const failed = usePromptInput()?.failed === true;
  if (!useOutside()) {
    return null;
  }
  return (
    <>
      {failed && (
        <p
          data-slot="prompt-input-note"
          {...stylex.props(styles.note, styles.noteFailed, style)}
        >
          <Icon icon={TriangleAlertIcon} />
          {words.failed}
        </p>
      )}
      {!isBlank(children) && (
        <p data-slot="prompt-input-note" {...stylex.props(styles.note, style)}>
          {children}
        </p>
      )}
    </>
  );
};

// The mark a banner wears when none is given: what the notice means.
const bannerIcons = {
  default: InfoIcon,
  warning: TriangleAlertIcon,
  destructive: TriangleAlertIcon,
} as const;

/**
 * A notice above the card that belongs to the prompt input (a limit reached, something to
 * connect first), tucked under the card's top: the quiet strip with an Alert in it, one short line
 * and one action, so it is said as an Alert is. Written straight in the PromptInput.
 */
export const PromptInputBanner = ({
  children,
  icon,
  variant = "default",
  action,
  onClose,
  style,
}: PromptInputBannerProps) => {
  const words = useI18n().alert;
  const form = usePromptInput();
  const drawn = useOutside();
  // A plain note is never said as it appears: it describes the text instead, so a screen reader
  // still hears it there.
  const wordsId = useId();
  const describes = drawn && variant === "default";
  const describe = form?.changeBannerIds;
  useEffect(() => {
    if (!describes || describe === undefined) {
      return nothing;
    }
    describe([wordsId, true]);
    return () => {
      describe([wordsId, false]);
    };
  }, [describes, describe, wordsId]);
  if (!drawn) {
    return null;
  }
  const mark = icon === false ? undefined : (icon ?? bannerIcons[variant]);
  const closable = onClose !== undefined;
  return (
    <div
      data-slot="prompt-input-banner"
      {...stylex.props(styles.banner, style)}
    >
      <Alert
        appearance="subtle"
        // Said at once when it warns or stops work; a plain note (what the prompt is about) is no
        // news, so it is read where it stands and never said as the page opens.
        live={variant === "default" ? "off" : "assertive"}
        icon={false}
      >
        <AlertTitle>
          <span
            {...stylex.props(
              styles.bannerLine,
              (!isBlank(action) || closable) && styles.bannerLineBesideAction,
              closable && styles.bannerLineClosable
            )}
          >
            {mark !== undefined && (
              <span
                aria-hidden="true"
                {...stylex.props(
                  styles.bannerMark,
                  variant === "warning" && styles.warning,
                  variant === "destructive" && styles.destructive
                )}
              >
                <Icon icon={mark} />
              </span>
            )}
            <span
              id={describes ? wordsId : undefined}
              {...stylex.props(styles.bannerWords)}
            >
              {children}
            </span>
          </span>
        </AlertTitle>
        {!isBlank(action) && (
          <AlertAction>
            <span
              {...stylex.props(
                styles.bannerAction,
                closable && styles.bannerActionClosable
              )}
            >
              {action}
            </span>
          </AlertAction>
        )}
      </Alert>
      {closable && (
        <span {...stylex.props(styles.bannerClose)}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={words.close}
            onClick={(event) => {
              // The banner goes, and its button with it: the text takes the focus it held.
              const held =
                event.currentTarget.parentElement?.parentElement?.contains(
                  document.activeElement
                ) === true;
              onClose();
              if (held) {
                form?.controller.focus({ at: "end" });
              }
            }}
          >
            <Icon icon={XIcon} />
          </Button>
        </span>
      )}
    </div>
  );
};

/**
 * The messages written while an answer was still coming, waiting their turn above the card: a
 * panel that folds open and shut, its foot behind the card. The product keeps the queue. Written
 * straight in the PromptInput.
 */
export const PromptInputQueue = ({
  children,
  defaultOpen = true,
  style,
}: PromptInputQueueProps) => {
  if (!useOutside()) {
    return null;
  }
  return (
    <div
      data-slot="prompt-input-queue"
      {...stylex.props(styles.above, styles.queue, style)}
    >
      <Collapsible defaultOpen={defaultOpen}>{children}</Collapsible>
    </div>
  );
};

/** The queue's fold: its words, with the count, open and shut it. */
export const PromptInputQueueTrigger = ({
  children,
}: PromptInputQueueTriggerProps) => (
  <CollapsibleTrigger>{children}</CollapsibleTrigger>
);

/** What the fold opens: the waiting messages, the next one first. */
export const PromptInputQueueContent = ({
  children,
}: PromptInputQueueContentProps) => (
  <CollapsibleContent>
    <ul {...stylex.props(styles.queueList)}>{children}</ul>
  </CollapsibleContent>
);

/**
 * One waiting message: its words, and its actions at the row's end. When an action takes the
 * row off from the keyboard, focus goes on to the next row's first action, or the one before, and
 * after the last to the text: never to the page.
 */
export const PromptInputQueueItem = ({
  children,
  actions,
  style,
}: PromptInputQueueItemProps) => {
  const controller = usePromptInput()?.controller;
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events -- the row hears its own actions' presses, to place the focus if one takes the row off
    <li
      data-slot="prompt-input-queue-item"
      onClick={(event) => {
        const row = event.currentTarget;
        if (!row.contains(document.activeElement)) {
          return;
        }
        const near = [row.nextElementSibling, row.previousElementSibling]
          .map((other) => other?.querySelector<HTMLElement>("button"))
          .find((button) => button !== null && button !== undefined);
        // Once the press has drawn: only if it took the row off and the focus fell to the page.
        requestAnimationFrame(() => {
          if (row.isConnected || document.activeElement !== document.body) {
            return;
          }
          if (near?.isConnected === true) {
            near.focus();
          } else {
            controller?.focus({ at: "end" });
          }
        });
      }}
      {...stylex.props(styles.queueItem, style)}
    >
      <span {...stylex.props(styles.queueText)}>{children}</span>
      {!isBlank(actions) && (
        <span {...stylex.props(styles.queueActions)}>{actions}</span>
      )}
    </li>
  );
};

const inOrder = (part: ReactNode, at: number) => (
  <Fragment key={at}>{part}</Fragment>
);

/** Children as one flat list, through lists and Fragments at any depth. */
const partsOf = (children: ReactNode): ReactNode[] =>
  listOf(children).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? partsOf(child.props.children)
      : [child]
  );

/**
 * The parts that stand outside the card, in the order they are written: the banners and the
 * queue above it, the notes under it.
 */
const outsideOf = (children: ReactNode) => {
  const parts = partsOf(children);
  return {
    above: parts
      .filter(
        (part) =>
          isPart(part, PromptInputBanner) || isPart(part, PromptInputQueue)
      )
      .map(inOrder),
    under: parts.filter((part) => isPart(part, PromptInputNote)).map(inOrder),
  };
};

/** The form: holds the text, its tokens and its files, and sends them. */
export const PromptInput = ({
  children,
  onSubmit,
  status = "ready",
  accent = "default",
  edge = "smooth",
  variant = "default",
  loading = false,
  value,
  defaultValue,
  onValueChange,
  codec,
  controller: given,
  accept,
  globalDrop = false,
  maxLength,
  disabled = false,
  compact = false,
  "aria-label": label,
  style,
}: PromptInputProps) => {
  const words = useI18n().promptInput;
  // oxlint-disable-next-line react/hook-use-state -- made once, never set
  const [own] = useState(createTokenInputController);
  const controller = given ?? own;
  // The value as it is now: the caller's, else the last the editor reported.
  const [seen, setSeen] = useState<TokenInputValue>(
    () => value ?? defaultValue ?? []
  );
  const current = value ?? seen;
  const [cut, setCut] = useState(false);
  const [editorShown, setEditorShown] = useState(true);
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  const [dictating, setDictating] = useState(false);
  const [interim, setInterim] = useState("");
  const [going, setGoing] = useState(false);
  // How many attached files are on their way or refused: none of them is sent.
  const [holds, changeHolds] = useReducer(countBy, 0);
  // What Escape does while a dictation listens: the speech button's cancel.
  const cancelDictation = useRef<(() => void) | null>(null);
  const setCancelDictation = (cancel: (() => void) | null) => {
    cancelDictation.current = cancel;
  };
  // In development: the outside parts written in the card, and those the form found and drew.
  const [written, changeWritten] = useReducer(countBy, 0);
  const [drawn, changeDrawn] = useReducer(countBy, 0);
  const warned = useRef(false);
  const failure = useFailure(status);
  const noteId = useId();
  const [bannerIds, changeBannerIds] = useReducer(listBy, []);
  const form = useRef<HTMLFormElement | null>(null);
  const card = useRef<HTMLFieldSetElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const attachments = useAttachments(accept, picker);
  const { files } = attachments.value;
  // While what fits of a change too long goes in, in its place: never cut again.
  const refitting = useRef(false);
  // The send that is out, while it is: a second Enter waits for it.
  const running = useRef<Promise<void> | null>(null);
  // A failure is said once, whether the send's rejection or the status says it first.
  const failureSaid = useRef(false);
  const busy = status === "submitted" || status === "streaming";
  const { length } = toLabel(current);
  const empty = emptyOf(current);
  const still = disabled || loading;
  const takeFiles = still ? undefined : attachments.value.add;
  const row = useRowFit(compact && !loading, card, dictating);
  const { tall } = row;
  useTypedQuiet(card, dictating, current);
  const success = useSuccessCount(status, words.succeeded);
  const drags = useFileDrags(form, takeFiles, globalDrop);
  const focusWatch = useTakeoverFocus(editorShown, form, controller);
  // The light over the card follows a voice: the field tells how loud, at each frame.
  const light = useRef<HTMLSpanElement | null>(null);
  const heardAt = (level: number) => {
    light.current?.style.setProperty(LISTEN, (0.18 + 0.17 * level).toFixed(3));
  };

  const failedStatus = status === "error";
  useEffect(() => {
    if (failedStatus) {
      sayOnce(failureSaid, words.failed);
    } else {
      failureSaid.current = false;
    }
  }, [failedStatus, words.failed]);
  // A change past the limit is put in again as what fits of it, where it went: the editor's caret
  // has already moved past it, and a paste over a selection replaces the selection.
  const refit = (next: TokenInputValue) => {
    if (maxLength === undefined) {
      return;
    }
    const {
      at,
      fits,
      cut: cutNow,
    } = refitOf(controller.getValue(), next, maxLength);
    if (cutNow) {
      setCut(true);
    }
    if (fits.length === 0) {
      return;
    }
    queueMicrotask(() => {
      refitting.current = true;
      controller.insert(fits, { at });
      refitting.current = false;
    });
  };

  const change = (
    next: TokenInputValue,
    details: TokenInputValueChangeDetails
  ) => {
    if (maxLength !== undefined) {
      const after = toLabel(next).length;
      if (after > maxLength && after > length) {
        details.cancel();
        if (!refitting.current) {
          refit(next);
        }
        return;
      }
    }
    // Drawn now, in the same task as the change: an agent writes and then presses Submit two
    // frames later, which Firefox can run before a render React schedules for later.
    flushSync(() => {
      setSeen(next);
      // What fits of a cut change keeps saying it was cut.
      setCut(refitting.current);
      failure.typed();
    });
    keepCaretInView(card.current);
    onValueChange?.(next, details);
  };

  const send = async (message: TokenInputValue, sending: PromptInputFile[]) => {
    failureSaid.current = false;
    failure.fresh();
    const sent = onSubmit?.({
      text: toText(message, codec),
      files: sending.map((attached) => attached.file),
      tokens: tokensOf(message),
      value: message,
    });
    if (isThenable(sent)) {
      try {
        await sent;
      } catch (error) {
        // Nothing was lost: the words and the files are where they were, to send again.
        failure.rejected();
        sayOnce(failureSaid, words.failed);
        throw error;
      }
    }
    // Sent: only what was sent clears, so words typed while it went stay.
    if (
      value === undefined &&
      toText(controller.getValue(), codec) === toText(message, codec)
    ) {
      controller.clear();
      // Clearing is no typing: a failure the status says next still shows.
      failure.fresh();
    }
    attachments.sent(sending);
  };

  const submit = async () => {
    if (running.current !== null) {
      await running.current;
      return;
    }
    const message = controller.getValue();
    // Nothing goes while a dictation's bar stands where Submit was, nor while a file is on its
    // way or refused: Submit is hidden or off then, and Enter does no more than it would.
    if (still || busy || dictating || holds > 0 || emptyOf(message)) {
      return;
    }
    await oneAtATime(running, async () => {
      await during(setGoing, async () => {
        await send(message, files);
      });
    });
  };

  const openFiles =
    takeFiles === undefined ? undefined : attachments.value.openFileDialog;

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    // One Escape does one thing: a layer inside (the mention menu, the action menu) closed on it,
    // and no listener of the page's hears it and closes more.
    if (event.key === "Escape" && event.defaultPrevented) {
      event.stopPropagation();
      return;
    }
    // Escape cancels a dictation, from the text as from its bar.
    if (event.key === "Escape" && cancelDictation.current !== null) {
      event.preventDefault();
      event.stopPropagation();
      cancelDictation.current();
      return;
    }
    // Cmd or Ctrl and / opens the file picker.
    if (
      event.key === "/" &&
      (event.metaKey || event.ctrlKey) &&
      openFiles !== undefined
    ) {
      event.preventDefault();
      openFiles();
    }
  };

  // A press on the card's empty room puts the caret at the end of the text.
  const onPointerDown = (event: PointerEvent<HTMLFieldSetElement>) => {
    const { target } = event;
    const room =
      target === event.currentTarget ||
      (target instanceof HTMLElement && ROOM.has(target.dataset.slot ?? ""));
    if (!room || !editorShown || disabled) {
      return;
    }
    event.preventDefault();
    controller.focus({ at: "end" });
  };

  const outside = outsideOf(children);
  useEffect(() => {
    if (isDevelopment && written > drawn && !warned.current) {
      warned.current = true;
      console.error(
        "PromptInput: a PromptInputBanner, PromptInputQueue or PromptInputNote inside another component is not drawn. Write it straight in the PromptInput (a Fragment or a list is fine)."
      );
    }
  }, [written, drawn]);

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the form hears what happens in its controls: focus, Escape, the file keys, files pasted and dropped
    <form
      ref={form}
      aria-label={label}
      data-slot="prompt-input"
      data-status={status}
      onSubmit={(event) => {
        event.preventDefault();
        void sendQuietly(submit);
      }}
      onKeyDown={onKeyDown}
      {...fileHandlers(takeFiles, drags.setOver)}
      onFocus={focusWatch.handleFocus}
      // A press or a key in the form is the person's too, where a press focuses nothing (Safari).
      onPointerDownCapture={focusWatch.handleFocus}
      onKeyDownCapture={focusWatch.handleFocus}
      onBlur={focusWatch.handleBlur}
      {...stylex.props(styles.root, style)}
    >
      <PromptInputContext
        // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
        value={{
          controller,
          status,
          disabled,
          compact,
          empty,
          failed: failure.shown,
          loading,
          tall,
          sending: going,
          held: holds > 0,
          changeHolds,
          interim,
          setInterim,
          changeWritten,
          changeDrawn,
          noteId,
          bannerIds,
          changeBannerIds,
          footer,
          setFooter,
          dictating,
          setDictating,
          heardAt,
          setCancelDictation,
          length,
          maxLength,
          submit,
          openFiles,
          setEditorShown,
        }}
      >
        <div {...stylex.props(styles.stack)}>
          <OutsideContext value>{outside.above}</OutsideContext>
          <div {...stylex.props(styles.room)}>
            <Light
              ref={light}
              on={busy}
              listening={dictating}
              dither={edge === "dither"}
              still={loading}
              accent={accent}
              success={success}
            />
            <AttachmentsContext
              // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
              value={{
                ...attachments.value,
                // The last file taken off: focus goes on to the text, as the list goes with it.
                remove: (id) => {
                  if (files.length === 1 && focusHere(form.current)) {
                    controller.focus({ at: "end" });
                  }
                  attachments.value.remove(id);
                },
              }}
            >
              <TokenInput
                controller={controller}
                value={value}
                defaultValue={defaultValue}
                onValueChange={change}
                codec={codec}
                disabled={disabled}
                getTokenDescription={describeToken}
                // Enter sends; never while an input method composes or a menu is open (the editor's).
                onSubmit={() => {
                  void sendQuietly(submit);
                }}
                renderToken={() => <Chip />}
              >
                <fieldset
                  ref={card}
                  disabled={disabled}
                  // Still while the page loads: nothing in it is focused or read out.
                  inert={loading}
                  aria-hidden={loading || undefined}
                  data-fold={row.fold}
                  data-away={row.away}
                  onPointerDown={onPointerDown}
                  {...stylex.props(
                    // The rings of the controls in the card are drawn inside them.
                    ringInsetMarker,
                    cardLook({
                      glass: variant === "glass",
                      compact,
                      tall,
                      dragging: drags.dragging,
                      over: drags.over,
                    })
                  )}
                >
                  {children}
                  {drags.dragging && (
                    <span aria-hidden="true" {...stylex.props(styles.drop)}>
                      {words.drop}
                    </span>
                  )}
                </fieldset>
              </TokenInput>
            </AttachmentsContext>
          </div>
        </div>
        <div
          id={noteId}
          data-slot="prompt-input-under"
          {...stylex.props(styles.under)}
        >
          <OutsideContext value>{outside.under}</OutsideContext>
        </div>
      </PromptInputContext>
      {takeFiles !== undefined && (
        <input
          ref={picker}
          type="file"
          multiple
          accept={accept}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const picked = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            takeFiles(picked);
          }}
          {...stylex.props(visuallyHidden)}
        />
      )}
      {maxLength !== undefined && (
        <p
          aria-live="polite"
          data-slot="prompt-input-live-region"
          {...stylex.props(visuallyHidden)}
        >
          {limitWords(words, length, maxLength, cut)}
        </p>
      )}
    </form>
  );
};

/**
 * One attached file: an Attachment whose remove action takes it off the message. While the
 * product says it is on its way or refused (`state`), the form sends nothing; a refusal is said
 * once, with its reason.
 */
export const PromptInputAttachment = ({
  data,
  state = "done",
  description,
  children,
  style,
}: PromptInputAttachmentProps) => {
  const words = useI18n().attachment;
  const locale = useLocale();
  const remove = use(AttachmentsContext)?.remove;
  const changeHolds = usePromptInput()?.changeHolds;
  const held =
    state === "uploading" || state === "processing" || state === "error";
  const refused = state === "error";
  useEffect(() => {
    if (!held || changeHolds === undefined) {
      return nothing;
    }
    changeHolds(1);
    return () => {
      changeHolds(-1);
    };
  }, [held, changeHolds]);
  const { name } = data;
  useEffect(() => {
    if (refused) {
      announce(description === undefined ? name : `${name}: ${description}`);
    }
  }, [refused, name, description]);
  return (
    <Attachment state={state} style={style}>
      {children ?? (
        <>
          <AttachmentMedia src={data.preview} type={data.type} />
          <AttachmentContent>
            <AttachmentTitle>{name}</AttachmentTitle>
            <AttachmentDescription>
              {description ?? formatFileSize(data.size, locale)}
            </AttachmentDescription>
          </AttachmentContent>
          {remove !== undefined && (
            <AttachmentActions>
              <AttachmentAction
                aria-label={words.remove(name)}
                onClick={() => {
                  remove(data.id);
                }}
              >
                <Icon icon={XIcon} />
              </AttachmentAction>
            </AttachmentActions>
          )}
        </>
      )}
    </Attachment>
  );
};

/** The files attached to the message, as an AttachmentGroup: nothing while there are none. */
export const PromptInputAttachments = ({
  children,
  "aria-label": label,
  style,
}: PromptInputAttachmentsProps) => {
  const words = useI18n().promptInput;
  const files = use(AttachmentsContext)?.files ?? [];
  if (files.length === 0) {
    return null;
  }
  return (
    // The files take the header's whole line: their row is a size container, which takes no width
    // from its files and would shrink to nothing as an item of the header's row.
    <div
      data-slot="prompt-input-attachments"
      {...stylex.props(styles.attachments)}
    >
      <AttachmentGroup aria-label={label ?? words.attachments} style={style}>
        {files.map((file) => (
          <Fragment key={file.id}>
            {children === undefined ? (
              <PromptInputAttachment data={file} />
            ) : (
              children(file)
            )}
          </Fragment>
        ))}
      </AttachmentGroup>
    </div>
  );
};

/** What stands above the text: the attached files, a notice. */
export const PromptInputHeader = ({
  children,
  style,
}: PromptInputHeaderProps) => {
  const compact = usePromptInput()?.compact === true;
  return (
    <div
      data-slot="prompt-input-header"
      {...stylex.props(styles.header, compact && styles.compactHeader, style)}
    >
      {children}
    </div>
  );
};

/** Where the text stands, or what the product puts in its place for a while. */
export const PromptInputBody = ({ children, style }: PromptInputBodyProps) => {
  const form = usePromptInput();
  const compact = form?.compact === true;
  return (
    <div
      data-slot="prompt-input-body"
      {...stylex.props(
        styles.body,
        compact && styles.compactBody,
        form?.tall === true && styles.compactBodyTall,
        style
      )}
    >
      {children}
    </div>
  );
};

/** The text: UI SDK's Token Input editor, a multi-line text box with tokens in it. */
export const PromptInputTextarea = ({
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  placeholder,
  autoFocus = false,
  onKeyDown,
  ref,
  style,
}: PromptInputTextareaProps) => {
  const form = usePromptInput();
  const setShown = form?.setEditorShown;
  const controller = form?.controller;
  const compact = form?.compact === true;
  const interim = form?.interim ?? "";
  // Here, the text stands in the body; gone, a takeover does.
  useEffect(() => {
    setShown?.(true);
    return () => {
      setShown?.(false);
    };
  }, [setShown]);
  useEffect(() => {
    if (autoFocus) {
      controller?.focus({ at: "end" });
    }
  }, [autoFocus, controller]);
  // A plain banner above says what the prompt is about (it is never said as it appears); the band
  // under the card says why the words are still here.
  const describers = [...(form?.bannerIds ?? [])];
  if (form?.failed === true) {
    describers.push(form.noteId);
  }
  const describedBy = describers.join(" ");
  const editor = (
    <TokenInputEditor
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy === "" ? undefined : describedBy}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      ref={(element: HTMLDivElement | null) => {
        assignRef(ref, element);
      }}
      render={(props: Record<string, unknown>, state: { empty: boolean }) => (
        <div
          {...props}
          data-slot="prompt-input-textarea"
          data-empty={state.empty ? "" : undefined}
          data-interim={form?.dictating === true ? interim : undefined}
          {...stylex.props(
            styles.editor,
            compact && styles.compactEditor,
            state.empty && interim === "" && styles.placeholder,
            state.empty && compact && styles.compactPlaceholder,
            styles.typedQuiet,
            form?.dictating === true && styles.interim,
            scrollbarHidden,
            style
          )}
        />
      )}
    />
  );
  if (form?.loading !== true) {
    return editor;
  }
  // While the page loads the text keeps its box, not drawn, a quiet line in its words' place.
  return (
    <div {...stylex.props(styles.pending)}>
      <div {...stylex.props(styles.kept, styles.body)}>{editor}</div>
      <span
        {...stylex.props(
          styles.pendingLine,
          compact && styles.compactPendingLine
        )}
      >
        <span {...stylex.props(styles.pendingWidth)}>
          <Skeleton size="sm" />
        </span>
      </span>
    </div>
  );
};

/** The row under the text: the tools at the start, Submit at the end. */
export const PromptInputFooter = ({
  children,
  style,
}: PromptInputFooterProps) => {
  const form = usePromptInput();
  const compact = form?.compact === true;
  return (
    // A dictation's bar is drawn in here by the speech button, in place of what the footer holds:
    // that stays in the page, away, so the button keeps its state and comes back as it was.
    <div
      ref={form?.setFooter}
      data-slot="prompt-input-footer"
      {...stylex.props(styles.footer, compact && styles.compactFooter, style)}
    >
      <div
        {...stylex.props(
          form?.dictating === true ? styles.away : styles.through
        )}
      >
        {children}
      </div>
    </div>
  );
};

/** The tools at the footer's start; with `align="end"`, those by Submit, Submit among them. */
export const PromptInputTools = ({
  children,
  align = "start",
  style,
}: PromptInputToolsProps) => {
  const compact = usePromptInput()?.compact === true;
  const end = align === "end";
  return (
    <div
      data-slot="prompt-input-tools"
      {...stylex.props(
        styles.tools,
        end && styles.toolsEnd,
        compact && (end ? styles.compactToolsEnd : styles.compactTools),
        style
      )}
    >
      {children}
    </div>
  );
};

/**
 * A bare (ghost) Button, small, named, pressed on or off (filled, for the one that ends a
 * dictation): an element, not a part of its own, so a TooltipTrigger around it gives its props to
 * the Button itself.
 */
const toolButton = ({
  children,
  "aria-label": ariaLabel,
  pressed,
  onClick,
  off,
  slot,
  variant = "ghost",
  ref,
  style,
}: Omit<PromptInputButtonProps, "tooltip" | "disabled"> & {
  off: boolean;
  slot: string;
  variant?: "ghost" | "default";
  ref?: (element: HTMLButtonElement | null) => void;
}) => {
  const element = (
    <button
      ref={ref}
      type="button"
      data-slot={slot}
      aria-pressed={pressed}
      // The text keeps the focus while a tool is pressed with a pointer.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
    >
      {children}
    </button>
  );
  // Words name it at the small size; an icon alone is a square named by `aria-label`.
  const sized =
    ariaLabel === undefined
      ? { size: "sm" as const }
      : { size: "icon-sm" as const, "aria-label": ariaLabel };
  return (
    <Button
      asChild
      variant={variant}
      {...sized}
      disabled={off}
      onClick={onClick}
      style={style}
    >
      {element}
    </Button>
  );
};

/** While the page loads a tool keeps its room but is not drawn; else it is itself. */
const keptWhile = (loading: boolean, tool: ReactNode): ReactNode =>
  loading ? <span {...stylex.props(styles.kept)}>{tool}</span> : tool;

/** A tool in the footer: a small bare button, an icon with words or alone, a tooltip if it helps. */
export const PromptInputButton = ({
  tooltip,
  disabled,
  ...props
}: PromptInputButtonProps): ReactNode => {
  const form = usePromptInput();
  const off = (form?.disabled ?? false) || disabled === true;
  const button = toolButton({ ...props, off, slot: "prompt-input-button" });
  if (form?.loading === true) {
    return keptWhile(true, button);
  }
  if (tooltip === undefined || tooltip === null) {
    return button;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
};

/**
 * The count near the limit: hidden from a screen reader, which hears the stage instead. Over the
 * footer's row it stands above Submit where the footer is narrow (`above`).
 */
const Count = ({
  length,
  max,
  above,
}: {
  length: number;
  max: number;
  above: boolean;
}) => {
  const words = useI18n().promptInput;
  const stage = stageOf(length, max);
  if (stage === "under") {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      data-slot="prompt-input-count"
      data-limit={stage}
      {...stylex.props(
        styles.count,
        above && styles.countAbove,
        stage === "at" && styles.countAt
      )}
    >
      {words.count(Math.min(length, max), max)}
    </span>
  );
};

/** The mark Submit wears: an arrow to send, a spinner once sent, a square to stop. */
const submitIcon = (status: Status, stoppable: boolean): ReactNode => {
  if (status === "streaming" || (status === "submitted" && stoppable)) {
    return <Icon icon={SquareIcon} />;
  }
  if (status === "submitted") {
    return (
      <span {...stylex.props(styles.spinner)}>
        <Icon icon={LoaderIcon} />
      </span>
    );
  }
  // After a failure it is the arrow still: the band under the card says what happened.
  return <Icon icon={ArrowUpIcon} />;
};

/** Where Submit is: its status, whether the answer comes, whether it stops it, whether it is off. */
const submitState = (
  form: PromptInputContextValue | null,
  given: Status | undefined,
  canStop: boolean
) => {
  const status = given ?? form?.status ?? "ready";
  const working = status === "submitted" || status === "streaming";
  const none = (form?.empty ?? true) || (form?.held ?? false);
  return {
    status,
    working,
    stoppable: working && canStop,
    off:
      (form?.disabled ?? false) ||
      (form?.loading ?? false) ||
      (working ? !canStop : none),
  };
};

/** Send, or Stop while the answer comes; the count before it near the limit. */
export const PromptInputSubmit = ({
  status: givenStatus,
  onStop,
  "aria-label": ariaLabel,
  style,
}: PromptInputSubmitProps) => {
  const words = useI18n().promptInput;
  const form = usePromptInput();
  const { status, working, stoppable, off } = submitState(
    form,
    givenStatus,
    onStop !== undefined
  );
  const compact = form?.compact === true;
  const press = async (event: MouseEvent<HTMLElement>) => {
    if (stoppable) {
      await onStop?.();
      return;
    }
    // The text takes the focus first: Submit gives way to Stop as the message goes, and focus
    // would fall to the page's body. Only when the focus is this form's, so an agent's press
    // never pulls it from elsewhere.
    if (focusHere(event.currentTarget.closest("form"))) {
      form?.controller.focus({ at: "end" });
    }
    await form?.submit();
  };
  return (
    <span
      data-slot="prompt-input-end"
      {...stylex.props(styles.end, compact && styles.compactEnd, style)}
    >
      {form?.maxLength !== undefined && (
        <Count length={form.length} max={form.maxLength} above={!compact} />
      )}
      <Button
        asChild
        variant={off && !working ? "ghost" : "default"}
        size="icon-sm"
        aria-label={ariaLabel ?? (stoppable ? words.stop : words.submit)}
        disabled={off}
        focusableWhenDisabled={working}
        // Busy while the message goes, whether a press or Enter sent it.
        aria-busy={
          status === "submitted" || form?.sending === true ? true : undefined
        }
        // The prompt input holds where its message is and draws it itself: the Button follows none.
        status="idle"
        onClick={press}
      >
        <button
          type="button"
          data-slot="prompt-input-submit"
          data-status={status}
        >
          {submitIcon(status, stoppable)}
        </button>
      </Button>
    </span>
  );
};

/** The plus menu: actions that add to the message. */
export const PromptInputActionMenu = ({
  onOpenChange,
  ...props
}: PromptInputActionMenuProps) => (
  <DropdownMenu
    {...props}
    // One Escape does one thing: it closes the menu, and no listener of the page's on the document
    // hears it and closes more.
    onOpenChange={(open, details) => {
      if (!open && details.reason === "escape-key") {
        details.event?.stopImmediatePropagation();
      }
      onOpenChange?.(open, details);
    }}
  />
);

/** The plus that opens the action menu. */
export const PromptInputActionMenuTrigger = ({
  children,
  "aria-label": ariaLabel,
  style,
}: PromptInputActionMenuTriggerProps) => {
  const words = useI18n().promptInput;
  const off = usePromptInput()?.disabled ?? false;
  return (
    <DropdownMenuTrigger asChild disabled={off}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={ariaLabel ?? words.add}
        disabled={off}
        style={style}
      >
        {children ?? <Icon icon={PlusIcon} />}
      </Button>
    </DropdownMenuTrigger>
  );
};

/** The action menu's panel, opening from the plus's start. */
export const PromptInputActionMenuContent = ({
  align = "start",
  ...props
}: PromptInputActionMenuContentProps) => (
  <DropdownMenuContent align={align} {...props} />
);

/** An action in the menu. */
export const PromptInputActionMenuItem = (
  props: PromptInputActionMenuItemProps
) => <DropdownMenuItem {...props} />;

// The keys that open the file picker while focus is in the form: Cmd or Ctrl and /.
const PICKER_KEYS = "mod+/";

/** Opens the file picker: Cmd or Ctrl and / does the same while focus is in the form. */
export const PromptInputActionAddAttachments = ({
  children,
  style,
}: PromptInputActionAddAttachmentsProps) => {
  const words = useI18n().promptInput;
  const openFiles = usePromptInput()?.openFiles;
  const said = children ?? words.addAttachments;
  return (
    <DropdownMenuItem
      icon={PaperclipIcon}
      disabled={openFiles === undefined}
      onSelect={() => {
        openFiles?.();
      }}
      label={said}
      style={style}
    >
      {said}
      <DropdownMenuShortcut>{PICKER_KEYS}</DropdownMenuShortcut>
    </DropdownMenuItem>
  );
};

/** The time a dictation has run, as a clock reads it ("0:12"). */
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** The seconds a voice has run: the time runs while `running`, and waits while it is not. */
const useSeconds = (running: boolean) => {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) {
      return nothing;
    }
    const timer = setInterval(() => {
      setSeconds((now) => now + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [running]);
  return seconds;
};

/**
 * Fetches the field and draws it on `canvas` while the canvas is in view and the page is shown,
 * and holds otherwise (out of view, under `display: none`, in a hidden tab). It is started again
 * as reduced motion is turned on or off, so that is followed while a voice runs. What it returns
 * sets how the field stands, and stops it, whether or not it had arrived.
 */
const drawVoice = (
  canvas: HTMLCanvasElement,
  sample: () => VoiceReading | undefined,
  onLevel: (level: number) => void
) => {
  const held: {
    field: VoiceField | null;
    mode: VoiceFieldMode;
    seen: boolean;
    gone: boolean;
  } = { field: null, mode: "listening", seen: false, gone: false };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const run = () => {
    held.field?.run(held.seen && document.visibilityState === "visible");
  };
  const start = async () => {
    const { startVoiceField } = await import("./prompt-input-voice-field");
    if (held.gone) {
      return;
    }
    held.field?.stop();
    held.field = startVoiceField(canvas, {
      sample,
      still: reduced.matches,
      onLevel,
    });
    held.field.mode(held.mode);
    run();
  };
  const restart = () => {
    void start();
  };
  const inView = new IntersectionObserver((entries) => {
    held.seen = entries.at(-1)?.isIntersecting === true;
    run();
  });
  inView.observe(canvas);
  document.addEventListener("visibilitychange", run);
  reduced.addEventListener("change", restart);
  restart();
  return {
    mode: (mode: VoiceFieldMode) => {
      held.mode = mode;
      held.field?.mode(mode);
    },
    stop: () => {
      held.gone = true;
      held.field?.stop();
      inView.disconnect();
      document.removeEventListener("visibilitychange", run);
      reduced.removeEventListener("change", restart);
    },
  };
};

/**
 * The voice's field, for a dictation as for a conversation: a canvas the field draws on at each
 * frame, from the product's sampler or, without one, the `level` it was last given. The field's
 * code is fetched as the first voice starts. `mode` says how it stands: listening, the other
 * voice speaking (a stop quieter), a stretch unheard (thinner), the microphone off (flat, dim), or
 * written down (it drains to its middle).
 */
const Level = ({
  level,
  sample,
  mode,
}: {
  level: number;
  sample: (() => VoiceReading | undefined) | undefined;
  mode: VoiceFieldMode;
}) => {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [drawing, setDrawing] = useState<ReturnType<typeof drawVoice> | null>(
    null
  );
  const heardAt = usePromptInput()?.heardAt;
  // The newest sampler and level, read at each frame.
  const now = useRef({ level, sample, heardAt });
  useEffect(() => {
    now.current = { level, sample, heardAt };
  });
  useEffect(() => {
    if (canvas === null) {
      return nothing;
    }
    const started = drawVoice(
      canvas,
      () => now.current.sample?.() ?? { level: now.current.level },
      (heard) => now.current.heardAt?.(heard)
    );
    setDrawing(started);
    return started.stop;
  }, [canvas]);
  useEffect(() => {
    drawing?.mode(mode);
  }, [drawing, mode]);
  return (
    <span aria-hidden="true" {...stylex.props(styles.level)}>
      <canvas ref={setCanvas} {...stylex.props(styles.canvas)} />
    </span>
  );
};

/** How the field stands in a dictation's bar: written down first, then the microphone off. */
const barMode = (settling: boolean, muted: boolean): VoiceFieldMode => {
  if (settling) {
    return "thinking";
  }
  return muted ? "muted" : "listening";
};

/**
 * A dictation's bar, in the footer's place while it listens: Cancel, the time it has run, the
 * voice's level as a field of pixels, the microphone (off for a moment, and on again), and Done
 * where Submit stood. A pointer's press leaves the focus in the text; the keyboard's goes to Done.
 * Escape cancels it, from the bar as from the text (the form hears it).
 */
const Dictation = ({
  level,
  sample,
  settling,
  muted,
  autoFocus,
  onMutedChange,
  onCancel,
  onDone,
}: {
  level: number;
  sample: (() => VoiceReading | undefined) | undefined;
  /** Done was pressed and the product writes it down: the field drains, the bar waits. */
  settling: boolean;
  muted: boolean;
  autoFocus: boolean;
  onMutedChange: (muted: boolean) => void;
  onCancel: () => void;
  onDone: () => void;
}) => {
  const words = useI18n().promptInput.speechButton;
  const compact = usePromptInput()?.compact === true;
  const seconds = useSeconds(!(muted || settling));
  const [done, setDone] = useState<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (settling) {
      announce(words.settling);
    }
  }, [settling, words.settling]);
  useEffect(() => {
    if (autoFocus) {
      done?.focus();
    }
  }, [autoFocus, done]);
  return (
    <div
      role="group"
      aria-label={words.listening}
      data-slot="prompt-input-dictation"
      {...stylex.props(styles.dictation, compact && styles.compactDictation)}
    >
      {toolButton({
        "aria-label": words.cancel,
        off: false,
        slot: "prompt-input-dictation-cancel",
        onClick: onCancel,
        children: <Icon icon={XIcon} />,
      })}
      <span role="timer" {...stylex.props(styles.time)}>
        {clock(seconds)}
      </span>
      <Level level={level} sample={sample} mode={barMode(settling, muted)} />
      {toolButton({
        "aria-label": words.mute,
        pressed: muted,
        off: settling,
        slot: "prompt-input-dictation-mute",
        onClick: () => {
          onMutedChange(!muted);
        },
        children: <Icon icon={MicIcon} />,
      })}
      {toolButton({
        "aria-label": words.done,
        off: settling,
        slot: "prompt-input-dictation-done",
        variant: "default",
        ref: setDone,
        onClick: onDone,
        children: <Icon icon={CheckIcon} />,
      })}
    </div>
  );
};

/**
 * As the bar goes, focus comes back to the button that started it from the keyboard (`keyed`):
 * only when the bar took the focus with it, never from where the person has gone since.
 */
const useFocusBack = (
  dictating: boolean,
  keyed: boolean,
  mic: HTMLButtonElement | null
) => {
  useEffect(() => {
    if (!dictating && keyed && document.activeElement === document.body) {
      mic?.focus();
    }
  }, [dictating, keyed, mic]);
};

/** While `on`, Escape anywhere in the form runs `cancel`: the newest one, set at every draw. */
const useEscape = (
  form: PromptInputContextValue | null,
  on: boolean,
  cancel: () => void
) => {
  const setCancel = form?.setCancelDictation;
  useEffect(() => {
    if (!on || setCancel === undefined) {
      return nothing;
    }
    setCancel(cancel);
    return () => {
      setCancel(null);
    };
  });
};

/** Draws its children in the form's footer, in place of what the footer holds. */
const InFooter = ({ children }: { children: ReactNode }) => {
  const footer = usePromptInput()?.footer ?? null;
  return footer === null ? null : createPortal(children, footer);
};

/** Tells the form that a voice runs in it (`shown`), and the words it has not yet settled. */
const useHeardInForm = (
  form: PromptInputContextValue | null,
  shown: boolean,
  interim: string
) => {
  const setDictating = form?.setDictating;
  const setInterim = form?.setInterim;
  useEffect(() => {
    setDictating?.(shown);
    return () => {
      setDictating?.(false);
    };
  }, [shown, setDictating]);
  useEffect(() => {
    setInterim?.(interim);
    return () => {
      setInterim?.("");
    };
  }, [interim, setInterim]);
};

/**
 * Dictation's button. The product listens, and writes what it hears; while it does, the footer
 * gives way to a bar: Cancel, the time, the voice's level, the microphone, and Done. Outside a
 * footer it is a toggle, pressed while it listens.
 */
export const PromptInputSpeechButton = ({
  listening,
  onListeningChange,
  onCancel,
  muted,
  onMutedChange,
  level = 0,
  sample,
  settling = false,
  interim = "",
  "aria-label": ariaLabel,
  disabled,
  style,
}: PromptInputSpeechButtonProps) => {
  const words = useI18n().promptInput.speechButton;
  const form = usePromptInput();
  const off = (form?.disabled ?? false) || disabled === true;
  const [own, setOwn] = useState(false);
  const on = listening ?? own;
  const [ownMuted, setOwnMuted] = useState(false);
  // The keyboard started it: focus goes to the bar, and back here as the bar goes.
  const [keyed, setKeyed] = useState(false);
  const [mic, setMic] = useState<HTMLButtonElement | null>(null);
  useHeardInForm(form, on || settling, on ? interim : "");
  useFocusBack(form?.dictating === true, keyed, mic);
  const listen = (next: boolean) => {
    if (next) {
      announce(words.listening);
      setKeyed(document.activeElement === mic);
    }
    setOwn(next);
    setOwnMuted(false);
    onListeningChange?.(next);
  };
  const cancel = () => {
    onCancel?.();
    listen(false);
  };
  useEscape(form, on, cancel);
  const button = toolButton({
    "aria-label": ariaLabel ?? words.label,
    pressed: on,
    off,
    slot: "prompt-input-speech-button",
    ref: setMic,
    style,
    onClick: () => {
      listen(!on);
    },
    children: <Icon icon={on ? AudioWaveformIcon : MicIcon} />,
  });
  return (
    <>
      {keptWhile(form?.loading === true, button)}
      {(on || settling) && (
        <InFooter>
          <Dictation
            level={level}
            sample={sample}
            settling={settling && !on}
            muted={muted ?? ownMuted}
            autoFocus={keyed}
            onMutedChange={(next) => {
              setOwnMuted(next);
              onMutedChange?.(next);
            }}
            onCancel={cancel}
            onDone={() => {
              listen(false);
            }}
          />
        </InFooter>
      )}
    </>
  );
};

/** The words of a turn, each in its own span, keyed by its place: a new one resolves as it comes. */
const resolving = (said: string) =>
  said
    .split(" ")
    .filter((word) => word !== "")
    .map((word, at) => (
      <Fragment key={at}>
        {at > 0 && " "}
        <span {...stylex.props(styles.word)}>{word}</span>
      </Fragment>
    ));

/**
 * The words of the turn where the text stood, the unsettled ones lighter with the mark of where
 * the next lands, and a note in the room under them, so the card keeps its height.
 */
const VoiceWords = ({
  note,
  interim,
  children,
  style,
}: Pick<PromptInputVoiceProps, "note" | "children" | "style"> & {
  interim: string;
}) => (
  <div {...stylex.props(styles.spokenRoom, style)}>
    <p
      data-slot="prompt-input-voice-words"
      {...stylex.props(styles.spoken, scrollbarHidden)}
    >
      {typeof children === "string" ? resolving(children) : children}
      {interim !== "" && (
        <span {...stylex.props(styles.spokenInterim)}> {interim}</span>
      )}
      <span aria-hidden="true" {...stylex.props(styles.spokenCaret)} />
    </p>
    {!isBlank(note) && (
      <span
        data-slot="prompt-input-voice-note"
        {...stylex.props(styles.voiceNote)}
      >
        <Icon icon={TriangleAlertIcon} />
        {note}
      </span>
    )}
  </div>
);

/** What leads the foot row: the other voice's mark while it speaks, else the time. */
const VoiceLead = ({
  speaker,
  seconds,
}: {
  speaker: ReactNode;
  seconds: number;
}) =>
  isBlank(speaker) ? (
    <span role="timer" {...stylex.props(styles.time, styles.voiceTime)}>
      {clock(seconds)}
    </span>
  ) : (
    <span {...stylex.props(styles.speaker)}>{speaker}</span>
  );

/** How the field stands in a conversation: the other voice's turn first, then the person's. */
const voiceMode = (
  speaking: boolean,
  off: boolean,
  unheard: boolean
): VoiceFieldMode => {
  if (speaking) {
    return "speaking";
  }
  if (off) {
    return "muted";
  }
  return unheard ? "unheard" : "listening";
};

/**
 * A spoken conversation, written in the PromptInput in place of its body and footer while it
 * runs: the words of the turn where the text stood, and under them the time (or, while the other
 * voice speaks, its mark), the voice's level as a field of light, the microphone and a close
 * button. The turns pass by themselves, so there is no Done and no Cancel. The product listens and
 * speaks; this part draws what it is told, and says each turn once.
 */
export const PromptInputVoice = ({
  status = "listening",
  children,
  interim = "",
  level = 0,
  sample,
  note,
  speaker,
  muted,
  onMutedChange,
  onClose,
  "aria-label": ariaLabel,
  style,
}: PromptInputVoiceProps) => {
  const words = useI18n().promptInput;
  const form = usePromptInput();
  const [ownMuted, setOwnMuted] = useState(false);
  const off = muted ?? ownMuted;
  const speaking = status === "speaking";
  const seconds = useSeconds(!off);
  const turn = speaking ? words.voice.speaking : words.voice.listening;
  useEffect(() => {
    announce(turn);
  }, [turn]);
  // A note is said once as it comes, through the page's one live region.
  const noted = typeof note === "string" ? note : "";
  useEffect(() => {
    if (noted !== "") {
      announce(noted);
    }
  }, [noted]);
  // The light over the card stands while the voice runs, as for a dictation.
  useHeardInForm(form, true, "");
  // It stands in the text's place: said before the form's first look at what it holds, so a
  // conversation already running as the page comes takes no focus, and the text takes it back
  // as this goes.
  const setEditorShown = form?.setEditorShown;
  useLayoutEffect(() => {
    setEditorShown?.(false);
  }, [setEditorShown]);
  // Escape anywhere in the form ends the voice, as the close button does.
  useEscape(form, true, onClose);
  return (
    <div
      role="group"
      aria-label={ariaLabel ?? words.voice.label}
      data-slot="prompt-input-voice"
      data-status={status}
      {...stylex.props(styles.conversation)}
    >
      <VoiceWords note={note} interim={interim} style={style}>
        {children}
      </VoiceWords>
      <div data-slot="prompt-input-footer" {...stylex.props(styles.footer)}>
        <div {...stylex.props(styles.dictation)}>
          <VoiceLead
            speaker={speaking ? speaker : undefined}
            seconds={seconds}
          />
          <Level
            level={level}
            sample={sample}
            mode={voiceMode(speaking, off, !isBlank(note))}
          />
          {toolButton({
            "aria-label": words.speechButton.mute,
            pressed: off,
            off: false,
            slot: "prompt-input-voice-mute",
            onClick: () => {
              setOwnMuted(!off);
              onMutedChange?.(!off);
            },
            children: <Icon icon={MicIcon} />,
          })}
          {toolButton({
            "aria-label": words.voice.close,
            off: false,
            slot: "prompt-input-voice-close",
            onClick: onClose,
            children: <Icon icon={XIcon} />,
          })}
        </div>
      </div>
    </div>
  );
};

// ---- Mentions ------------------------------------------------------------------------------------

/**
 * Whether an entry the menu hands back is one of the caller's items: the menu keeps the objects it
 * was given, so their icon and description come back with them.
 */
const isMentionData = (entry: unknown): entry is PromptInputMentionData =>
  typeof entry === "object" &&
  entry !== null &&
  "value" in entry &&
  typeof entry.value === "string" &&
  "label" in entry &&
  typeof entry.label === "string";

/** Items as the menu takes them: the ungrouped first, then each group in the order it first comes. */
const toMenuData = (
  items: readonly PromptInputMentionData[]
): TriggerMenuData => {
  const loose: PromptInputMentionData[] = [];
  const groups = new Map<string, PromptInputMentionData[]>();
  for (const item of items) {
    if (item.group === undefined) {
      loose.push(item);
    } else {
      groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
    }
  }
  return [
    ...loose,
    ...[...groups].map(([label, grouped]) => ({
      type: "group" as const,
      label,
      items: grouped,
    })),
  ];
};

/** The caller's item for an entry of the menu, or one made of its value and label. */
const itemOf = (entry: {
  value: unknown;
  label: string;
}): PromptInputMentionData =>
  isMentionData(entry)
    ? entry
    : { value: String(entry.value), label: entry.label };

/** A kind as a row of the menu: picked, the menu stays and lists the things of that kind. */
type KindRow = PromptInputMentionData & { after: "continue"; kind: true };

const isKind = (entry: unknown): entry is KindRow =>
  isMentionData(entry) && "kind" in entry && entry.kind === true;

/** Whether typing finds the item: in its name, its quiet line or its other words. */
const found = (item: PromptInputMentionData, query: string) =>
  [item.label, item.description ?? "", ...(item.keywords ?? [])].some((words) =>
    words.toLowerCase().includes(query.toLowerCase())
  );

/**
 * The items of a trigger with kinds, for what was typed: the kinds while nothing is typed at the
 * first level; inside a kind, its things, without their heading; else every kind's, as given.
 */
const kindItems = async (
  trigger: PromptInputMentionTrigger,
  kinds: readonly PromptInputMentionData[],
  kind: PromptInputMentionData | null,
  query: string,
  signal: AbortSignal
): Promise<TriggerMenuData> => {
  if (kind === null && query === "") {
    return kinds.map((each): KindRow => ({
      ...each,
      after: "continue",
      kind: true,
    }));
  }
  const { items } = trigger;
  const all =
    typeof items === "function"
      ? await items(query, { signal, kind: kind?.value })
      : items.filter((item) => found(item, query));
  return toMenuData(
    kind === null
      ? all
      : all
          .filter((item) => item.group === kind.label)
          .map((item) => ({ ...item, group: undefined }))
  );
};

/** The trigger's items as the menu takes them: its data, a loader, or the levels of its kinds. */
const itemsOf = (
  trigger: PromptInputMentionTrigger,
  kindNow: () => PromptInputMentionData | null
) => {
  const { items, kinds } = trigger;
  if (kinds !== undefined) {
    return async (query: string, context: { signal: AbortSignal }) =>
      await kindItems(trigger, kinds, kindNow(), query, context.signal);
  }
  return typeof items === "function"
    ? async (query: string, context: { signal: AbortSignal }) =>
        toMenuData(await items(query, context))
    : toMenuData(items);
};

/** The kind the person went into in an open menu, kept beside the menu: none at its first level. */
const createLevel = () => {
  let kind: PromptInputMentionData | null = null;
  return {
    read: () => kind,
    enter: (next: PromptInputMentionData | null) => {
      kind = next;
    },
  };
};

/**
 * One trigger as UI SDK's Trigger Menu takes it: the items as its data, the token a pick inserts.
 * `kindNow` reads the kind the person went into, as the items are asked for.
 */
const definitionOf = (
  trigger: PromptInputMentionTrigger,
  kindNow: () => PromptInputMentionData | null
) => ({
  char: trigger.char,
  boundary: trigger.boundary,
  type: trigger.type,
  items: itemsOf(trigger, kindNow),
  insert: (entry: { value: unknown; label: string }) => {
    const item = itemOf(entry);
    const made: MentionToken = trigger.toToken?.(item) ?? {
      value: item.value,
      label: item.label,
    };
    return {
      type: made.type ?? trigger.type,
      value: made.value,
      label: made.label,
      // What it says after its label, in the caller's words; never written into the text.
      data: {
        ...made.data,
        description: trigger.description ?? trigger.type,
      },
    };
  },
});

/** How an item shows in the menu, when the caller draws it. */
const RenderItemContext = createContext<
  ((item: PromptInputMentionData) => ReactNode) | undefined
>(undefined);

/** One suggestion: a mark, its name and a quiet line. Picked, it goes in the text as a token. */
export const PromptInputMentionItem = ({
  value,
  label,
  description,
  icon,
  disabled,
  children,
  style,
}: PromptInputMentionItemProps) => (
  <TriggerMenuItem
    value={value}
    label={label}
    disabled={disabled}
    className={(state: TriggerMenuItemState) =>
      className(
        menuStyles.item,
        styles.mentionItem,
        state.highlighted && menuStyles.highlighted,
        state.disabled && menuStyles.disabled,
        style
      )
    }
  >
    {icon !== undefined && (
      <TriggerMenuItemIcon data-menu-icon="" {...stylex.props(menuStyles.icon)}>
        <Icon icon={icon} />
      </TriggerMenuItemIcon>
    )}
    {children ?? (
      <span {...stylex.props(menuStyles.text, styles.mentionText)}>
        {label}
        {description !== undefined && (
          <span {...stylex.props(styles.mentionDescription)}>
            {description}
          </span>
        )}
      </span>
    )}
  </TriggerMenuItem>
);

/** One row of the menu as data gives it: the caller's drawing, else a mark, its name and a quiet line. */
const DataItem = ({ item }: { item: PromptInputMentionData }) => {
  const renderItem = use(RenderItemContext);
  if (isKind(item)) {
    // A kind goes one level in: a chevron at its end says so.
    return (
      <PromptInputMentionItem
        value={item.value}
        label={item.label}
        icon={item.icon}
        disabled={item.disabled}
      >
        <span {...stylex.props(menuStyles.text, styles.mentionText)}>
          {item.label}
          {item.description !== undefined && (
            <span {...stylex.props(styles.mentionDescription)}>
              {item.description}
            </span>
          )}
        </span>
        <span aria-hidden="true" {...stylex.props(styles.mentionInto)}>
          <Icon icon={ChevronRightIcon} />
        </span>
      </PromptInputMentionItem>
    );
  }
  return (
    <PromptInputMentionItem
      value={item.value}
      label={item.label}
      description={item.description}
      icon={item.icon}
      disabled={item.disabled}
    >
      {renderItem?.(item)}
    </PromptInputMentionItem>
  );
};

/**
 * The rows of the menu, from the items it shows now: loose items, then groups under their names,
 * which is all toMenuData gives it. Keyed by place: two items may stand for the same value.
 */
const DataRows = ({ items }: { items: TriggerMenuData<unknown> }) =>
  items.map((entry, index) => {
    if (isMentionData(entry)) {
      return <DataItem key={index} item={entry} />;
    }
    return typeof entry === "object" &&
      "type" in entry &&
      entry.type === "group" ? (
      <TriggerMenuGroup key={index}>
        {entry.label !== undefined && (
          <TriggerMenuGroupLabel {...stylex.props(menuStyles.label)}>
            {entry.label}
          </TriggerMenuGroupLabel>
        )}
        {entry.items.filter(isMentionData).map((item, at) => (
          <DataItem key={at} item={item} />
        ))}
      </TriggerMenuGroup>
    ) : null;
  });

/** What the menu says of itself: that its items failed to load, that they load, else `rest`. */
const menuWords = (
  state: { status: TriggerMenuContentState["status"]; loading?: boolean },
  words: { error: string; loading: string },
  rest: ReactNode
): ReactNode => {
  if (state.status === "error") {
    return words.error;
  }
  return state.loading === true || state.status === "loading"
    ? words.loading
    : rest;
};

/** Where the menu is, for its PromptInputMentionEmpty: its state and its own words for it. */
const MentionMenuContext = createContext<
  | {
      state: TriggerMenuContentState;
      said: { error: string; loading: string };
    }
  | undefined
>(undefined);

/** What the menu says while nothing matches; and while its items load, or when they failed. */
export const PromptInputMentionEmpty = ({
  children,
}: PromptInputMentionEmptyProps) => {
  const menu = use(MentionMenuContext);
  const words = useI18n().promptInput;
  if (menu === undefined) {
    throw new Error(
      "PromptInputMentionEmpty must be used within a PromptInputMentionContent."
    );
  }
  return (
    // Its own words when the loader failed, where UI SDK would say nothing matched.
    <TriggerMenuEmpty {...stylex.props(styles.mentionEmpty)}>
      {menuWords(menu.state, menu.said, children ?? words.mentionEmpty)}
    </TriggerMenuEmpty>
  );
};

/** The menu: a menu's panel at the caret, its items, and what it says when it has none. */
export const PromptInputMentionContent = ({
  children,
  errorText,
  style,
}: PromptInputMentionContentProps) => {
  const words = useI18n().promptInput;
  const said = {
    error: errorText ?? words.mentionsError,
    loading: words.mentionsLoading,
  };
  const parts = partsOf(children);
  const empty = parts.find((part) => isPart(part, PromptInputMentionEmpty));
  const rows = parts.filter((part) => !isPart(part, PromptInputMentionEmpty));
  return (
    <TriggerMenuContent
      side="bottom"
      align="start"
      sideOffset={popup.gap}
      collisionPadding={popup.gutter}
      render={(props: Record<string, unknown>) => (
        <div
          {...props}
          data-slot="prompt-input-mention-content"
          {...stylex.props(
            menuStyles.panel,
            menuStyles.motion,
            styles.mentionPanel,
            scrollbarHidden,
            style
          )}
        />
      )}
    >
      {(state: TriggerMenuContentState) => (
        // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
        <MentionMenuContext value={{ state, said }}>
          {empty ?? <PromptInputMentionEmpty />}
          <TriggerMenuList
            data-slot="prompt-input-mention"
            {...stylex.props(styles.mentionList)}
          >
            {rows.length > 0 ? rows : <DataRows items={state.items} />}
          </TriggerMenuList>
        </MentionMenuContext>
      )}
    </TriggerMenuContent>
  );
};

/** The menus that open on typed characters, each with its trigger's items, inserting tokens. */
export const PromptInputMention = ({
  triggers,
  onSelect,
  renderItem,
  children,
}: PromptInputMentionProps) => {
  const words = useI18n().promptInput;
  const said = { error: words.mentionsError, loading: words.mentionsLoading };
  // The kind the person went into, read as the menu asks for its items: it asks at once as a
  // kind is picked, before a render would tell it.
  // oxlint-disable-next-line react/hook-use-state -- made once, never set
  const [level] = useState(createLevel);
  return (
    <TriggerMenu
      triggers={triggers.map((trigger) => definitionOf(trigger, level.read))}
      // Silent: the status below says that items load, in the page's language.
      pendingAnnouncement=""
      // One Escape does one thing: it closes the menu, and no listener of the page's on the
      // document hears it and closes more (UI SDK's layers hear it there first).
      onOpenChange={(
        open: boolean,
        details: { reason: string; event?: Event }
      ) => {
        if (!open) {
          level.enter(null);
        }
        if (!open && details.reason === "escape-key") {
          details.event?.preventDefault();
          details.event?.stopImmediatePropagation();
        }
      }}
      onSelect={(
        _value: string,
        details: {
          trigger: string;
          item: { value: unknown; label: string };
          insert: (content: string) => void;
        }
      ): void | Promise<void> => {
        // A kind is no mention: the character goes, and the menu stays with that kind's things.
        if (isKind(details.item)) {
          level.enter(details.item);
          details.insert("");
          return undefined;
        }
        return onSelect?.(itemOf(details.item), details.trigger);
      }}
    >
      <TriggerMenuStatus {...stylex.props(visuallyHidden)}>
        {(state: TriggerMenuStatusState): ReactNode =>
          menuWords(
            state,
            said,
            state.open ? words.mentionsFound(state.count) : ""
          )
        }
      </TriggerMenuStatus>
      <RenderItemContext value={renderItem}>
        {children ?? <PromptInputMentionContent />}
      </RenderItemContext>
    </TriggerMenu>
  );
};
