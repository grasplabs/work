// The page's card with the shell's panels beside it, at the end side: a docked chat or a second
// page (the product's frame/app-frame.tsx `panels`, and its Panel's resize). The two stand on the
// window's ground as two cards; between them the gutter is the handle that resizes the panels, by
// pointer or with the arrow keys (Shift for a longer step, Home and End to the ends). Its width
// lives with the host (`panelWidth`, `onPanelWidthChange`), in pixels, kept between its least and
// most and never past half the shell, as the product has it.
//
// Two things put the panels over the page instead: `covered` (a panel full screen), and a narrow
// shell, where the panels take the window under the bar's row (F20: the row keeps the Menu button
// and the panels' own button, which sets them aside for the page). The card then spans the shell
// beside the sidebar, the page in it fades out and takes no presses or keys, and the panels stand
// over it, on the card's own ground.
//
// The group is always there, with or without panels: the page's card is the same element before,
// while and after a panel stands beside it, so a page keeps its scroll place, its fields' text and
// its state when a chat opens (the panels' side is simply at no width, with nothing in it).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  ResizableHandle as ResizableHandlePrimitive,
  ResizablePanel as ResizablePanelPrimitive,
} from "@ui-sdk/react/resizable";
import type { ResizableLayoutChangeDetails } from "@ui-sdk/react/resizable";
import { createContext, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { Button } from "../button";
import { focus } from "../focus/focus";
import { Cross } from "../icons";
import { simply } from "../motion/simply.stylex";
import { Resizable } from "../resizable";
import { grasp, media } from "../tokens/tokens.stylex";
import { CardLine } from "./card-line";
import { cardLine } from "./card-line.stylex";
import { FOCUSABLE, firstStop, placeOf } from "./focus-place";

const NARROW = "@container app-shell (width < 40rem)";
// Before the script has measured the column (on the server, before hydration), the crowded rule is
// guessed in CSS for the default least widths: the page's 366 with its margin and the panels' 340.
// Once measured, the script decides, with the host's own least.
const CROWDED = "@container app-shell-column (width < 706px)";

/** The page card's least width, in pixels: a phone's width less the window's margins, so the
 * product's page stays readable. Where the column cannot hold the page at this width beside the
 * panels at their least, the panels cover the page instead (the shell's crowded rule). */
export const PAGE_MIN = 360;

/** The room the page's card takes beside the panels: its least and the margin at its start (the
 * token `shell-inset`, 6px; beside the panels it has none at its end). */
const PAGE_ROOM = PAGE_MIN + 6;

/** How far an arrow key resizes the panels, in pixels; with Shift, five times as far. */
const STEP = 24;
const LARGE_STEP = STEP * 5;

const styles = stylex.create({
  // What the cards stand in: the column beside the sidebar. What goes over the page is placed in it.
  column: {
    position: "relative",
    containerType: "inline-size",
    containerName: "app-shell-column",
    minWidth: 0,
    minHeight: 0,
  },
  // A side of the group: the page's card, or the panels. It never scrolls and never shows a bar: what it holds
  // is clipped while its width moves.
  side: { minWidth: 0, minHeight: 0, overflow: "clip" },
  // While the panels come or go, both sides of the group change width as one movement.
  sideComing: {
    transitionProperty: "flex-basis",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  sideGoing: {
    transitionProperty: "flex-basis",
    transitionDuration: simply.leave,
    transitionTimingFunction: grasp.ease,
  },
  // The panels' side holds its card at its final width from the first frame: the card is uncovered
  // from the end edge, never laid out again per frame.
  hold: (width: number) => ({
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "minmax(0, 1fr)",
    height: "100%",
    width: { default: width, [NARROW]: "auto" },
    minHeight: 0,
  }),
  holdFree: { width: "auto" },
  // Closed, the panels stay drawn but out of sight and reach, so opening them again is a change of
  // state, not a first drawing: no long frame as they come, and their scroll and draft are kept.
  closedAway: { visibility: "hidden" },
  // Over the page (crowded, covered, a phone): the card fades in and rises a little.
  over: {
    transitionProperty: "opacity, translate",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  overAway: {
    opacity: 0,
    translate: `0 ${grasp.space3}`,
    transitionDuration: simply.leave,
  },
  // On a phone the panels are always over the page: the same coming and going there.
  overAwayNarrow: {
    opacity: { default: null, [NARROW]: 0 },
    translate: { default: null, [NARROW]: `0 ${grasp.space5}` },
    transitionDuration: { default: null, [NARROW]: simply.leave },
  },
  gone: { display: "none" },
  handleAway: { visibility: "hidden" },
  // Inside a panel of the group, a box the card fills, margins and all.
  fit: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "minmax(0, 1fr)",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
  },
  // The panels' own card, on the ground at the end, a hair off the window's edges. A container: while
  // it moves, what is in it is held at its end width (`heldDocking`, `heldCovering`), and a part that
  // keeps to the card's seen end (a head's end button) measures the card itself with `100cqi`
  // (FRESH.md F82d).
  panels: {
    containerType: "inline-size",
    containerName: "app-shell-panels",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "minmax(0, 1fr)",
    minWidth: 0,
    minHeight: 0,
    marginBlock: grasp.shellInset,
    marginInlineEnd: grasp.shellInset,
    overflow: "clip",
    borderRadius: grasp.shellCardCorner,
    backgroundColor: grasp.shellCard,
    // Its edge a line inside it, round all four corners, as the page's card (app-shell.tsx `card`,
    // FRESH.md F89): drawn outside, a lift was cut by the clip of its side of the group. Drawn over
    // what it holds (card-line.tsx), so a head's ground never covers it; the card is its box.
    position: "relative",
    [cardLine.width]: grasp.hairline,
  },
  headLine: {
    position: "absolute",
    insetBlockStart: `calc(${grasp.shellBar} - ${grasp.hairline})`,
    insetInline: { default: grasp.hairline, [NARROW]: 0 },
    zIndex: `calc(${grasp.shellPageLayer} + 1)`,
    height: grasp.hairline,
    backgroundColor: {
      default: grasp.shellCardLine,
      [media.forced]: "CanvasText",
    },
    pointerEvents: "none",
  },
  // On a narrow shell the panels take the whole window, over the page, on the card's ground.
  panelsNarrow: {
    position: { default: "relative", [NARROW]: "absolute" },
    inset: { default: null, [NARROW]: 0 },
    zIndex: { default: null, [NARROW]: grasp.shellPageLayer },
    marginBlock: { default: grasp.shellInset, [NARROW]: 0 },
    marginInlineEnd: { default: grasp.shellInset, [NARROW]: 0 },
    borderRadius: { default: grasp.shellCardCorner, [NARROW]: 0 },
    backgroundColor: { default: grasp.shellCard, [NARROW]: "transparent" },
    [cardLine.width]: { default: grasp.hairline, [NARROW]: "0px" },
  },
  // Lifted off their side while they go full screen or come back beside the page (F13): over the
  // column, in the box they have beside the page, their start easing to its place as the page's
  // side changes width under them.
  lifted: (shown: number) => ({
    position: { default: "absolute", [NARROW]: "absolute" },
    insetBlock: { default: grasp.shellInset, [NARROW]: 0 },
    insetInlineStart: { default: `calc(100% - ${shown}px)`, [NARROW]: 0 },
    insetInlineEnd: { default: grasp.shellInset, [NARROW]: 0 },
    zIndex: grasp.shellPageLayer,
    marginBlock: 0,
    marginInlineEnd: 0,
  }),
  // Their start moves with the page's side, on its time and its curve.
  shifting: {
    transitionProperty: "opacity, translate, inset-inline-start",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  // Going full screen they keep their own card's look until they lie on the page's card, whole.
  stillCard: {
    borderRadius: { default: grasp.shellCardCorner, [NARROW]: 0 },
    backgroundColor: { default: grasp.shellCard, [NARROW]: "transparent" },
    [cardLine.width]: { default: grasp.hairline, [NARROW]: "0px" },
  },
  // While their box moves (going full screen or docking again), what is in them is held at the width
  // it ends at: its words wrap once, never again every frame (App shell FRESH.md F82), as `hold` does
  // when they come in. It rides with their moving start, so what is read first (the head, the start of
  // the words) is there from the first frame, and what does not fit yet is cut at their end (F82,
  // changed in batch 3: held at the end, the start showed some 200ms of empty card).
  // Docking, the end is their width beside the page, less the margin at their end (`heldDocking`,
  // as `lifted` places them); going full screen, the column
  // less the cards' margins, and the reopen button's room while the sidebar is folded, as
  // `panelsCovering` and `panelsAfterReopen` place them (the column is the container `cqi` reads).
  heldDocking: (shown: number) => ({
    gridTemplateColumns: {
      default: `calc(${shown}px - ${grasp.shellInset})`,
      [NARROW]: "minmax(0, 1fr)",
    },
    justifyContent: "start",
  }),
  heldCovering: {
    gridTemplateColumns: {
      default: `calc(100cqi - 2 * ${grasp.shellInset})`,
      [stylex.when.ancestor("[data-sidebar-folded]")]: {
        default: `calc(100cqi - 2 * ${grasp.shellInset} - ${grasp.shellPageInline} - ${grasp.shellIcon} - ${grasp.space3})`,
        [NARROW]: "minmax(0, 1fr)",
      },
      [NARROW]: "minmax(0, 1fr)",
    },
    justifyContent: "start",
  },
  // While the panels go full screen or come back beside the page, the page's card is held at the width
  // it has beside them (their side's, less the gutter), at its start: the panels' card slides over it
  // or off it, so the page's head and words are laid out once and there from the first frame the card
  // is seen, cut by the panels' edge (FRESH.md F82, batch 4: the page's side changed width every frame
  // and the page faded in only after the move, so its card showed empty while it was uncovered).
  heldPage: (shown: number) => ({
    gridTemplateColumns: {
      default: `calc(100cqi - ${shown}px - ${grasp.shellInset})`,
      [NARROW]: "minmax(0, 1fr)",
    },
    justifyContent: "start",
  }),
  // Full screen: over the whole card, which stays as their ground.
  panelsCovering: {
    position: "absolute",
    inset: { default: grasp.shellInset, [NARROW]: 0 },
    zIndex: grasp.shellPageLayer,
    marginBlock: 0,
    marginInlineEnd: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    boxShadow: "none",
    [cardLine.width]: "0px",
  },
  // The gutter between the two cards is the handle. Nothing marks it but the resize cursor, and the
  // focus ring for the keyboard (the product's Panel handle). On a narrow shell, or while the
  // panels cover the page, there is nothing to resize.
  handle: {
    position: "relative",
    width: grasp.shellInset,
    display: { default: "block", [NARROW]: "none" },
    cursor: "col-resize",
    borderRadius: grasp.cornerPill,
  },
  handleGone: { display: "none" },
  // Crowded, the panels lie over the page as their own card: the ground and lift stay, the page
  // under them has faded out. Narrow, they take the whole window as before.
  panelsCrowded: {
    position: "absolute",
    inset: { default: grasp.shellInset, [NARROW]: 0 },
    zIndex: grasp.shellPageLayer,
    marginBlock: 0,
    marginInlineEnd: 0,
    borderRadius: { default: grasp.shellCardCorner, [NARROW]: 0 },
    backgroundColor: grasp.shellCard,
    [cardLine.width]: { default: grasp.hairline, [NARROW]: "0px" },
  },
  // The guess before measuring: crowded, the panels lie over the page as their own card.
  panelsGuess: {
    position: {
      default: "static",
      [CROWDED]: "absolute",
      [NARROW]: "absolute",
    },
    inset: { default: null, [CROWDED]: grasp.shellInset, [NARROW]: 0 },
    zIndex: {
      default: null,
      [CROWDED]: grasp.shellPageLayer,
      [NARROW]: grasp.shellPageLayer,
    },
    marginBlock: { default: grasp.shellInset, [CROWDED]: 0, [NARROW]: 0 },
    marginInlineEnd: { default: grasp.shellInset, [CROWDED]: 0, [NARROW]: 0 },
  },
  // Over the page while the sidebar is folded (A3-shell-01, F55): the Sidebar's reopen button
  // stands at the page card's top start (sidebar.tsx `reveal`), so the panels start the cards' gap
  // (shellInset) after its box, as the bar's crumbs start the bar's gap after its glyph (bar.tsx
  // AFTER_REOPEN), never under or over it. Not on a narrow shell, where there is no reopen.
  panelsAfterReopen: {
    insetInlineStart: {
      default: null,
      [stylex.when.ancestor("[data-sidebar-folded]")]: {
        default: `calc(${grasp.shellInset} + ${grasp.shellPageInline} + ${grasp.shellIcon} + ${grasp.space3})`,
        [NARROW]: 0,
      },
    },
  },
  handleGuess: {
    display: { default: "block", [CROWDED]: "none", [NARROW]: "none" },
  },
  // On a phone the panels leave the bar's row to the shell (its Menu button, their own button):
  // they start under it, whichever of the rules above placed them. One row high (shellBar); a bar
  // whose middle takes a row of its own keeps only its first row over them.
  panelsUnderRow: {
    insetBlockStart: { default: null, [NARROW]: grasp.shellBar },
  },
  // Set aside for the page, on a phone only.
  panelsAside: { display: { default: null, [NARROW]: "none" } },
  // The close button, at the panels' top end, over what the host put there: centred on the head's
  // row, its glyph ending the page's room from the card's end, where the bar's last ink and the
  // panel's words stand (FRESH.md F63).
  close: {
    position: "absolute",
    insetBlockStart: `calc((${grasp.shellBar} - ${grasp.controlSm}) / 2)`,
    insetInlineEnd: `calc(${grasp.shellPageInline} - (${grasp.controlSm} - ${grasp.iconSm}) / 2)`,
    zIndex: 1,
  },
  // Shown on a narrow shell only, so the script can read what the CSS decided.
  probe: {
    position: "absolute",
    display: { default: "none", [NARROW]: "block" },
  },
  // A little more to catch than the gutter; a finger gets 44px.
  reach: {
    position: "absolute",
    insetBlock: 0,
    insetInline: {
      default: `calc(-1 * ${grasp.space1})`,
      [media.coarse]: `calc((${grasp.shellInset} - ${grasp.tap}) / 2)`,
    },
  },
});

interface PanelsProps {
  /** The page's card. */
  card: ReactNode;
  /** What stands in the panels; nothing, and the page has the column. */
  panels: ReactNode;
  /** Whether the panels show. Turning it off plays their leaving while `panels` is still given. */
  open: boolean;
  /** Runs when the panels have arrived. */
  onShown?: () => void;
  /** Runs when the panels are gone. */
  onGone?: () => void;
  width: number;
  min: number;
  max: number;
  covered: boolean;
  /** On a phone, set aside for the page. */
  aside: boolean;
  /** The handle's name (AppShell's `panelResizeLabel`). @default "Resize the panel" */
  resizeLabel?: string;
  onWidthChange?: (width: number) => void;
  /** Says whether the shell is narrow, as its CSS decided, each time that changes. */
  onNarrowChange: (narrow: boolean) => void;
  /** Closes the panels while they cover the page for want of room; without it, no close button. */
  onClose?: () => void;
  /** The close button's name. */
  closeLabel: string;
  /** Where focus stood in the page's card when it was last taken down (AppShell's). */
  keep: RefObject<number>;
  /** Says whether the column is too crowded for the page beside the panels, each time that changes;
   * undefined until the column is measured. */
  onCrowdedChange: (crowded: boolean | undefined) => void;
  /** A line at the foot of the panels' head row (AppShell's `panelsHeadLine`). */
  headLine?: boolean;
}

/** A width kept between its least and most, in whole pixels. */
const clamp = (wanted: number, least: number, most: number): number =>
  Math.round(Math.max(least, Math.min(most, wanted)));

/** Watches the column: the room the two cards share, and whether the shell is narrow. */
const watchColumn = (
  column: HTMLElement,
  onSpace: (space: number) => void,
  onNarrow: (narrow: boolean) => void
) => {
  const measure = () => {
    const boxes = column.querySelectorAll<HTMLElement>(
      "[data-slot=app-shell-fit]"
    );
    let space = 0;
    for (const box of boxes) {
      space += box.getBoundingClientRect().width;
    }
    // Their exact widths added, then rounded: while the two sides move, each one's width rounded
    // on its own could add up a pixel off, and the panels' share would change and restart the move.
    onSpace(Math.round(space));
    // The CSS decides whether the shell is narrow (its probe shows then); this only reads it.
    const probe = column.querySelector<HTMLElement>(
      "[data-slot=app-shell-probe]"
    );
    onNarrow(probe !== null && getComputedStyle(probe).display !== "none");
  };
  measure();
  const observer = new ResizeObserver(measure);
  // The column has its width before the group lays its panels out: watch the boxes in it too.
  observer.observe(column);
  for (const box of column.querySelectorAll<HTMLElement>(
    "[data-slot=app-shell-fit]"
  )) {
    observer.observe(box);
  }
  return () => {
    observer.disconnect();
  };
};

/** Gives focus back to the page: the same element if it is still there, else the one in its place. */
const giveBack = (
  shell: HTMLElement | null,
  before: HTMLElement | null,
  place: number
) => {
  if (before !== null && before.isConnected && before !== document.body) {
    before.focus();
    return;
  }
  const card = shell?.querySelector<HTMLElement>("[data-slot=app-shell-card]");
  card?.querySelectorAll<HTMLElement>(FOCUSABLE)[place]?.focus();
};

/** While the panels cover the page: moves the focus the page held into them, closes them on Escape,
 * and gives the focus back when they stand beside the page again or close. */
const holdFocus = (
  column: HTMLElement,
  onClose: (() => void) | undefined,
  keep: RefObject<number>
) => {
  const panels = column.querySelector<HTMLElement>(
    "[data-slot=app-shell-panels]"
  );
  const card = column.querySelector<HTMLElement>("[data-slot=app-shell-card]");
  const shell = column.closest<HTMLElement>("[data-slot=app-shell]");
  const before =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  // Focus in the page now, or where it stood in the card the panels' coming took down.
  const place =
    before !== null && card !== null && card.contains(before)
      ? placeOf(card, before)
      : keep.current;
  keep.current = -1;
  // Focus the host has already put in the panels (a chat's own field) stays where it is.
  if (
    place >= 0 &&
    panels !== null &&
    !panels.contains(document.activeElement)
  ) {
    firstStop(panels)?.focus();
  }
  const escape = (event: KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      onClose !== undefined
    ) {
      onClose();
    }
  };
  // Whether the panels held focus or were pressed: only then does closing them hand focus over.
  let held = place >= 0;
  const hold = () => {
    held = true;
  };
  panels?.addEventListener("keydown", escape);
  panels?.addEventListener("focusin", hold);
  panels?.addEventListener("pointerdown", hold);
  return () => {
    panels?.removeEventListener("keydown", escape);
    panels?.removeEventListener("focusin", hold);
    panels?.removeEventListener("pointerdown", hold);
    // After the shell has drawn the page again: back where it was, or, when the panels held focus
    // and nothing in the page had it before (they were open from the start), the page's first stop.
    requestAnimationFrame(() => {
      // Focus the host has put somewhere itself in the meantime (the dock's field) stays there.
      const now = document.activeElement;
      if (
        now instanceof HTMLElement &&
        now !== document.body &&
        now.isConnected &&
        panels?.contains(now) !== true
      ) {
        return;
      }
      if (place >= 0) {
        giveBack(shell, before, place);
      } else if (
        held &&
        (document.activeElement === document.body ||
          document.activeElement === null)
      ) {
        shell
          ?.querySelector<HTMLElement>("[data-slot=app-shell-page]")
          ?.querySelector<HTMLElement>(FOCUSABLE)
          ?.focus();
      }
    });
  };
};

type Phase = "closed" | "start" | "coming" | "open" | "going";

/** How long an element's own transition takes, in milliseconds: 0 with reduced motion. */
const moveTime = (element: HTMLElement | null): number => {
  if (element === null) {
    return 0;
  }
  const [first = "0s"] =
    getComputedStyle(element).transitionDuration.split(",");
  const time = first.trim();
  const value = Number(time.replace(/m?s$/u, ""));
  if (Number.isNaN(value)) {
    return 0;
  }
  return time.endsWith("ms") ? value : value * 1000;
};

/** Runs `done` once the start state has been drawn: two frames on. */
const afterPaint = (done: () => void) => {
  let second = 0;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(done);
  });
  return () => {
    cancelAnimationFrame(first);
    cancelAnimationFrame(second);
  };
};

/** Runs `done` when the side's movement has ended. */
const afterMove = (element: HTMLElement | null, done: () => void) => {
  const timer = setTimeout(done, moveTime(element) + 20);
  return () => {
    clearTimeout(timer);
  };
};

/** Where the panels are in their coming and going. */
const usePhase = (
  given: boolean,
  open: boolean,
  side: RefObject<HTMLDivElement | null>,
  onShown?: () => void,
  onGone?: () => void
) => {
  const want = given && open;
  const [phase, setPhase] = useState<Phase>(want ? "open" : "closed");
  if (want && (phase === "closed" || phase === "going")) {
    setPhase("start");
  }
  if (!want && (phase === "start" || phase === "coming" || phase === "open")) {
    // Taken away by the host, there is nothing left to draw leaving: gone at once.
    setPhase(given ? "going" : "closed");
  }
  if (!given && phase === "going") {
    setPhase("closed");
  }
  // The host's callbacks as they are now, without starting the movement's wait again.
  const told = useRef({ onShown, onGone });
  useEffect(() => {
    told.current = { onShown, onGone };
  });
  useEffect(() => {
    // What each phase waits for before the next; a phase at rest waits for nothing.
    const steps: Partial<Record<Phase, () => () => void>> = {
      start: () =>
        afterPaint(() => {
          setPhase("coming");
        }),
      coming: () =>
        afterMove(side.current, () => {
          setPhase("open");
          told.current.onShown?.();
        }),
      going: () =>
        afterMove(side.current, () => {
          setPhase("closed");
          told.current.onGone?.();
        }),
    };
    return steps[phase]?.();
  }, [phase, side]);
  return phase;
};

/**
 * Where the panels are in going full screen and coming back beside the page (`covered`, F13): beside
 * it; lifted off their side in the box they have there, for one frame; growing over the page as its
 * side takes the column; over it; and easing back to their box beside it as the page's side narrows.
 */
export type Cover = "docked" | "lifting" | "covering" | "covered" | "docking";

/** Where the panels beside the page are in going full screen or coming back, for the page's card in
 * them: it stays shown while they move, and goes at once when they lie over it (F82, batch 4). Only
 * while the panels are out; otherwise "docked". */
export const ShellCoverContext = createContext<Cover>("docked");

const useCover = (wanted: boolean, side: RefObject<HTMLDivElement | null>) => {
  const [cover, setCover] = useState<Cover>(wanted ? "covered" : "docked");
  if (wanted && (cover === "docked" || cover === "docking")) {
    setCover(cover === "docked" ? "lifting" : "covering");
  }
  if (
    !wanted &&
    (cover === "lifting" || cover === "covering" || cover === "covered")
  ) {
    setCover(cover === "lifting" ? "docked" : "docking");
  }
  useEffect(() => {
    const steps: Partial<Record<Cover, () => () => void>> = {
      lifting: () =>
        afterPaint(() => {
          setCover("covering");
        }),
      covering: () =>
        afterMove(side.current, () => {
          setCover("covered");
        }),
      docking: () =>
        afterMove(side.current, () => {
          setCover("docked");
        }),
    };
    return steps[cover]?.();
  }, [cover, side]);
  return cover;
};

/** How the panels' card stands while they go full screen or come back, by the step they are at. */
const coverLook = (cover: Cover, shown: number) => {
  if (cover === "lifting" || cover === "docking") {
    return [
      styles.lifted(shown),
      cover === "docking" && styles.shifting,
      cover === "docking" && styles.heldDocking(shown),
    ];
  }
  if (cover === "covering") {
    return [
      styles.panelsCovering,
      styles.panelsAfterReopen,
      styles.stillCard,
      styles.shifting,
      styles.heldCovering,
    ];
  }
  return [styles.panelsCovering, styles.panelsAfterReopen];
};

/** Where the panels' card stands against the page: beside it, over it, or on its way between. */
const placeLook = ({
  measured,
  covered,
  crowded,
  moving,
  cover,
  shown,
}: {
  measured: boolean;
  covered: boolean;
  crowded: boolean;
  moving: boolean;
  cover: Cover;
  shown: number;
}) => {
  if (moving) {
    return [
      !measured && styles.panelsGuess,
      styles.over,
      ...coverLook(cover, shown),
    ];
  }
  return [
    !measured && styles.panelsGuess,
    covered && !crowded && styles.panelsCovering,
    crowded && styles.panelsCrowded,
    (covered || crowded) && styles.panelsAfterReopen,
    styles.over,
  ];
};

/** The gutter's look: gone where there is nothing to resize, out of sight while the panels move. */
const handleLook = ({
  measured,
  covered,
  cover,
  still,
}: {
  measured: boolean;
  covered: boolean;
  cover: Cover;
  still: boolean;
}) =>
  stylex.props(
    styles.handle,
    !measured && styles.handleGuess,
    covered && cover === "docked" && styles.handleGone,
    !still && styles.handleAway,
    focus.ring
  ).className;

/** The panels' share of the column, in percent: none while closed, going or full screen. */
const shareOf = ({
  measured,
  full,
  phase,
  shown,
  space,
}: {
  measured: boolean;
  full: boolean;
  phase: Phase;
  shown: number;
  space: number;
}) =>
  measured && !full && (phase === "coming" || phase === "open")
    ? (shown / space) * 100
    : 0;

/** The room the two cards share, and what the panels get of it. */
const useRoom = ({
  column,
  width,
  min,
  max,
  onNarrowChange,
}: {
  column: RefObject<HTMLDivElement | null>;
  width: number;
  min: number;
  max: number;
  onNarrowChange: (narrow: boolean) => void;
}) => {
  // The pixels the two cards share, once measured; 0 before (and on a server).
  const [space, setSpace] = useState(0);
  useEffect(() => {
    const element = column.current;
    return element === null || typeof ResizeObserver === "undefined"
      ? undefined
      : watchColumn(element, setSpace, onNarrowChange);
  }, [column, onNarrowChange]);
  // Never past half the shell, but never under its least either (the product's Panel).
  // And never so wide the page goes under its least: the panels give way down to their own least
  // first, and only then cover the page.
  const most =
    space > 0
      ? Math.max(min, Math.min(max, space / 2, space - PAGE_ROOM))
      : max;
  const measured = space > 0;
  return {
    space,
    most,
    measured,
    shown: clamp(width, min, most),
    tight: measured && space - min < PAGE_ROOM,
  };
};

interface SideProps {
  panels: ReactNode;
  /** The host gives panels, open or not: closed, they stay drawn out of sight. */
  given: boolean;
  phase: Phase;
  shown: number;
  measured: boolean;
  covered: boolean;
  crowded: boolean;
  aside: boolean;
  /** Where they are in going full screen or coming back. */
  cover: Cover;
  onClose?: () => void;
  closeLabel: string;
  headLine: boolean;
}

/** What stands in the panels' side: their card, held at its final width while the side moves. */
const PanelsCard = ({
  panels,
  given,
  phase,
  shown,
  measured,
  covered,
  crowded,
  aside,
  cover,
  onClose,
  closeLabel,
  headLine,
}: SideProps) => {
  const out = phase === "coming" || phase === "open";
  const over = covered || crowded;
  // Full screen by the host's word (not for want of room): their place moves as one movement.
  const moving = !crowded && cover !== "docked";
  return (
    <div {...stylex.props(styles.hold(shown), over && styles.holdFree)}>
      {given && (
        <div
          data-slot="app-shell-panels"
          data-closed={phase === "closed" ? "" : undefined}
          inert={phase === "closed" || phase === "going"}
          {...stylex.props(
            styles.panels,
            styles.panelsNarrow,
            ...placeLook({ measured, covered, crowded, moving, cover, shown }),
            styles.panelsUnderRow,
            aside && styles.panelsAside,
            !out && over && styles.overAway,
            !out && styles.overAwayNarrow,
            phase === "closed" && styles.closedAway
          )}
        >
          {panels}
          <CardLine />
          {headLine && (
            <span
              aria-hidden="true"
              data-slot="app-shell-panels-head-line"
              {...stylex.props(styles.headLine)}
            />
          )}
          {crowded && onClose !== undefined && (
            <span
              data-slot="app-shell-panels-close"
              {...stylex.props(styles.close)}
            >
              <Button
                variant="ghost"
                size="sm"
                icon={Cross}
                aria-label={closeLabel}
                onClick={onClose}
              />
            </span>
          )}
        </div>
      )}
    </div>
  );
};

/** How the two sides travel while the panels come or go: nothing at rest. */
const travelOf = (phase: Phase) => {
  if (phase === "open" || phase === "closed") {
    return null;
  }
  return phase === "going" ? styles.sideGoing : styles.sideComing;
};

/** How the two sides travel while the panels go full screen or come back: nothing at rest. */
const coverTravelOf = (cover: Cover) =>
  cover === "covering" || cover === "docking" ? styles.sideComing : null;

export const Panels = ({
  card,
  panels,
  open,
  onShown,
  onGone,
  width,
  min,
  max,
  covered,
  aside,
  resizeLabel = "Resize the panel",
  onWidthChange,
  onNarrowChange,
  onCrowdedChange,
  onClose,
  closeLabel,
  keep,
  headLine = true,
}: PanelsProps) => {
  const column = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  const given = panels !== undefined && panels !== null;
  const phase = usePhase(given, open, side, onShown, onGone);
  const { space, most, measured, shown, tight } = useRoom({
    column,
    width,
    min,
    max,
    onNarrowChange,
  });
  const crowded = phase !== "closed" && tight;
  // Full screen by the host's word: the page's side takes the whole column (its card the panels'
  // ground), and the two move there and back as the panels' coming and going do.
  const cover = useCover(covered && !crowded, side);
  const full = cover === "covering" || cover === "covered";
  const resting = phase === "open";
  // At rest beside the page: only then can the gutter resize them.
  const still = resting && cover === "docked";

  useEffect(() => {
    onCrowdedChange(measured ? crowded : undefined);
  }, [measured, crowded, onCrowdedChange]);

  // While they cover the page, the panels hold the focus the page had, Escape closes them, and once
  // they stand beside it again focus goes back where it was.
  useEffect(() => {
    const element = column.current;
    return crowded && element !== null
      ? holdFocus(element, onClose, keep)
      : undefined;
  }, [crowded, onClose, keep]);
  const percent = shareOf({ measured, full, phase, shown, space });

  const changed = (layout: number[], details: ResizableLayoutChangeDetails) => {
    // The group laying itself out again as the window resizes is not a person resizing.
    const [, share] = layout;
    if (
      details.reason === "resize" ||
      !measured ||
      !still ||
      onWidthChange === undefined ||
      share === undefined
    ) {
      return;
    }
    const next = clamp((share / 100) * space, min, most);
    if (next !== width) {
      onWidthChange(next);
    }
  };
  const travel = travelOf(phase) ?? coverTravelOf(cover);
  // What the page's card is told of the move: only while the panels are out.
  const told: Cover = resting ? cover : "docked";
  const held = told === "lifting" || told === "covering" || told === "docking";
  const group = measured
    ? {
        layout: [100 - percent, percent],
        step: (STEP / space) * 100,
        largeStep: (LARGE_STEP / space) * 100,
      }
    : {};

  return (
    <div
      ref={column}
      data-slot="app-shell-column"
      data-crowded={crowded ? "" : undefined}
      data-panels={phase}
      {...stylex.props(styles.column)}
    >
      <span
        aria-hidden="true"
        data-slot="app-shell-probe"
        {...stylex.props(styles.probe)}
      />
      <Resizable {...group} onLayoutChange={changed}>
        <ResizablePanelPrimitive {...stylex.props(styles.side, travel)}>
          <div
            data-slot="app-shell-fit"
            {...stylex.props(styles.fit, held && styles.heldPage(shown))}
          >
            <ShellCoverContext.Provider value={told}>
              {card}
            </ShellCoverContext.Provider>
          </div>
        </ResizablePanelPrimitive>
        {/* Full screen by the host's word the gutter keeps its room, out of sight, so the page's card
            ends the window's margin from the column's end, as it does beside the panels. */}
        <ResizableHandlePrimitive
          aria-label={resizeLabel}
          data-slot="app-shell-panel-handle"
          disabled={covered || !still}
          className={handleLook({ measured, covered, cover, still })}
        >
          {/* Its wider reach for a pointer only while there is something to resize: with no panels
              the gutter is the window's margin, and the reach stood 4px past the window (F80). */}
          {still && <span aria-hidden="true" {...stylex.props(styles.reach)} />}
        </ResizableHandlePrimitive>
        <ResizablePanelPrimitive
          ref={side}
          defaultSize={given && open ? `${width}px` : "0px"}
          minSize={still ? `${min}px` : "0px"}
          maxSize={`${most}px`}
          {...stylex.props(styles.side, travel)}
        >
          <div data-slot="app-shell-fit" {...stylex.props(styles.fit)}>
            <PanelsCard
              panels={panels}
              given={given}
              phase={phase}
              shown={shown}
              measured={measured}
              covered={covered}
              crowded={crowded}
              aside={aside}
              cover={cover}
              onClose={onClose}
              closeLabel={closeLabel}
              headLine={headLine}
            />
          </div>
        </ResizablePanelPrimitive>
      </Resizable>
    </div>
  );
};
