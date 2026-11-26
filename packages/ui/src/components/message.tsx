// Message: one message in a conversation. A Message
// is the row: an avatar, and a column of a header, the surface and a footer, at the start of the
// line or, with `align="end"`, at its end. The surface is a Bubble for the person's words, or the
// assistant's answer drawn from Markdown across the column (MessageResponse).
//
//   <Message align="end">
//     <MessageContent>
//       <Bubble variant="muted" align="end">
//         <BubbleContent>Which invoices are unpaid?</BubbleContent>
//       </Bubble>
//     </MessageContent>
//   </Message>
//   <Message status={status}>
//     <MessageContent>
//       <MessageResponse>{answer}</MessageResponse>
//       <MessageActions>
//         <CopyButton value={answer} />
//         <MessageAction aria-label="Good answer"><Icon icon={ThumbsUpIcon} /></MessageAction>
//       </MessageActions>
//       <MessageFooter><time dateTime="2026-11-12T12:00">2 min ago</time></MessageFooter>
//     </MessageContent>
//   </Message>
//
// Beside the row's parts, each for what a product would otherwise build itself: the
// answer drawn through Markdown at a steady pace while it streams (MessageResponse), a named row of
// actions (MessageActions, MessageAction), a failure with Try again (MessageError), a message's
// shape while it loads (MessageSkeleton), the assistant's `status` said once, and a name for each
// message ("You" at the end of the line, "Assistant" at its start, unless the caller names it), so
// a screen reader tells the two apart by name and not only by side. While the answer is written its
// actions keep their room, unseen and out of reach, so the end moves nothing. Every value is a
// token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  Suspense,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import {
  Icon,
  RefreshCwIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "../lib/icons";
import { focusRingText, scrollbarHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { announce, lazyPart, nothing, useReducedMotion } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";
import { Bubble, BubbleContent } from "./bubble";
import { Button } from "./button";
import { messageVars } from "./message.stylex";
import { Skeleton } from "./skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** Where the assistant's message is: thinking, being written, written, stopped part way, or failed. */
export type MessageStatus =
  | "thinking"
  | "streaming"
  | "done"
  | "stopped"
  | "error";

type Align = "start" | "end";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the types below, so they cannot drift from what the code accepts.

/** Every prop a MessageGroup takes. */
export interface MessageGroupProps {
  /** Consecutive Messages from the same sender. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a Message takes. */
export interface MessageProps {
  /** Its MessageAvatar, then its MessageContent. */
  children: ReactNode;
  /**
   * Which end of the line it stands at: `end` for the person using the product, `start` for the
   * assistant (or anyone else). Its avatar, surface and footer follow.
   * @default "start"
   */
  align?: Align;
  /**
   * For the assistant's message: `thinking` before it writes, `streaming` while it writes, `done`
   * once written, `stopped` when stopped part way (its words kept, Stopped first on its actions'
   * row, or under them with no actions), `error`
   * when it could not be written (put a MessageError in it). Said once to a screen reader as it
   * changes.
   * @default "done"
   */
  status?: MessageStatus;
  /**
   * Its name for a screen reader, so the person's and the assistant's are told apart.
   * @default the catalogue's message.user ("You") at the end, message.assistant ("Assistant") at the start
   */
  "aria-label"?: string;
  /** The id of an element whose words name it, in place of `aria-label`. */
  "aria-labelledby"?: string;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a MessageAvatar takes. */
export interface MessageAvatarProps {
  /** An Avatar; none, to keep the room of one beside the last message of a group. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MessageContent takes. */
export interface MessageContentProps {
  /**
   * Its MessageHeader, the surface (a Bubble, or the assistant's MessageResponse and anything drawn
   * with it), then its MessageActions and MessageFooter.
   */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MessageHeader takes. */
export interface MessageHeaderProps {
  /** Small words above the surface: who wrote it. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MessageResponse takes. */
export interface MessageResponseProps {
  /** The answer, in Markdown: as much of it as has arrived. Copy copies this same source. */
  children: string;
  /**
   * Still being written: the words come in smoothly, never in bursts, and what is half-written is
   * drawn whole. With reduced motion they are drawn as they arrive. Once false, all of it shows.
   * @default true while the Message's status is streaming
   */
  streaming?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MessageActions takes. */
export interface MessageActionsProps {
  /** Its buttons: a CopyButton, MessageAction. */
  children: ReactNode;
  /**
   * The row's name for a screen reader.
   * @default the catalogue's message.actions, "Message actions"
   */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MessageAction takes. */
export interface MessageActionProps {
  /** Its name, for a screen reader and an agent ("Good answer"). */
  "aria-label": string;
  /**
   * What its tooltip says.
   * @default aria-label
   */
  tooltip?: string;
  /** The icon: `<Icon icon={ThumbsUpIcon} />`. */
  children: ReactNode;
  /** What a press does. Return a Promise and the button waits for it. */
  onClick?: () => unknown;
  /** On: a choice that stays, such as a rating given. Said as pressed. */
  pressed?: boolean;
  /**
   * Out of use.
   * @default false
   */
  disabled?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MessageFooter takes. */
export interface MessageFooterProps {
  /** Small words at the message's foot: when it was sent, as a `<time>`, or whether it was read. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MessageError takes. */
export interface MessageErrorProps {
  /**
   * What did not happen.
   * @default the catalogue's message.error, "Could not answer"
   */
  children?: ReactNode;
  /** Tries again. Without it there is no Try again. Return a Promise and the button waits for it. */
  onRetry?: () => unknown;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a MessageSkeleton takes. */
export interface MessageSkeletonProps {
  /**
   * Whose message it stands for: `end`, the person's, a bubble at the end; `start`, the
   * assistant's, lines of words.
   * @default "start"
   */
  align?: Align;
  /**
   * How many lines of words it stands for, from one to eight. A bubble grows with them.
   * @default 1 at the end, 3 at the start
   */
  lines?: number;
  /** Layout only. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  group: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    minWidth: 0,
  },
  root: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    // How far the rows under the surface reach, for the avatar to stand level with the surface.
    [messageVars.actions]: {
      default: "0px",
      ":has([data-slot='message-actions'])": `calc(${size.controlSm} + ${space["2"]})`,
    },
    [messageVars.footer]: {
      default: "0px",
      ":has([data-slot='message-footer'])": `calc(${font.textXsLine} + ${space["2"]})`,
    },
    // Stopped is said once: on the actions' row when the Message holds actions, else under the words.
    [messageVars.stoppedUnder]: {
      default: "inline-flex",
      ":has([data-slot='message-actions'])": "none",
    },
    position: "relative",
    display: "flex",
    gap: space["2"],
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: size.messageText,
    lineHeight: size.messageTextLine,
  },
  end: { flexDirection: "row-reverse" },
  // The assistant's takes focus from code only (after Try again): the ring for words, keyboard only.
  start: {
    borderRadius: radius.sm,
    cornerShape: radius.shape,
  },
  avatar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-end",
    flexShrink: 0,
    width: "fit-content",
    minWidth: size.avatarDefault,
    overflow: "hidden",
    borderRadius: radius.circle,
    transform: `translateY(calc(-1 * (${messageVars.actions} + ${messageVars.footer})))`,
  },
  // The column: header, surface, actions and footer, a small gap apart; wide content scrolls
  // inside it.
  content: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    width: "100%",
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  contentEnd: { alignItems: "flex-end" },
  header: {
    display: "flex",
    alignItems: "center",
    alignSelf: "flex-start",
    maxWidth: "100%",
    minWidth: 0,
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
  },
  response: { minWidth: 0, overflowX: "auto" },
  // The answer's plain words while Markdown loads: Markdown's message type, as written.
  plain: {
    margin: 0,
    fontFamily: font.sans,
    fontSize: size.messageText,
    lineHeight: size.messageTextLine,
    color: colors.bodyForeground,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  // A stopped answer's one quiet line. With actions it stands on their row, before them
  // (MessageActions draws it there): the one under the words is for a Message that holds none
  // (messageVars.stoppedUnder, set by the Message from what it holds).
  note: {
    display: "inline-flex",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: space["1"],
    margin: 0,
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  error: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
    color: colors.destructive,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  errorWords: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    margin: 0,
  },
  // A fieldset for its group role, laid out as a row; its own border and room taken off.
  actions: {
    boxSizing: "border-box",
    minInlineSize: "auto",
    margin: 0,
    padding: 0,
    border: "none",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    // On a touch screen the buttons stand a finger apart.
    gap: {
      default: space["1"],
      [media.pointerCoarse]: `calc(${size.tapTarget} - ${size.controlSm})`,
    },
    "--tap-room-inline": {
      default: `calc(${space["1"]} / 2)`,
      [media.pointerCoarse]: `calc((${size.tapTarget} - ${size.controlSm}) / 2)`,
    },
    "--tap-room-block": {
      default: `calc(${space["1"]} / 2)`,
      [media.pointerCoarse]: `calc((${size.tapTarget} - ${size.controlSm}) / 2)`,
    },
    // The first icon stands under the first letter of the words; at the end, the last under the
    // bubble's edge.
    marginInlineStart: `calc(-1 * (${size.controlSm} - ${size.iconSm}) / 2)`,
    // As wide as its buttons, not the column: its name belongs to them alone.
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  // After Stopped on the row, the actions start after its words, not under the first letter.
  actionsStopped: { marginInlineStart: 0 },
  // Stopped under the words: only when the Message holds no actions.
  noteUnder: { display: messageVars.stoppedUnder },
  // Stopped on the actions' row: a space-3 before the first button.
  noteInRow: {
    display: "inline-flex",
    alignSelf: "center",
    marginInlineEnd: `calc(${space["3"]} - ${space["1"]})`,
  },
  actionsEnd: {
    alignSelf: "flex-end",
    marginInlineStart: 0,
    marginInlineEnd: `calc(-1 * (${size.controlSm} - ${size.iconSm}) / 2)`,
  },
  // While the answer is written its actions keep their room, unseen and out of reach.
  waiting: { visibility: "hidden" },
  // Small and muted at the message's own edge. Where a pointer hovers it shows while the message
  // is hovered or holds the focus; on touch always. Its line keeps its room, so nothing moves.
  footer: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: space["3"],
    minWidth: 0,
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    opacity: {
      default: 1,
      [media.hover]: {
        default: 0,
        [stylex.when.ancestor(":hover")]: 1,
        [stylex.when.ancestor(":focus-within")]: 1,
      },
    },
    transitionProperty: "opacity",
    transitionDuration: {
      default: duration.hover,
      [media.reducedMotion]: "0s",
    },
    transitionTimingFunction: duration.ease,
  },
  selfEnd: { alignSelf: "flex-end" },
  // ---- The skeleton ----
  skeleton: { display: "grid", minWidth: 0 },
  // The column is the container its bubble's width is read against.
  skeletonEnd: { justifyItems: "end", containerType: "inline-size" },
  skeletonLines: (lines: number) => ({
    display: "block",
    height: `calc(${lines} * ${font.textBaseLine})`,
  }),
  // The bubble's whole width, its padding taken off: short for one line, long for more.
  short: { width: `calc(min(12rem, 45cqi) - 2 * ${space["4"]})` },
  long: { width: `calc(min(20rem, 65cqi) - 2 * ${space["4"]})` },
  line: { display: "block", width: "100%" },
  last: { width: "60%" },
});

const AlignContext = createContext<Align>("start");
const StatusContext = createContext<MessageStatus>("done");

const isLive = (status: MessageStatus) =>
  status === "thinking" || status === "streaming";

/** What is said once as the assistant's status changes, given the status before it. */
const sayFor = (
  now: MessageStatus,
  before: MessageStatus | null,
  words: { streaming: string; done: string; stopped: string }
) => {
  if (now === "streaming") {
    return words.streaming;
  }
  if (before === null || !isLive(before)) {
    return "";
  }
  if (now === "done") {
    return words.done;
  }
  return now === "stopped" ? words.stopped : "";
};

/** Consecutive messages from the same sender, stacked close. */
export const MessageGroup = ({ children, style }: MessageGroupProps) => (
  <div data-slot="message-group" {...stylex.props(styles.group, style)}>
    {children}
  </div>
);

/** One message: the row that holds its avatar and its column, at its end of the line. */
export const Message = ({
  children,
  align = "start",
  status = "done",
  "aria-label": label,
  "aria-labelledby": labelledBy,
  style,
}: MessageProps) => {
  const words = useI18n().message;
  const was = useRef<MessageStatus | null>(null);
  const { streaming, done, stopped } = words;
  // Said once as the status changes; a message drawn done or stopped (from history) says nothing.
  useEffect(() => {
    const before = was.current;
    was.current = status;
    if (before === status) {
      return;
    }
    // After the answer's last block, which its Markdown said in its own effect, just before.
    const said = sayFor(status, before, { streaming, done, stopped });
    if (said !== "") {
      announce(said);
    }
  }, [status, streaming, done, stopped]);
  const end = align === "end";
  return (
    <AlignContext value={align}>
      <StatusContext value={status}>
        <article
          tabIndex={end ? undefined : -1}
          aria-label={
            labelledBy === undefined
              ? (label ?? (end ? words.user : words.assistant))
              : label
          }
          aria-labelledby={labelledBy}
          data-slot="message"
          data-align={align}
          data-status={status}
          {...stylex.props(
            stylex.defaultMarker(),
            styles.root,
            end && styles.end,
            !end && styles.start,
            !end && focusRingText,
            style
          )}
        >
          {children}
        </article>
      </StatusContext>
    </AlignContext>
  );
};

/** The avatar beside the message, level with the foot of its surface. */
export const MessageAvatar = ({ children, style }: MessageAvatarProps) => (
  <div data-slot="message-avatar" {...stylex.props(styles.avatar, style)}>
    {children}
  </div>
);

/** The message's column: its header, surface, actions and footer, at the message's end of the line. */
export const MessageContent = ({ children, style }: MessageContentProps) => {
  const align = use(AlignContext);
  return (
    <div
      data-slot="message-content"
      {...stylex.props(
        styles.content,
        align === "end" && styles.contentEnd,
        style
      )}
    >
      {children}
    </div>
  );
};

/** Small words above the surface: who wrote it. */
export const MessageHeader = ({ children, style }: MessageHeaderProps) => {
  const align = use(AlignContext);
  return (
    <div
      data-slot="message-header"
      {...stylex.props(styles.header, align === "end" && styles.selfEnd, style)}
    >
      {children}
    </div>
  );
};

/** Small words at the message's foot, at its own end of the line. */
export const MessageFooter = ({ children, style }: MessageFooterProps) => {
  const align = use(AlignContext);
  return (
    <div
      data-slot="message-footer"
      {...stylex.props(styles.footer, align === "end" && styles.selfEnd, style)}
    >
      {children}
    </div>
  );
};

// ---- Smooth text --------------------------------------------------------------------------------

/** The time it takes to catch up with what has arrived: a burst is spread over about this long. */
const CATCH_UP = 300;

/** Runs `step` once a frame with the share of CATCH_UP since the last one; returns what stops it. */
const everyFrame = (step: (share: number) => void) => {
  let last = performance.now();
  let frame = 0;
  const tick = (now: number) => {
    step(Math.min(1, (now - last) / CATCH_UP));
    last = now;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
  };
};

/**
 * The text of an answer still being written, let out over time so a chunk never lands as a lump:
 * each frame takes a share of what is still to show, so a large burst comes quickly and a trickle
 * at about a frame a character. Markdown shows only its whole words, so the words come one after
 * another, each whole. Once the stream ends, or with reduced motion, the whole text shows at once:
 * the end is never held back. Nothing runs while caught up, so the answer is drawn again (and its
 * last block read again) at most once a frame.
 */
const useSmoothText = (text: string, streaming: boolean): string => {
  const reduced = useReducedMotion();
  const paced = streaming && !reduced;
  // Words there when it is first drawn are not news: they show at once.
  const [shown, setShown] = useState(text.length);
  // Not paced, or the text was replaced by a shorter one (an answer written again): in step.
  if ((!paced && shown !== text.length) || shown > text.length) {
    setShown(text.length);
  }
  const behind = paced && shown < text.length;
  useEffect(() => {
    if (!behind) {
      return nothing;
    }
    const end = text.length;
    return everyFrame((share) => {
      setShown((at) =>
        Math.min(end, at + Math.max(1, Math.ceil((end - at) * share)))
      );
    });
  }, [behind, text.length]);
  return paced ? text.slice(0, Math.min(shown, text.length)) : text;
};

// -------------------------------------------------------------------------------------------------

// Markdown (its parser, CodeBlock, Table and Link) is fetched only once an answer is drawn, so a
// page that shows none does not pay for it. A server render that waits for it (React's prerender,
// renderToReadableStream's allReady) draws the formatted answer as before; until it has come in the
// browser, the answer stands as its plain words in the same type, and an answer drawn on the server
// keeps that HTML until it is live.
const Markdown = lazyPart(
  async () => await import("./markdown"),
  (module) => module.Markdown
);

/**
 * The assistant's answer, drawn from Markdown, its words coming in smoothly while it is written;
 * Stopped under it when it was stopped part way and its Message holds no actions (MessageActions
 * says it on its row otherwise), wherever in the Message either stands.
 */
export const MessageResponse = ({
  children,
  streaming: given,
  style,
}: MessageResponseProps) => {
  const status = use(StatusContext);
  const words = useI18n().message;
  const streaming = given ?? status === "streaming";
  const shown = useSmoothText(children, streaming);
  return (
    <>
      <div
        data-slot="message-response"
        {...stylex.props(styles.response, scrollbarHidden, style)}
      >
        <Suspense fallback={<p {...stylex.props(styles.plain)}>{shown}</p>}>
          <Markdown
            size="message"
            streaming={streaming}
            truncated={status === "stopped"}
          >
            {shown}
          </Markdown>
        </Suspense>
      </div>
      {status === "stopped" && (
        <p
          data-slot="message-stopped"
          {...stylex.props(styles.note, styles.noteUnder)}
        >
          <Icon icon={SquareIcon} />
          {words.stopped}
        </p>
      )}
    </>
  );
};

/**
 * A named row of quiet buttons: hidden and out of reach (its room kept) while the answer is
 * written. A stopped answer's Stopped stands at its start.
 */
export const MessageActions = ({
  children,
  "aria-label": label,
  style,
}: MessageActionsProps) => {
  const align = use(AlignContext);
  const status = use(StatusContext);
  const words = useI18n().message;
  const waiting = isLive(status);
  return (
    <fieldset
      aria-label={label ?? words.actions}
      data-slot="message-actions"
      inert={waiting}
      {...stylex.props(
        styles.actions,
        status === "stopped" && styles.actionsStopped,
        align === "end" && styles.actionsEnd,
        waiting && styles.waiting,
        style
      )}
    >
      {/* A stopped answer says so on this row, before its buttons, as the original did. */}
      {status === "stopped" && (
        <p
          data-slot="message-stopped"
          {...stylex.props(styles.note, styles.noteInRow)}
        >
          <Icon icon={SquareIcon} />
          {words.stopped}
        </p>
      )}
      {children}
    </fieldset>
  );
};

/** One quiet icon button in a message's actions, named by `label`, with its tooltip. */
export const MessageAction = ({
  "aria-label": ariaLabel,
  tooltip,
  children,
  onClick,
  pressed,
  disabled = false,
  style,
}: MessageActionProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={ariaLabel}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick === undefined ? undefined : () => onClick()}
        style={style}
        asChild
      >
        {/* The slot is set on the element drawn: UI SDK keeps a part's own data-slot over a prop. */}
        <button type="button" data-slot="message-action">
          {children}
        </button>
      </Button>
    </TooltipTrigger>
    <TooltipContent>{tooltip ?? ariaLabel}</TooltipContent>
  </Tooltip>
);

/**
 * Says the answer could not be written, as an alert, with Try again beside it. When it goes (the
 * answer is written again) while the focus was in it, the focus goes to the message, never the page.
 */
export const MessageError = ({
  children,
  onRetry,
  style,
}: MessageErrorProps) => {
  const words = useI18n().message;
  const box = useRef<HTMLDivElement | null>(null);
  // A layout effect's cleanup runs while the error is still on the page, so the focus is still in it.
  useLayoutEffect(() => {
    const element = box.current;
    return () => {
      if (element?.contains(document.activeElement) === true) {
        element.closest<HTMLElement>('[data-slot="message"]')?.focus();
      }
    };
  }, []);
  return (
    <div
      ref={box}
      data-slot="message-error"
      {...stylex.props(styles.error, style)}
    >
      <p role="alert" {...stylex.props(styles.errorWords)}>
        <Icon icon={TriangleAlertIcon} />
        {children ?? words.error}
      </p>
      {onRetry !== undefined && (
        <Button variant="outline" size="sm" onClick={() => onRetry()}>
          <Icon icon={RefreshCwIcon} />
          {words.retry}
        </Button>
      )}
    </div>
  );
};

/** The lines' keys: the same each time, in the same order. At most eight. */
const LINES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/**
 * One message's shape while it loads, at the message's own widths: a muted Bubble at the end, or
 * the assistant's lines at the start. Busy, and hidden from screen readers: the conversation it
 * stands in says once what is loading.
 */
export const MessageSkeleton = ({
  align = "start",
  lines,
  style,
}: MessageSkeletonProps) => {
  if (align === "end") {
    const count = Math.min(LINES.length, Math.max(1, lines ?? 1));
    return (
      <div
        aria-busy="true"
        data-slot="message-skeleton"
        data-align="end"
        {...stylex.props(styles.skeleton, styles.skeletonEnd, style)}
      >
        <Bubble variant="muted" align="end">
          <BubbleContent>
            <span
              aria-hidden="true"
              {...stylex.props(
                styles.skeletonLines(count),
                count > 1 ? styles.long : styles.short
              )}
            />
          </BubbleContent>
        </Bubble>
      </div>
    );
  }
  const count = Math.min(LINES.length, Math.max(1, lines ?? 3));
  return (
    <div
      aria-busy="true"
      data-slot="message-skeleton"
      data-align="start"
      {...stylex.props(styles.skeleton, style)}
    >
      {LINES.slice(0, count).map((key, line) => (
        <span
          key={key}
          {...stylex.props(
            styles.line,
            line === count - 1 && count > 1 && styles.last
          )}
        >
          <Skeleton size="default" />
        </span>
      ))}
    </div>
  );
};
