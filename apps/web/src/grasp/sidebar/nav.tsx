// Sidebar's rows, in groups: what sidebar.tsx draws inside its nav. Not used on its own.
//
// Beyond plain groups of links, each of these is the caller's choice and off until asked for:
//   a group that folds   `collapsible` on a group, remembered under the Sidebar's `storageKey`
//   a count per group     `count` on a group; while filtering, the number of matches instead
//   a filter field        `filter` on the Sidebar: matches row names and their `keywords`
//   the keys of a list    `keys="list"`: one tab stop, ↑/↓, Home/End, →/← on a group's label
// The current row is scrolled into view inside the sidebar's own scroller on first paint, never
// the page.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactElement, RefObject } from "react";

import { focus } from "../focus/focus";
import { ChevronRight, Icon, Search } from "../icons";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../input-group";
import { grasp, media } from "../tokens/tokens.stylex";

const HOVER = media.hover;
const COARSE = media.coarse;

/** The filter field at the top of the rows. Every word is the caller's. */
export interface SidebarFilter {
  /** The field's name, said to a screen reader ("Filter components"). */
  label: string;
  /** What the empty field shows ("Filter"). */
  placeholder?: string;
  /** What shows when nothing matches ("Nothing matches"). */
  empty: string;
  /** The name of the button that empties the field ("Clear filter"); none without it. */
  clear?: string;
}

/** A row's words, as the filter reads them. */
export interface NavRow {
  label: string;
  keywords?: readonly string[];
  rows?: readonly { label: string }[];
}

/** A group, as the nav reads it. */
export interface NavGroup<Row extends NavRow> {
  id?: string;
  part?: string;
  partHref?: string;
  partCurrent?: boolean;
  label?: string;
  rows: readonly Row[];
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  count?: number;
}

// The list's end fades out over its last rows (black to here, clear by its end, less a hair).
const END_FADE = `calc(100% - ${grasp.space10}), transparent calc(100% - ${grasp.space1})`;
// Where the sticky filter's ground ends in the list: its field and the room above and below it.
const FILTER_END = `calc(2 * ${grasp.shellGutter} + ${grasp.controlMd})`;
// The end's fade mirrored, from the list's top or from under the filter down: whole above it, clear
// just under it, whole again a fade's length on.
const START_FADE = `black 0px, transparent 0px, transparent ${grasp.space1}, black ${grasp.space10}`;
const START_FADE_FILTER = `black ${FILTER_END}, transparent ${FILTER_END}, transparent calc(${FILTER_END} + ${grasp.space1}), black calc(${FILTER_END} + ${grasp.space10})`;

export const navStyles = stylex.create({
  body: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: grasp.shellGutter,
    minHeight: 0,
    margin: 0,
    padding: grasp.shellGutter,
    overflowX: "hidden",
    overflowY: "auto",
    // No bar (PRODUCT-RULES, src/scroll): the rows still scroll by wheel, touch and keys.
    scrollbarWidth: "none",
    // While more rows lie below, the list's end fades out (data-under-end, set by watchEnd), so it
    // never reads as cut at the foot's hairline. While rows lie above it (scrolled), its start fades
    // the same way, mirrored (data-under-start): from the list's top, or from under the filter, which
    // stays at the top (its 36px field and its room above and below), so a row passing under it is
    // never seen cut at its edge (App shell FRESH.md F86b). At rest at the top, nothing fades.
    maskImage: {
      default: null,
      ":is([data-under-end])": `linear-gradient(to bottom, black ${END_FADE})`,
      ":is([data-under-start])": `linear-gradient(to bottom, ${START_FADE})`,
      ":is([data-under-start][data-under-end])": `linear-gradient(to bottom, ${START_FADE}, black ${END_FADE})`,
      ":is([data-under-start]:has(> [data-slot=sidebar-filter]))": `linear-gradient(to bottom, ${START_FADE_FILTER})`,
      ":is([data-under-start][data-under-end]:has(> [data-slot=sidebar-filter]))": `linear-gradient(to bottom, ${START_FADE_FILTER}, black ${END_FADE})`,
    },
  },
  group: { display: "flex", flexDirection: "column", gap: grasp.shellRowGap },
  // A run of groups that fold reads as a tree (App shell FRESH.md F67): a folding group right after
  // another stands a row's gap under it, as a row under a row, not the groups' wider gap, so a run of
  // folded groups keeps the rows' pitch.
  groupInRun: {
    marginBlockStart: `calc(${grasp.shellRowGap} - ${grasp.shellGutter})`,
  },
  // A part's name over the groups that follow it: a level above a group's label, in the rows'
  // own size and a step quieter than a row, with room above it to start a new part.
  // A hairline over it starts the part; its name stands in the shell's ink, above the rows' quieter
  // words and the groups' small labels.
  part: {
    margin: 0,
    marginBlockStart: grasp.space2,
    paddingInline: { default: grasp.shellRowInline, ":has(> a)": 0 },
    paddingBlockStart: { default: grasp.space4, ":has(> a)": grasp.space3 },
    boxShadow: `inset 0 ${grasp.hairline} 0 ${grasp.line}`,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.shellText,
  },
  // A part's name that leads to its own page (an overview): a row's box, hover and current fill,
  // in the part's own size and ink.
  partLink: {
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    height: { default: grasp.shellRow, [COARSE]: grasp.tap },
    paddingInline: grasp.shellRowInline,
    borderRadius: grasp.shellCorner,
    color: "inherit",
    textDecoration: "none",
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: "transparent", ":hover": grasp.shellHover },
    },
    transitionProperty: "background-color",
    transitionDuration: grasp.shellAnswer,
    transitionTimingFunction: grasp.ease,
  },
  // Its own page is open: the row's current fill (a border in forced colours, where fills drop).
  partCurrent: {
    backgroundColor: grasp.shellSelected,
    outline: {
      default: null,
      [media.forced]: `${grasp.hairline} solid CanvasText`,
    },
  },
  groupLabel: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    width: "100%",
    margin: 0,
    paddingInline: grasp.shellRowInline,
    paddingBlockStart: grasp.space2,
    paddingBlockEnd: grasp.space1,
    borderWidth: 0,
    borderRadius: grasp.shellCorner,
    backgroundColor: "transparent",
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    textAlign: "start",
    // The rows' own quiet colour: the label tells itself from them by its smaller size and its
    // weight. In the tertiary colour it read 3.0:1 in light, under the 4.5:1 its small words need,
    // and paler than the rows it holds (A3-shell-04).
    color: grasp.shellTextSecondary,
  },
  // A label that folds its group: the same words, a button, the chevron at its end.
  groupButton: {
    minHeight: { default: null, [COARSE]: grasp.tap },
    cursor: "pointer",
    color: {
      default: grasp.shellTextSecondary,
      [HOVER]: { default: grasp.shellTextSecondary, ":hover": grasp.shellText },
    },
  },
  groupWords: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  groupCount: { flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    // Open, it points down in either direction: the icon is mirrored right to left, so it turns
    // the other way there.
    transform: { default: "rotate(90deg)", ":dir(rtl)": "rotate(-90deg)" },
    transitionProperty: "transform",
    transitionDuration: grasp.shellAnswer,
    transitionTimingFunction: grasp.ease,
  },
  // Folded, it points the way of reading: the mirrored icon already does.
  chevronFolded: { transform: { default: "none", ":dir(rtl)": "none" } },
  list: {
    display: { default: "flex", ":is([hidden])": "none" },
    flexDirection: "column",
    gap: grasp.shellRowGap,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // The rows of a group that folds stand in from its label, so the open group and its rows read as a
  // tree, not one column (F67).
  listUnder: { paddingInlineStart: grasp.space3 },
  // The filter stays at the top while the rows scroll under it, on the sidebar's own ground.
  filterGroup: {
    position: "sticky",
    insetBlockStart: `calc(-1 * ${grasp.shellGutter})`,
    zIndex: 1,
    flexShrink: 0,
    width: "100%",
    marginBlock: `calc(-1 * ${grasp.shellGutter})`,
    paddingBlock: grasp.shellGutter,
    backgroundColor: grasp.shellGround,
  },
  empty: {
    margin: 0,
    paddingInline: grasp.shellRowInline,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.shellTextSecondary,
  },
});

/** Whether a row, or one of its own rows, matches the words typed. */
const matches = (row: NavRow, query: string) => {
  if (query === "") {
    return true;
  }
  const words = [
    row.label,
    ...(row.keywords ?? []),
    ...(row.rows ?? []).map((sub) => sub.label),
  ];
  return words.some((word) => word.toLocaleLowerCase().includes(query));
};

/** Whether a group folds and follows one that folds, with no part's name between: a run of them is a tree. */
const inRun = (
  groups: readonly { collapsible?: boolean; part?: string }[],
  index: number,
  shown: (index: number) => boolean
) => {
  const group = groups[index];
  // The group drawn before it: one a filter has emptied is not drawn.
  const at = groups.findLastIndex((_, each) => each < index && shown(each));
  const before = at === -1 ? undefined : groups[at];
  return (
    group?.collapsible === true &&
    before?.collapsible === true &&
    (group.part === undefined || group.part === "")
  );
};

/** Each group's key: its id, else its label, else its place. */
const keyOf = (group: { id?: string; label?: string }, index: number) =>
  group.id ?? group.label ?? String(index);

/** Told when the folds are written here, so every nav reading the same key draws them again. */
const FOLDS_CHANGED = "grasp-sidebar-folds";

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  window.addEventListener(FOLDS_CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(FOLDS_CHANGED, onChange);
  };
};

/** The folds as kept: only true or false under each key; anything else in the store is left out. */
const parseFolds = (kept: string | null): Record<string, boolean> => {
  if (kept === null) {
    return {};
  }
  try {
    const read: unknown = JSON.parse(kept);
    const entries =
      typeof read === "object" && read !== null ? Object.entries(read) : [];
    return Object.fromEntries(
      entries.filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
      )
    );
  } catch {
    return {};
  }
};

const readStore = (storageKey: string | undefined) => {
  if (storageKey === undefined) {
    return null;
  }
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
};

const writeFolds = (
  storageKey: string | undefined,
  folds: Record<string, boolean>
) => {
  if (storageKey === undefined) {
    return;
  }
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(folds));
  } catch {
    // A store that is full or shut keeps nothing; the folds still work until the page goes.
  }
  window.dispatchEvent(new Event(FOLDS_CHANGED));
};

/** This entry of the history, where the browser names it (the Navigation API): a page left by a
 * link gets a new entry, so only Back and Forward come back to the same one. */
const entryKey = (storageKey: string | undefined): string | null => {
  // Read without assuming its type: a browser without it has none, and gets null.
  const navigation: unknown = Reflect.get(window, "navigation");
  const current: unknown =
    typeof navigation === "object" && navigation !== null
      ? Reflect.get(navigation, "currentEntry")
      : undefined;
  const entry: unknown =
    typeof current === "object" && current !== null
      ? Reflect.get(current, "key")
      : undefined;
  return storageKey === undefined || typeof entry !== "string"
    ? null
    : `${storageKey}:scroll:${entry}`;
};

const readScroll = (storageKey: string | undefined): number | null => {
  const key = entryKey(storageKey);
  try {
    const kept = key === null ? null : window.sessionStorage.getItem(key);
    return kept === null ? null : Number(kept);
  } catch {
    return null;
  }
};

const writeScroll = (storageKey: string | undefined, top: number) => {
  const key = entryKey(storageKey);
  try {
    if (key !== null) {
      window.sessionStorage.setItem(key, String(Math.round(top)));
    }
  } catch {
    // A shut store keeps nothing: Back brings the current row into view instead.
  }
};

/** Marks the list while more rows lie below its end or above its start (the fades there), on scroll
 * and as it or its rows change size; never a render per scroll. Returns the clean-up. */
const watchEnd = (element: HTMLElement) => {
  const measure = () => {
    element.toggleAttribute(
      "data-under-end",
      element.scrollHeight - element.clientHeight - element.scrollTop > 1
    );
    element.toggleAttribute("data-under-start", element.scrollTop > 1);
  };
  measure();
  element.addEventListener("scroll", measure, { passive: true });
  const observer =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
  observer?.observe(element);
  for (const child of element.children) {
    observer?.observe(child);
  }
  return () => {
    observer?.disconnect();
    element.removeEventListener("scroll", measure);
  };
};

const STEPS: Record<
  string,
  (items: HTMLElement[], at: number) => HTMLElement | undefined
> = {
  ArrowDown: (items, at) => items[Math.min(at + 1, items.length - 1)],
  ArrowUp: (items, at) => items[Math.max(at - 1, 0)],
  Home: (items) => items[0],
  End: (items) => items.at(-1),
};

/** The nav's items a person can reach now: its rows and its group labels, in order. */
const itemsIn = (nav: HTMLElement) =>
  [...nav.querySelectorAll<HTMLElement>("[data-sidebar-item]")].filter(
    (item) => item.closest("[hidden]") === null
  );

/** One stop for the whole list: the item that holds it takes 0, every other -1. */
const rove = (nav: HTMLElement, to: HTMLElement | null) => {
  const items = itemsIn(nav);
  const holder =
    to ??
    items.find((item) => item.getAttribute("aria-current") === "page") ??
    items[0];
  for (const item of nav.querySelectorAll<HTMLElement>("[data-sidebar-item]")) {
    item.tabIndex = item === holder ? 0 : -1;
  }
};

/** The current row, brought into the sidebar's own scroller without moving the page. */
const reveal = (scroller: HTMLElement) => {
  const current = scroller.querySelector<HTMLElement>('[aria-current="page"]');
  if (current === null) {
    return;
  }
  const box = scroller.getBoundingClientRect();
  const row = current.getBoundingClientRect();
  // Out of view, it comes to the middle, with rows round it, not flush with an edge.
  if (row.top < box.top || row.bottom > box.bottom) {
    scroller.scrollTop += row.top + row.height / 2 - (box.top + box.height / 2);
  }
};

interface Folding {
  /** Whether a group is folded now: never while filtering, never one that does not fold. */
  folded: (index: number) => boolean;
  fold: (index: number, next: boolean) => void;
}

/** The arrow keys on a list's items: ↑/↓, Home and End move, → opens a group and ← folds it. */
const onListKey = (
  nav: HTMLElement,
  event: KeyboardEvent,
  folding: Folding
) => {
  const { target } = event;
  if (
    !(target instanceof HTMLElement) ||
    target.dataset.sidebarItem === undefined
  ) {
    return;
  }
  const { sidebarGroup } = target.dataset;
  if (
    (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
    sidebarGroup !== undefined
  ) {
    const index = Number(sidebarGroup);
    const rtl = getComputedStyle(target).direction === "rtl";
    const opening = (event.key === "ArrowRight") !== rtl;
    if (folding.folded(index) === opening) {
      folding.fold(index, !opening);
    }
    event.preventDefault();
    return;
  }
  const items = itemsIn(nav);
  const to = STEPS[event.key]?.(items, items.indexOf(target));
  if (to === undefined) {
    return;
  }
  event.preventDefault();
  rove(nav, to);
  to.focus();
};

interface NavProps<Row extends NavRow> {
  groups: readonly NavGroup<Row>[];
  label: string;
  id: string;
  filter?: SidebarFilter;
  filterRef?: RefObject<HTMLInputElement | null>;
  storageKey?: string;
  keys?: "tab" | "list";
  /** Draws a row; `item` marks it as one of the list's items, for `keys="list"`. */
  renderRow: (row: Row, item: boolean) => ReactElement;
}

/** The filter field, the system's own (InputGroup): Escape clears it, ↓ moves into the rows. */
const FilterField = ({
  filter,
  field,
  query,
  onQuery,
  onDown,
}: {
  filter: SidebarFilter;
  field: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  onDown: () => boolean;
}) => (
  <div data-slot="sidebar-filter" {...stylex.props(navStyles.filterGroup)}>
    <InputGroup>
      <InputGroupText icon={Search} />
      <InputGroupInput
        ref={field}
        type="search"
        aria-label={filter.label}
        placeholder={filter.placeholder}
        value={query}
        onValueChange={(value: string) => {
          onQuery(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query !== "") {
            event.preventDefault();
            event.stopPropagation();
            onQuery("");
          } else if (event.key === "ArrowDown" && onDown()) {
            event.preventDefault();
          }
        }}
      />
      {filter.clear !== undefined && <InputGroupClear label={filter.clear} />}
    </InputGroup>
  </div>
);

/** A group's label: a button that folds it, or plain words. */
const GroupLabel = ({
  index,
  label,
  heading,
  list,
  count,
  collapsible,
  shut,
  item,
  onFold,
}: {
  index: number;
  label: string;
  heading: string;
  list: string;
  count: number | undefined;
  collapsible: boolean;
  shut: boolean;
  item: boolean;
  onFold: () => void;
}) => {
  const words = (
    <>
      <span id={heading} {...stylex.props(navStyles.groupWords)}>
        {label}
      </span>
      {count !== undefined && (
        <span {...stylex.props(navStyles.groupCount)}>{count}</span>
      )}
    </>
  );
  if (!collapsible) {
    return <p {...stylex.props(navStyles.groupLabel)}>{words}</p>;
  }
  return (
    <button
      type="button"
      aria-expanded={!shut}
      aria-controls={list}
      data-sidebar-group={index}
      data-sidebar-item={item ? "" : undefined}
      onClick={onFold}
      {...stylex.props(navStyles.groupLabel, navStyles.groupButton, focus.ring)}
    >
      {words}
      <span
        aria-hidden="true"
        {...stylex.props(navStyles.chevron, shut && navStyles.chevronFolded)}
      >
        <Icon icon={ChevronRight} />
      </span>
    </button>
  );
};

/** The nav: the filter, then each group, folding where asked. */
/**
 * How a group's rows stand folded. Awake, as chosen. Before the page wakes (and with no script at
 * all) a group that starts folded is drawn open and marked: the head's fold script (fold-script.ts),
 * which only runs with a script, hides what is marked until the sidebar wakes, so a page with no
 * script keeps every row in reach (its fold buttons cannot open anything without one).
 */
const foldedLook = (shut: boolean, awake: boolean) =>
  awake
    ? { hidden: shut }
    : { hidden: false, "data-sidebar-asleep-shut": shut ? "" : undefined };

/**
 * A part's name, over the group that starts it and the ones after it. With an `href` the name is a
 * link to the part's own page: a tab stop as a row is (one of the list's items with `keys="list"`),
 * marked as the page where it is open.
 */
const PartLabel = ({
  part,
  href,
  current,
  item,
}: {
  part: string | undefined;
  href: string | undefined;
  current: boolean;
  item: boolean;
}) => {
  if (part === undefined || part === "") {
    return null;
  }
  return (
    <div data-slot="sidebar-part" {...stylex.props(navStyles.part)}>
      {href === undefined ? (
        part
      ) : (
        <a
          href={href}
          aria-current={current ? "page" : undefined}
          data-sidebar-item={item ? "" : undefined}
          {...stylex.props(
            navStyles.partLink,
            current && navStyles.partCurrent,
            focus.ring
          )}
        >
          {part}
        </a>
      )}
    </div>
  );
};

export const SidebarNav = <Row extends NavRow>({
  groups,
  label,
  id,
  filter,
  filterRef,
  storageKey,
  keys = "tab",
  renderRow,
}: NavProps<Row>) => {
  const nav = useRef<HTMLElement>(null);
  const ownField = useRef<HTMLInputElement>(null);
  const field = filterRef ?? ownField;
  const [query, setQuery] = useState("");
  // The folds as kept, by group key: none on the server, the store's once the page wakes.
  const kept = useSyncExternalStore(
    subscribe,
    () => readStore(storageKey),
    () => null
  );
  // Without a store, the folds the person chose on this page.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const folds = storageKey === undefined ? chosen : parseFolds(kept);
  const needle = query.trim().toLocaleLowerCase();
  const list = keys === "list";

  const folding: Folding = {
    folded: (index) => {
      const group = groups[index];
      if (group === undefined || needle !== "" || group.collapsible !== true) {
        return false;
      }
      return (
        group.collapsed ??
        folds[keyOf(group, index)] ??
        group.defaultCollapsed ??
        false
      );
    },
    fold: (index, next) => {
      const group = groups[index];
      if (group === undefined) {
        return;
      }
      group.onCollapsedChange?.(next);
      if (group.collapsed !== undefined) {
        return;
      }
      const key = keyOf(group, index);
      const updated = { ...folds, [key]: next };
      setChosen(updated);
      writeFolds(storageKey, updated);
    },
  };

  // Before the first paint after the page wakes: back on a page by Back or Forward, the rows stand
  // where the person left them; a fresh visit brings the current row into view. Again once the kept
  // folds are read (the first render draws the server's folds): groups opening above the current
  // row would otherwise push it out of view, and a kept place would be clamped to a shorter list.
  // Awake: the store's folds are in use (the first render draws the server's).
  const foldsRead = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
  useLayoutEffect(() => {
    const element = nav.current;
    // Only once awake, with the kept folds drawn: placed against the server's folds, the rows above
    // could still open and push the current row away.
    if (element === null || !foldsRead) {
      return;
    }
    const saved = readScroll(storageKey);
    if (saved === null) {
      reveal(element);
    } else {
      element.scrollTo({ top: saved });
    }
  }, [storageKey, foldsRead]);

  // Where the rows stand, kept for this entry of the history as they scroll.
  useEffect(() => {
    const element = nav.current;
    const keep = () => {
      if (element !== null) {
        writeScroll(storageKey, element.scrollTop);
      }
    };
    element?.addEventListener("scroll", keep, { passive: true });
    return () => {
      element?.removeEventListener("scroll", keep);
    };
  }, [storageKey]);

  // The fade at the list's end while more lies below; watched afresh after each draw, as the
  // groups and their folds change what the list holds.
  useEffect(() => {
    const element = nav.current;
    return element === null ? undefined : watchEnd(element);
  });

  // Awake once the kept folds are drawn by React: the head's fold style (fold-script.ts) lets go
  // only then. While the page wakes, the first draw still holds the server's folds (none kept), so
  // letting go there would open the groups for a frame.
  useLayoutEffect(() => {
    const element = nav.current;
    if (element !== null && kept === readStore(storageKey)) {
      element.dataset.sidebarWoke = "";
    }
  }, [kept, storageKey]);

  // One tab stop, kept on the current row while the keys are elsewhere.
  useEffect(() => {
    const element = nav.current;
    if (list && element !== null && !element.contains(document.activeElement)) {
      rove(element, null);
    }
  });

  // The arrow keys, on the nav as a whole, for a list.
  useEffect(() => {
    const element = nav.current;
    const keyed = (event: KeyboardEvent) => {
      if (element !== null) {
        onListKey(element, event, folding);
      }
    };
    if (list) {
      element?.addEventListener("keydown", keyed);
    }
    return () => {
      element?.removeEventListener("keydown", keyed);
    };
  });

  const intoRows = () => {
    const element = nav.current;
    const first =
      element?.querySelector<HTMLElement>(
        "ul:not([hidden]) a, ul:not([hidden]) button"
      ) ?? null;
    if (element === null || first === null) {
      return false;
    }
    if (list) {
      rove(element, first);
    }
    first.focus();
    return true;
  };

  const visible = groups.map((group) =>
    group.rows.filter((row) => matches(row, needle))
  );
  const none = needle !== "" && visible.every((rows) => rows.length === 0);
  const drawn = (index: number) =>
    needle === "" || (visible[index]?.length ?? 0) > 0;

  return (
    <nav ref={nav} aria-label={label} {...stylex.props(navStyles.body)}>
      {filter !== undefined && (
        <FilterField
          filter={filter}
          field={field}
          query={query}
          onQuery={setQuery}
          onDown={intoRows}
        />
      )}
      {none && (
        <output {...stylex.props(navStyles.empty)}>{filter?.empty}</output>
      )}
      {groups.map((group, index) => {
        const rows = visible[index] ?? [];
        if (rows.length === 0 && needle !== "") {
          return null;
        }
        const named = group.label !== undefined && group.label !== "";
        const heading = `${id}-group-${index}`;
        const listId = `${id}-list-${index}`;
        const shut = folding.folded(index);
        return (
          <div
            key={keyOf(group, index)}
            {...stylex.props(
              navStyles.group,
              inRun(groups, index, drawn) && navStyles.groupInRun
            )}
          >
            <PartLabel
              part={group.part}
              href={group.partHref}
              current={group.partCurrent === true}
              item={list}
            />
            {named && (
              <GroupLabel
                index={index}
                label={group.label ?? ""}
                heading={heading}
                list={listId}
                count={needle === "" ? group.count : rows.length}
                collapsible={group.collapsible === true}
                shut={shut}
                item={list}
                onFold={() => {
                  folding.fold(index, !shut);
                }}
              />
            )}
            <ul
              id={listId}
              aria-labelledby={named ? heading : undefined}
              {...foldedLook(shut, foldsRead)}
              data-sidebar-fold={
                group.collapsible === true && group.collapsed === undefined
                  ? keyOf(group, index)
                  : undefined
              }
              {...stylex.props(
                navStyles.list,
                group.collapsible === true && navStyles.listUnder
              )}
            >
              {rows.map((row) => renderRow(row, list))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
};
