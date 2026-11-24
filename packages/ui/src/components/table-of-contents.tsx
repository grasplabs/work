// Table of contents: "On this page", the sections of a long page beside it. A quiet list on one
// start edge, the title on that same edge; one mark that glides to the section being read; a thin
// measure of how much of the page is read; group names as quiet labels above their items; collapsed
// sections marked with a small chevron. Its compact variant is a column of ticks, one per section,
// the one being read marked, that opens into the names on hover or focus.
//
//   <TableOfContents
//     container="main"
//     items={[
//       { id: "basic", label: "Basic" },
//       { id: "when-to-use-it", label: "When to use it", group: "Using it" },
//       { id: "api", label: "API", group: "Reference", collapsed: true },
//     ]}
//     footer={<PageActions />}
//   />
//
// The links are real links (`#id`): they work with no script and with the browser's own scroll to
// a heading. The script follows the container and marks the section being read with
// aria-current="location"; the list is one stop for Tab, and Up, Down, Home and End move in it.
//
// Every value is a token. Its words come from the I18nProvider (`tableOfContents`).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  HoverCardContent as ContentPrimitive,
  HoverCard as HoverCardPrimitive,
  HoverCardTrigger as TriggerPrimitive,
} from "@ui-sdk/react/hover-card";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  Dispatch,
  FocusEvent,
  KeyboardEvent,
  ReactNode,
  SetStateAction,
} from "react";

import { useI18n } from "../lib/i18n";
import { ChevronRightIcon, Icon } from "../lib/icons";
import { focusRing, focusRingText, scrollbarHidden } from "../lib/styles";
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
import { durations, popup } from "../lib/tokens.values";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";

/** One section of the page. */
export interface TableOfContentsItem {
  /** The id of the section's heading on the page: the link goes to `#id`. */
  id: string;
  /** The section's name, as its heading says it. */
  label: string;
  /**
   * 2 for a section, 3 for a section inside one, which stands a little further in.
   * @default 2
   */
  level?: 2 | 3;
  /** The group of the page it is in. A run of items in the same group is listed under its name. */
  group?: string;
  /** The section is collapsed on the page: a small chevron after its name says it opens. */
  collapsed?: boolean;
}

/** Every prop a TableOfContents takes. */
export interface TableOfContentsProps {
  /** The page's sections, in the order they come on the page. */
  items: TableOfContentsItem[];
  /**
   * Its name, over the list on its start edge, and its name to a screen reader.
   * @default "On this page"
   */
  title?: string;
  /**
   * A CSS selector for the box that scrolls the page, such as `"main"`. Leave it out when the
   * window scrolls.
   */
  container?: string;
  /**
   * How far below the container's top a heading counts as being read, in pixels: below a header
   * that stays in view.
   * @default 96
   */
  offset?: number;
  /**
   * `list` shows every section's name. `compact` shows a tick for each, and opens the names on
   * hover or focus, for a narrow column.
   * @default "list"
   */
  variant?: "list" | "compact";
  /** Under the list, set off by a line: the page's own actions, such as Copy as Markdown. */
  footer?: ReactNode;
  /** Layout only: its width and where it sits. */
  style?: LayoutStyle;
}

// ---- Reading ------------------------------------------------------------------------------------
//
// Which section is being read, and how much of the page. Read from the container's layout on scroll
// (at most once a frame), on resize, when its content changes size, and once after mount; never in
// render. The section being read is the last whose heading's top has reached the reading line,
// `offset` below the container's top; at the very end of the container it is the last; scrolled but
// above the first heading, the first.

/** Where the reader is: the section being read and how much of the page is behind them. */
interface Reading {
  /** The item being read, counted from 0; -1 above the first heading. */
  current: number;
  /** How far the container has scrolled, from 0 at its top to 1 at its end. */
  progress: number;
  /** False until the page has been read once, after mount: nothing is drawn as current before. */
  known: boolean;
}

const UNREAD: Reading = { current: -1, progress: 0, known: false };

/** The container's top on screen, how far it has scrolled, how much of it shows and how tall it is. */
const scrollOf = (box: HTMLElement | null) => {
  if (box === null) {
    const page = document.scrollingElement ?? document.documentElement;
    return {
      top: 0,
      scrolled: page.scrollTop,
      seen: page.clientHeight,
      whole: page.scrollHeight,
    };
  }
  return {
    top: box.getBoundingClientRect().top + box.clientTop,
    scrolled: box.scrollTop,
    seen: box.clientHeight,
    whole: box.scrollHeight,
  };
};

// A heading that the browser scrolled to by its link stands at the line, give or take a fraction.
const SLACK = 1;

/**
 * The item being read: the last at the very end; above the first heading but on the way (a long
 * opening before it), the first, where the reader is going; only at the very top none; else the
 * last whose heading has passed.
 */
const currentOf = (
  passed: number,
  count: number,
  end: boolean,
  moved: boolean
) => {
  if (count === 0) {
    return -1;
  }
  if (end) {
    return count - 1;
  }
  if (passed === -1 && moved) {
    return 0;
  }
  return passed;
};

/** Reads the page: the item being read and the share scrolled. Layout reads, for handlers only. */
const read = (
  ids: string[],
  box: HTMLElement | null,
  offset: number
): Reading => {
  const at = scrollOf(box);
  const travel = at.whole - at.seen;
  const end = travel > 0 && at.scrolled >= travel - SLACK;
  const line = at.top + offset + SLACK;
  let passed = -1;
  for (const [index, id] of ids.entries()) {
    const target = document.querySelector(`#${CSS.escape(id)}`);
    if (target !== null && target.getBoundingClientRect().top <= line) {
      passed = index;
    }
  }
  const share = travel > 0 ? Math.min(1, Math.max(0, at.scrolled / travel)) : 1;
  return {
    current: currentOf(passed, ids.length, end, at.scrolled > SLACK),
    progress: Math.round(share * 1000) / 1000,
    known: true,
  };
};

const sameReading = (a: Reading, b: Reading) =>
  a.current === b.current && a.progress === b.progress && a.known === b.known;

/**
 * Follows the container (a CSS selector; the window without one) until the result is called:
 * listens passively, reads at most once a frame, and hands each new reading to `set`.
 */
const follow = (
  key: string,
  container: string | undefined,
  offset: number,
  set: (update: (previous: Reading) => Reading) => void
) => {
  const ids = key === "" ? [] : key.split("\n");
  const box =
    container === undefined
      ? null
      : document.querySelector<HTMLElement>(container);
  const source: HTMLElement | Window = box ?? window;
  let frame = 0;
  const update = () => {
    frame = 0;
    const next = read(ids, box, offset);
    set((previous) => (sameReading(previous, next) ? previous : next));
  };
  const schedule = () => {
    if (frame === 0) {
      frame = requestAnimationFrame(update);
    }
  };
  source.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  // Content that grows or shrinks (a fold opening, a picture loading) moves the headings with no scroll.
  const observer = new ResizeObserver(schedule);
  observer.observe(box ?? document.body);
  for (const child of box?.children ?? []) {
    observer.observe(child);
  }
  schedule();
  return () => {
    source.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
};

/** The section being read and how much is read, for the items whose ids are `key` (one per line). */
const useReading = (
  key: string,
  container: string | undefined,
  offset: number
): Reading => {
  const [reading, setReading] = useState<Reading>(UNREAD);
  useEffect(
    () => follow(key, container, offset, setReading),
    [key, container, offset]
  );
  return reading;
};

// ---- The list -----------------------------------------------------------------------------------
//
// The list variant, and the list the compact variant opens. The title, the measure of what is read
// and the sections all stand on one edge, space-3 in from the component's own, and the mark runs in
// that room beside the section being read, inside the component's box, so nothing round it clips
// the mark. The mark is placed at once the first time, and glides after: it moves by transform and
// changes height, so a fast scroll retargets it smoothly from wherever it is. With no section being
// read it fades out, and it fades back in. Its place is read from the links' layout in effects,
// never in render.

const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const HOVER = media.hover;
const REDUCED = media.reducedMotion;

// A link stands a little wider than its words, so its ring keeps off the first and last letter. At
// the start it reaches into the room before the list, so the words stay on the list's edge; at the
// end it stops short of the box by its ring, so the ring stays inside and nothing scrolls sideways.
const ROOM = size.ringOffsetText;
const RING = `calc(${ROOM} + ${size.ringWidth})`;

// While the compact variant's popup opens and as it closes: a little smaller and clear.
const moving = ":is([data-starting-style], [data-ending-style])";

const styles = stylex.create({
  // The box: everything in it stands space-3 in from its start edge, where the mark runs.
  nav: {
    position: "relative",
    boxSizing: "border-box",
    minWidth: 0,
    paddingInlineStart: space[3],
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    color: colors.mutedForeground,
    overflowWrap: "break-word",
  },
  title: {
    margin: 0,
    marginBlockEnd: space[3],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  // How much of the page is read: under the title a quiet hairline across the list's own width, and
  // over it the part read, in mint and as thick as the mark. With nothing read, only the hairline. In
  // forced colours the hairline is CanvasText and the read part alone Highlight.
  track: {
    display: "block",
    height: size.tableOfContentsMark,
    marginBlockEnd: space[4],
    overflow: "hidden",
    borderRadius: radius.full,
    backgroundImage: {
      default: `linear-gradient(${colors.border}, ${colors.border})`,
      [FORCED]: "linear-gradient(CanvasText, CanvasText)",
    },
    backgroundSize: `100% ${size.hairline}`,
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    forcedColorAdjust: "none",
  },
  fill: {
    display: "block",
    height: "100%",
    backgroundColor: {
      default: colors.tableOfContentsRead,
      [FORCED]: "Highlight",
    },
    transformOrigin: { default: "left center", ":dir(rtl)": "right center" },
  },
  filled: (progress: number) => ({
    transform: `scaleX(${progress})`,
  }),
  fillGlide: {
    transitionProperty: "transform",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  // The mark beside the section being read. Until it glides, only its fade moves.
  mark: {
    position: "absolute",
    top: 0,
    insetInlineStart: 0,
    width: size.tableOfContentsMark,
    height: 0,
    borderRadius: radius.full,
    backgroundColor: { default: colors.foreground, [FORCED]: "CanvasText" },
    forcedColorAdjust: "none",
    pointerEvents: "none",
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  placed: (y: number, height: number) => ({
    transform: `translateY(${y}px)`,
    height: `${height}px`,
  }),
  glide: {
    transitionProperty: "transform, height, opacity",
  },
  away: {
    opacity: 0,
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  item: {
    margin: 0,
  },
  // A group of the page after the first: room above its name.
  later: {
    marginBlockStart: space[4],
  },
  // A group's name over its sections: smaller, medium and quieter than they are, so it labels them
  // rather than reading as one more of them.
  group: {
    display: "block",
    paddingBlockEnd: space[1],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    color: colors.subtleForeground,
  },
  // A section's link: as tall as a tap on a touch screen, and as wide as its words and the room
  // round them, so its ring stands evenly round the words, not out to the list's end.
  link: {
    display: "inline-block",
    maxWidth: `calc(100% - ${RING})`,
    paddingBlock: {
      default: space[1],
      [COARSE]: `calc((${size.tapTarget} - ${font.textSmLine}) / 2)`,
    },
    paddingInline: ROOM,
    marginInlineStart: `calc(-1 * ${ROOM})`,
    marginInlineEnd: RING,
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    textDecoration: "none",
    textWrap: "pretty",
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    transitionProperty: "color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  deep: {
    marginInlineStart: `calc(${space[3]} - ${ROOM})`,
  },
  current: {
    color: colors.foreground,
  },
  // The chevron after a collapsed section's name, on the middle of its line, quieter than the words.
  chevron: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "inline-flex",
    alignItems: "center",
    height: font.textSmLine,
    marginInlineStart: space[1],
    verticalAlign: "top",
    color: colors.subtleForeground,
  },
  // The page's own actions, set off under the sections and quieter than them.
  footer: {
    marginBlockStart: space[6],
    paddingBlockStart: space[4],
    borderBlockStartWidth: size.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
    color: colors.mutedForeground,
  },
  // The compact variant: its root.
  root: {
    minWidth: 0,
  },
  // The button: the ticks in a column, from its start edge.
  strip: {
    boxSizing: "border-box",
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "flex-start",
    justifyContent: "center",
    rowGap: space.tableOfContentsTickGap,
    minWidth: { default: null, [COARSE]: size.tapTarget },
    minHeight: { default: null, [COARSE]: size.tapTarget },
    margin: 0,
    padding: space[2],
    borderWidth: 0,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    // A ghost button's fill under the pointer, so the column reads as something to press.
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
    },
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
  },
  ticks: {
    display: "contents",
  },
  tick: {
    display: "block",
    width: space.tableOfContentsTick,
    height: size.tableOfContentsMark,
    borderRadius: radius.full,
    // Muted, not the divider's colour: the ticks are the button, and must read as one.
    backgroundColor: { default: colors.mutedForeground, [FORCED]: "GrayText" },
    forcedColorAdjust: "none",
    transitionProperty: "width, background-color",
    transitionDuration: `${motionVars.mark}, ${duration.hover}`,
    transitionTimingFunction: duration.ease,
  },
  tickShort: {
    width: space.tableOfContentsTickShort,
  },
  // A section already read.
  tickRead: {
    backgroundColor: { default: colors.foreground, [FORCED]: "CanvasText" },
  },
  tickCurrent: {
    width: space.tableOfContentsTickActive,
    backgroundColor: {
      default: colors.tableOfContentsRead,
      [FORCED]: "Highlight",
    },
  },
  // The first section of a new group: a little more room above it.
  tickGroup: {
    marginBlockStart: space[2],
  },
  // The list, open: the popup's raised surface with the one corner, never wider than the window
  // less its gutters, and no taller than the room beside the ticks; past that it scrolls inside.
  popup: {
    boxSizing: "border-box",
    width: `min(${size.tableOfContentsWidth}, 100vw - 2 * ${space.popupGutter})`,
    maxHeight: `var(--available-height, calc(100vh - 2 * ${space.popupGutter}))`,
    margin: 0,
    paddingBlock: space[4],
    paddingInlineStart: space[2],
    paddingInlineEnd: space[5],
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.popover,
    boxShadow: shadow.popupShadow,
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, [moving]: 0 },
    transform: {
      default: "none",
      [moving]: {
        default: `scale(${size.popupFromScale})`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: motionVars.popup,
      ":is([data-ending-style])": motionVars.leave,
    },
    transitionTimingFunction: duration.ease,
  },
});

/** Where the mark stands: its top in the box and its height, in pixels. */
interface Place {
  y: number;
  height: number;
}

const samePlace = (a: Place | null, b: Place | null) =>
  a === b || (a !== null && b !== null && a.y === b.y && a.height === b.height);

/** A run of items in one group of the page ("" for none), from the item at `start`. */
interface Run {
  group: string;
  start: number;
  items: TableOfContentsItem[];
}

const runsOf = (items: TableOfContentsItem[]): Run[] => {
  const runs: Run[] = [];
  for (const [index, item] of items.entries()) {
    const group = item.group ?? "";
    const last = runs.at(-1);
    if (last?.group === group) {
      last.items.push(item);
    } else {
      runs.push({ group, start: index, items: [item] });
    }
  }
  return runs;
};

const LINK = "a[data-table-of-contents-link]";
const BOX = "[data-table-of-contents-box]";

/** The link's top inside the box, through every positioned box between them, untouched by transforms. */
const topIn = (element: HTMLElement, box: HTMLElement) => {
  let y = 0;
  let at: Element | null = element;
  while (at instanceof HTMLElement && at !== box) {
    y += at.offsetTop;
    at = at.offsetParent;
  }
  return y;
};

// A computed length in pixels.
const px = (value: string) => {
  const number = Number(value.replace(/px$/u, ""));
  return Number.isFinite(number) ? number : 0;
};

/** Where the mark stands beside the item at `index`: its words' lines, without the row's padding. */
const placeOf = (box: HTMLElement | null, index: number): Place | null => {
  const link =
    box === null
      ? undefined
      : [...box.querySelectorAll<HTMLElement>(LINK)][index];
  // A box not laid out (hidden, or a popup not yet shown) has no place to give.
  if (box === null || link === undefined || box.offsetHeight === 0) {
    return null;
  }
  const look = getComputedStyle(link);
  const before = px(look.paddingTop);
  const after = px(look.paddingBottom);
  return {
    y: topIn(link, box) + before,
    height: Math.max(0, link.offsetHeight - before - after),
  };
};

/**
 * Places the mark by the item at `index` now, and again whenever the box changes size (the type
 * loading, words wrapping); the result stops. While the box is not laid out the mark keeps its
 * place: it is placed, without a glide, once the box is.
 */
const placeMark = (
  box: HTMLElement | null,
  index: number,
  set: Dispatch<SetStateAction<Place | null>>
) => {
  const measure = () => {
    const next = placeOf(box, index);
    set((previous) =>
      next === null || samePlace(previous, next) ? previous : next
    );
  };
  measure();
  const observer = new ResizeObserver(measure);
  if (box !== null) {
    observer.observe(box);
  }
  return () => {
    observer.disconnect();
  };
};

/**
 * Runs `done` a frame after the mark was placed. Reading its layout first makes the placed style
 * the one the browser starts from, so turning the glide on then moves nothing.
 */
const afterPlaced = (mark: HTMLElement | null, done: () => void) => {
  mark?.getBoundingClientRect();
  const frame = requestAnimationFrame(done);
  return () => {
    cancelAnimationFrame(frame);
  };
};

/** Up, Down, Home and End: the link to move to, or null for any other key. */
const stepOf = (key: string, from: number, count: number) => {
  switch (key) {
    case "ArrowDown": {
      return Math.min(count - 1, from + 1);
    }
    case "ArrowUp": {
      return Math.max(0, from - 1);
    }
    case "Home": {
      return 0;
    }
    case "End": {
      return count - 1;
    }
    default: {
      return null;
    }
  }
};

/** Moves focus between the links with the arrow keys, Home and End. */
const moveIn = (event: KeyboardEvent<HTMLAnchorElement>) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }
  const box = event.currentTarget.closest(BOX);
  const links =
    box === null ? [] : [...box.querySelectorAll<HTMLAnchorElement>(LINK)];
  const to = stepOf(
    event.key,
    links.indexOf(event.currentTarget),
    links.length
  );
  if (to === null || links.length === 0) {
    return;
  }
  event.preventDefault();
  // The list's one Tab stop moves with focus at once, in the same event: a Tab pressed before the
  // next render then still leaves the list (the render that follows gives the same).
  for (const [index, link] of links.entries()) {
    link.tabIndex = index === to ? 0 : -1;
  }
  links[to]?.focus();
};

const unsubscribe = () => {
  // Nothing to undo: the store never changes.
};
const noChange = () => unsubscribe;

interface RowProps {
  item: TableOfContentsItem;
  index: number;
  current: boolean;
  stop: boolean;
  scripted: boolean;
  collapsedLabel: (label: string) => string;
  setFocused: Dispatch<SetStateAction<number | null>>;
  onFollow: (() => void) | undefined;
}

/**
 * One section: its link, the chevron after a collapsed one, and its name with the collapsed word
 * for a screen reader. Once the script runs, Tab reaches one link of the list (`stop`); with none, every one.
 */
const Row = ({
  item,
  index,
  current,
  stop,
  scripted,
  collapsedLabel,
  setFocused,
  onFollow,
}: RowProps) => {
  const reach = stop ? 0 : -1;
  return (
    <li {...stylex.props(styles.item)}>
      <a
        href={`#${item.id}`}
        data-table-of-contents-link=""
        aria-current={current ? "location" : undefined}
        aria-label={
          item.collapsed === true ? collapsedLabel(item.label) : undefined
        }
        tabIndex={scripted ? reach : undefined}
        onKeyDown={moveIn}
        onFocus={() => {
          setFocused(index);
        }}
        onBlur={(event: FocusEvent<HTMLAnchorElement>) => {
          const box = event.currentTarget.closest(BOX);
          const into = event.relatedTarget;
          // A frame later, once focus has moved: done at once, Firefox reckons Tab's next stop after
          // the current link has become the list's stop again, and Tab lands there, not past the list.
          if (box === null || !(into instanceof Node) || !box.contains(into)) {
            requestAnimationFrame(() => {
              setFocused(null);
            });
          }
        }}
        onClick={onFollow}
        {...stylex.props(
          styles.link,
          item.level === 3 && styles.deep,
          current && styles.current,
          focusRingText
        )}
      >
        {item.label}
        {item.collapsed === true ? (
          <span aria-hidden="true" {...stylex.props(styles.chevron)}>
            <Icon icon={ChevronRightIcon} />
          </span>
        ) : null}
      </a>
    </li>
  );
};

interface ListProps {
  items: TableOfContentsItem[];
  title: string;
  footer: ReactNode;
  collapsedLabel: (label: string) => string;
  reading: Reading;
  /** In the compact variant's popup: it names its box apart from the compact variant's own. */
  inPopup?: boolean;
  /** Runs when a link is followed: the compact variant closes its popup. */
  onFollow?: () => void;
  style?: LayoutStyle;
}

/** The title, the measure, the sections under their groups' names, the mark, and the footer. */
const List = ({
  items,
  title,
  footer,
  collapsedLabel,
  reading,
  inPopup = false,
  onFollow,
  style,
}: ListProps) => {
  const id = useId();
  const box = useRef<HTMLElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const scripted = useSyncExternalStore(
    noChange,
    () => true,
    () => false
  );
  const [place, setPlace] = useState<Place | null>(null);
  const [glide, setGlide] = useState(false);
  // The link that holds focus, while one does: Tab comes back to it, and to the current one after.
  const [focused, setFocused] = useState<number | null>(null);
  const { current, progress, known } = reading;
  // With no section being read, the mark waits, faded, by the first.
  const target = Math.max(0, current);

  // Once the page has been read, the mark stands by the section being read, and again whenever the
  // list changes size.
  useLayoutEffect(
    () => (known ? placeMark(box.current, target, setPlace) : unsubscribe),
    [known, target]
  );

  // Placed once, it glides from then on.
  useEffect(
    () =>
      place === null || glide
        ? unsubscribe
        : afterPlaced(mark.current, () => {
            setGlide(true);
          }),
    [place, glide]
  );

  const stop = focused ?? target;
  const shown = known && current >= 0 && place !== null;
  const runs = runsOf(items);
  const grouped = runs.some((run) => run.group !== "");
  const row = (item: TableOfContentsItem, index: number) => (
    <Row
      key={item.id}
      item={item}
      index={index}
      current={index === current}
      stop={index === stop}
      scripted={scripted}
      collapsedLabel={collapsedLabel}
      setFocused={setFocused}
      onFollow={onFollow}
    />
  );

  return (
    <nav
      ref={box}
      aria-labelledby={id}
      data-slot={inPopup ? "table-of-contents-list" : "table-of-contents"}
      data-variant={inPopup ? undefined : "list"}
      data-table-of-contents-box=""
      {...stylex.props(styles.nav, style)}
    >
      <p id={id} {...stylex.props(styles.title)}>
        {title}
      </p>
      <span aria-hidden="true" {...stylex.props(styles.track)}>
        <span
          {...stylex.props(
            styles.fill,
            styles.filled(progress),
            glide && styles.fillGlide
          )}
        />
      </span>
      <span
        ref={mark}
        aria-hidden="true"
        {...stylex.props(
          styles.mark,
          place !== null && styles.placed(place.y, place.height),
          glide && styles.glide,
          !shown && styles.away
        )}
      />
      {grouped ? (
        <ul {...stylex.props(styles.list)}>
          {runs.map((run, n) => (
            <li
              key={run.start}
              {...stylex.props(styles.item, n > 0 && styles.later)}
            >
              {run.group === "" ? null : (
                <span id={`${id}-${n}`} {...stylex.props(styles.group)}>
                  {run.group}
                </span>
              )}
              <ul
                aria-labelledby={run.group === "" ? undefined : `${id}-${n}`}
                {...stylex.props(styles.list)}
              >
                {run.items.map((item, at) => row(item, run.start + at))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <ul {...stylex.props(styles.list)}>
          {items.map((item, index) => row(item, index))}
        </ul>
      )}
      {footer === undefined || footer === null ? null : (
        <div {...stylex.props(styles.footer)}>{footer}</div>
      )}
    </nav>
  );
};

// ---- The compact variant ------------------------------------------------------------------------
//
// After Notion's: a column of ticks, one per section, the one being read marked. It is one button.
// Hover or focus opens the list on UI SDK's hover card, in a layer of its own beside the ticks that
// no box round it clips, kept inside the window and scrolling inside itself when it is tall. Tab goes
// on from the button into the list; Escape closes it, and so does following a link. A touch screen
// opens it with a tap.

/** The ticks themselves, hidden from a screen reader: the button they stand in has the name. */
const Ticks = ({
  items,
  current,
}: {
  items: TableOfContentsItem[];
  current: number;
}) => (
  <span aria-hidden="true" {...stylex.props(styles.ticks)}>
    {items.map((item, index) => (
      <span
        key={item.id}
        data-current={index === current ? "" : undefined}
        {...stylex.props(
          styles.tick,
          item.level === 3 && styles.tickShort,
          index > 0 &&
            items[index - 1]?.group !== item.group &&
            styles.tickGroup,
          index < current && styles.tickRead,
          index === current && styles.tickCurrent
        )}
      />
    ))}
  </span>
);

/** The box the table of contents follows: its `container`, else its nearest scrolling ancestor, else the page. */
const containerOf = (
  element: HTMLElement,
  container: string | undefined
): HTMLElement => {
  const named =
    container === undefined
      ? null
      : document.querySelector<HTMLElement>(container);
  if (named !== null) {
    return named;
  }
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    if (/(?:auto|scroll)/u.test(getComputedStyle(at).overflowY)) {
      return at;
    }
  }
  return document.documentElement;
};

/**
 * While the list is open, the box the page scrolls in keeps still: WebKit (26) moved a scrolling
 * article to its very end as the list mounted, at 390, though nothing in the article changed size
 * and no script scrolled it: its scroll anchoring. Anchoring is off on that box only while the list
 * is open, and put back as it was when it closes; the rest of the time the box keeps it (with it
 * always off, Chromium and Firefox lost their own corrections).
 */
const holdStill = (root: HTMLElement | null, container: string | undefined) => {
  if (root === null) {
    return () => {
      // Nothing was held.
    };
  }
  const box = containerOf(root, container);
  const before = box.style.overflowAnchor;
  box.style.overflowAnchor = "none";
  return () => {
    box.style.overflowAnchor = before;
  };
};

interface CompactProps {
  items: TableOfContentsItem[];
  title: string;
  footer: ReactNode;
  collapsedLabel: (label: string) => string;
  openLabel: (title: string) => string;
  reading: Reading;
  container: string | undefined;
  style: LayoutStyle | undefined;
}

/** The ticks, one per section; hover or focus opens the names. */
const Compact = ({
  items,
  title,
  footer,
  collapsedLabel,
  openLabel,
  reading,
  container,
  style,
}: CompactProps) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // What puts the box's anchoring back: set as the list opens (before it mounts, so before WebKit
  // can move the box), run as it closes or the table of contents leaves.
  const release = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      release.current?.();
    },
    []
  );
  return (
    <div
      ref={root}
      data-slot="table-of-contents"
      data-variant="compact"
      {...stylex.props(styles.root, style)}
    >
      <HoverCardPrimitive
        open={open}
        delay={durations.hover}
        onOpenChange={(next: boolean) => {
          release.current?.();
          release.current = next ? holdStill(root.current, container) : null;
          setOpen(next);
        }}
      >
        <TriggerPrimitive
          render={(props: Record<string, unknown>) => (
            <button type="button" {...props} />
          )}
          aria-label={openLabel(title)}
          onClick={() => {
            if (!open) {
              release.current?.();
              release.current = holdStill(root.current, container);
            }
            setOpen(true);
          }}
          {...stylex.props(styles.strip, focusRing)}
        >
          <Ticks items={items} current={reading.current} />
        </TriggerPrimitive>
        <ContentPrimitive
          side="start"
          align="start"
          sideOffset={popup.popoverGap}
          collisionPadding={popup.gutter}
          {...stylex.props(styles.popup, scrollbarHidden)}
        >
          <List
            items={items}
            title={title}
            footer={footer}
            collapsedLabel={collapsedLabel}
            reading={reading}
            inPopup
            onFollow={() => {
              setOpen(false);
            }}
          />
        </ContentPrimitive>
      </HoverCardPrimitive>
    </div>
  );
};

/** The sections of a long page, the one being read marked, each a link to its place. */
export const TableOfContents = ({
  items,
  title,
  container,
  offset = 96,
  variant = "list",
  footer,
  style,
}: TableOfContentsProps) => {
  const { tableOfContents: words } = useI18n();
  const reading = useReading(
    items.map((item) => item.id).join("\n"),
    container,
    offset
  );
  const shared = {
    items,
    title: title ?? words.title,
    footer,
    collapsedLabel: words.collapsed,
    reading,
    style,
  };
  return variant === "compact" ? (
    <Compact {...shared} openLabel={words.open} container={container} />
  ) : (
    <List {...shared} />
  );
};
