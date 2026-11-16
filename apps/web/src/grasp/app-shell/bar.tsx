// The page bar: across the top of the page's card, flush on it with no edge, one line high. Where
// the page is (its crumbs) at the start, what it is about after them, and the page's actions at the
// end (Ruben's grasp/frame/page-bar.tsx). App shell draws it itself from its own props
// (`bar="frame"`); a page that draws its own (`bar="page"`) renders AppShellBar at its top, where it
// stays as the page scrolls under it.
//
//   <AppShell bar="page" sidebar={<Sidebar … />}>
//     <AppShellBar crumbs={[{ label: "Projects", href: "/projects" }, { label: "Spring launch" }]} />
//     <PageHeader title="Spring launch" />
//   </AppShell>
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Fragment,
  createElement,
  isValidElement,
  useEffect,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";

import { focus } from "../focus/focus";
import { grasp, media } from "../tokens/tokens.stylex";

/** A step on the way to the page, in the page bar. The last is the page itself. */
export interface AppShellCrumb {
  /** Its name ("Projects"). */
  label: string;
  /** Where it leads. Leave it out for the page itself. */
  href?: string;
  /** The link itself, when a router draws it: `<Link to="/projects" />`. It takes the crumb's look and name. */
  render?: ReactElement;
}

/** Every prop an AppShellBar takes: what the page bar says. */
export interface AppShellBarProps {
  /** Where the page is: its steps, the page itself last. */
  crumbs?: readonly AppShellCrumb[];
  /**
   * Which crumbs a narrow shell keeps: the page and the step before it, the page alone, or the
   * first step alone. However many stay, the steps before the page give way before the page's own
   * name is cut.
   * @default "last-two"
   */
  phoneCrumbs?: "last-two" | "last" | "first";
  /** After the crumbs: where the page's subject stands, such as a status. */
  trailing?: ReactNode;
  /** At the bar's start, before the crumbs: the product's mark and name, as a link home. */
  brand?: ReactNode;
  /** In the middle of the bar: a short switch between the product's sections ("Docs | Components"). */
  middle?: ReactNode;
  /**
   * Where `middle` goes on a phone's window (under 40rem): `bar`, a row of its own under the bar;
   * `sheet`, the top of the phone's menu, above the sidebar, so the bar keeps one row.
   * @default "bar"
   */
  phoneMiddle?: "bar" | "sheet";
  /** At the end: the page's own buttons. */
  actions?: ReactNode;
  /**
   * The name of the crumbs' navigation, said to a screen reader.
   * @default "Breadcrumb"
   */
  breadcrumbLabel?: string;
}

// The width under which the sidebar folds into a sheet: the system's phone width, 40rem, measured
// on the shell (app-shell.tsx keeps the same query).
const NARROW = "@container app-shell (width < 40rem)";
const HOVER = media.hover;
// A phone's window, whatever the shell folds by: where `phoneMiddle="sheet"` moves the middle.
const PHONE = "@media (width < 40rem)";
// Under this (34rem: the mark, a crumb, a two-link switch and search fit above it) the bar's middle
// takes its own row. Read on the card round the bar, which is the bar's width (the card beside a
// sidebar may be narrow in a wide window): the bar cannot ask its own width how to lay itself out.
const CARD_NARROW = "@container app-shell-card (width < 34rem)";
// A bar with a middle (F14): two equal sides round it; the start's least is what in it never gives
// way, the end's its actions whole.
const SIDES = "minmax(auto, 1fr) auto minmax(max-content, 1fr)";
const SIDES_NARROW = "minmax(auto, 1fr) max-content";
// Under this (20rem of card: a phone's 320px window) a start and an end that never give way may not
// fit one row together (the Menu button, a brand, a crumb and "Search ⌘K" need 264px of a 272px
// card's 224): each takes a row of its own, the end at the end, rather than run past the card (F02).
const CARD_TIGHT = "@container app-shell-card (width < 20rem)";
// One rule for the bar's edges (FLAWS.md F06, F07, F08, F26): its first and last ink stand as far
// in as the page's words (shellPageInline), at both ends and every width, and every part stands the
// bar's gap (space3) from the next, ink to ink. An icon button's glyph sits inside its box, so the
// bar hangs the empty rim of its fill out into that room. Folded, the Sidebar's reopen button stands
// over the bar's start (sidebar.tsx `reveal`: shellGutter in from the window, the card shellInset):
// the crumbs begin the gap after its glyph.
const REOPEN_INK_END = `calc(${grasp.shellGutter} + ${grasp.shellIconButton} - (${grasp.shellIconButton} - ${grasp.shellIcon}) / 2 - ${grasp.shellInset})`;
const AFTER_REOPEN = `calc(${REOPEN_INK_END} + ${grasp.space3})`;
// The room a crumb's link keeps round its words, inside the box its ring is drawn round (F40): with
// it the ring stands about as far from the first and last letters (4.5–5px) as from the capitals'
// tops and the descenders' feet (5–5.5px, what the line leaves). A hair under space1, so the ring
// keeps clear of the slash the crumbs' gap (space2) away as well as of its own letters. The link
// gives it back with a negative margin, so the crumbs stand where they did and nothing moves on focus.
const CRUMB_ROOM = `calc(${grasp.space1} - ${grasp.hairline})`;
// A ring's reach past the crumbs' words: the room a clipping box keeps round them.
const RING_REACH = `calc(${grasp.ringWidth} + ${grasp.ringOffsetWords} + ${CRUMB_ROOM})`;
// The page's crumb at its least: a readable stub, its first letters and the ellipsis (F02, F14).
const PAGE_LEAST = grasp.space8;

const styles = stylex.create({
  bar: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: grasp.shellBar,
    paddingInlineStart: {
      default: grasp.shellPageInline,
      // While the Sidebar is folded away, its button to open it again stands at the bar's start, a
      // gap's width before the crumbs.
      [stylex.when.ancestor("[data-sidebar-folded]")]: AFTER_REOPEN,
      // Narrow, the Menu button leads the bar, its glyph where the page's words begin.
      [NARROW]: grasp.shellPageInline,
    },
    paddingInlineEnd: grasp.shellPageInline,
    // One row of 48px (shellBar, F16) by mouse or finger: on a touch screen a crumb's link is 44px
    // tall (tap), and the room above and below it gives way so the row stays 48.
    paddingBlock: {
      default: grasp.shellRowBlock,
      [media.coarse]: `calc((${grasp.shellBar} - ${grasp.tap}) / 2)`,
    },
    backgroundColor: grasp.shellCard,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  // A page's own bar: at the top of the page, across the card from edge to edge (out over the page's
  // side room), and it stays as the page scrolls under it. On a narrow shell the menu button floats
  // at its start (App shell draws it), so the crumbs begin after it.
  pageBar: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: grasp.shellPageLayer,
    marginInline: `calc(-1 * ${grasp.shellPageInline})`,
    marginBlockEnd: grasp.space7,
    paddingInlineStart: {
      default: grasp.shellPageInline,
      [stylex.when.ancestor("[data-sidebar-folded]")]: AFTER_REOPEN,
      // The Menu button's glyph (an icon, iconSm) at the page's edge, then the bar's gap.
      [NARROW]: `calc(${grasp.shellPageInline} + ${grasp.iconSm} + ${grasp.space3})`,
    },
    // On a phone with panels their button floats at the row's end (app-shell.tsx, F20): the same.
    paddingInlineEnd: {
      default: grasp.shellPageInline,
      [NARROW]: {
        default: grasp.shellPageInline,
        [stylex.when.ancestor("[data-shell-panels]")]:
          `calc(${grasp.shellPageInline} + ${grasp.iconSm} + ${grasp.space3})`,
      },
    },
  },
  crumbs: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // The steps before the page give way first, cut short, so the page's own name is cut last.
  crumb: {
    // A step the bar's measure took away (data-gone, `fitCrumbs`): no room for it at its least.
    display: { default: "flex", ":is([data-gone])": "none" },
    flexShrink: 100,
    alignItems: "center",
    // Never to nothing: a step keeps its first letter and its ellipsis, so no bare slash leads. On a
    // touch screen never narrower than its link, which a finger needs 44px wide: the step stays in
    // its own box, never laid over the slash after it.
    minWidth: { default: grasp.space6, [media.coarse]: grasp.tap },
    color: grasp.shellTextSecondary,
  },
  // A step's words, cut short with an ellipsis inside its link, so the link's ring is never cut.
  words: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  last: { flexShrink: 1, minWidth: PAGE_LEAST },
  // The middle in the phone's menu instead: gone from the bar on a phone's window only (40rem), so a
  // shell folded sooner (sheetBelow) keeps it in its bar while there is room.
  middleInSheet: { display: { default: "flex", [PHONE]: "none" } },
  separator: {
    display: { default: "flex", ":is([data-gone])": "none" },
    flexShrink: 0,
    color: grasp.shellTextTertiary,
  },
  // On a narrow shell only some crumbs stay (`phoneCrumbs`).
  narrowHidden: {
    display: { default: "flex", ":is([data-gone])": "none", [NARROW]: "none" },
  },
  // The crumbs' list may shrink, so the page's name is cut short rather than the bar overflowing.
  // Never wider than its room: what does not fit is cut at its own edge, never laid over the next
  // part of the bar. The clip spares a link's focus ring: the nav reaches a ring's width past the
  // crumbs on every side (padding) and gives it back (margin), so it takes no more room. Not
  // overflow-clip-margin: Chromium computes a calc() there to 0 and cut the ring (F01).
  // Never narrower than the page's crumb at its least (F02): the page's name keeps its stub inside
  // the nav's clip, and what does not fit beside it gives way (the bar's measure, `fitCrumbs`).
  nav: {
    display: "flex",
    minWidth: `calc(${PAGE_LEAST} + 2 * ${RING_REACH})`,
    overflow: "clip",
    padding: RING_REACH,
    margin: `calc(-1 * ${RING_REACH})`,
  },
  // A finger needs 44px: on a touch screen a crumb's link is that tall.
  link: {
    position: "relative",
    display: "inline-flex",
    minWidth: 0,
    alignItems: "center",
    minHeight: { default: null, [media.coarse]: grasp.tap },
    borderRadius: grasp.cornerMark,
    color: {
      default: grasp.shellTextSecondary,
      [HOVER]: { default: grasp.shellTextSecondary, ":hover": grasp.shellText },
    },
    textDecoration: "none",
    transitionProperty: "color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
    // A finger needs 44px on a touch screen, however short the crumb's words: the link itself, so
    // no unseen area reaches into the next crumb.
    justifyContent: "center",
    minInlineSize: { default: null, [media.coarse]: grasp.tap },
    paddingInline: CRUMB_ROOM,
    marginInline: `calc(-1 * ${CRUMB_ROOM})`,
  },
  page: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: grasp.shellText,
    fontWeight: grasp.weightMedium,
  },
  trailing: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
  },
  // The mark and name never give way, nor wrap: what the bar's start keeps whole (F14).
  brand: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    whiteSpace: "nowrap",
  },
  // A bar with a middle (F14): three columns, the middle on the bar's own centre, so it stands in the
  // same place on every page whatever the crumbs say. The two sides share what is left equally, and
  // each is never narrower than what in it never gives way: the start's fold or Menu button, the
  // brand, the page's crumb at its least (32px) and what trails it; the end's actions. So the
  // crumbs give way first (their ellipsis); only when the start's least is more than its half does
  // the middle move toward the end, by just that much, never over either side; and under 34rem the
  // middle takes a row of its own under the rest, centred on the bar.
  // On a touch screen the rows stand further apart, so a button on each gets 44px of its own.
  // The end's least is its actions whole (max-content): a button's words never wrap to make room.
  centred: {
    display: "grid",
    // Without a script (the server's first draw), the card's width decides the rows: the tight rule
    // inside the narrow one, so it wins where both hold. Awake, the bar measures what fits
    // (`fitBar`) and says so in data-rows: `one`, the middle between the sides; `two`, the middle on
    // a row of its own under them; `three`, the start, the end and the middle each a row.
    gridTemplateColumns: {
      default: SIDES,
      ":not([data-rows])": {
        [CARD_NARROW]: {
          default: SIDES_NARROW,
          [CARD_TIGHT]: "minmax(0, 1fr)",
        },
      },
      ":is([data-rows=two])": SIDES_NARROW,
      ":is([data-rows=three])": "minmax(0, 1fr)",
    },
    gridTemplateAreas: {
      default: '"start middle end"',
      ":not([data-rows])": {
        [CARD_NARROW]: {
          default: '"start end" "middle middle"',
          [CARD_TIGHT]: '"start" "end" "middle"',
        },
      },
      ":is([data-rows=two])": '"start end" "middle middle"',
      ":is([data-rows=three])": '"start" "end" "middle"',
    },
    rowGap: { default: grasp.space1, [media.coarse]: grasp.space3 },
  },
  // The same where the middle moves into the phone's menu: on a phone's window the bar is the start
  // and the end alone.
  centredSheet: {
    // The phone's rule inside the card's: a container query would otherwise win over the media one.
    gridTemplateColumns: {
      default: SIDES,
      ":not([data-rows])": {
        [CARD_NARROW]: {
          default: SIDES_NARROW,
          [CARD_TIGHT]: "minmax(0, 1fr)",
        },
        [PHONE]: SIDES_NARROW,
      },
      ":is([data-rows=two])": SIDES_NARROW,
      ":is([data-rows=three])": "minmax(0, 1fr)",
    },
    gridTemplateAreas: {
      default: '"start middle end"',
      ":not([data-rows])": {
        [CARD_NARROW]: {
          default: '"start end" "middle middle"',
          [PHONE]: '"start end"',
          [CARD_TIGHT]: {
            default: '"start" "end" "middle"',
            [PHONE]: '"start" "end"',
          },
        },
        [PHONE]: '"start end"',
      },
      ":is([data-rows=two])": {
        default: '"start end" "middle middle"',
        [PHONE]: '"start end"',
      },
      ":is([data-rows=three])": {
        default: '"start" "end" "middle"',
        [PHONE]: '"start" "end"',
      },
    },
  },
  // The start's parts, side by side: the fold or Menu button, the brand, then the crumbs and what
  // trails them.
  // Its least is what is in it (min-width auto, which the page's reset would take to 0).
  start: {
    gridArea: "start",
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minWidth: "auto",
  },
  // The crumbs and what trails them. Their column is never under the page's crumb at its least, and
  // never wider than the crumbs: the crumbs' whole words do not count toward the start's least, so
  // they give way before the middle moves.
  where: {
    display: "grid",
    flexGrow: 1,
    gridTemplateColumns: `minmax(${grasp.space8}, max-content)`,
    alignItems: "center",
    justifyContent: "start",
    columnGap: grasp.space3,
  },
  whereTrailed: {
    gridTemplateColumns: `minmax(${grasp.space8}, max-content) auto`,
  },
  middle: {
    gridArea: "middle",
    minWidth: "auto",
    justifySelf: "center",
    display: "flex",
    whiteSpace: "nowrap",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space2,
  },
  // The end in a bar with a middle: its own column.
  tailCentred: {
    gridArea: "end",
    justifySelf: "end",
    marginInlineStart: 0,
    minWidth: "auto",
  },
  // The bar's end, at its end: the page's actions, then the shell's own button, the bar's gap apart.
  tail: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space3,
    marginInlineStart: "auto",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
  },
});

/** A crumb that leads somewhere: the caller's link, or a plain one, in the bar's link look. */
const CrumbLink = ({ crumb }: { crumb: AppShellCrumb }) => {
  const look = stylex.props(styles.link, focus.words);
  if (
    crumb.render !== undefined &&
    isValidElement<{ className?: string; children?: ReactNode }>(crumb.render)
  ) {
    const own = crumb.render.props.className;
    const props = {
      className: [own, look.className]
        .filter((part) => part !== undefined && part !== "")
        .join(" "),
      children: (
        <span title={crumb.label} dir="auto" {...stylex.props(styles.words)}>
          {crumb.label}
        </span>
      ),
    };
    // The caller's element again, its own props and the crumb's together.
    return createElement(crumb.render.type, {
      ...crumb.render.props,
      ...props,
    });
  }
  return (
    <a href={crumb.href} {...look}>
      <span title={crumb.label} dir="auto" {...stylex.props(styles.words)}>
        {crumb.label}
      </span>
    </a>
  );
};

/** One step: a link when it leads somewhere, else the page itself, named as the current page when last. */
const CrumbStep = ({
  crumb,
  current,
}: {
  crumb: AppShellCrumb;
  current: boolean;
}) => {
  if (crumb.href !== undefined || crumb.render !== undefined) {
    return <CrumbLink crumb={crumb} />;
  }
  return (
    <span
      aria-current={current ? "page" : undefined}
      title={crumb.label}
      dir="auto"
      {...stylex.props(styles.page)}
    >
      {crumb.label}
    </span>
  );
};

/** The crumbs: each step a link, the page itself last, with a slash between. */
const Crumbs = ({
  crumbs,
  phoneCrumbs,
  label,
}: {
  crumbs: readonly AppShellCrumb[];
  phoneCrumbs: "last-two" | "last" | "first";
  label: string;
}) => {
  const last = crumbs.length - 1;
  // Whether step `index` (and the slash before it) is left out on a narrow shell.
  const hidden = (index: number): boolean => {
    if (phoneCrumbs === "first") {
      return index > 0;
    }
    return index < (phoneCrumbs === "last" ? last : last - 1);
  };
  return (
    <nav
      aria-label={label}
      data-slot="app-shell-crumbs"
      {...stylex.props(styles.nav)}
    >
      <ol {...stylex.props(styles.crumbs)}>
        {crumbs.map((crumb, index) => (
          <Fragment key={`${crumb.label}-${crumb.href ?? ""}`}>
            {index > 0 && (
              <li
                aria-hidden="true"
                {...stylex.props(
                  styles.separator,
                  (hidden(index) || hidden(index - 1)) && styles.narrowHidden
                )}
              >
                /
              </li>
            )}
            <li
              data-crumb-step={index === last ? undefined : ""}
              {...stylex.props(
                styles.crumb,
                index === last && styles.last,
                hidden(index) && styles.narrowHidden
              )}
            >
              <CrumbStep crumb={crumb} current={index === last} />
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
};

// The bar's measure (F02, F03, F39, F46). CSS cannot ask whether words are cut, so once awake the
// bar measures, from scratch each time its card's width or its parts change, in this order:
//   1. With a middle, one row (`data-rows="one"`) only while every crumb shows whole and nothing runs
//      past the bar: no crumb is ever cut while the middle shows beside it (F46).
//   2. Else the middle takes a row of its own under the start and the end (`two`). Now the crumbs
//      may give way: first their words, to an ellipsis inside their own room; then, while the steps
//      before the page still do not fit beside it at their least, those steps go, the first first,
//      with the slash after each (data-gone). The page's own name never goes under its stub.
//   3. Else, when even the start at its least and the end do not fit one row, each takes a row of
//      its own (`three`), and the steps are looked at again with the room that gives.
// A bar with no middle is one row: only step 2's giving way applies. What is tried is drawn in the
// same task, before the browser paints, so nothing flickers.

/** The words of each crumb shown, which carry the whole in their title. */
const wordsShown = (bar: HTMLElement) =>
  [
    ...bar.querySelectorAll<HTMLElement>(
      '[data-slot="app-shell-crumbs"] [title]'
    ),
  ].filter((each) => each.getClientRects().length > 0);

/** Whether a crumb's words are cut short: the words' own width past their box. */
const isCut = (words: HTMLElement) => {
  const range = document.createRange();
  range.selectNodeContents(words);
  return (
    range.getBoundingClientRect().width >
    words.getBoundingClientRect().width + 0.5
  );
};

/** Whether anything in the bar runs past its end. */
const overflows = (bar: HTMLElement) => bar.scrollWidth > bar.clientWidth + 1;

/** Whether the crumbs at their least run past their navigation's room. */
const crowded = (bar: HTMLElement) => {
  const nav = bar.querySelector<HTMLElement>('[data-slot="app-shell-crumbs"]');
  const list = nav?.querySelector<HTMLElement>(":scope > ol");
  if (
    nav === null ||
    nav === undefined ||
    list === null ||
    list === undefined
  ) {
    return false;
  }
  // The nav's room is inside its padding (the ring's reach, which its margin gives back); a
  // computed padding is always in px.
  const look = getComputedStyle(nav);
  const pad =
    Number(look.paddingInlineStart.replace("px", "")) +
    Number(look.paddingInlineEnd.replace("px", ""));
  return list.scrollWidth > nav.clientWidth - pad + 1;
};

/** Every step and slash the measure took away, back. */
const restoreSteps = (bar: HTMLElement) => {
  for (const each of bar.querySelectorAll<HTMLElement>("[data-gone]")) {
    delete each.dataset.gone;
  }
};

/** Takes the steps before the page away, the first first, with the slash after each, while the
 * crumbs at their least do not fit their room. */
const thinSteps = (bar: HTMLElement) => {
  const steps = [
    ...bar.querySelectorAll<HTMLElement>("[data-crumb-step]"),
  ].filter((each) => each.getClientRects().length > 0);
  for (const step of steps) {
    if (!crowded(bar)) {
      return;
    }
    step.toggleAttribute("data-gone", true);
    step.nextElementSibling?.toggleAttribute("data-gone", true);
  }
};

const ROWS = ["one", "two", "three"] as const;

/** Lays the bar out in the fewest rows in which its parts fit, as the order above says. */
const fitBar = (bar: HTMLElement) => {
  restoreSteps(bar);
  const middle = bar.querySelector<HTMLElement>(
    '[data-slot="app-shell-bar-middle"]'
  );
  if (middle === null) {
    thinSteps(bar);
    return;
  }
  // A middle in the phone's menu is not in the bar: its sides alone, one row or two.
  const rows =
    getComputedStyle(middle).display === "none" ? ROWS.slice(1) : ROWS;
  for (const each of rows) {
    restoreSteps(bar);
    bar.dataset.rows = each;
    if (each === "one") {
      if (!overflows(bar) && !wordsShown(bar).some(isCut)) {
        return;
      }
    } else {
      thinSteps(bar);
      if (!overflows(bar)) {
        return;
      }
    }
  }
};

/** The cleanup of an effect that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

/** Measures the bar when it is drawn, and again a frame after its card changes size or a font loads. */
const useFitBar = (bar: HTMLElement | null) => {
  // After every draw: the crumbs, the brand or the actions may have changed.
  useEffect(() => {
    if (bar === null) {
      return keep;
    }
    fitBar(bar);
    const card = bar.parentElement;
    if (card === null || typeof ResizeObserver === "undefined") {
      return keep;
    }
    // A frame later, not inside the observer's report: what the measure changes changes sizes too.
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        fitBar(bar);
      });
    };
    const watch = new ResizeObserver(later);
    watch.observe(card);
    document.fonts.addEventListener("loadingdone", later);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      document.fonts.removeEventListener("loadingdone", later);
    };
  });
};

/** No crumbs: the default, one stable list rather than a new one each render. */
const NO_CRUMBS: readonly AppShellCrumb[] = [];

/** The bar itself, drawn by the frame (with its menu button at the start) or by a page. */
export const PageBar = ({
  look,
  start,
  crumbs = NO_CRUMBS,
  phoneCrumbs = "last-two",
  trailing,
  brand,
  middle,
  phoneMiddle = "bar",
  actions,
  breadcrumbLabel = "Breadcrumb",
  end,
}: AppShellBarProps & {
  look: "frame" | "page";
  start?: ReactNode;
  end?: ReactNode;
}) => {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  useFitBar(bar);
  const head =
    brand === undefined ? null : (
      <div {...stylex.props(styles.brand)}>{brand}</div>
    );
  const where =
    crumbs.length > 0 ? (
      <Crumbs
        crumbs={crumbs}
        phoneCrumbs={phoneCrumbs}
        label={breadcrumbLabel}
      />
    ) : null;
  const trail =
    trailing === undefined ? null : (
      <div {...stylex.props(styles.trailing)}>{trailing}</div>
    );
  // The end: the page's actions, then what the shell puts after them (the panels' button on a phone).
  const tail =
    actions === undefined && end === undefined ? null : (
      <div
        {...stylex.props(
          styles.tail,
          middle !== undefined && styles.tailCentred
        )}
      >
        {actions !== undefined && (
          <div {...stylex.props(styles.actions)}>{actions}</div>
        )}
        {end}
      </div>
    );
  if (middle === undefined) {
    return (
      <header
        ref={setBar}
        data-slot="app-shell-bar"
        {...stylex.props(styles.bar, look === "page" && styles.pageBar)}
      >
        {start}
        {head}
        {where}
        {trail}
        {tail}
      </header>
    );
  }
  return (
    <header
      ref={setBar}
      data-slot="app-shell-bar"
      {...stylex.props(
        styles.bar,
        look === "page" && styles.pageBar,
        styles.centred,
        phoneMiddle === "sheet" && styles.centredSheet
      )}
    >
      <div data-slot="app-shell-bar-start" {...stylex.props(styles.start)}>
        {start}
        {head}
        {(where !== null || trail !== null) && (
          <div
            data-slot="app-shell-bar-where"
            {...stylex.props(
              styles.where,
              trail !== null && styles.whereTrailed
            )}
          >
            {where}
            {trail}
          </div>
        )}
      </div>
      <div
        data-slot="app-shell-bar-middle"
        {...stylex.props(
          styles.middle,
          phoneMiddle === "sheet" && styles.middleInSheet
        )}
      >
        {middle}
      </div>
      {tail}
    </header>
  );
};

/**
 * A page's own page bar, for an App shell with `bar="page"`: render it first in the page. It runs
 * across the top of the card and stays as the page scrolls under it.
 */
export const AppShellBar = (props: AppShellBarProps) => (
  <PageBar look="page" {...props} />
);
