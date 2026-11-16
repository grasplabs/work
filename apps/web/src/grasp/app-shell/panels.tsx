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
"use client";

import * as stylex from "@stylexjs/stylex";
import { ResizableHandle as ResizableHandlePrimitive } from "@ui-sdk/react/resizable";
import type { ResizableLayoutChangeDetails } from "@ui-sdk/react/resizable";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { Button } from "../button";
import { focus } from "../focus/focus";
import { Cross } from "../icons";
import { Resizable, ResizablePanel } from "../resizable";
import { grasp, media } from "../tokens/tokens.stylex";
import { FOCUSABLE, firstStop, placeOf } from "./focus-place";

const NARROW = "@container app-shell (width < 40rem)";
// Before the script has measured the column (on the server, before hydration), the crowded rule is
// guessed in CSS for the default least widths: the page's 366 with its margin and the panels' 340.
// Once measured, the script decides, with the host's own least.
const CROWDED = "@container app-shell-column (width < 706px)";
const FORCED = media.forced;

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
  // Inside a panel of the group, a box the card fills, margins and all.
  fit: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "minmax(0, 1fr)",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
  },
  // The panels' own card, on the ground at the end, a hair off the window's edges.
  panels: {
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
    boxShadow: grasp.shellCardShadow,
    outlineWidth: { default: 0, [FORCED]: grasp.hairline },
    outlineStyle: "solid",
    outlineColor: "CanvasText",
    outlineOffset: `calc(-1 * ${grasp.hairline})`,
  },
  // On a narrow shell the panels take the whole window, over the page, on the card's ground.
  panelsNarrow: {
    position: { default: "static", [NARROW]: "absolute" },
    inset: { default: null, [NARROW]: 0 },
    zIndex: { default: null, [NARROW]: grasp.shellPageLayer },
    marginBlock: { default: grasp.shellInset, [NARROW]: 0 },
    marginInlineEnd: { default: grasp.shellInset, [NARROW]: 0 },
    borderRadius: { default: grasp.shellCardCorner, [NARROW]: 0 },
    backgroundColor: { default: grasp.shellCard, [NARROW]: "transparent" },
    boxShadow: { default: grasp.shellCardShadow, [NARROW]: "none" },
    outlineWidth: { default: 0, [FORCED]: grasp.hairline, [NARROW]: 0 },
  },
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
    outlineWidth: 0,
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
    boxShadow: { default: grasp.shellCardShadow, [NARROW]: "none" },
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
  // The close button, at the panels' top end, over what the host put there.
  close: {
    position: "absolute",
    insetBlockStart: grasp.space2,
    insetInlineEnd: grasp.space2,
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
  /** What stands in the panels. */
  panels: ReactNode;
  width: number;
  min: number;
  max: number;
  covered: boolean;
  /** On a phone, set aside for the page. */
  aside: boolean;
  resizeLabel: string;
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
      space += box.offsetWidth;
    }
    onSpace(space);
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
  if (place >= 0 && panels !== null) {
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

export const Panels = ({
  card,
  panels,
  width,
  min,
  max,
  covered,
  aside,
  resizeLabel,
  onWidthChange,
  onNarrowChange,
  onCrowdedChange,
  onClose,
  closeLabel,
  keep,
}: PanelsProps) => {
  const column = useRef<HTMLDivElement>(null);
  // The pixels the two cards share, once measured; 0 before (and on a server).
  const [space, setSpace] = useState(0);

  useEffect(() => {
    const element = column.current;
    return element === null || typeof ResizeObserver === "undefined"
      ? undefined
      : watchColumn(element, setSpace, onNarrowChange);
  }, [onNarrowChange]);

  // Never past half the shell, but never under its least either (the product's Panel).
  // And never so wide the page goes under its least: the panels give way down to their own least
  // first, and only then cover the page.
  const most =
    space > 0
      ? Math.max(min, Math.min(max, space / 2, space - PAGE_ROOM))
      : max;
  const shown = clamp(width, min, most);
  const measured = space > 0;
  const crowded = measured && space - min < PAGE_ROOM;

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
  const percent = measured ? (shown / space) * 100 : 0;

  const changed = (layout: number[], details: ResizableLayoutChangeDetails) => {
    // The group laying itself out again as the window resizes is not a person resizing.
    if (
      details.reason === "resize" ||
      !measured ||
      onWidthChange === undefined
    ) {
      return;
    }
    const [, share] = layout;
    if (share === undefined) {
      return;
    }
    const next = clamp((share / 100) * space, min, most);
    if (next !== width) {
      onWidthChange(next);
    }
  };

  return (
    <div
      ref={column}
      data-slot="app-shell-column"
      data-crowded={crowded ? "" : undefined}
      {...stylex.props(styles.column)}
    >
      <span
        aria-hidden="true"
        data-slot="app-shell-probe"
        {...stylex.props(styles.probe)}
      />
      <Resizable
        {...(measured
          ? {
              layout: [100 - percent, percent],
              step: (STEP / space) * 100,
              largeStep: (LARGE_STEP / space) * 100,
            }
          : {})}
        onLayoutChange={changed}
      >
        <ResizablePanel>
          <div data-slot="app-shell-fit" {...stylex.props(styles.fit)}>
            {card}
          </div>
        </ResizablePanel>
        <ResizableHandlePrimitive
          aria-label={resizeLabel}
          data-slot="app-shell-panel-handle"
          disabled={covered}
          className={
            stylex.props(
              styles.handle,
              !measured && styles.handleGuess,
              covered && styles.handleGone,
              focus.ring
            ).className
          }
        >
          <span aria-hidden="true" {...stylex.props(styles.reach)} />
        </ResizableHandlePrimitive>
        <ResizablePanel
          defaultSize={`${width}px`}
          minSize={`${min}px`}
          maxSize={`${most}px`}
        >
          <div data-slot="app-shell-fit" {...stylex.props(styles.fit)}>
            <div
              data-slot="app-shell-panels"
              {...stylex.props(
                styles.panels,
                styles.panelsNarrow,
                !measured && styles.panelsGuess,
                covered && !crowded && styles.panelsCovering,
                crowded && styles.panelsCrowded,
                styles.panelsUnderRow,
                aside && styles.panelsAside
              )}
            >
              {panels}
              {crowded && onClose !== undefined && (
                <span
                  data-slot="app-shell-panels-close"
                  {...stylex.props(styles.close)}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Cross}
                    label={closeLabel}
                    onClick={onClose}
                  />
                </span>
              )}
            </div>
          </div>
        </ResizablePanel>
      </Resizable>
    </div>
  );
};
