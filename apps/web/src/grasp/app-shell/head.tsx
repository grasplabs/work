// A panel's head, for what the host puts in App shell's panels (a chat): one bar's height, the
// panel's name at its start, then the control that switches it between beside the page and floating
// over it, a link to its own page where the host has one, and the host's own actions. Floating, the
// head is what moves the window: dragged (from the head, never from what the panel holds), or
// focused and moved with the arrow keys; Escape goes back to the page.
//
// And the name in it (`AppShellPanelTitle`): always one line, faded out at its end when it runs
// longer than its room, never wrapped. Given `onRename`, a double-click on it, or F2 or Enter while
// it has focus, opens a small popup with a field: Enter keeps the new name, Escape the old one. The
// host keeps the name.
"use client";

import * as stylex from "@stylexjs/stylex";
import { use, useEffect, useId, useState } from "react";
import type { KeyboardEvent, ReactNode, SubmitEvent } from "react";

import { Button } from "../button";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import {
  AppWindow,
  ExitFullScreen,
  Expand,
  External,
  PanelToggle,
} from "../icons";
import { Input } from "../input";
import {
  Popover,
  PopoverContent,
  PopoverFooter,
  PopoverTitle,
} from "../popover";
import { grasp } from "../tokens/tokens.stylex";
import { renameWords } from "../words/rename";
import { useWords } from "../words/words";
import { PanelPlaceContext } from "./float-window";
import type { PanelPlacement } from "./float-window";
import { appShellPanelWords } from "./words";

const NARROW = "@container app-shell (width < 40rem)";

const styles = stylex.create({
  // One bar's height (shellBar), the name where the page's words begin and the last button's glyph
  // the same room from the card's end (FRESH.md F63), as the page's bar.
  head: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    flexShrink: 0,
    minWidth: 0,
    minHeight: grasp.shellBar,
    paddingInlineStart: grasp.shellPageInline,
    paddingInlineEnd: `calc(${grasp.shellPageInline} - (${grasp.controlSm} - ${grasp.iconSm}) / 2)`,
    color: grasp.shellText,
  },
  // Floating: the head's ground is the window's handle, a control under the name and the buttons. It
  // takes a finger's drag (no scrolling from it), and no words are selected while it moves.
  move: {
    position: "absolute",
    inset: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: { default: "grab", ":active": "grabbing" },
    touchAction: "none",
    userSelect: "none",
  },
  dragging: { cursor: "grabbing" },
  // While the head is the window's handle, a finger on any of it (the name too) drags it: the browser
  // never takes it as a pan of the page, which would cancel the drag.
  handle: { touchAction: "none" },
  // Its focus ring inside its own box: the window clips what stands outside it.
  ring: { outlineOffset: `calc(-1 * ${grasp.ringWidth})` },
  // The name and the buttons over the handle.
  above: { position: "relative" },
  // Floating, a press on the name's room (not on its words) goes through to the handle under it.
  passThrough: { pointerEvents: "none" },
  title: { display: "flex", flexGrow: 1, minWidth: 0 },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    flexShrink: 0,
  },
  // The name itself takes presses again inside the room that passes them through.
  takesPresses: { pointerEvents: "auto" },
  // The switch has nothing to switch on a phone, where both placements are the same panels.
  wideOnly: { display: { default: "flex", [NARROW]: "none" } },
  // The name: one line, never wrapped, faded out at its end when it runs past its room.
  name: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    borderRadius: grasp.cornerMark,
  },
  fades: {
    maskImage: {
      default: `linear-gradient(to right, black calc(100% - ${grasp.space8}), transparent)`,
      ":dir(rtl)": `linear-gradient(to left, black calc(100% - ${grasp.space8}), transparent)`,
    },
  },
  // As a button, with no look of one: the name's own words, where they stood.
  renamable: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    textAlign: "start",
    cursor: "text",
  },
  // The words at their own width, so the name's box can tell when they outgrow it.
  words: { display: "inline-block" },
  field: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  // The panel's body: the page's room under the head's line (the page's own padding above its words
  // under the bar), so the hairline keeps clear space on both sides, and the page's room at its sides.
  // It scrolls with no bar of its own (the product's rule), its words going under the line, cut at
  // its foot, never over it.
  body: {
    minHeight: 0,
    flexGrow: 1,
    overflowY: "auto",
    scrollbarWidth: "none",
    paddingInline: grasp.shellPageInline,
    paddingBlockStart: grasp.space7,
  },
  // Floating, the window is a layer over the page: its scroll keeps the wheel (PRODUCT-RULES 5).
  contained: { overscrollBehavior: "contain" },
  // Filled by one thing that scrolls itself (a Thread): no scroll of its own, and that one thing the
  // body's whole height, so its own scroll has a height to work in. The same room round it.
  fill: {
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr)",
    overflowY: "hidden",
  },
});

/** Every prop an AppShellPanelHead takes. */
export interface AppShellPanelHeadProps {
  /** The panel's name: an `AppShellPanelTitle`, or words of your own. */
  title: ReactNode;
  /** Your own buttons at the head's end (a new chat, close), after the switch and the page's link. */
  actions?: ReactNode;
  /** The panel's own page: a link to it, "Open as a page", where you give one. */
  pageHref?: string;
  /**
   * Whether the panel is full screen: keep it with `onExpandedChange` and give it to AppShell's
   * `covered`. Docked or floating, it goes full screen and comes back to where it was, in one move.
   */
  expanded?: boolean;
  /** Runs when the person takes the panel full screen or back; without it, no full-screen control. */
  onExpandedChange?: (expanded: boolean) => void;
}

/** The head's own controls: the switch between docked and floating, full screen, the page's link. */
const HeadControls = ({
  setPlacement,
  next,
  pageHref,
  expanded,
  onExpandedChange,
}: {
  setPlacement?: (placement: PanelPlacement) => void;
  next: PanelPlacement;
  pageHref?: string;
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) => {
  const words = useWords("app-shell-panel", appShellPanelWords);
  return (
    <>
      {setPlacement !== undefined && (
        <span {...stylex.props(styles.wideOnly)}>
          <Button
            variant="ghost"
            size="sm"
            icon={next === "floating" ? AppWindow : PanelToggle}
            aria-label={next === "floating" ? words.float : words.dock}
            onClick={() => {
              setPlacement(next);
            }}
          />
        </span>
      )}
      {onExpandedChange !== undefined && (
        <Button
          variant="ghost"
          size="sm"
          icon={expanded ? ExitFullScreen : Expand}
          aria-label={expanded ? words.collapse : words.expand}
          aria-pressed={expanded}
          onClick={() => {
            onExpandedChange(!expanded);
          }}
        />
      )}
      {pageHref !== undefined && (
        <Button
          variant="ghost"
          size="sm"
          icon={External}
          aria-label={words.page}
          render={<a href={pageHref} aria-label={words.page} />}
        />
      )}
    </>
  );
};

/** The head of what stands in App shell's panels: its name, the placement switch, and your actions. */
export const AppShellPanelHead = ({
  title,
  actions,
  pageHref,
  expanded = false,
  onExpandedChange,
}: AppShellPanelHeadProps) => {
  const place = use(PanelPlaceContext);
  const words = useWords("app-shell-panel", appShellPanelWords);
  const { setPlacement, handleMovePress, handleMoveKey } = place;
  const hint = useId();
  const next = place.placement === "floating" ? "docked" : "floating";
  return (
    <div
      data-slot="app-shell-panel-head"
      data-floating={place.floating ? "" : undefined}
      {...stylex.props(
        styles.head,
        (place.floating || place.pullable) && styles.handle
      )}
    >
      {/* Floating, the head's ground is the window's handle: a control of its own under the name and
          the buttons, dragged, or focused and moved with the arrow keys. */}
      {(place.floating || place.pullable) && (
        <button
          type="button"
          aria-label={words.move}
          aria-describedby={place.floating ? hint : undefined}
          // Docked, the handle is for a pointer's pull only: the switch does the same from the keys.
          tabIndex={place.floating ? undefined : -1}
          data-slot="app-shell-panel-move"
          onPointerDown={handleMovePress}
          onKeyDown={handleMoveKey}
          {...stylex.props(
            styles.move,
            place.dragging && styles.dragging,
            focus.ring,
            styles.ring
          )}
        />
      )}
      {place.floating && (
        <span id={hint} {...stylex.props(visuallyHidden)}>
          {words.moveHint}
        </span>
      )}
      <div
        {...stylex.props(
          styles.title,
          styles.above,
          (place.floating || place.pullable) && styles.passThrough
        )}
      >
        {title}
      </div>
      <div {...stylex.props(styles.actions, styles.above)}>
        <HeadControls
          setPlacement={setPlacement}
          next={next}
          pageHref={pageHref}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
        />
        {actions}
      </div>
    </div>
  );
};

/** Every prop an AppShellPanelBody takes. */
export interface AppShellPanelBodyProps {
  /** What the panel holds under its head: a thread, a page's words. */
  children: ReactNode;
  /**
   * For one thing that scrolls itself, such as a Thread: the body does not scroll, and that one thing
   * takes its whole height, so its own scroll works. Without it the body scrolls what it holds.
   * @default false
   */
  fill?: boolean;
}

/**
 * The panel's content under its head: the page's room under the head's line and at its sides, and
 * its own scroll with no bar. Put a Composer or a foot after it, not in it.
 */
export const AppShellPanelBody = ({
  children,
  fill = false,
}: AppShellPanelBodyProps) => {
  const { floating } = use(PanelPlaceContext);
  return (
    <div
      data-slot="app-shell-panel-body"
      data-fill={fill ? "" : undefined}
      {...stylex.props(
        styles.body,
        floating && styles.contained,
        fill && styles.fill
      )}
    >
      {children}
    </div>
  );
};

/** Every prop an AppShellPanelTitle takes. */
export interface AppShellPanelTitleProps {
  /** The panel's name, as it stands now ("New chat"). */
  children: string;
  /** Runs with the new name when the person renames it; without it, the name cannot be renamed. */
  onRename?: (name: string) => void;
}

/** Watches whether the name runs past its room: its box, and its words, which grow with a new name.
 * Returns the clean-up. */
const watchFit = (element: HTMLElement, setOver: (over: boolean) => void) => {
  const observer = new ResizeObserver(() => {
    setOver(element.scrollWidth > element.clientWidth + 1);
  });
  observer.observe(element);
  if (element.firstElementChild !== null) {
    observer.observe(element.firstElementChild);
  }
  return () => {
    observer.disconnect();
  };
};

/** Whether a key on the name opens the rename: F2, or Enter as on any button. */
const opensRename = (event: KeyboardEvent<HTMLElement>) =>
  event.key === "F2" || event.key === "Enter";

/** The panel's name in its head: one line, faded at its end, renamed in a small popup. */
export const AppShellPanelTitle = ({
  children,
  onRename,
}: AppShellPanelTitleProps) => {
  const said = useWords("rename", renameWords);
  const { handleMovePress } = use(PanelPlaceContext);
  const hint = useId();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const setButton = (button: HTMLButtonElement | null) => {
    setElement(button);
  };
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(children);
  useEffect(
    () =>
      element === null || typeof ResizeObserver === "undefined"
        ? undefined
        : watchFit(element, setOver),
    [element]
  );
  const renamable = onRename !== undefined;
  const start = () => {
    setDraft(children);
    setOpen(true);
  };
  const save = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draft.trim();
    if (name !== "" && name !== children) {
      onRename?.(name);
    }
    setOpen(false);
  };
  const look = stylex.props(
    styles.name,
    over && styles.fades,
    renamable && styles.renamable,
    renamable && styles.takesPresses,
    renamable && focus.ring
  );
  const words = <span {...stylex.props(styles.words)}>{children}</span>;
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (opensRename(event)) {
      event.preventDefault();
      event.stopPropagation();
      start();
    }
  };
  return (
    <>
      {renamable ? (
        // A press on the name still moves a floating window (the head's handle lies under it); a
        // double-click, F2 or Enter renames it.
        <button
          ref={setButton}
          type="button"
          data-slot="app-shell-panel-title"
          title={over ? children : undefined}
          aria-haspopup="dialog"
          aria-describedby={hint}
          onDoubleClick={start}
          onKeyDown={handleKeyDown}
          onPointerDown={handleMovePress}
          {...look}
        >
          {words}
        </button>
      ) : (
        <span
          ref={setElement}
          data-slot="app-shell-panel-title"
          title={over ? children : undefined}
          {...look}
        >
          {words}
        </span>
      )}
      {renamable && (
        <span id={hint} {...stylex.props(visuallyHidden)}>
          {said.hint}
        </span>
      )}
      {renamable && element !== null && (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
          }}
        >
          <PopoverContent anchor={element} side="bottom" align="start">
            <form onSubmit={save} {...stylex.props(styles.field)}>
              <PopoverTitle>{said.rename}</PopoverTitle>
              <Input
                aria-label={said.field}
                value={draft}
                onValueChange={setDraft}
              />
              <PopoverFooter>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  {said.cancel}
                </Button>
                <Button size="sm" type="submit">
                  {said.save}
                </Button>
              </PopoverFooter>
            </form>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
};
