// Breadcrumb: the path from the top of a site to the page you are on, from shadcn's
// (registry/bases/base/ui/breadcrumb.tsx), converted from Tailwind to StyleX and made Grasp's.
// Palermo has none: it takes Grasp's small type and muted words, each step a link, the page you
// are on in ink, a chevron between them that turns round in right-to-left text.
//
//   <Breadcrumb items={[{ label: "Projects", href: "/projects" }, { label: "Atlas" }]} />
//
// It holds one line, always. When the path is wider than its room, the levels between the first
// and the page's parent fold into a "…" menu, nearest the top first, and unfold when room comes
// back; only then is the page's own name cut off with an ellipsis, down to a few letters, and only
// past that the parent's. On a phone only the parent stays, as a back link. The server sends every
// level on one line; until the script has measured it, or with no script, the levels between give
// way first, so the first level, the parent and the page stay in view.
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { focus } from "../focus/focus";
import { ChevronLeft, ChevronRight, Icon } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { Current } from "./current";
import { HiddenLevels } from "./hidden-levels";
import { breadcrumbWords } from "./words";

const PHONE = media.belowPhone;
const COARSE = media.coarse;

/** What a caller may style: where the breadcrumb sits. Never its look. */
export type BreadcrumbLayoutStyle = LayoutStyle;

/** One step on the path. */
export interface BreadcrumbItem {
  /** The page's name, as its own title says it. */
  label: string;
  /** Where the step goes. The last item, the page you are on, has none. */
  href?: string;
}

/** Every prop a Breadcrumb takes. */
export interface BreadcrumbProps {
  /** The steps, from the top of the site down to the page you are on, which comes last. */
  items: BreadcrumbItem[];
  /**
   * `auto` shows the path, and under 640px only the parent as a back link. `back` always shows the
   * back link, for a header as narrow as a phone's.
   * @default "auto"
   */
  variant?: "auto" | "back";
  /** @deprecated Use `variant`. */
  form?: "auto" | "back";
  /**
   * The name of the path to a screen reader and an agent.
   * @default "Breadcrumb"
   */
  "aria-label"?: string;
  /** The name of the button that opens the folded levels. @default "Show hidden levels" */
  hiddenLabel?: string;
  /** @deprecated Use `layout`. */
  style?: BreadcrumbLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the breadcrumb. */
  layout?: BreadcrumbLayoutStyle;
}

// A link stands a little wider than its words, into the gap round it, so its ring keeps off the
// first and last letter as it does off the line above and below.
const ROOM = grasp.ringOffsetWords;
// Room for the focus ring at the ends of the line, which clips what does not fit.
const RING = `calc(${ROOM} + ${grasp.ringWidth} + ${grasp.ringOffsetWords})`;

const styles = stylex.create({
  nav: {
    minWidth: 0,
  },
  list: {
    display: "flex",
    flexWrap: "nowrap",
    alignItems: "center",
    gap: grasp.space1,
    margin: 0,
    marginInline: `calc(-1 * ${RING})`,
    padding: 0,
    paddingInline: RING,
    overflowX: "clip",
    listStyle: "none",
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    whiteSpace: "nowrap",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    flexShrink: 0,
    minWidth: "auto",
  },
  // A level between the first and the parent: before the line is measured, and with no script, it
  // gives way long before the others.
  between: {
    flexShrink: 1000,
    minWidth: 0,
  },
  // A level folded into the "…", or the "…" while nothing is folded.
  folded: {
    display: "none",
  },
  // The page you are on gives way once the rest are folded, down to a few letters.
  current: {
    flexShrink: 1,
    minWidth: "4em",
  },
  // When even that does not fit, the page's name holds at those few letters and the first level
  // and the parent give way instead; in the back form, the parent alone.
  squeezed: {
    flexShrink: 0,
    maxWidth: "4em",
  },
  yielding: {
    flexShrink: 1,
    minWidth: 0,
  },
  link: {
    position: "relative",
    display: "flex",
    minWidth: 0,
    color: {
      default: grasp.muted,
      ":hover": { default: null, [media.hover]: grasp.ink },
    },
    textDecoration: "none",
    paddingInline: ROOM,
    marginInline: `calc(-1 * ${ROOM})`,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    transitionProperty: "color",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
    // An unseen area makes the link 24px tall, and 44px each way on a touch screen.
    "::after": {
      content: '""',
      position: "absolute",
      insetInline: {
        default: 0,
        [COARSE]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
      },
      insetBlock: {
        default: `calc((${grasp.textSmLine} - ${grasp.space6}) / 2)`,
        [COARSE]: `calc((${grasp.textSmLine} - ${grasp.tap}) / 2)`,
      },
    },
  },
  words: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // The chevron between steps, quieter than the words. Right to left the icon turns round itself.
  separator: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.quiet,
  },
  // The back chevron, inside the parent's link: as far from its words as a chevron from a level's.
  // Its drawing starts 9/24 into its box, so the box is pulled back by that: the "<" itself then
  // starts on the content's edge, and the ring stands as far before it as after the words
  // (A3-nav-03: 10px before against 4px after; A3-nav-07: the "<" started 6px in).
  backChevron: {
    alignItems: "center",
    marginInlineStart: `calc(-9 / 24 * ${grasp.iconSm})`,
    marginInlineEnd: grasp.space1,
  },
  // The back form, under 640px or always: only the parent, as a back link.
  autoHide: {
    display: { default: "flex", [PHONE]: "none" },
  },
  autoParent: {
    flexShrink: { default: 0, [PHONE]: 1 },
    minWidth: { default: "auto", [PHONE]: 0 },
  },
  autoBack: {
    display: { default: "none", [PHONE]: "inline-flex" },
  },
  autoTrail: {
    display: { default: "inline-flex", [PHONE]: "none" },
  },
  backHide: {
    display: "none",
  },
  backShow: {
    display: "inline-flex",
  },
});

/** The levels that fold, nearest the top first: every one between the first and the parent. */
const middleOf = (count: number) => Math.max(0, count - 3);

interface Fit {
  fold: number;
  cut: boolean;
  tight: boolean;
}

// How many levels to fold, whether the page's name is then cut off, and whether even the parent
// must give way, from the line's room and each item's width in full (the "…" included). It never
// folds fewer than `least`: the levels in an open menu stay in it.
const fit = (
  room: number,
  gap: number,
  widths: number[],
  ellipsis: number,
  least: number,
  fewest: number,
  count: number
): Fit => {
  const middle = middleOf(count);
  const total = (fold: number) => {
    const shown = widths.filter((_, index) => index === 0 || index > fold);
    const parts = shown.length + (fold > 0 ? 1 : 0);
    return (
      shown.reduce((sum, width) => sum + width, 0) +
      (fold > 0 ? ellipsis : 0) +
      gap * (parts - 1)
    );
  };
  const slack = 0.01;
  for (let fold = Math.min(least, middle); fold <= middle; fold += 1) {
    if (total(fold) <= room + slack) {
      return { fold, cut: false, tight: false };
    }
  }
  const page = widths.at(-1) ?? 0;
  return {
    fold: middle,
    cut: true,
    tight: total(middle) - page + Math.min(page, fewest) > room + slack,
  };
};

const same = (a: Fit, b: Fit) =>
  a.fold === b.fold && a.cut === b.cut && a.tight === b.tight;

const UNFOLDED: Fit = { fold: 0, cut: false, tight: false };

const unsubscribe = () => {
  // Nothing to undo: the store never changes.
};
const noChange = () => unsubscribe;

// A computed length in pixels; a keyword such as `auto` or `normal` counts as none.
const px = (value: string) => {
  const number = Number(value.replace(/px$/u, ""));
  return Number.isFinite(number) ? number : 0;
};

// Lays every item out in full for a moment, before the browser paints, to measure it: the line's
// own styles stay, so what fits is what will show.
const measureLine = (
  ol: HTMLOListElement,
  back: boolean,
  least: number,
  count: number
): Fit => {
  const all = [...ol.querySelectorAll<HTMLElement>(":scope > li")];
  const last = all.at(-1);
  // The back form shows one level: there is nothing to fold.
  if (last === undefined || back || getComputedStyle(last).display === "none") {
    return UNFOLDED;
  }
  for (const li of all) {
    if (li.dataset.fold !== undefined) {
      li.style.display = "flex";
    }
    li.style.flexShrink = "0";
  }
  const sheet = getComputedStyle(ol);
  const room =
    ol.getBoundingClientRect().width -
    px(sheet.paddingInlineStart) -
    px(sheet.paddingInlineEnd);
  const gap = px(sheet.columnGap);
  const ellipsis =
    all.find((li) => li.dataset.ellipsis !== undefined)?.getBoundingClientRect()
      .width ?? 0;
  const levels = all.filter((li) => li.dataset.ellipsis === undefined);
  // The page's name in full, to the fraction of a pixel, however much of it shows.
  const name = last.querySelector('[aria-current="page"]');
  const range = document.createRange();
  if (name !== null) {
    range.selectNodeContents(name);
  }
  const widths = levels.map((li, index) =>
    index === levels.length - 1 && name !== null
      ? range.getBoundingClientRect().width
      : li.getBoundingClientRect().width
  );
  const fewest = px(getComputedStyle(last).minWidth);
  for (const li of all) {
    li.style.display = "";
    li.style.flexShrink = "";
  }
  return fit(room, gap, widths, ellipsis, least, fewest, count);
};

const seen = (element: HTMLElement) => element.getClientRects().length > 0;

// Focus on a level that just folded moves to the "…", or to the first level shown in its place.
const keepFocus = (ol: HTMLOListElement | null) => {
  const active = document.activeElement;
  if (
    ol === null ||
    !(active instanceof HTMLElement) ||
    !ol.contains(active) ||
    seen(active)
  ) {
    return;
  }
  const next = [
    "[data-ellipsis] button",
    "li[data-fold] a",
    "a",
    "[aria-current]",
  ]
    .map((query) => [...ol.querySelectorAll<HTMLElement>(query)].find(seen))
    .find((element) => element !== undefined);
  next?.focus();
};

// Measures again once the type has loaded, when the words change width, unless the line has gone.
const afterFonts = async (live: () => boolean, measure: () => void) => {
  await document.fonts.ready;
  if (live()) {
    measure();
  }
};

// Measures the line and keeps the fold it finds, unless nothing changed. Levels in an open menu
// stay folded.
const remeasure = (
  ol: HTMLOListElement | null,
  back: boolean,
  drawn: { state: Fit; menu: boolean; count: number },
  setState: (update: (previous: Fit) => Fit) => void
) => {
  if (ol === null) {
    return;
  }
  const next = measureLine(
    ol,
    back,
    drawn.menu ? drawn.state.fold : 0,
    drawn.count
  );
  setState((previous) => (same(previous, next) ? previous : next));
};

// Measures the line whenever its room or a level's width changes, and once the type has loaded; the result undoes it.
const watch = (ol: HTMLOListElement | null, measure: () => void) => {
  if (ol === null) {
    return unsubscribe;
  }
  const observer = new ResizeObserver(() => {
    measure();
  });
  observer.observe(ol);
  // Each level too: past 640px the levels come back while the line itself may keep its width.
  for (const li of ol.children) {
    observer.observe(li);
  }
  let live = true;
  void afterFonts(() => live, measure);
  return () => {
    live = false;
    observer.disconnect();
  };
};

interface LookOf {
  index: number;
  count: number;
  middle: number;
  back: boolean;
  state: Fit;
}

// The styles of the level at `index`: whether it gives way, folds, or hides in the back form.
const lookOf = ({ index, count, middle, back, state }: LookOf) => {
  const last = index === count - 1;
  const isParent = index === count - 2;
  const folds = index >= 1 && index <= middle;
  const hide = back ? styles.backHide : styles.autoHide;
  return [
    styles.item,
    folds && styles.between,
    last && styles.current,
    // In the back form only the parent shows; with no parent, the page itself.
    !isParent && !(last && count === 1) && hide,
    isParent && (back ? styles.yielding : styles.autoParent),
    (isParent || index === 0) && !last && state.tight && styles.yielding,
    last && state.tight && styles.squeezed,
    folds && index <= state.fold && styles.folded,
  ];
};

/** A level above the page: its link, and the chevron after it; the parent's back chevron before. */
const Level = ({
  item,
  isParent,
  back,
  whole,
}: {
  item: BreadcrumbItem;
  isParent: boolean;
  back: boolean;
  whole: boolean;
}) => {
  const words = (
    <span
      title={whole ? item.label : undefined}
      {...stylex.props(styles.words)}
    >
      {item.label}
    </span>
  );
  // The back chevron stands inside the link, so its ring and its target hold the "<" too.
  const chevron = isParent && (
    <span
      aria-hidden="true"
      {...stylex.props(
        styles.separator,
        styles.backChevron,
        back ? styles.backShow : styles.autoBack
      )}
    >
      <Icon icon={ChevronLeft} />
    </span>
  );
  return (
    <>
      {item.href === undefined ? (
        <span {...stylex.props(styles.link)}>
          {chevron}
          {words}
        </span>
      ) : (
        <a href={item.href} {...stylex.props(styles.link, focus.words)}>
          {chevron}
          {words}
        </a>
      )}
      <span
        aria-hidden="true"
        {...stylex.props(
          styles.separator,
          isParent && (back ? styles.backHide : styles.autoTrail)
        )}
      >
        <Icon icon={ChevronRight} />
      </span>
    </>
  );
};

/** The path from the top of the site to the page you are on, on one line. */
export const Breadcrumb = ({
  items,
  form: formDeprecated,
  variant: form = formDeprecated ?? "auto",
  "aria-label": labelGiven,
  hiddenLabel: hiddenLabelGiven,
  style: styleProp,
  layout,
}: BreadcrumbProps) => {
  const { name: label, hidden: hiddenLabel } = withGiven(
    useWords("breadcrumb", breadcrumbWords),
    { name: labelGiven, hidden: hiddenLabelGiven }
  );
  // Until the script runs (and with none) nothing folds and the levels give way with an ellipsis,
  // so each carries its whole name as a title; the fold and the tooltip take over once it runs.
  const scripted = useSyncExternalStore(
    noChange,
    () => true,
    () => false
  );
  const list = useRef<HTMLOListElement>(null);
  const [state, setState] = useState<Fit>(UNFOLDED);
  const [menu, setMenu] = useState(false);
  // The fold and the menu as last drawn, for a measure that runs later (a resize). Kept after each
  // render, before the measures below, which read it.
  const now = useRef({ state, menu, count: items.length });
  useLayoutEffect(() => {
    now.current = { state, menu, count: items.length };
  });
  const count = items.length;
  const middle = middleOf(count);
  const back = form === "back";

  // Measured on new items, a new fold, and the menu closing (what it held may unfold now).
  useLayoutEffect(() => {
    remeasure(
      list.current,
      back,
      { state, menu, count: items.length },
      setState
    );
  }, [back, state, menu, items]);

  // And again when the line's room changes, and once the type has loaded.
  useLayoutEffect(
    () =>
      watch(list.current, () => {
        remeasure(list.current, back, now.current, setState);
      }),
    [back]
  );

  // After a fold, focus on a level that left the line moves to what took its place.
  useLayoutEffect(() => {
    keepFocus(list.current);
  });

  const hidden = items.slice(1, 1 + Math.min(state.fold, middle));
  const levels = items.map((item, index) => (
    <li
      key={`${index}:${item.href ?? item.label}`}
      data-fold={index >= 1 && index <= middle ? "" : undefined}
      {...stylex.props(...lookOf({ index, count, middle, back, state }))}
    >
      {index === count - 1 ? (
        <Current label={item.label} cut={state.cut} whole={!scripted} />
      ) : (
        <Level
          item={item}
          isParent={index === count - 2}
          back={back}
          whole={!scripted}
        />
      )}
    </li>
  ));
  // The "…", after the first level, while there are levels between to fold.
  const ellipsis = middle > 0 && (
    <li
      key="ellipsis"
      data-fold=""
      data-ellipsis=""
      {...stylex.props(
        styles.item,
        back ? styles.backHide : styles.autoHide,
        state.fold === 0 && styles.folded
      )}
    >
      <HiddenLevels
        levels={hidden}
        open={menu}
        onOpenChange={setMenu}
        label={hiddenLabel}
      />
      <span aria-hidden="true" {...stylex.props(styles.separator)}>
        <Icon icon={ChevronRight} />
      </span>
    </li>
  );

  return (
    <nav
      aria-label={label}
      data-slot="breadcrumb"
      {...stylex.props(styles.nav, layout ?? styleProp)}
    >
      <ol ref={list} {...stylex.props(styles.list)}>
        {levels.slice(0, 1)}
        {ellipsis}
        {levels.slice(1)}
      </ol>
    </nav>
  );
};
