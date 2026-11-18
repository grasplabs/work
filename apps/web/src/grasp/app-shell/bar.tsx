"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { createElement, isValidElement, useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { Button } from "../button";
import { DropdownMenuMore } from "../dropdown-menu";
import type { DropdownMenuAction } from "../dropdown-menu";
import { focus } from "../focus/focus";
import { simply } from "../motion/simply.stylex";
import { Skeleton } from "../skeleton";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { cardLine } from "./card-line.stylex";
import { RenamableName } from "./rename";
import { appShellWords } from "./words";

/** A step on the way to the page, in the page bar. The last is the page itself. */
export interface AppShellCrumb {
  /** Its name ("Projects"). */
  label: string;
  /** Where it leads. Leave it out for the page itself. */
  href?: string;
  /** The link itself, when a router draws it: `<Link to="/projects" />`. It takes the crumb's look and name. */
  render?: ReactElement;
  /**
   * The page's own name only (the last crumb, with no `href`): runs with its new name when the person
   * renames it in place, by a double-click, F2 or Enter, in a small popup (Enter keeps it, Escape
   * the old one). Without it, the name cannot be renamed. Keep the name in your own state.
   */
  onRename?: (name: string) => void;
  /**
   * Whether the rename popup is open, when you open it yourself (a menu's Rename): keep it with
   * `onRenamingChange`. Leave it out and the name opens it on its own keys.
   */
  renaming?: boolean;
  /** Runs when the rename popup opens or closes. */
  onRenamingChange?: (renaming: boolean) => void;
}

/** Every prop an AppShellBar takes: what the page bar says. */
export interface AppShellBarProps {
  /** Where the page is: its steps, the page itself last. */
  crumbs?: readonly AppShellCrumb[];
  /**
   * Which crumbs a phone-wide card (under 40rem) keeps: the page and the step before it, the page
   * alone, or the first step alone. At any width a step that does not fit whole goes, the first
   * first, and the page's own name is cut only when no step is left beside it.
   * @default "last-two"
   */
  phoneCrumbs?: "last-two" | "last" | "first";
  /**
   * After the crumbs: where the page's subject stands, such as a status. Where the page's name
   * would be cut beside it, it gives way first, so the name is cut last.
   */
  end?: ReactNode;
  /** @deprecated Use `end`. */
  trailing?: ReactNode;
  /**
   * At the bar's start, before the crumbs: the product's mark and name, as a link home. Where the
   * Menu button leads the bar (a narrow shell with a sidebar), it stands in the menu's head instead.
   */
  brand?: ReactNode;
  /** In the middle of the bar: a short switch between the product's sections ("Docs | Components"). */
  middle?: ReactNode;
  /**
   * Where `middle` goes on a phone's window (under 40rem): `bar`, a row of its own under the bar;
   * `sheet`, the top of the phone's menu, above the sidebar, so the bar keeps one row.
   * @default "bar"
   */
  phoneMiddle?: "bar" | "sheet";
  /** At the end: the page's own buttons, or a TabsNav of its views. It shrinks, once the bar is tight, as far as its parts fold. */
  actions?: ReactNode;
  /**
   * At the end, after `actions`: the page's buttons as items the bar can fold. Drawn as buttons while
   * there is room; when there is not (after the crumbs and `actions` have given way), they fold from
   * the first into one More menu, in order, links as links. The last, the page's main action, stays
   * out. Give the buttons here or in `actions`, not both; a TabsNav goes in `actions` beside these.
   */
  actionItems?: readonly DropdownMenuAction[];
  /**
   * The More button's name.
   * @default "More actions"
   */
  moreLabel?: string;
  /**
   * The name of the crumbs' navigation, said to a screen reader.
   * @default "Breadcrumb"
   */
  breadcrumbLabel?: string;
  /**
   * The crumbs are not known yet: the bar keeps its height and shows a placeholder in their place
   * (Skeleton's dot field), and says it is busy, so nothing jumps when they arrive.
   * @default false
   */
  loading?: boolean;
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
// A small phone's window (under 22.5rem, 360px: a 320px phone), as PHONE is read on the window: a
// brand still in the bar (a shell with no sidebar, so no Menu button) keeps its mark and gives its
// words to a screen reader, so the page's name beside it reads whole (FRESH.md F75b).
const SMALL_PHONE = "@media (width < 22.5rem)";
// A card a phone's width (40rem): where `phoneCrumbs` keeps only some crumbs.
const CARD_PHONE = "@container app-shell-card (width < 40rem)";
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
// over the bar's start (sidebar.tsx `reveal`: its glyph the page's room in from the card, F09): the
// crumbs begin the gap after its glyph.
const REOPEN_INK_END = `calc(${grasp.shellPageInline} + ${grasp.shellIcon})`;
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
  // Where the crumbs will stand while they load: about two crumbs' width, never past the bar's room.
  crumbsLoading: { width: "min(12rem, 40%)", flexShrink: 1, minWidth: 0 },
  bar: {
    // A menu opened from the bar (its actions, its middle) stands on the shell's own surfaces, as the
    // person's menu in the sidebar does (FRESH.md F84): popups in the bar read these.
    "--grasp-popup-fill": grasp.shellPopup,
    "--grasp-popup-line": grasp.shellPopupLine,
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
    // The room for the reopen button opens and closes with the fold, as the card moves: the crumbs
    // ease along with it, never a step of their own (FLAWS.md F12).
    transitionProperty: "padding-inline-start",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
    // One row of 48px (shellBar, F16) by mouse or finger: on a touch screen a crumb's link is 44px
    // tall (tap), and the room above and below it gives way so the row stays 48.
    paddingBlock: {
      default: grasp.shellRowBlock,
      [media.coarse]: `calc((${grasp.shellBar} - ${grasp.tap}) / 2)`,
    },
    backgroundColor: grasp.shellCard,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    // A box for its foot's line (`::after`); a page's own bar is sticky, which is one too.
    position: "relative",
    "::after": {
      content: '""',
      position: "absolute",
      insetInline: cardLine.width,
      insetBlockEnd: 0,
      height: grasp.hairline,
      backgroundColor: {
        default: grasp.shellCardLine,
        [media.forced]: "CanvasText",
      },
      pointerEvents: "none",
    },
  },
  // A page's own bar: at the top of the page, across the card from edge to edge (out over the page's
  // side room), and it stays as the page scrolls under it. On a narrow shell the menu button floats
  // at its start (App shell draws it), so the crumbs begin after it.
  pageBar: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: grasp.shellPageLayer,
    // Out over the page's side room; on a whole page (page="whole") there is none, so it stays on
    // the card's edges and its crumbs keep the page's inset (row 33: they stood flush on the edge).
    marginInline: {
      default: `calc(-1 * ${grasp.shellPageInline})`,
      [stylex.when.ancestor("[data-page-whole]")]: 0,
    },
    // The room under it, as a padded page has above its words; a whole page lays out its own.
    marginBlockEnd: {
      default: grasp.space7,
      [stylex.when.ancestor("[data-page-whole]")]: 0,
    },
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
  // The crumbs' list (F02, A3-shell-02): one line, the page's name first to take its room and the
  // steps before it after, nearest first, each whole or not at all: what does not fit wraps onto a
  // second line, which the nav's clip hides. So the first step goes first, its slash with it, a step
  // is never cut to "Co…", and the page's name is cut only when it stands alone; nothing runs past
  // the room, with or without a script (a docs preview sleeps until it nears the screen). Laid end
  // to start (row-reverse, the steps' `order`), so the eye still reads first step to page.
  crumbs: {
    display: "flex",
    flexDirection: "row-reverse",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    alignContent: "flex-start",
    columnGap: grasp.space2,
    // A second line starts past the nav's clip (its padding, RING_REACH, below this line).
    rowGap: RING_REACH,
    blockSize: { default: grasp.textXsLine, [media.coarse]: grasp.tap },
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // A step: its link, then the slash before the next, whole (it never gives way to an ellipsis).
  crumb: {
    // A step the bar's measure took away (data-gone, `thinSteps`): it wrapped, so it is put away.
    display: { default: "flex", ":is([data-gone])": "none" },
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
    // Each the line's height (a tap's on a touch screen, where a link is), so a step that wrapped
    // always starts below the line, under the nav's clip.
    minBlockSize: { default: null, [media.coarse]: grasp.tap },
    color: grasp.shellTextSecondary,
  },
  // A step's words, cut short with an ellipsis inside its link, so the link's ring is never cut.
  words: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The page's name: first on the line, whole while a step stands beside it; alone on the line it
  // is cut to fit, never under its stub.
  last: { order: -100, flexShrink: 1, minWidth: PAGE_LEAST },
  // The middle in the phone's menu instead: gone from the bar on a phone's window only (40rem), so a
  // shell folded sooner (sheetBelow) keeps it in its bar while there is room.
  middleInSheet: { display: { default: "flex", [PHONE]: "none" } },
  separator: { display: "flex", flexShrink: 0, color: grasp.shellTextTertiary },
  // On a phone-wide card only some crumbs stay (`phoneCrumbs`): read on the card, not the shell,
  // so a shell that folds its sidebar into the menu early (sheetBelow) keeps every step while its
  // card has room (A3-shell-03); past that, steps go only when they do not fit (`crumbs`).
  narrowHidden: {
    display: {
      default: "flex",
      ":is([data-gone])": "none",
      [CARD_PHONE]: "none",
    },
  },
  // The crumbs' list may shrink, so the page's name is cut short rather than the bar overflowing.
  // Never wider than its room: what does not fit is cut at its own edge, never laid over the next
  // part of the bar. The clip spares a link's focus ring: the nav reaches a ring's width past the
  // crumbs on every side (padding) and gives it back (margin), so it takes no more room. Not
  // overflow-clip-margin: Chromium computes a calc() there to 0 and cut the ring (F01).
  // Never narrower than the page's crumb at its least (F02): the page's name keeps its stub inside
  // the nav's clip, and what does not fit beside it gives way (the bar's measure, `fitCrumbs`).
  // The crumbs go whole only at the very last, in a bar that holds more than a phone has room for
  // (fitBar): the page's name stands as its heading under the bar.
  nav: {
    display: { default: "flex", ":is([data-gone])": "none" },
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
  // What trails the crumbs: whole, or not at all. Where the page's name would be cut beside it, it
  // gives way first (the bar's measure, `thinTrailing`, F61): F02's order, the page's name cut last.
  trailing: {
    display: { default: "flex", ":is([data-gone])": "none" },
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
  },
  // What a peeking Sidebar covers of the bar's start (its brand, its crumbs and what trails them) is
  // covered whole: it fades as the panel comes in and back as it leaves, so no crumb stands cut
  // beside the panel's edge as if its own (FRESH.md F76), and the peek's head carries the brand.
  underPeek: {
    // While the Sidebar peeks over it: the shell's grid says so, as it says the fold (app-shell.tsx).
    opacity: {
      default: 1,
      [stylex.when.ancestor("[data-sidebar-peeking]")]: 0,
    },
    visibility: {
      default: "visible",
      [stylex.when.ancestor("[data-sidebar-peeking]")]: "hidden",
    },
    transitionProperty: "opacity, visibility",
    transitionDuration: simply.leave,
    transitionTimingFunction: grasp.ease,
  },
  // Between the brand, a link home, and where the page is: a short rule, as the bar's parts stand the
  // bar's gap apart, so the two never read as one phrase or as a first crumb (FRESH.md F75).
  brandRule: {
    // Gone where the Menu button leads the bar, as the brand is (`brand`, F88).
    display: {
      default: "block",
      [NARROW]: {
        default: "block",
        [stylex.when.ancestor("[data-shell-menu]")]: "none",
      },
    },
    flexShrink: 0,
    width: grasp.separatorWidth,
    height: grasp.iconSm,
    backgroundColor: { default: grasp.line, [media.forced]: "CanvasText" },
  },
  // The brand's words (AppShellBrandName): on a small phone's window, in a bar that still holds the
  // brand (no sidebar, so no Menu button: with one the brand is in the menu, `brand` below), only a
  // screen reader has them, in the link's name, and the mark stands for the product; the crumbs get
  // the room (F75b). Only the bar's own brand gives way there: the same brand in the sidebar's head (a
  // peek, the phone's menu, which stands inside the bar's header) keeps its name.
  brandName: {
    position: {
      default: null,
      [stylex.when.ancestor('[data-slot="app-shell-bar-brand"]')]: {
        default: null,
        [SMALL_PHONE]: "absolute",
      },
    },
    width: {
      default: null,
      [stylex.when.ancestor('[data-slot="app-shell-bar-brand"]')]: {
        default: null,
        [SMALL_PHONE]: 1,
      },
    },
    height: {
      default: null,
      [stylex.when.ancestor('[data-slot="app-shell-bar-brand"]')]: {
        default: null,
        [SMALL_PHONE]: 1,
      },
    },
    margin: {
      default: null,
      [stylex.when.ancestor('[data-slot="app-shell-bar-brand"]')]: {
        default: null,
        [SMALL_PHONE]: -1,
      },
    },
    overflow: {
      default: null,
      [stylex.when.ancestor('[data-slot="app-shell-bar-brand"]')]: {
        default: null,
        [SMALL_PHONE]: "hidden",
      },
    },
    clipPath: {
      default: null,
      [stylex.when.ancestor('[data-slot="app-shell-bar-brand"]')]: {
        default: null,
        [SMALL_PHONE]: "inset(50%)",
      },
    },
    whiteSpace: "nowrap",
  },
  // The mark and name never give way, nor wrap: what the bar's start keeps whole (F14). Where the
  // Menu button leads the bar, the brand is not in it: the button and the brand's mark read as two
  // glyphs side by side, and the menu's head holds the brand (F88). That is a narrow shell (NARROW, as
  // app-shell.tsx shows the button by) with a sidebar to put in the menu, which its grid says
  // (data-shell-menu).
  brand: {
    display: {
      default: "flex",
      [NARROW]: {
        default: "flex",
        [stylex.when.ancestor("[data-shell-menu]")]: "none",
      },
    },
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
    // The first row is the bar's one row at any number of rows: centred where a one-row bar's parts
    // are (half of shellBar down), level with the sidebar head's row; the next row starts under it
    // (FRESH.md F74: two rows put the first 2px higher).
    gridTemplateRows: {
      default: `minmax(calc(${grasp.shellBar} - 2 * ${grasp.shellRowBlock}), auto)`,
      [media.coarse]: `minmax(${grasp.tap}, auto)`,
    },
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
    gridTemplateColumns: {
      default: `minmax(${grasp.space8}, max-content) auto`,
      // What trails gave way (F61): the crumbs' column alone, with no gap kept for it.
      ":has(> [data-gone])": `minmax(${grasp.space8}, max-content)`,
    },
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
  // Once the crumbs have given way and the bar is still too narrow (`data-tight`, fitBar), the end
  // gives way before it leaves the window: the actions shrink in their own row (a TabsNav there
  // folds; buttons scroll sideways, Tab still reaching each), and what the shell puts after them
  // (the panels' button) keeps its whole box, so a closed panel always has a way back.
  tail: {
    display: "flex",
    flexShrink: { default: 0, [stylex.when.ancestor("[data-tight]")]: 1 },
    minWidth: { default: null, [stylex.when.ancestor("[data-tight]")]: 0 },
    alignItems: "center",
    gap: grasp.space3,
    marginInlineStart: "auto",
  },
  // The action items: never shrinking, each whole or folded away into More, which shows once any has.
  items: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
  },
  item: {
    display: { default: "flex", ":is([data-folded])": "none" },
    flexShrink: 0,
  },
  itemWords: {
    display: { default: "flex", [stylex.when.ancestor("[data-bare]")]: "none" },
  },
  itemBare: {
    display: { default: "none", [stylex.when.ancestor("[data-bare]")]: "flex" },
  },
  more: {
    display: { default: "none", ":is([data-shown])": "flex" },
    flexShrink: 0,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: {
      default: null,
      [stylex.when.ancestor("[data-tight]")]: "var(--bar-actions-least, 0px)",
    },
    overflowX: {
      default: null,
      [stylex.when.ancestor("[data-tight]")]: "auto",
    },
    scrollbarWidth: {
      default: null,
      [stylex.when.ancestor("[data-tight]")]: "none",
    },
  },
});

// Each step's place on the line (`crumbs`): the nearer the page, the sooner it takes its room. A
// bar holds a handful of steps; past the last of these they keep the farthest place.
const stepPlaces = stylex.create({
  s0: { order: 0 },
  s1: { order: -1 },
  s2: { order: -2 },
  s3: { order: -3 },
  s4: { order: -4 },
  s5: { order: -5 },
  s6: { order: -6 },
  s7: { order: -7 },
  s8: { order: -8 },
  s9: { order: -9 },
  s10: { order: -10 },
  s11: { order: -11 },
});
const STEP_PLACES = [
  stepPlaces.s0,
  stepPlaces.s1,
  stepPlaces.s2,
  stepPlaces.s3,
  stepPlaces.s4,
  stepPlaces.s5,
  stepPlaces.s6,
  stepPlaces.s7,
  stepPlaces.s8,
  stepPlaces.s9,
  stepPlaces.s10,
  stepPlaces.s11,
];
const stepPlace = (index: number) =>
  STEP_PLACES[Math.min(index, STEP_PLACES.length - 1)];

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
  const { onRename: handleRename, onRenamingChange: handleRenamingChange } =
    crumb;
  if (current && handleRename !== undefined) {
    return (
      <RenamableName
        name={crumb.label}
        onRename={handleRename}
        open={crumb.renaming}
        onOpenChange={handleRenamingChange}
        look={styles.page}
        current
      />
    );
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
  // Whether step `index` (and the slash after it) is left out on a narrow shell.
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
      {...stylex.props(styles.nav, styles.underPeek)}
    >
      <ol {...stylex.props(styles.crumbs)}>
        {crumbs.map((crumb, index) =>
          index === last ? (
            <li
              key={`${crumb.label}-${crumb.href ?? ""}`}
              {...stylex.props(
                styles.crumb,
                styles.last,
                hidden(index) && styles.narrowHidden
              )}
            >
              <CrumbStep crumb={crumb} current />
            </li>
          ) : (
            <li
              key={`${crumb.label}-${crumb.href ?? ""}`}
              data-crumb-step=""
              {...stylex.props(
                styles.crumb,
                stepPlace(index),
                hidden(index) && styles.narrowHidden
              )}
            >
              <CrumbStep crumb={crumb} current={false} />
              <span
                aria-hidden="true"
                {...stylex.props(
                  styles.separator,
                  hidden(index + 1) && styles.narrowHidden
                )}
              >
                /
              </span>
            </li>
          )
        )}
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
/**
 * Whether anything at the bar's end stands past the bar's own edge, either way round. (The shell's
 * buttons hang into the bar's padding by design, so its content edge is not the limit.)
 */
const endPast = (bar: HTMLElement) => {
  const tail = bar.querySelector<HTMLElement>("[data-bar-tail]");
  if (tail === null) {
    return false;
  }
  const box = bar.getBoundingClientRect();
  const start = box.left;
  const end = box.right;
  return [...tail.querySelectorAll<HTMLElement>("button, a")].some(
    (control) => {
      if (
        control.getClientRects().length === 0 ||
        control.closest("[inert], [aria-hidden=true]") !== null
      ) {
        return false;
      }
      const at = control.getBoundingClientRect();
      return at.right > end + 1 || at.left < start - 1;
    }
  );
};

/**
 * Whether the bar runs past its room: its scroll is wider than it, or its end (the shell's buttons
 * after the page's actions) stands past its edge, which the bar's own clip hides from the scroll's
 * measure.
 */
const overflows = (bar: HTMLElement) =>
  bar.scrollWidth > bar.clientWidth + 1 || endPast(bar);

/** Whether a crumb at its least did not fit the crumbs' room: it wrapped past their one line
 * (`crumbs`), under the nav's clip. */
const crowded = (bar: HTMLElement) => {
  const list = bar.querySelector<HTMLElement>(
    '[data-slot="app-shell-crumbs"] > ol'
  );
  if (list === null) {
    return false;
  }
  const line = list.getBoundingClientRect().bottom;
  return [...list.children].some(
    (each) =>
      each.getClientRects().length > 0 &&
      each.getBoundingClientRect().top >= line
  );
};

/** Every step the measure took away, and what trails the crumbs, back. */
const restoreSteps = (bar: HTMLElement) => {
  for (const each of bar.querySelectorAll<HTMLElement>("[data-gone]")) {
    delete each.dataset.gone;
  }
};

/** Takes the steps before the page away, the first first (each with the slash after it), while the
 * crumbs at their least do not fit their room: what wrapped out of sight, out of the tab order too. */
const thinSteps = (bar: HTMLElement) => {
  const steps = [
    ...bar.querySelectorAll<HTMLElement>("[data-crumb-step]"),
  ].filter((each) => each.getClientRects().length > 0);
  for (const step of steps) {
    if (!crowded(bar)) {
      return;
    }
    step.toggleAttribute("data-gone", true);
  }
};

/** Whether the page's own name is cut short where it shows. */
const pageCut = (bar: HTMLElement) => {
  const page = bar.querySelector<HTMLElement>(
    '[data-slot="app-shell-crumbs"] li:not([data-crumb-step]) [title]'
  );
  return page !== null && page.getClientRects().length > 0 && isCut(page);
};

/** After the steps: while the page's name is cut and something trails it, what trails it gives way
 * (F61), so the name is cut last (F02's order). It comes back with the next measure, when there is
 * room. */
const thinTrailing = (bar: HTMLElement) => {
  const trailing = bar.querySelector<HTMLElement>(
    '[data-slot="app-shell-bar-trailing"]'
  );
  if (trailing !== null && pageCut(bar)) {
    trailing.toggleAttribute("data-gone", true);
  }
};

/** What gives way while the crumbs do not fit: the steps before the page, then what trails it. */
const thin = (bar: HTMLElement) => {
  thinSteps(bar);
  thinTrailing(bar);
};

const ROWS = ["one", "two", "three"] as const;

/** The rows the bar takes, and what gives way in them first: the crumbs' steps, then what trails them. */
const fitRows = (bar: HTMLElement) => {
  restoreSteps(bar);
  const middle = bar.querySelector<HTMLElement>(
    '[data-slot="app-shell-bar-middle"]'
  );
  if (middle === null) {
    thin(bar);
    return;
  }
  // A middle in the phone's menu is not in the bar: its sides alone, one row or two.
  const rows =
    getComputedStyle(middle).display === "none" ? ROWS.slice(1) : ROWS;
  for (const each of rows) {
    restoreSteps(bar);
    bar.dataset.rows = each;
    if (each === "one") {
      if (!overflows(bar) && !crowded(bar) && !wordsShown(bar).some(isCut)) {
        return;
      }
    } else {
      thin(bar);
      if (!overflows(bar)) {
        return;
      }
    }
  }
};

/**
 * Last of all, once the crumbs have given way and the bar still runs past its room: the end gives
 * way (`data-tight`), its actions shrinking in their own row, so the shell's own buttons keep their
 * whole box and nothing leaves the bar.
 */
const tighten = (bar: HTMLElement) => {
  // The actions' floor: a TabsNav among them folds to one button, and no further.
  const actions = bar.querySelector<HTMLElement>("[data-bar-actions]");
  if (actions !== null) {
    const folds = [
      ...actions.querySelectorAll<HTMLElement>("[data-tabs-fold] button"),
    ].map((button) => button.getBoundingClientRect().width);
    actions.style.setProperty(
      "--bar-actions-least",
      `${String(Math.ceil(Math.max(0, ...folds)))}px`
    );
  }
  if (overflows(bar)) {
    bar.dataset.tight = "";
  }
};

/**
 * Past even that, at a phone's narrowest with a crowded bar: the main item folds too, last in the
 * More menu, so the shell's own buttons keep their whole box. Returns 1 when it folded.
 */
const foldLast = (bar: HTMLElement) => {
  const items = [...bar.querySelectorAll<HTMLElement>("[data-bar-item]")];
  const last = items.at(-1);
  const more = bar.querySelector<HTMLElement>("[data-bar-more]");
  if (
    last === undefined ||
    more === null ||
    items.length < 2 ||
    !overflows(bar)
  ) {
    return 0;
  }
  last.dataset.folded = "";
  more.dataset.shown = "";
  return 1;
};

/** At the very last, at a phone's least: the last action item shows its icon alone, its words its name. */
const bareLast = (bar: HTMLElement) => {
  const last = [...bar.querySelectorAll<HTMLElement>("[data-bar-item]")].at(-1);
  if (
    last !== undefined &&
    last.querySelector("[data-bar-bare]") !== null &&
    overflows(bar)
  ) {
    last.dataset.bare = "";
  }
};

/**
 * Last, while the bar still runs past its room: the page's action items fold into the More menu,
 * the first first, the last never. Returns how many folded.
 */
const foldItems = (bar: HTMLElement) => {
  const items = [...bar.querySelectorAll<HTMLElement>("[data-bar-item]")];
  const more = bar.querySelector<HTMLElement>("[data-bar-more]");
  let folded = 0;
  if (more === null || items.length < 2 || !overflows(bar)) {
    return folded;
  }
  more.dataset.shown = "";
  for (const item of items.slice(0, -1)) {
    if (!overflows(bar)) {
      break;
    }
    item.dataset.folded = "";
    folded += 1;
  }
  return folded;
};

/** Everything that gave way at the last measure, back, so the bar is measured whole. */
const unfold = (bar: HTMLElement) => {
  delete bar.dataset.tight;
  for (const each of bar.querySelectorAll<HTMLElement>("[data-bar-item]")) {
    delete each.dataset.folded;
    delete each.dataset.bare;
  }
  const more = bar.querySelector<HTMLElement>("[data-bar-more]");
  if (more !== null) {
    delete more.dataset.shown;
  }
};

/**
 * Lays the bar out in the fewest rows in which its parts fit, as the order above says: the crumbs
 * give way, then `actions` (tight), then the action items fold. Returns how many folded.
 */
const fitBar = (bar: HTMLElement) => {
  unfold(bar);
  fitRows(bar);
  tighten(bar);
  const folded = foldItems(bar);
  bareLast(bar);
  const last = foldLast(bar);
  // At the very least room, the crumbs go whole (the page's name is its heading, under the bar);
  // past even that, the actions' floor gives way: they scroll in a box as small as need be (Tab
  // still reaches what is in them). The shell's buttons always keep their whole box.
  const crumbs = bar.querySelector<HTMLElement>(
    '[data-slot="app-shell-crumbs"]'
  );
  if (crumbs !== null && overflows(bar)) {
    crumbs.dataset.gone = "";
  }
  if (overflows(bar)) {
    bar
      .querySelector<HTMLElement>("[data-bar-actions]")
      ?.style.setProperty("--bar-actions-least", "0px");
  }
  return folded + last;
};

// What the measure changes itself, so it is not watched: the start that holds the crumbs, their
// column and the crumbs.
const MEASURED = new Set([
  "app-shell-bar-start",
  "app-shell-bar-where",
  "app-shell-crumbs",
]);

/** The cleanup of an effect that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

/** Measures the bar when it is drawn, and again a frame after its card or a part beside the crumbs
 * changes size, or a font loads. */
const useFitBar = (
  bar: HTMLElement | null,
  onFold: (folded: number) => void
) => {
  // After every draw: the crumbs, the brand or the actions may have changed.
  useEffect(() => {
    if (bar === null) {
      return keep;
    }
    onFold(fitBar(bar));
    const card = bar.parentElement;
    if (card === null || typeof ResizeObserver === "undefined") {
      return keep;
    }
    // A frame later, not inside the observer's report: what the measure changes changes sizes too.
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        onFold(fitBar(bar));
      });
    };
    const watch = new ResizeObserver(later);
    watch.observe(card);
    // And the parts beside the crumbs (the brand, the trailing words, the actions): one may change
    // its words without a new draw of the bar. Not the crumbs, which the measure itself changes.
    for (const part of bar.querySelectorAll<HTMLElement>(
      ':scope > *, [data-slot="app-shell-bar-start"] > *'
    )) {
      if (!MEASURED.has(part.dataset.slot ?? "")) {
        watch.observe(part);
      }
    }
    document.fonts.addEventListener("loadingdone", later);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      document.fonts.removeEventListener("loadingdone", later);
    };
  });
};

/** No action items: one stable list. */
const NO_ITEMS: readonly DropdownMenuAction[] = [];

/** Where an action item leads: the host's router link, an <a href>, or nowhere (a plain button). */
const linkOf = (item: DropdownMenuAction) => {
  if (isValidElement(item.render)) {
    return item.render;
  }
  const { href } = item;
  // An <a href> for the button to draw itself as: its words are the button's own. SAFETY: an <a>'s
  // props are a record of strings to values, which is all Button's `render` reads of them.
  return href === undefined || href === ""
    ? undefined
    : (createElement("a", { href }) as ReactElement<Record<string, unknown>>);
};

/** An action item's look: danger as given, the main one solid, the others quiet. */
const variantOf = (item: DropdownMenuAction, main: boolean) => {
  if (item.danger === true) {
    return "danger";
  }
  return main ? undefined : "ghost";
};

/** An action item as a button: its words, its icon, a link where it leads. The last is the page's main one. */
const ItemButton = ({
  item,
  main,
}: {
  item: DropdownMenuAction;
  main: boolean;
}) => {
  const link = linkOf(item);
  const variant = variantOf(item, main);
  const handleSelect = item.onSelect;
  return (
    <>
      <span data-bar-words="" {...stylex.props(styles.itemWords)}>
        <Button
          size="sm"
          variant={variant}
          icon={item.icon}
          disabled={item.disabled}
          render={link}
          onClick={handleSelect}
        >
          {item.label}
        </Button>
      </span>
      {/* The main item with an icon has a bare twin, its icon alone, for a phone's least room. */}
      {main && item.icon !== undefined && (
        <span data-bar-bare="" {...stylex.props(styles.itemBare)}>
          <Button
            size="sm"
            variant={variant}
            icon={item.icon}
            aria-label={item.label}
            disabled={item.disabled}
            render={link}
            onClick={handleSelect}
          />
        </span>
      )}
    </>
  );
};

/**
 * The page's action items at the bar's end: the More menu (shown once any folded, holding those, in
 * order), then each item as a button, the folded ones out of sight. fitBar folds them as room runs out.
 */
const ActionItems = ({
  items,
  folded,
  moreLabel,
}: {
  items: readonly DropdownMenuAction[];
  folded: number;
  moreLabel: string;
}) => (
  <div data-slot="app-shell-bar-items" {...stylex.props(styles.items)}>
    <span data-bar-more="" {...stylex.props(styles.more)}>
      <DropdownMenuMore actions={items.slice(0, folded)} label={moreLabel} />
    </span>
    {items.map((item, index) => (
      <span
        key={item.label}
        data-bar-item={index}
        {...stylex.props(styles.item, stylex.defaultMarker())}
      >
        <ItemButton item={item} main={index === items.length - 1} />
      </span>
    ))}
  </div>
);

/** The bar's end: the page's actions, its action items, then what the shell puts after them (the panels' button). */
const BarTail = ({
  actions,
  items,
  folded,
  moreLabel,
  barEnd,
  centred,
}: {
  actions: ReactNode;
  items: readonly DropdownMenuAction[];
  folded: number;
  moreLabel: string;
  barEnd: ReactNode;
  centred: boolean;
}) =>
  actions === undefined && items.length === 0 && barEnd === undefined ? null : (
    <div
      data-bar-tail=""
      {...stylex.props(styles.tail, centred && styles.tailCentred)}
    >
      {actions !== undefined && (
        <div data-bar-actions="" {...stylex.props(styles.actions)}>
          {actions}
        </div>
      )}
      {items.length > 0 && (
        <ActionItems items={items} folded={folded} moreLabel={moreLabel} />
      )}
      {barEnd}
    </div>
  );

/** No crumbs: the default, one stable list rather than a new one each render. */
const NO_CRUMBS: readonly AppShellCrumb[] = [];

/** The bar itself, drawn by the frame (with its menu button at the start) or by a page. */
/** The bar says it is busy only while its crumbs load. */
const busyOf = (loading: boolean): true | undefined =>
  loading ? true : undefined;

/** Where the page is: its crumbs, a placeholder while they load, or nothing. */
const whereOf = ({
  loading,
  crumbs,
  phoneCrumbs,
  label,
}: {
  loading: boolean;
  crumbs: readonly AppShellCrumb[];
  phoneCrumbs: AppShellBarProps["phoneCrumbs"];
  label: string;
}) => {
  if (loading) {
    return <Skeleton text="sm" layout={styles.crumbsLoading} />;
  }
  return crumbs.length > 0 ? (
    <Crumbs
      crumbs={crumbs}
      phoneCrumbs={phoneCrumbs ?? "last-two"}
      label={label}
    />
  ) : null;
};

/** The rule between the brand and the crumbs (F75): only where crumbs follow a brand. */
const ruleOf = (brand: ReactNode, where: ReactNode) =>
  brand === undefined || where === null ? null : (
    <span
      aria-hidden="true"
      data-slot="app-shell-bar-rule"
      {...stylex.props(styles.brandRule, styles.underPeek)}
    />
  );

export const PageBar = ({
  look,
  barStart,
  crumbs = NO_CRUMBS,
  phoneCrumbs = "last-two",
  end: trailing,
  brand,
  middle,
  phoneMiddle = "bar",
  actions,
  actionItems,
  moreLabel,
  breadcrumbLabel,
  loading = false,
  barEnd,
}: AppShellBarProps & {
  look: "frame" | "page";
  barStart?: ReactNode;
  barEnd?: ReactNode;
}) => {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const { breadcrumb, more } = withGiven(useWords("appShell", appShellWords), {
    breadcrumb: breadcrumbLabel,
    more: moreLabel,
  });
  // How many of the action items the last measure folded into the More menu.
  const [folded, setFolded] = useState(0);
  useFitBar(bar, setFolded);
  const where = whereOf({ loading, crumbs, phoneCrumbs, label: breadcrumb });
  const head =
    brand === undefined ? null : (
      <div
        data-slot="app-shell-bar-brand"
        {...stylex.props(
          styles.brand,
          styles.underPeek,
          stylex.defaultMarker()
        )}
      >
        {brand}
      </div>
    );
  const rule = ruleOf(brand, where);
  const trail =
    trailing === undefined ? null : (
      <div
        data-slot="app-shell-bar-trailing"
        {...stylex.props(styles.trailing, styles.underPeek)}
      >
        {trailing}
      </div>
    );
  const tail = (
    <BarTail
      actions={actions}
      items={actionItems ?? NO_ITEMS}
      folded={folded}
      moreLabel={more}
      barEnd={barEnd}
      centred={middle !== undefined}
    />
  );
  if (middle === undefined) {
    return (
      <header
        ref={setBar}
        data-slot="app-shell-bar"
        aria-busy={busyOf(loading)}
        {...stylex.props(
          styles.bar,
          look === "page" && styles.pageBar,
          stylex.defaultMarker()
        )}
      >
        {barStart}
        {head}
        {rule}
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
      aria-busy={busyOf(loading)}
      {...stylex.props(
        styles.bar,
        look === "page" && styles.pageBar,
        styles.centred,
        phoneMiddle === "sheet" && styles.centredSheet,
        stylex.defaultMarker()
      )}
    >
      <div data-slot="app-shell-bar-start" {...stylex.props(styles.start)}>
        {barStart}
        {head}
        {rule}
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

export interface AppShellBrandNameProps {
  /** The product's name, as words. In a bar with no sidebar, on a small phone's window, only a screen reader has it. */
  children: ReactNode;
}

/**
 * The product's name inside `brand`, after its mark: `<a href="/"><Mark /><AppShellBrandName>Damsko
 * </AppShellBrandName></a>`. Where the bar leads with the Menu button, the brand is in the menu's
 * head, not the bar, and shows its name there. A bar with no sidebar (no Menu button) keeps the brand:
 * on a small phone's window (under 22.5rem) it shows only the mark there, and the name stays the
 * link's name for a screen reader, so the page's name beside it reads whole.
 */
export const AppShellBrandName = ({ children }: AppShellBrandNameProps) => (
  <span {...stylex.props(styles.brandName)}>{children}</span>
);

/**
 * A page's own page bar, for an App shell with `bar="page"`: render it first in the page. It runs
 * across the top of the card and stays as the page scrolls under it.
 */
export const AppShellBar = ({
  trailing,
  end = trailing,
  ...props
}: AppShellBarProps) => <PageBar look="page" {...props} end={end} />;
