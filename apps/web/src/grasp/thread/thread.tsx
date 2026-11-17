// Thread: the scrolling list that holds a conversation's messages. It stays at the bottom while
// the agent writes, unless the person has scrolled up; then it stays put, and "Jump to latest"
// appears. New messages fade in, and nothing on screen jumps: older messages load at the top
// without moving what is in view. Date lines where the day changes, an "Unread" line before the
// first unread message, and only the rows in view drawn, however long the thread. It draws any
// message the caller gives it (`renderItem`). Learned from Slack's and ChatGPT's threads: follow
// the end, keep the reader's place, offer the way back down. Built on UI SDK's
// createStickToBottom and createVirtualizer. There is no shadcn or Palermo original.
//
//   <Thread
//     aria-label="Conversation with the research agent"
//     items={messages}
//     renderItem={(message) => <ChatMessage {...message} />}
//     unreadFrom={firstUnreadId}
//     hasOlder onLoadOlder={loadOlder}
//   />
//
// Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import { createStickToBottom, createVirtualizer } from "@ui-sdk/core";
import type { StickToBottom, Virtualizer } from "@ui-sdk/core";
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode, RefObject } from "react";

import { Button } from "../button";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { ArrowDown, Icon, Spinner } from "../icons";
import { scroll } from "../scroll/scroll";
import { dayWritten, rowsOf } from "./rows";
import type { ThreadItemBase, ThreadRow } from "./rows";
import { threadPlaces as places, threadStyles as styles } from "./styles";

/** The words the thread writes itself: its lines, its status words and the days. */
export interface ThreadWords {
  /** The line before the first unread message, as it is seen and as it is said. */
  unread: string;
  unreadFrom: string;
  /** While older messages load at the top. */
  loadingOlder: string;
  /** The way back down when a message has come in since the reader left, from `jumpLabel`. */
  jumpToNew: (jumpLabel: string) => string;
  /** What a screen reader hears for the messages that came in, from their count. */
  arrived: (count: number) => string;
  today: string;
  yesterday: string;
  /** A day further back, as it is written; `sameYear` is false for a day in another year. */
  day: (day: Date, sameYear: boolean) => string;
}

/** Every prop a Thread takes. */
export interface ThreadProps<T extends ThreadItemBase> {
  /** The messages, oldest first. Each has an `id`, and an `at` for its date line. */
  items: T[];
  /** Draws one message: the caller's own message component. */
  renderItem: (item: T, index: number) => ReactNode;
  /** Its name, as a screen reader and an agent say it ("Conversation with the research agent"). */
  "aria-label": string;
  /** The id of the first message the person has not read: an "Unread" line stands before it. */
  unreadFrom?: string;
  /** There are older messages to load at the top. */
  hasOlder?: boolean;
  /**
   * Loads older messages when the person nears the top. Add them to the start of `items`; what is
   * in view stays where it is. Return a Promise and a quiet line says they are loading.
   */
  onLoadOlder?: () => unknown;
  /**
   * The moment the date lines count from ("Today", "Yesterday"). Give a fixed one when the page is
   * drawn on the server ahead of time, so the server and the browser agree past midnight.
   * @default the moment the thread is first drawn
   */
  now?: Date | string;
  /**
   * The words of the button that brings the person back down.
   * @default "Jump to latest"
   */
  jumpLabel?: string;
  /** How tall a message is before it is measured, in pixels: a close guess keeps the scrollbar steady. @default 96 */
  estimate?: number;
  /**
   * Where it opens: at the latest message, following what arrives, or at the Unread line, so the
   * person reads on from where they left (with "Jump to latest" below).
   * @default "end"
   */
  startAt?: "end" | "unread";
  /**
   * The id of the message the person just sent. It goes to the top of the view, and the room
   * under it is kept for the answer, so the answer grows into space instead of pushing the page
   * up a line at a time. Once the answer is taller than that room, the thread follows it as ever.
   * The thread needs a height of its own for this (a fixed one, or its place in a layout that
   * gives it one): in a box only as tall as its messages no room is kept, and nothing else changes.
   */
  answerTo?: string;
  /** The words it writes itself, any of them replaced: the Unread line, the status words, the days. */
  words?: Partial<ThreadWords>;
}

const DATE_ROW = 44;
// How many of the latest rows the server draws, before the virtualiser takes over.
const SERVER_ROWS = 30;

/**
 * The rows drawn before the thread is alive, where it will open: the latest, or from the Unread
 * line on when it opens there.
 */
const firstRows = <R extends { kind: string }>(
  rows: readonly R[],
  startAt: "end" | "unread"
) => {
  const unread =
    startAt === "unread" ? rows.findIndex((row) => row.kind === "unread") : -1;
  return unread === -1
    ? rows.slice(-SERVER_ROWS)
    : rows.slice(unread, unread + SERVER_ROWS);
};
// Nearer the top than this, in pixels, older messages load.
const NEAR_TOP = 240;

/**
 * Which messages are news. Ones that arrive after the thread is drawn fade in, once; the ones there
 * at first, older ones loaded above and the rows a scroll brings back do not. And where the reader
 * left the latest, so the way back can say a message came in since.
 */
/** The first message, not the first row: older messages of the same day leave its date line first. */
const firstMessage = <T extends ThreadItemBase>(list: ThreadRow<T>[]) =>
  list.find((row) => row.kind === "message")?.key;

const createNews = <T extends ThreadItemBase>(first: ThreadRow<T>[]) => {
  let known = new Set(first.map((row) => row.key));
  const arriving = new Set<string>();
  let firstKnown = firstMessage(first);
  let leftAt: string | undefined;
  let arrived = 0;
  return {
    /**
     * Notes this render's rows; returns how many messages have arrived since the thread was drawn.
     * The count is kept here, with the rows it is counted from, so a render reads it as it is.
     */
    see: (rows: ThreadRow<T>[], sent: string | undefined) => {
      const firstKey = firstMessage(rows);
      for (const row of rows) {
        if (!known.has(row.key)) {
          known.add(row.key);
          // Older messages loaded above are not news: they are there, not arriving.
          if (row.kind === "message" && firstKey === firstKnown) {
            arriving.add(row.key);
            // The one the person just sent (`answerTo`) fades in, but is not news to them: it is
            // not counted, so sending and its answer say "1 new message", not 2 (audit B20).
            if (row.item.id !== sent) {
              arrived += 1;
            }
          }
        }
      }
      firstKnown = firstKey;
      // Rows that left the thread leave the bookkeeping too.
      if (known.size > rows.length * 2) {
        known = new Set(rows.map((row) => row.key));
      }
      return arrived;
    },
    arriving: (key: string) => arriving.has(key),
    /** The fade plays once: when it ends, the row is no longer arriving. */
    settle: (key: string) => {
      arriving.delete(key);
    },
    newBelow: (following: boolean, lastKey: string | undefined) => {
      if (following) {
        leftAt = undefined;
      } else {
        leftAt ??= lastKey;
      }
      return !following && leftAt !== undefined && lastKey !== leftAt;
    },
  };
};

// After the last wheel, touch or scroll event, this long with none, a scroll has ended (where the
// browser does not say so with scrollend).
const SCROLL_IDLE = 150;

/** Nothing to let go: what a row's ref hands back when it is called with no element. */
const letGo = () => {
  // A row that is not drawn holds nothing.
};

/**
 * Runs `run` with `element`'s scroll held: what it writes to scrollTop is handed to `onWrite` as
 * the distance it asked for, and the scroll itself is left alone. (Only in the browser: the
 * scroll's own getter is read from the element's prototype when it is needed.)
 */
const withScrollHeld = (
  element: HTMLElement,
  onWrite: (by: number) => void,
  run: () => void
) => {
  const scrollTopOf = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop"
  );
  const read = () => Number(scrollTopOf?.get?.call(element) ?? 0);
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: read,
    set: (to: number) => {
      onWrite(to - read());
    },
  });
  try {
    run();
  } finally {
    Reflect.deleteProperty(element, "scrollTop");
  }
};

/** Sets the lead straight on the rows' box, through the same StyleX variable the box reads. */
const showLead = (box: HTMLElement | null, lead: number) => {
  if (box === null) {
    return;
  }
  const { style } = stylex.props(places.lead(`${lead}px`));
  for (const [name, value] of Object.entries(style ?? {})) {
    box.style.setProperty(name, String(value));
  }
};

/**
 * The rows the virtualiser places, and the one holding focus, which stays drawn wherever the reader
 * scrolls, so focus is never lost. Held here, not in refs, as the virtualiser reads them during render.
 *
 * The rows are measured here, not by the virtualiser's own observer: a row that changes size is
 * read when the browser says so, and handed to the virtualiser in the next frame, so the box it
 * grows is laid out in a frame of its own (handed over at once, the box's new height came during
 * the observers' round, and the browser reported a ResizeObserver loop). And while a wheel or a
 * touch scroll is under way, what measuring a row above the view would write to the scroll goes to
 * the lead instead (thread.stylex.ts), and back into the scroll when it ends: a write to the scroll
 * cuts WebKit's wheel short.
 */
const createRowSource = <T extends ThreadItemBase>(
  estimate: number,
  first: ThreadRow<T>[]
) => {
  let rows = first;
  let focused: number | null = null;
  let lead = 0;
  let scroller: HTMLElement | null = null;
  let box: HTMLElement | null = null;
  let holding = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let lastTurn = 0;
  let watch: ResizeObserver | null = null;
  let observed = new WeakSet<HTMLElement>();
  const due = new Set<HTMLElement>();
  let frame = 0;
  const options = {
    count: () => rows.length,
    key: (index: number) => rows[index]?.key ?? String(index),
    estimate: (index: number) =>
      rows[index]?.kind === "message" ? estimate : DATE_ROW,
    overscan: 6,
    keep: () => (focused === null ? [] : [focused]),
    // Where the rows start in the scroller: down by the lead.
    get scrollMargin() {
      return lead;
    },
  };
  const virtual = createVirtualizer(options);
  const moveLead = (by: number) => {
    lead -= by;
    showLead(box, lead);
  };
  /** Moves the scroll by `by`, or, while a wheel is under way, the rows the other way. */
  const shift = (element: HTMLElement, by: number) => {
    if (holding) {
      moveLead(by);
      return;
    }
    element.scrollTop += by;
  };
  /** The scroll has ended: the lead goes back into the scroll, in one step. */
  const release = () => {
    clearTimeout(idle);
    holding = false;
    if (lead === 0 || scroller === null) {
      return;
    }
    const by = lead;
    lead = 0;
    showLead(box, 0);
    scroller.scrollTop -= by;
    virtual.refresh();
  };
  /**
   * The lead stands the rows down, and leaves an empty room above the first of them: that room is
   * never seen. Within a view's height of the first row, the lead goes back into the scroll at
   * once (a wheel there is at the top already), so the view always holds rows.
   */
  const guard = () => {
    if (
      holding &&
      scroller !== null &&
      lead > 0 &&
      scroller.scrollTop - lead < scroller.clientHeight
    ) {
      release();
    }
  };
  const record = (element: HTMLElement) => {
    const index = Number(element.dataset.index);
    if (!element.isConnected || Number.isNaN(index)) {
      return;
    }
    // Measured once and let go: this source watches the row, not the virtualiser.
    const measureOnce = () => {
      virtual.measure(index, element)();
    };
    if (holding && scroller !== null) {
      withScrollHeld(scroller, moveLead, measureOnce);
      guard();
    } else {
      measureOnce();
    }
  };
  const flush = () => {
    frame = 0;
    const rowsDue = [...due];
    due.clear();
    for (const element of rowsDue) {
      record(element);
    }
  };
  const resized = (entries: ResizeObserverEntry[]) => {
    for (const entry of entries) {
      if (entry.target instanceof HTMLElement) {
        due.add(entry.target);
      }
    }
    if (frame === 0) {
      frame = requestAnimationFrame(flush);
    }
  };
  const turned = () => {
    holding = true;
    lastTurn = performance.now();
    clearTimeout(idle);
    idle = setTimeout(release, SCROLL_IDLE);
  };
  const scrolled = () => {
    if (!holding) {
      return;
    }
    clearTimeout(idle);
    idle = setTimeout(release, SCROLL_IDLE);
    guard();
  };
  // scrollend can come between two turns of a wheel; only one after the wheel has rested ends it.
  const ended = () => {
    if (holding && performance.now() - lastTurn > SCROLL_IDLE / 2) {
      release();
    }
  };
  return {
    virtual,
    // The virtualiser's store, bound, as useSyncExternalStore takes it.
    subscribe: (listener: () => void) => virtual.subscribe(listener),
    placed: () => virtual.items(),
    size: () => virtual.size(),
    rows: () => rows,
    show: (next: ThreadRow<T>[]) => {
      rows = next;
    },
    focus: (index: number | null) => {
      focused = index;
    },
    /** How far the rows stand down from the top of the scroller, while a wheel is under way. */
    lead: () => lead,
    holding: () => holding,
    shift,
    /** The rows' box, for the lead. */
    hold: (element: HTMLElement | null) => {
      box = element;
      showLead(box, lead);
    },
    /** Measures a row now, and again whenever it changes size, while it is drawn. */
    track: (element: HTMLElement | null) => {
      if (element === null) {
        return letGo;
      }
      record(element);
      watch ??= new ResizeObserver(resized);
      if (!observed.has(element)) {
        observed.add(element);
        watch.observe(element);
      }
      const watching = watch;
      const seen = observed;
      return () => {
        // Drawn again in the same place, a row keeps its element: it is let go only once it left.
        queueMicrotask(() => {
          if (!element.isConnected) {
            watching.unobserve(element);
            seen.delete(element);
            due.delete(element);
          }
        });
      };
    },
    /** Watches the reader's wheel and touch on the scroller; returns what lets it go. */
    connect: (element: HTMLElement) => {
      scroller = element;
      const events: [string, () => void][] = [
        ["wheel", turned],
        ["touchstart", turned],
        ["touchmove", turned],
        ["scroll", scrolled],
        ["scrollend", ended],
      ];
      for (const [name, listener] of events) {
        element.addEventListener(name, listener, { passive: true });
      }
      return () => {
        for (const [name, listener] of events) {
          element.removeEventListener(name, listener);
        }
        release();
        cancelAnimationFrame(frame);
        frame = 0;
        watch?.disconnect();
        watch = null;
        observed = new WeakSet();
        scroller = null;
      };
    },
  };
};

/** Following the end, with its store's subscribe bound, as useSyncExternalStore takes it. */
const createFollow = () => {
  const stick = createStickToBottom();
  return {
    stick,
    subscribe: (listener: () => void) => stick.subscribe(listener),
  };
};

/** The moment the date lines count from: the one given, or the one the thread was first drawn. */
const nowOf = (nowKey: number | string | undefined, drawn: Date) =>
  nowKey === undefined ? drawn : new Date(nowKey);

/** Does it now, and again a frame later, as the first rows measured can change the height. */
const nowAndNextFrame = (go: () => void) => {
  go();
  const frame = requestAnimationFrame(go);
  return () => {
    cancelAnimationFrame(frame);
  };
};

/**
 * Marks which edges of the scroller have rows past them, straight on the scroller, so a scroll
 * never renders: `data-under-start` with rows above the view, `data-under-end` with rows below it.
 * The scroller's style fades a marked edge out (styles.ts), as Table's, Tabs' and the Composer
 * strip's do; at the very top or at the end that edge is sharp.
 */
/** Where the opening flow stands, by where the thread opens: at the Unread line, below the top's fade. */
const openingAt = {
  end: styles.openingEnd,
  unread: styles.openingUnread,
} as const;

const markEdges = (element: HTMLElement) => {
  const room = element.scrollHeight - element.clientHeight;
  element.toggleAttribute(
    "data-under-start",
    room > 1 && element.scrollTop > 1
  );
  element.toggleAttribute(
    "data-under-end",
    room > 1 && element.scrollTop < room - 1
  );
};

/** Hands the scroller to the rows, the virtualiser and the follower; returns what lets it go again. */
const connectScroller = (
  element: HTMLElement,
  source: {
    virtual: Virtualizer;
    connect: (element: HTMLElement) => () => void;
  },
  stick: StickToBottom
) => {
  const offSource = source.connect(element);
  const offVirtual = source.virtual.connect(element);
  const offStick = stick.connect(element);
  return () => {
    offSource();
    offVirtual();
    offStick();
  };
};

/**
 * Starts at the latest: twice, a frame apart, as the first rows measured can change the height.
 * Or, with startAt="unread", at the Unread line, no longer following: below the top's fade (the
 * scroller's scroll padding, styles.ts), so the line it opens at reads whole while rows lie above.
 */
const openAt = (
  element: HTMLElement | null,
  rows: readonly { kind: string }[],
  startAt: "end" | "unread",
  stick: StickToBottom,
  virtual: Virtualizer
) => {
  const unread = rows.findIndex((row) => row.kind === "unread");
  if (startAt === "unread" && unread !== -1) {
    stick.release();
    return nowAndNextFrame(() => {
      virtual.scrollToIndex(unread, { align: "start" });
      if (element !== null) {
        element.scrollTop -=
          Number(
            getComputedStyle(element).scrollPaddingTop.replace("px", "")
          ) || 0;
      }
    });
  }
  return nowAndNextFrame(() => {
    stick.scrollToBottom();
  });
};

/**
 * The scroller's own height for its rows, once it is on the page, and as it changes: without the
 * room it keeps at its end for "Jump to latest", so a scroller only as tall as its rows reads as such.
 */
const useViewHeight = (scroller: RefObject<HTMLDivElement | null>) => {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const element = scroller.current;
    // The observer's own measure is the box inside the padding, so the kept room is left out.
    const watch = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setHeight(entry.contentRect.height);
      }
    });
    if (element !== null) {
      watch.observe(element);
    }
    return () => {
      watch.disconnect();
    };
  }, [scroller]);
  return height;
};

/**
 * Where the sent message starts, when room can be kept under it: its row is drawn, and the
 * scroller has a height of its own. A scroller that is only as tall as its messages has no view
 * to keep room in (the room is a share of its height, and would make it taller for ever), so there
 * the thread simply follows its end.
 */
const sentStart = (
  answerTo: string | undefined,
  placed: readonly { key: string; start: number }[],
  view: number | null,
  size: number
) => {
  if (answerTo === undefined || view === null || Math.abs(view - size) <= 2) {
    return null;
  }
  return (
    placed.find((place) => place.key === `message-${answerTo}`)?.start ?? null
  );
};

/**
 * The sent message at the top: when the person sends (`answerTo` changes), and once more when its
 * row is first placed, the thread goes to its end, which the kept room makes the place where that
 * message stands at the top. Never again for the same message, so reading back is never undone.
 */
const useSentToTop = (
  answerTo: string | undefined,
  placedAt: number | null,
  mounted: boolean,
  stick: StickToBottom
) => {
  const done = useRef<string | null>(null);
  const known = placedAt !== null;
  useEffect(() => {
    const due = mounted && answerTo !== undefined && done.current !== answerTo;
    if (due && known) {
      done.current = answerTo;
    }
    const stop = due
      ? nowAndNextFrame(() => {
          stick.scrollToBottom();
        })
      : null;
    return () => {
      stop?.();
    };
  }, [answerTo, known, mounted, stick]);
};

/** Waits for what `onLoadOlder` gave back, then runs `done`, whether it loaded or failed. */
const afterLoading = async (result: unknown, done: () => void) => {
  try {
    await result;
  } finally {
    done();
  }
};

/** Its words in English: replace any of them through `words`. */
const englishWords: ThreadWords = {
  unread: "Unread",
  unreadFrom: "Unread messages from here",
  loadingOlder: "Loading older messages",
  jumpToNew: (jumpLabel) => `${jumpLabel}, new messages`,
  arrived: (count) => (count === 1 ? "1 new message" : `${count} new messages`),
  today: "Today",
  yesterday: "Yesterday",
  day: (day, sameYear) => dayWritten(day, sameYear),
};

/** What the status line says for the messages that came in, or nothing for none. */
const arrivedSaid = (count: number, words: ThreadWords) =>
  count === 0 ? "" : words.arrived(count);

/** A date line's words: today, yesterday, or the day as it is written. */
const dayWords = (
  row: Extract<LineRow, { kind: "date" }>,
  words: ThreadWords
) => {
  if (row.ago === 0) {
    return words.today;
  }
  return row.ago === 1 ? words.yesterday : words.day(row.day, row.sameYear);
};

/** The thread takes focus, so the keys scroll it: the arrows, Page Up and Down, Space. */
const SCROLLER_TAB_INDEX = 0;

/**
 * Watches the reader in the thread: a key ends the pin, and focus notes the row holding it, so the
 * virtualiser keeps that row drawn. These watch, they offer nothing, so they sit beside the
 * virtualiser's and the follower's own listeners on the scroller, not on its props.
 */
const watchReader = (
  element: HTMLElement,
  onKey: () => void,
  onRow: (index: number | null) => void
) => {
  const focusIn = (event: FocusEvent) => {
    const row =
      event.target instanceof Element
        ? event.target.closest("[data-index]")
        : null;
    onRow(
      row instanceof HTMLElement || row instanceof SVGElement
        ? Number(row.dataset.index)
        : null
    );
  };
  element.addEventListener("keydown", onKey);
  element.addEventListener("focusin", focusIn);
  return () => {
    element.removeEventListener("keydown", onKey);
    element.removeEventListener("focusin", focusIn);
  };
};

type LineRow = Exclude<ThreadRow<unknown>, { kind: "message" }>;

/**
 * A date line, or the unread line. The line itself is an hr with the name, out of sight; the word
 * and the two hairlines beside it are what is seen, and are not read a second time.
 */
const drawLine = (row: LineRow, words: ThreadWords) => {
  if (row.kind === "date") {
    const label = dayWords(row, words);
    return (
      <div {...stylex.props(styles.divider)}>
        <hr aria-label={label} {...stylex.props(visuallyHidden)} />
        <span aria-hidden="true">{label}</span>
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.divider, styles.unread)}>
      <hr aria-label={words.unreadFrom} {...stylex.props(visuallyHidden)} />
      <span aria-hidden="true">{words.unread}</span>
    </div>
  );
};

/** The thread: the messages, the lines between them, and the way back to the latest. */
export const Thread = <T extends ThreadItemBase>({
  items,
  renderItem,
  "aria-label": ariaLabel,
  unreadFrom,
  hasOlder = false,
  onLoadOlder,
  jumpLabel = "Jump to latest",
  estimate = 96,
  startAt = "end",
  now: nowProp,
  answerTo,
  words: given,
}: ThreadProps<T>) => {
  const words = { ...englishWords, ...given };
  // The day lines are worked out against `now`, or the day the page was drawn, once, so the server
  // and the browser agree.
  const nowKey = nowProp instanceof Date ? nowProp.getTime() : nowProp;
  // Made with the first rows, and the row source again only for a new estimate. The moment the
  // page was drawn and the news are made once, with the first rows.
  const [made, setMade] = useState(() => {
    const drawn = new Date();
    const first = rowsOf(items, unreadFrom, nowOf(nowKey, drawn));
    return {
      drawn,
      estimate,
      source: createRowSource<T>(estimate, first),
      news: createNews(first),
      follow: createFollow(),
    };
  });
  const { drawn, news, follow } = made;
  // The rows are kept with what they were made from, and made again only when that changes.
  const [kept, setKept] = useState(() => ({
    items,
    unreadFrom,
    nowKey,
    rows: rowsOf(items, unreadFrom, nowOf(nowKey, drawn)),
  }));
  if (
    kept.items !== items ||
    kept.unreadFrom !== unreadFrom ||
    kept.nowKey !== nowKey
  ) {
    setKept({
      items,
      unreadFrom,
      nowKey,
      rows: rowsOf(items, unreadFrom, nowOf(nowKey, drawn)),
    });
  }
  const { rows } = kept;

  const scroller = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  if (made.estimate !== estimate) {
    setMade({ ...made, estimate, source: createRowSource<T>(estimate, rows) });
  }
  const { source } = made;
  // The virtualiser reads the rows during render, so it is handed this render's rows first.
  source.show(rows);
  const { virtual } = source;
  const { stick } = follow;

  const placed = useSyncExternalStore(
    source.subscribe,
    source.placed,
    source.placed
  );
  const size = useSyncExternalStore(source.subscribe, source.size, source.size);
  const at = useSyncExternalStore(follow.subscribe, stick.get, stick.get);
  // Where the message the person just sent starts, while its row is drawn and room can be kept.
  const view = useViewHeight(scroller);
  const sentAt = sentStart(answerTo, placed, view, size);
  useSentToTop(answerTo, sentAt, mounted, stick);

  useLayoutEffect(() => {
    const element = scroller.current;
    const disconnect =
      element === null ? undefined : connectScroller(element, source, stick);
    if (element !== null) {
      setMounted(true);
    }
    return disconnect;
  }, [source, stick]);

  // Once the rows are placed, start where it opens. The source and its virtualiser are made
  // together, so naming both runs this no more often than naming the virtualiser alone.
  useEffect(
    () =>
      mounted
        ? openAt(scroller.current, source.rows(), startAt, stick, virtual)
        : undefined,
    [mounted, source, stick, virtual, startAt]
  );

  // When older rows come in above, the row being read is pinned: its offset from the top of the
  // view is noted from the rows drawn before, and for a moment after, as the rows above are
  // measured and their heights settle, the scroll keeps that offset. Nothing in view moves.
  // What was drawn at the last commit: the virtualiser reads the new rows during render, so the
  // pin needs the rows and the height from before.
  const placedRef = useRef(
    placed.map((place) => ({ ...place, kind: rows[place.index]?.kind }))
  );
  const sizeRef = useRef(size);
  const lastFirst = useRef(firstMessage(rows));
  const pin = useRef<{ key: string; offset: number; until: number } | null>(
    null
  );
  useLayoutEffect(() => {
    const first = firstMessage(rows);
    const element = scroller.current;
    if (
      element &&
      mounted &&
      first !== lastFirst.current &&
      lastFirst.current !== undefined
    ) {
      // The top of the view, in the rows' own measure: the lead stands them further down.
      const top = element.scrollTop - source.lead();
      // A message, never a date line: a date line moves when older messages of its day come in.
      const reading = placedRef.current.find(
        (place) => place.start + place.size > top && place.kind === "message"
      );
      if (reading) {
        pin.current = {
          key: reading.key,
          offset: reading.start - top,
          until: performance.now() + 800,
        };
      }
    }
    lastFirst.current = first;
    virtual.refresh();
    const held = pin.current;
    // The box takes its new height now, not on the next render, so the scroll below is not cut
    // short by the old one.
    const grown = virtual.size() - sizeRef.current;
    // Through the same StyleX variable the render sets, so the next render takes over from it.
    if (box.current) {
      const { style } = stylex.props(places.height(`${virtual.size()}px`));
      for (const [name, value] of Object.entries(style ?? {})) {
        box.current.style.setProperty(name, String(value));
      }
    }
    // Down by the height that came in above: the rows above are estimated alike before and after,
    // so the pinned row lands where it was. Measuring the rows near it then corrects the rest.
    if (element && held && grown > 0) {
      source.shift(element, grown);
    }
  }, [rows, virtual, mounted, source]);
  useLayoutEffect(() => {
    const element = scroller.current;
    const held = pin.current;
    if (!element || !held) {
      return;
    }
    // A wheel under way ends the pin: the lead keeps the rows in place until it rests.
    if (performance.now() > held.until || source.holding()) {
      pin.current = null;
      return;
    }
    const place = placed.find((item) => item.key === held.key);
    if (!place) {
      return;
    }
    const wanted = place.start + source.lead() - held.offset;
    if (Math.abs(element.scrollTop - wanted) > 0.5) {
      element.scrollTop = wanted;
    }
    // Only `placed` is read: a change of the height that leaves the rows drawn where they were
    // leaves the pinned row where it was too, so there is nothing to correct.
  }, [placed, source]);
  // Noted after every commit, for the next change of rows.
  useLayoutEffect(() => {
    placedRef.current = virtual
      .items()
      .map((place) => ({ ...place, kind: source.rows()[place.index]?.kind }));
    sizeRef.current = virtual.size();
    // Rows that came, grew or left, and a view that changed height, without a scroll: the edges
    // are marked again. An attribute, not state: its mask moves nothing, so nothing renders again.
    if (scroller.current) {
      markEdges(scroller.current);
    }
  });
  // The reader scrolling ends the pin at once.
  const unpin = () => {
    pin.current = null;
  };
  useLayoutEffect(() => {
    const element = scroller.current;
    const ended = () => {
      pin.current = null;
    };
    return element ? watchReader(element, ended, source.focus) : undefined;
  }, [source]);

  // Messages that arrive after the thread is drawn fade in, once; the ones there at first, and
  // the rows a scroll brings back, do not. The count of them is said by the status line.
  const lastKey = rows.findLast((row) => row.kind === "message")?.key;
  const arrived = news.see(rows, answerTo);
  // "New messages" on the way back means a message came in at the bottom since the reader left.
  const newBelow = news.newBelow(at.following, lastKey);
  // The pill's row comes and goes a render later than the following does: the following changes
  // inside the observers' round (the follower's own), and a row coming or going there resizes the
  // scroller in the same round, which the browser reports as a ResizeObserver loop.
  const away = useDeferredValue(!at.following);

  // Near the top, load older messages, once at a time.
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const check = useRef<(() => void) | null>(null);
  const onScroll = () => {
    const element = scroller.current;
    if (element) {
      markEdges(element);
    }
    if (!element || !hasOlder || !onLoadOlder || loadingRef.current) {
      return;
    }
    if (element.scrollTop > NEAR_TOP) {
      return;
    }
    loadingRef.current = true;
    const result = onLoadOlder();
    const thenable =
      result !== null && typeof result === "object" && "then" in result;
    if (!thenable) {
      loadingRef.current = false;
      return;
    }
    setLoading(true);
    void afterLoading(result, () => {
      loadingRef.current = false;
      setLoading(false);
      // Still near the top once they are in (a short page of them): look again.
      requestAnimationFrame(() => {
        check.current?.();
      });
    });
  };
  // The newest look at the top, for a look again a frame after older messages came in.
  useEffect(() => {
    check.current = onScroll;
  });
  // A thread too short to scroll still loads what is older: when it is drawn, and again whenever
  // there is more that is older. With nothing older the look at the top would stop at once.
  useEffect(() => {
    if (mounted && hasOlder) {
      check.current?.();
    }
  }, [mounted, hasOlder]);

  return (
    <div data-slot="thread" {...stylex.props(styles.root)}>
      <div
        ref={scroller}
        role="log"
        // Quiet: rows drawn by a scroll and words streaming in are not news. New messages are said
        // by the status line below, once each.
        aria-live="off"
        aria-label={ariaLabel}
        aria-busy={loading || undefined}
        tabIndex={SCROLLER_TAB_INDEX}
        onScroll={onScroll}
        onWheel={unpin}
        onTouchMove={unpin}
        {...stylex.props(
          styles.scroller,
          scroll.bar,
          focus.carrier,
          !mounted && startAt === "end" && styles.opening
        )}
      >
        {mounted ? (
          <div
            ref={(element) => {
              box.current = element;
              source.hold(element);
            }}
            // The lead's own class is always on the box, so the value showLead writes reaches the
            // box's top: without it the rows stood still while the virtualiser drew them a lead
            // lower, and a wheel up a long thread could leave the view empty. The render says 0;
            // only showLead moves it, and React leaves an unchanged value alone.
            {...stylex.props(
              styles.box,
              places.height(`${size}px`),
              places.lead("0px"),
              sentAt !== null && places.room(`${sentAt}px`)
            )}
          >
            {placed.map((place) => {
              const row = rows[place.index];
              if (!row) {
                return null;
              }
              return (
                <div
                  // Keyed by the row's own key, so a row keeps its element when older ones come in.
                  key={row.key}
                  data-slot="thread-row"
                  data-kind={row.kind}
                  data-index={place.index}
                  ref={(element) => source.track(element)}
                  // The virtualiser's place for the row, in pixels: a measure, not a look.
                  {...stylex.props(
                    styles.row,
                    styles.placed,
                    places.at(`${place.start}px`)
                  )}
                >
                  {/* The fade is on the row's insides, so it never fights the row's place. */}
                  <div
                    onAnimationEnd={() => {
                      news.settle(row.key);
                    }}
                    {...stylex.props(news.arriving(row.key) && styles.arriving)}
                  >
                    {row.kind === "message"
                      ? renderItem(row.item, row.index)
                      : drawLine(row, words)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            {...stylex.props(
              styles.flow,
              styles.openingFlow,
              openingAt[startAt]
            )}
          >
            {/* On the server and with JavaScript off: the rows where the thread opens, standing as it opens. */}
            {firstRows(rows, startAt).map((row) => (
              <div
                key={row.key}
                data-slot="thread-row"
                data-kind={row.kind}
                {...stylex.props(styles.row)}
              >
                {row.kind === "message"
                  ? renderItem(row.item, row.index)
                  : drawLine(row, words)}
              </div>
            ))}
          </div>
        )}
      </div>
      {loading && (
        <output {...stylex.props(styles.older)}>
          <Icon icon={Spinner} />
          {words.loadingOlder}
        </output>
      )}
      <output {...stylex.props(visuallyHidden)}>
        {arrivedSaid(arrived, words)}
      </output>
      {mounted && away && (
        <div {...stylex.props(styles.jump)}>
          <span {...stylex.props(styles.jumpButton)}>
            <Button
              variant="quiet"
              size="sm"
              icon={ArrowDown}
              onClick={() => {
                const still = window.matchMedia(
                  "(prefers-reduced-motion: reduce)"
                ).matches;
                stick.scrollToBottom({ behavior: still ? "auto" : "smooth" });
                // The button goes once at the end; focus goes to the thread, not the page.
                scroller.current?.focus({ preventScroll: true });
              }}
            >
              {newBelow ? words.jumpToNew(jumpLabel) : jumpLabel}
            </Button>
          </span>
        </div>
      )}
    </div>
  );
};
