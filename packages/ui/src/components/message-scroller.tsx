// Message scroller: the scrolling transcript of a chat, in StyleX. With `autoScroll` it follows the
// end while an answer streams, gliding as the words come (lib/stick-to-bottom.ts), until the person
// scrolls up or presses a key up; then it stays put, and "Jump to latest" appears under it. A newly sent turn
// (`scrollAnchor`) goes to the top with room kept under it for the answer. New rows fade in, once;
// the ones there when it opened do not. No virtualiser: each row is skipped by the browser while it
// is out of view (`content-visibility: auto`).
//
//   <MessageScrollerProvider autoScroll>
//     <MessageScroller>
//       <MessageScrollerViewport aria-label="Conversation with the assistant">
//         <MessageScrollerContent>
//           {messages.map((message) => (
//             <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === "user"}>
//               <Message … />
//             </MessageScrollerItem>
//           ))}
//         </MessageScrollerContent>
//       </MessageScrollerViewport>
//       <MessageScrollerButton />
//     </MessageScroller>
//   </MessageScrollerProvider>
//
// The viewport is the transcript's named `log`, which the keys scroll. It is quiet
// (`aria-live="off"`): rows drawn by a scroll and words streaming in are not news. New rows are said
// once each, by count, through the page's one live region. Every value is a token. A caller may set
// layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  isValidElement,
  use,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode, RefObject } from "react";

import { scrollEdgesOf, useScrollEdges } from "../hooks/use-scroll-edges";
import { useI18n } from "../lib/i18n";
import { ArrowDownIcon, Icon } from "../lib/icons";
import { createStickToBottom } from "../lib/stick-to-bottom";
import type { StickToBottom } from "../lib/stick-to-bottom";
import { focusCarrier, scrollbarHidden } from "../lib/styles";
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
import { announce, listOf, nothing } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";
import { Button } from "./button";
import type { ButtonSize, ButtonVariant } from "./button";

/** Where the transcript opens: its first row, its last, or the last turn that starts with an anchor. */
export type MessageScrollerPosition = "start" | "end" | "last-anchor";

/** Every prop a MessageScrollerProvider takes. */
export interface MessageScrollerProviderProps {
  /** Its MessageScroller, and any control that drives it through the hooks. */
  children: ReactNode;
  /**
   * Follow new content while the reader is at the end. Wheel, touch, a key up, the scrollbar and a
   * jump to a message let go; reaching the end again, or `scrollToEnd`, follows again.
   * @default false
   */
  autoScroll?: boolean;
  /**
   * Where it opens, once: `end` at the latest row, standing there before scripts run;
   * `last-anchor` at the last `scrollAnchor` row with what follows it under it (the end when that
   * fits, or there is no anchor), hidden until placed; `start` at the first row.
   * @default "end"
   */
  defaultScrollPosition?: MessageScrollerPosition;
  /**
   * How near an edge, in pixels, still counts as at it: for following, the edge fades, the button
   * and `useMessageScrollerScrollable`.
   * @default 8
   */
  scrollEdgeThreshold?: number;
  /**
   * Room, in pixels, kept at the edge a row is brought to: by `scrollToMessage`, for the reading
   * line of `useMessageScrollerVisibility`, and above a newly sent turn.
   * @default 0
   */
  scrollMargin?: number;
  /**
   * How much of the row before a newly sent turn stays in view above it, in pixels, added to
   * `scrollMargin`. Left out, it is the top's fade, so the sent turn stands whole below it.
   * @default the space-16 token (64px)
   */
  scrollPreviousItemPeek?: number;
  /**
   * The whole transcript is loading: the log is busy, says so once, and does not scroll. Draw
   * placeholder rows meanwhile. When it turns false the rows that come stand at the opening
   * position, with no fade and nothing said as new.
   * @default false
   */
  loading?: boolean;
}

/** Every prop a MessageScroller takes. */
export interface MessageScrollerProps {
  /** Its MessageScrollerViewport, then its MessageScrollerButton. */
  children: ReactNode;
  /** Its size and where it sits. It fills its parent's height. */
  style?: LayoutStyle;
}

/** Every prop a MessageScrollerViewport takes. */
export interface MessageScrollerViewportProps {
  /** Its MessageScrollerContent. */
  children: ReactNode;
  /**
   * The log's name, as a screen reader and an agent say it ("Conversation with the assistant").
   * @default the catalogue's messageScroller.label ("Messages")
   */
  "aria-label"?: string;
  /** The id of an element whose words name it (the chat's heading), in place of `aria-label`. */
  "aria-labelledby"?: string;
  /**
   * Keep what the reader is looking at in place when rows are drawn above it (older messages
   * loaded, a row above measured), while it is not following the end. A log with `autoScroll`
   * always does.
   * @default true
   */
  preserveScrollOnPrepend?: boolean;
  /** Its id. */
  id?: string;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a MessageScrollerContent takes. */
export interface MessageScrollerContentProps {
  /** The rows, oldest first: each a MessageScrollerItem with a `key`, or what stands in their place (an empty state). */
  children: ReactNode;
  /** The log is busy, as while a turn streams. */
  "aria-busy"?: boolean;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a MessageScrollerItem takes. */
export interface MessageScrollerItemProps {
  /** One row: a message, a divider, a card, a placeholder. */
  children: ReactNode;
  /** Its id, for `scrollToMessage` and `useMessageScrollerVisibility`, and to tell rows apart. Stable. */
  messageId?: string;
  /**
   * The row starts a turn, as the person's own message does. Appended after it opened, it goes to
   * the top with room under it for the answer; it is not said as news (it is the person's own); and
   * `last-anchor` opens at the last one.
   * @default false
   */
  scrollAnchor?: boolean;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a MessageScrollerButton takes. */
export interface MessageScrollerButtonProps {
  /**
   * Which end it brings the reader to: `end`, the latest, under the log; `start`, the first, over it.
   * It shows while there is more that way.
   * @default "end"
   */
  direction?: "start" | "end";
  /**
   * How it scrolls there. Smooth becomes at once with reduced motion.
   * @default "smooth"
   */
  behavior?: ScrollBehavior;
  /**
   * Button's variant.
   * @default "outline"
   */
  variant?: ButtonVariant;
  /**
   * Button's size. An icon size draws the arrow alone, named by the words.
   * @default "sm"
   */
  size?: ButtonSize;
  /**
   * Its own words, in place of the catalogue's ("Jump to latest"). With `asChild`, the one element
   * drawn as the button.
   */
  children?: ReactNode;
  /**
   * Draws its one child element as the button, with the button's look and behaviour.
   * @default false
   */
  asChild?: boolean;
  /** Where it sits in its row. */
  style?: LayoutStyle;
}

/** How a command scrolls. */
export interface MessageScrollerScrollOptions {
  /**
   * Where a message lands in the view.
   * @default "start"
   */
  align?: "start" | "center" | "end" | "nearest";
  /**
   * How it scrolls there. Smooth becomes at once with reduced motion.
   * @default "auto"
   */
  behavior?: ScrollBehavior;
  /**
   * Room kept at the edge it lands at, in pixels.
   * @default the provider's scrollMargin
   */
  scrollMargin?: number;
}

/** What `useMessageScroller` gives: commands that drive the transcript from anywhere in the provider. */
export interface MessageScrollerCommands {
  /** Brings the row with this `messageId` into view and lets go of the end. False when it is not drawn. */
  scrollToMessage: (
    messageId: string,
    options?: MessageScrollerScrollOptions
  ) => boolean;
  /** Goes to the latest row, and follows again with `autoScroll`. False before the viewport is drawn. */
  scrollToEnd: (options?: MessageScrollerScrollOptions) => boolean;
  /** Goes to the first row and lets go of the end. False before the viewport is drawn. */
  scrollToStart: (options?: MessageScrollerScrollOptions) => boolean;
}

/** What `useMessageScrollerScrollable` gives: which ways there is more to scroll. */
export interface MessageScrollerScrollable {
  /** There are rows above the view. */
  start: boolean;
  /** There are rows below the view. False while it follows the end. */
  end: boolean;
}

/** What `useMessageScrollerVisibility` gives: where the reader is. */
export interface MessageScrollerVisibility {
  /** The last `scrollAnchor` row at or above the top of the view (the turn being read), or null. */
  currentAnchorId: string | null;
  /** The `messageId` of every row in view, in order. */
  visibleMessageIds: string[];
}

const REDUCED = media.reducedMotion;

// The fade at an edge with more rows past it: space-16 tall, clear for only the last space-1, so a
// row cut there dissolves over most of a message's height, not in a thin band before the edge.
const fadeTop = `transparent ${space["1"]}, black ${space["16"]}`;
const fadeBottom = `black calc(100% - ${space["16"]}), transparent calc(100% - ${space["1"]})`;

// A row arriving: it fades in, a little lower first; with reduced motion it is simply there.
const arrive = stylex.keyframes({
  from: { opacity: 0, transform: `translateY(${space["2"]})` },
  to: { opacity: 1, transform: "none" },
});
const fade = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const styles = stylex.create({
  root: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "grid",
    // "Jump to start" in a row over the log, the log, and "Jump to latest" in a row under it, each
    // only while the reader is away from that end: a button never lies over a row, and the view
    // gives way to make room for it.
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    height: "100%",
    minHeight: 0,
    fontFamily: font.sans,
    // The keyboard's ring is drawn here, round the log, while the log has the focus: with the
    // corners of the box it stands in (the log itself is square, and a ring on it broke at a
    // rounded box's corners). Its own layer, so the ring is drawn last.
    isolation: "isolate",
    borderRadius: "inherit",
    cornerShape: "inherit",
    outlineWidth: size.ringWidth,
    outlineColor: colors.ring,
    outlineStyle: { default: "none", ":has(> :focus-visible)": "solid" },
    outlineOffset: `calc(-1 * ${size.ringWidth})`,
  },
  // The log: it holds the rows, and the keys scroll it. An edge with rows past it fades out
  // (`data-scrollable` marks it), so a row is never cut hard at the edge. No transition: the fade
  // is there or not as the scroll moves. Forced colours keep it: a mask only fades what it covers.
  viewport: {
    gridRow: 2,
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "auto",
    borderRadius: "inherit",
    cornerShape: "inherit",
    maskImage: {
      default: null,
      ":is([data-scrollable='start'])": `linear-gradient(to bottom, ${fadeTop}, black)`,
      ":is([data-scrollable='end'])": `linear-gradient(to bottom, ${fadeBottom})`,
      ":is([data-scrollable='start end'])": `linear-gradient(to bottom, ${fadeTop}, ${fadeBottom})`,
    },
  },
  // While the transcript loads: nothing to scroll to, the placeholders stand at the foot.
  still: {
    overflowY: "hidden",
  },
  // Before it is alive it already stands at its end: a column that runs upward starts its scroll at
  // the end, with no script. The rows inside keep their order, and a transcript shorter than its
  // view still starts at the top.
  opening: {
    display: "flex",
    flexDirection: "column-reverse",
  },
  // Opening at the last anchor: hidden until placed there, so the reader never sees it jump.
  pending: {
    visibility: "hidden",
  },
  // The rows, in their natural flow, at least as tall as the view, so an empty state fills it.
  content: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    boxSizing: "border-box",
    minHeight: "100%",
    marginBlockEnd: "auto",
  },
  item: {
    boxSizing: "border-box",
    width: "100%",
    paddingInline: space["4"],
    paddingBlock: space["2"],
    // A row out of view is not laid out or drawn; once drawn it keeps its size while it is away.
    contentVisibility: "auto",
    containIntrinsicSize: "auto 96px",
  },
  arriving: {
    animationName: { default: arrive, [REDUCED]: "none" },
    animationDuration: duration.ui,
    animationTimingFunction: duration.ease,
    animationFillMode: "backwards",
  },
  // A jump, in its own row by the log, while the reader is away from its end.
  jump: {
    display: "flex",
    justifyContent: "center",
    paddingBlock: space["2"],
    pointerEvents: "none",
    animationName: { default: fade, [REDUCED]: "none" },
    animationDuration: duration.ui,
    animationTimingFunction: duration.ease,
  },
  jumpStart: { gridRow: 1 },
  jumpEnd: { gridRow: 3 },
  // Its own raised ground under the button, with the low lift, so the rows never show through it.
  // The button's corner, so the two read as one.
  jumpButton: {
    display: "inline-flex",
    pointerEvents: "auto",
    borderRadius: `min(${radius.xl}, calc(${size.controlSm} / 2))`,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
  },
  // The arrow points up for the way to the start.
  up: {
    display: "inline-flex",
    transform: "rotate(180deg)",
  },
});

// Where a row brought into view stands (a row the keyboard's focus reaches, the sent turn at the
// top): `scrollMargin` and the peek of the row before it below the top. The room kept under a sent
// turn makes the rows at least as tall as puts that turn there, so the answer under it grows into
// space.
const places = stylex.create({
  offset: (offset: string) => ({
    scrollPaddingTop: offset,
  }),
  room: (start: string, offset: string) => ({
    minHeight: `calc(${start} + 100% - ${offset})`,
  }),
});

/** A small store of which ways there is more to scroll, read by the hook and the buttons. */
interface Edges {
  get: () => MessageScrollerScrollable;
  set: (next: MessageScrollerScrollable) => void;
  subscribe: (listener: () => void) => () => void;
}

const createEdges = (): Edges => {
  let value: MessageScrollerScrollable = { start: false, end: false };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next.start === value.start && next.end === value.end) {
        return;
      }
      value = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

interface ScrollerState {
  stick: StickToBottom;
  edges: Edges;
  autoScroll: boolean;
  position: MessageScrollerPosition;
  threshold: number;
  margin: number;
  /** The scroll padding at the top, as CSS: the margin and the peek. */
  offset: string;
  loading: boolean;
  viewport: HTMLDivElement | null;
  setViewport: (element: HTMLDivElement | null) => void;
  mounted: boolean;
  setMounted: (mounted: boolean) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  lastKey: string | undefined;
  setLastKey: (key: string | undefined) => void;
}

const ScrollerContext = createContext<ScrollerState | null>(null);

const useScroller = (part: string): ScrollerState => {
  const state = use(ScrollerContext);
  if (state === null) {
    throw new Error(`${part} must be inside a MessageScrollerProvider.`);
  }
  return state;
};

/** What Content tells each row: whether it is new, and the ref of the sent turn. */
interface Row {
  /** The row's key in Content. */
  key: string;
  arriving: boolean;
  anchorRef: RefObject<HTMLDivElement | null> | undefined;
  /** Where each row says whether it starts a turn, read by Content after the rows are drawn. */
  anchors: RefObject<Map<string, boolean>> | undefined;
}

const RowContext = createContext<Row>({
  key: "",
  arriving: false,
  anchorRef: undefined,
  anchors: undefined,
});

/** Does it now, and again a frame later, as the first rows drawn can change the height. */
const nowAndNextFrame = (go: () => void) => {
  go();
  const frame = requestAnimationFrame(go);
  return () => {
    cancelAnimationFrame(frame);
  };
};

/** Smooth, unless the reader asked for less motion. */
const motionOf = (behavior: ScrollBehavior): ScrollBehavior =>
  behavior === "smooth" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : behavior;

/**
 * Marks which ways the log has rows past it, straight on the element and the frame round it
 * (`data-scrollable`), so a scroll never renders, and tells the store. While it follows the end
 * there is nothing below to show.
 */
const markEdges = ({
  viewport: element,
  threshold,
  stick,
  autoScroll,
  edges,
}: Pick<ScrollerState, "threshold" | "stick" | "autoScroll" | "edges"> & {
  viewport: HTMLElement | null;
}) => {
  if (element === null) {
    return;
  }
  const found = scrollEdgesOf(element, "block", threshold);
  const following = autoScroll && stick.get().following;
  const { start } = found;
  const end = !following && found.end;
  const value = [start && "start", end && "end"].filter(Boolean).join(" ");
  const frame = element.parentElement;
  // Written only when it changes: an attribute written, even to what it was, has the page work
  // out its styles again, and this runs on every scroll.
  for (const each of frame?.dataset.slot === "message-scroller"
    ? [element, frame]
    : [element]) {
    if ((each.dataset.scrollable ?? "") === value) {
      continue;
    }
    if (value === "") {
      delete each.dataset.scrollable;
    } else {
      each.dataset.scrollable = value;
    }
  }
  edges.set({ start, end });
};

/** Whether a Button size draws the icon alone. */
const iconOnly = (
  each: ButtonSize
): each is Extract<ButtonSize, `icon${string}`> => each.startsWith("icon");

/** The rows of the log, each a MessageScrollerItem drawn by Content. */
const rowsOf = (element: HTMLElement) =>
  element.querySelectorAll<HTMLElement>(":scope > * > [data-message-id]");

/**
 * Goes to the end: the follower, which follows again (gliding there when smooth, at once with
 * reduced motion), or the scroll alone without `autoScroll`.
 */
type Follow = Pick<ScrollerState, "viewport" | "stick" | "autoScroll">;

const toEnd = (
  { viewport, stick, autoScroll }: Follow,
  behavior: ScrollBehavior = "auto"
) => {
  if (autoScroll) {
    stick.scrollToBottom({ behavior });
  } else {
    viewport?.scrollTo({
      top: viewport.scrollHeight,
      behavior: motionOf(behavior),
    });
  }
};

/** Puts the log at its opening position. */
const open = (follow: Follow, position: MessageScrollerPosition) => {
  const { viewport: element, stick } = follow;
  if (element === null || position === "start") {
    return;
  }
  const anchors = element.querySelectorAll<HTMLElement>(
    ":scope > * > [data-scroll-anchor='true']"
  );
  const last = anchors.item(anchors.length - 1);
  if (position === "last-anchor" && last !== null) {
    const top =
      last.getBoundingClientRect().top -
      element.getBoundingClientRect().top +
      element.scrollTop;
    // The turn does not fit: its anchor stands at the top, where a sent turn stands.
    if (element.scrollHeight - top > element.clientHeight) {
      stick.release();
      // The scroll padding is a computed length, in pixels ("64px").
      // oxlint-disable-next-line unicorn/prefer-number-coercion -- Number() reads no unit
      const padding = Number.parseFloat(
        getComputedStyle(element).scrollPaddingTop
      );
      element.scrollTop = top - padding;
      return;
    }
  }
  toEnd(follow);
};

/** A row's key: its `messageId`, else the key its caller gave, else its place. */
const keyOf = (child: ReactNode, index: number) => {
  if (!isValidElement<{ messageId?: unknown }>(child)) {
    return `#${index}`;
  }
  const { messageId } = child.props;
  if (typeof messageId === "string") {
    return messageId;
  }
  return child.key ?? `#${index}`;
};

/** Which rows have come since it opened. */
interface News {
  /** The rows there when it opened (or finished loading), and older ones drawn above: they never fade in. */
  start: ReadonlySet<string>;
  /** Every row seen so far. */
  known: ReadonlySet<string>;
  /** The rows that arrived after the last one known, in order, since it opened. */
  arrived: readonly string[];
  /** The rows of the last draw. */
  last: readonly string[];
  /** How many times another conversation has been put in its place: each is opened afresh. */
  opened: number;
}

const newsFrom = (keys: readonly string[], opened = 0): News => ({
  start: new Set(keys),
  known: new Set(keys),
  arrived: [],
  last: keys,
  opened,
});

/** Whether the rows are another conversation's: none of them was in the last draw. */
const isReplaced = (last: readonly string[], keys: readonly string[]) => {
  if (last.length === 0 || keys.length === 0) {
    return false;
  }
  const before = new Set(last);
  return keys.every((key) => !before.has(key));
};

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * The headless root: it owns where the transcript stands and how it follows, for its parts and
 * the hooks. It draws nothing of its own.
 */
export const MessageScrollerProvider = ({
  children,
  autoScroll = false,
  defaultScrollPosition = "end",
  scrollEdgeThreshold = 8,
  scrollMargin = 0,
  scrollPreviousItemPeek,
  loading = false,
}: MessageScrollerProviderProps) => {
  // oxlint-disable-next-line react/hook-use-state -- a follower made once, never replaced
  const [stick] = useState(() =>
    createStickToBottom({
      initial: defaultScrollPosition === "end",
      threshold: scrollEdgeThreshold,
    })
  );
  // oxlint-disable-next-line react/hook-use-state -- a store made once, never replaced
  const [edges] = useState(createEdges);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastKey, setLastKey] = useState<string | undefined>();
  const peek =
    scrollPreviousItemPeek === undefined
      ? space["16"]
      : `${scrollPreviousItemPeek}px`;
  const state: ScrollerState = {
    stick,
    edges,
    autoScroll,
    position: defaultScrollPosition,
    threshold: scrollEdgeThreshold,
    margin: scrollMargin,
    offset: `calc(${scrollMargin}px + ${peek})`,
    loading,
    viewport,
    setViewport,
    mounted,
    setMounted,
    busy,
    setBusy,
    lastKey,
    setLastKey,
  };
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <ScrollerContext value={state}>{children}</ScrollerContext>
  );
};

/** The frame: the log, with a jump over and under it. It fills its parent's height. */
export const MessageScroller = ({ children, style }: MessageScrollerProps) => (
  <div data-slot="message-scroller" {...stylex.props(styles.root, style)}>
    {children}
  </div>
);

/** The log itself: the element that scrolls, named, which the keys reach. */
export const MessageScrollerViewport = ({
  children,
  "aria-label": label,
  "aria-labelledby": labelledBy,
  preserveScrollOnPrepend = true,
  id,
  style,
}: MessageScrollerViewportProps) => {
  const {
    stick,
    edges,
    autoScroll,
    position,
    threshold,
    offset,
    loading,
    viewport,
    setViewport,
    mounted,
    setMounted,
    busy,
  } = useScroller("MessageScrollerViewport");
  const words = useI18n().messageScroller;

  // Follow the end from the moment it is on the page, with `autoScroll`; it then leaves its
  // opening layout.
  useLayoutEffect(() => {
    if (viewport === null) {
      return nothing;
    }
    const disconnect = autoScroll ? stick.connect(viewport) : nothing;
    setMounted(true);
    return () => {
      disconnect();
      setMounted(false);
    };
  }, [viewport, autoScroll, stick, setMounted]);

  // Stand at the opening position, twice, a frame apart; and again once a loading transcript has
  // come.
  useLayoutEffect(
    () =>
      mounted && !loading
        ? nowAndNextFrame(() => {
            open({ viewport, stick, autoScroll }, position);
          })
        : nothing,
    [mounted, loading, viewport, stick, autoScroll, position]
  );

  // Away from the end, what the reader looks at stays in place as rows above it are drawn and
  // measured. A log that follows its end (`autoScroll`) has the follower hold it, at the very top
  // too; any other has the browser's own anchoring. Never both: together they moved the log twice
  // as far, to its end.
  useLayoutEffect(() => {
    viewport?.style.setProperty(
      "overflow-anchor",
      !autoScroll && preserveScrollOnPrepend ? "auto" : "none"
    );
  }, [autoScroll, preserveScrollOnPrepend, viewport]);

  // A scroll, or the log or its rows changing size, changes what lies past each edge.
  const watchEdges = useScrollEdges({
    axis: "block",
    threshold,
    onChange: (_, element) => {
      markEdges({ viewport: element, threshold, stick, autoScroll, edges });
    },
  });

  // The follower letting go or following again changes what lies below.
  useEffect(
    () =>
      stick.subscribe(() => {
        markEdges({ viewport, threshold, stick, autoScroll, edges });
      }),
    [viewport, threshold, stick, autoScroll, edges]
  );

  return (
    <div
      ref={(node) => {
        setViewport(node);
        return watchEdges(node);
      }}
      id={id}
      role="log"
      // Quiet: rows drawn by a scroll and words streaming in are not news. New rows are said once
      // each, through the page's live region.
      aria-live="off"
      aria-label={labelledBy === undefined ? (label ?? words.label) : label}
      aria-labelledby={labelledBy}
      aria-busy={loading || busy || undefined}
      // The log takes focus, so the keys scroll it: the arrows, Page Up and Down, Space.
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroller the keys must reach
      tabIndex={0}
      data-slot="message-scroller-viewport"
      data-pending-scroll={(!mounted && position !== "start") || undefined}
      {...stylex.props(
        styles.viewport,
        places.offset(offset),
        scrollbarHidden,
        focusCarrier,
        !mounted && position === "end" && styles.opening,
        !mounted && position === "last-anchor" && styles.pending,
        loading && styles.still,
        style
      )}
    >
      {children}
    </div>
  );
};

/** The rows, in order: it fades new ones in, says them, and keeps room under a sent turn. */
export const MessageScrollerContent = ({
  children,
  "aria-busy": ariaBusy = false,
  style,
}: MessageScrollerContentProps) => {
  const state = useScroller("MessageScrollerContent");
  const {
    stick,
    autoScroll,
    position,
    offset,
    loading,
    viewport,
    mounted,
    setBusy,
    setLastKey,
  } = state;
  const words = useI18n().messageScroller;
  const flow = useRef<HTMLDivElement | null>(null);
  const anchorRow = useRef<HTMLDivElement | null>(null);

  const rows = listOf(children);
  const keys = rows.map(keyOf);
  const lastKey = keys.at(-1);
  // Whether each row starts a turn, as its MessageScrollerItem says once drawn.
  const anchors = useRef(new Map<string, boolean>());

  // The news: made with the rows there when it opens, or when loading ends; rows seen for the first
  // time after that, past the last one known, have arrived. Older rows drawn above the known ones
  // (reading back) have not: they neither fade in nor are said.
  const [news, setNews] = useState<News | null>(() =>
    loading ? null : newsFrom(keys)
  );
  if (loading && news !== null) {
    setNews(null);
  } else if (!loading && news === null) {
    setNews(newsFrom(keys));
  } else if (news !== null && !sameIds(news.last, keys)) {
    // Another conversation in its place (the caller swapped every row, the provider kept): opened
    // afresh, so none of its rows fades in or is said.
    const fresh = keys.filter((key) => !news.known.has(key));
    if (isReplaced(news.last, keys)) {
      setNews(newsFrom(keys, news.opened + 1));
    } else if (fresh.length > 0) {
      const after = keys.slice(
        keys.findLastIndex((key) => news.known.has(key)) + 1
      );
      setNews({
        start: new Set([
          ...news.start,
          ...fresh.filter((key) => !after.includes(key)),
        ]),
        known: new Set([...news.known, ...fresh]),
        arrived: [...news.arrived, ...after],
        last: keys,
        opened: news.opened,
      });
    } else {
      setNews({ ...news, last: keys });
    }
  }

  // The sent turn: the last row that starts a turn and came after it opened, read once the rows
  // are drawn and have said which they are.
  const [anchor, setAnchor] = useState<string | undefined>();
  useLayoutEffect(() => {
    setAnchor(
      news === null
        ? undefined
        : keys.findLast(
            (key) => anchors.current.get(key) === true && !news.start.has(key)
          )
    );
  }, [keys, news]);

  useLayoutEffect(() => {
    setBusy(ariaBusy);
  }, [ariaBusy, setBusy]);

  // Another conversation put in its place stands at the opening position, as one just opened.
  const opened = news?.opened ?? 0;
  useLayoutEffect(
    () =>
      opened > 0
        ? nowAndNextFrame(() => {
            open({ viewport, stick, autoScroll }, position);
          })
        : nothing,
    [opened, viewport, stick, autoScroll, position]
  );

  // Rows that came, grew or left, and a view that changed height, without a scroll: the edges are
  // marked again. An attribute, not state: its mask moves nothing, so nothing renders again.
  useLayoutEffect(() => {
    markEdges(state);
  });

  useEffect(() => {
    setLastKey(lastKey);
  }, [lastKey, setLastKey]);

  // New rows are said once each, by how many came since the last were said, all but the person's
  // own turns, which are not news to them (sending and its answer say "1 new message", not 2);
  // streaming words never are.
  const { arrived: arrivedWords, loading: loadingWords } = words;
  const arrived = news?.arrived;
  const told = useRef<readonly string[] | null>(null);
  useEffect(() => {
    const before = told.current;
    told.current = arrived ?? null;
    if (arrived === undefined || before === null) {
      return;
    }
    const since = arrived
      .slice(before.length)
      .filter((key) => anchors.current.get(key) !== true).length;
    if (since > 0) {
      announce(arrivedWords(since));
    }
  }, [arrived, arrivedWords]);
  useEffect(() => {
    if (loading) {
      announce(loadingWords);
    }
  }, [loading, loadingWords]);

  // The sent turn at the top: the room under it is reckoned from where it starts, when the log has
  // a height of its own (a log only as tall as its rows has no view to keep room in), and again
  // whenever the rows or the view change size (a row above it measured, the window resized).
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const rowsBox = flow.current;
    const row = anchorRow.current;
    if (
      anchor === undefined ||
      viewport === null ||
      rowsBox === null ||
      row === null
    ) {
      setRoom(null);
      return nothing;
    }
    const measure = () => {
      // A log as tall as its rows, to within 2px, has no height of its own.
      const { top } = rowsBox.getBoundingClientRect();
      const end =
        rowsBox.lastElementChild?.getBoundingClientRect().bottom ?? top;
      const own = Math.abs(viewport.clientHeight - (end - top)) > 2;
      const start = row.getBoundingClientRect().top - top;
      setRoom(own ? start : null);
    };
    measure();
    const sizes = new ResizeObserver(measure);
    sizes.observe(rowsBox);
    sizes.observe(viewport);
    return () => {
      sizes.disconnect();
    };
  }, [anchor, viewport]);

  // When the person sends, the log glides to its end, which the kept room makes the place where
  // that turn stands at the top. Once for each sent turn, so reading back is never undone.
  const sentDone = useRef<string | null>(null);
  useEffect(() => {
    if (!mounted || anchor === undefined || sentDone.current === anchor) {
      return nothing;
    }
    sentDone.current = anchor;
    return nowAndNextFrame(() => {
      toEnd({ viewport, stick, autoScroll }, autoScroll ? "smooth" : "auto");
    });
  }, [anchor, mounted, viewport, stick, autoScroll]);

  return (
    <div
      ref={flow}
      data-slot="message-scroller-content"
      {...stylex.props(
        styles.content,
        room !== null && places.room(`${room}px`, offset),
        style
      )}
    >
      {rows.map((child, index) => {
        const key = keys[index] ?? `#${index}`;
        return (
          <RowContext
            key={key}
            // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
            value={{
              key,
              arriving: news !== null && !news.start.has(key),
              anchorRef: key === anchor ? anchorRow : undefined,
              anchors,
            }}
          >
            {child}
          </RowContext>
        );
      })}
    </div>
  );
};

/** One row of the transcript: a message, a divider, a card. */
export const MessageScrollerItem = ({
  children,
  messageId,
  scrollAnchor = false,
  style,
}: MessageScrollerItemProps) => {
  const { key, arriving, anchorRef, anchors } = use(RowContext);
  // Tells Content whether this row starts a turn, before Content reads it.
  useLayoutEffect(() => {
    const seen = anchors?.current;
    seen?.set(key, scrollAnchor);
    return () => {
      seen?.delete(key);
    };
  }, [anchors, key, scrollAnchor]);
  return (
    <div
      ref={anchorRef}
      data-slot="message-scroller-item"
      data-message-id={messageId}
      data-scroll-anchor={scrollAnchor}
      {...stylex.props(styles.item, arriving && styles.arriving, style)}
    >
      {children}
    </div>
  );
};

/** The way to an end, while the reader is away from it: toward the latest it says when a row came since. */
const Jump = ({
  direction = "end",
  behavior = "smooth",
  variant = "outline",
  size: buttonSize = "sm",
  children,
  asChild = false,
  style,
}: MessageScrollerButtonProps) => {
  const { stick, viewport, autoScroll, lastKey } = useScroller(
    "MessageScrollerButton"
  );
  const words = useI18n().messageScroller;
  // Where the reader left the latest, so the way back can say a row came in since.
  // oxlint-disable-next-line react/hook-use-state -- noted once, as the reader leaves
  const [leftAt] = useState(lastKey);
  const toStart = direction === "start";
  let label = words.scrollToEnd;
  if (toStart) {
    label = words.scrollToStart;
  } else if (lastKey !== leftAt) {
    label = words.jumpToNew(words.scrollToEnd);
  }
  const arrow = toStart ? (
    <span {...stylex.props(styles.up)}>
      <Icon icon={ArrowDownIcon} />
    </span>
  ) : (
    <Icon icon={ArrowDownIcon} />
  );
  const go = () => {
    if (toStart) {
      stick.release();
      viewport?.scrollTo({ top: 0, behavior: motionOf(behavior) });
    } else {
      toEnd({ viewport, stick, autoScroll }, behavior);
    }
    // The button goes once at the end; focus goes to the log, not the page.
    viewport?.focus({ preventScroll: true });
  };
  let button: ReactNode;
  if (asChild) {
    button = iconOnly(buttonSize) ? (
      <Button
        variant={variant}
        size={buttonSize}
        aria-label={label}
        asChild
        onClick={go}
      >
        {children}
      </Button>
    ) : (
      <Button variant={variant} size={buttonSize} asChild onClick={go}>
        {children}
      </Button>
    );
  } else {
    button = iconOnly(buttonSize) ? (
      <Button
        variant={variant}
        size={buttonSize}
        aria-label={typeof children === "string" ? children : label}
        onClick={go}
      >
        {arrow}
      </Button>
    ) : (
      <Button variant={variant} size={buttonSize} onClick={go}>
        {arrow}
        {children ?? label}
      </Button>
    );
  }
  return (
    <div
      data-slot="message-scroller-button"
      data-direction={direction}
      {...stylex.props(
        styles.jump,
        toStart ? styles.jumpStart : styles.jumpEnd,
        style
      )}
    >
      <span {...stylex.props(styles.jumpButton)}>{button}</span>
    </div>
  );
};

/** "Jump to latest", in a row under the log (or "Jump to start" over it), while the reader is away from that end. */
export const MessageScrollerButton = (props: MessageScrollerButtonProps) => {
  const { edges, mounted } = useScroller("MessageScrollerButton");
  const { start, end } = useSyncExternalStore(
    edges.subscribe,
    edges.get,
    edges.get
  );
  // The row comes and goes a render later than the edges do: they change inside the observers'
  // round, and a row coming or going there resizes the log in the same round, which the browser
  // reports as a ResizeObserver loop.
  const away = useDeferredValue(props.direction === "start" ? start : end);
  return mounted && away ? <Jump {...props} /> : null;
};

/** Commands that drive the transcript from anywhere inside the provider: a search, an outline, a permalink. */
export const useMessageScroller = (): MessageScrollerCommands => {
  const { stick, viewport, autoScroll, margin } =
    useScroller("useMessageScroller");
  return {
    scrollToMessage: (messageId, options = {}) => {
      const row =
        viewport === null
          ? undefined
          : [...rowsOf(viewport)].find(
              (each) => each.dataset.messageId === messageId
            );
      if (viewport === null || row === undefined) {
        return false;
      }
      const { align = "start", behavior = "auto" } = options;
      const gap = options.scrollMargin ?? margin;
      const top =
        row.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop;
      const bottom = top + row.offsetHeight;
      const view = viewport.clientHeight;
      const above = top - gap < viewport.scrollTop;
      const below = bottom + gap > viewport.scrollTop + view;
      if (align === "nearest" && !above && !below) {
        return true;
      }
      let to = top - gap;
      if (align === "center") {
        to = top + row.offsetHeight / 2 - view / 2;
      } else if (align === "end" || (align === "nearest" && !above)) {
        to = bottom - view + gap;
      }
      stick.release();
      viewport.scrollTo({ top: to, behavior: motionOf(behavior) });
      return true;
    },
    scrollToEnd: (options = {}) => {
      if (viewport === null) {
        return false;
      }
      toEnd({ viewport, stick, autoScroll }, options.behavior);
      return true;
    },
    scrollToStart: (options = {}) => {
      if (viewport === null) {
        return false;
      }
      stick.release();
      viewport.scrollTo({
        top: 0,
        behavior: motionOf(options.behavior ?? "auto"),
      });
      return true;
    },
  };
};

/** Which ways there is more to scroll, for a control beside the transcript. */
export const useMessageScrollerScrollable = (): MessageScrollerScrollable => {
  const { edges } = useScroller("useMessageScrollerScrollable");
  return useSyncExternalStore(edges.subscribe, edges.get, edges.get);
};

const NOWHERE: MessageScrollerVisibility = {
  currentAnchorId: null,
  visibleMessageIds: [],
};

/**
 * Where the reader is: the turn being read and the rows in view, for an outline or a jump menu.
 * It reads the rows only while something uses it, once a frame as the log scrolls or resizes.
 */
export const useMessageScrollerVisibility = (): MessageScrollerVisibility => {
  const { viewport, margin } = useScroller("useMessageScrollerVisibility");
  const [seen, setSeen] = useState(NOWHERE);
  useEffect(() => {
    if (viewport === null) {
      return nothing;
    }
    let frame = 0;
    const read = () => {
      frame = 0;
      const view = viewport.getBoundingClientRect();
      const line = view.top + margin + 1;
      const visibleMessageIds: string[] = [];
      let currentAnchorId: string | null = null;
      for (const row of rowsOf(viewport)) {
        const id = row.dataset.messageId ?? "";
        const box = row.getBoundingClientRect();
        if (box.bottom > view.top && box.top < view.bottom) {
          visibleMessageIds.push(id);
        }
        if (row.dataset.scrollAnchor === "true" && box.top <= line) {
          currentAnchorId = id;
        }
      }
      setSeen((was) =>
        was.currentAnchorId === currentAnchorId &&
        sameIds(was.visibleMessageIds, visibleMessageIds)
          ? was
          : { currentAnchorId, visibleMessageIds }
      );
    };
    const soon = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(read);
      }
    };
    read();
    viewport.addEventListener("scroll", soon, { passive: true });
    const sizes = new ResizeObserver(soon);
    sizes.observe(viewport);
    if (viewport.firstElementChild !== null) {
      sizes.observe(viewport.firstElementChild);
    }
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", soon);
      sizes.disconnect();
    };
  }, [viewport, margin]);
  return seen;
};
