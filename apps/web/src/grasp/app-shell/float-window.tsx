"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";

import { focus } from "../focus/focus";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { cardLine } from "./card-line.stylex";
import {
  DOCK_SLACK,
  FLOAT_MARGIN,
  PULL,
  UNMEASURED,
  draggable,
  floatHeight,
  floatPlace,
  floatWidth,
  followPointer,
  nearEnd,
  placeByKey,
  placeUnder,
  readsBackward,
  sizeByKey,
} from "./floating";
import type { FloatRoom, PanelPosition } from "./floating";
import { FOCUSABLE } from "./focus-place";
import { appShellPanelWords } from "./words";

const NARROW = "@container app-shell (width < 40rem)";

/** Where the host's panels stand: beside the page, or over it as a window. */
export type PanelPlacement = "docked" | "floating";

/** What a panel's head needs of the shell: whether it floats, and how to move it or switch it. */
export interface PanelPlaceValue {
  /** The host's placement, whatever the shell can show. */
  placement: PanelPlacement;
  /** Floating now: not on a phone, not full screen. */
  floating: boolean;
  /** Switches the placement; undefined when the host gives no `onPanelPlacementChange`. */
  setPlacement?: (placement: PanelPlacement) => void;
  /** A press on the head: a drag that moves the window, when it floats. */
  handleMovePress?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** A key on the head's move control: the arrows move the window, Escape goes back to the page. */
  handleMoveKey?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /** The head is being dragged. */
  dragging: boolean;
  /** Docked, a pull on the head lifts the panels into a window: the head offers its handle. */
  pullable: boolean;
}

const still: PanelPlaceValue = {
  placement: "docked",
  floating: false,
  dragging: false,
  pullable: false,
};

/** The shell's panels as a panel's head sees them (AppShellPanelHead). */
export const PanelPlaceContext = createContext<PanelPlaceValue>(still);

const styles = stylex.create({
  // The window: over the page's card and its line, its own card with its own line, lifted off the
  // page. On a phone, before the script knows it is one, the narrow look (the panels over the window
  // under the bar's row, panels.tsx `panelsNarrow`, `panelsUnderRow`).
  window: {
    position: "absolute",
    insetInlineStart: { default: "auto", [NARROW]: 0 },
    insetBlockStart: { default: "auto", [NARROW]: grasp.shellBar },
    zIndex: {
      default: `calc(${grasp.shellPageLayer} + 2)`,
      [NARROW]: grasp.shellPageLayer,
    },
    // The docked card's margins (panels.tsx `panels`) would add to its place: none here.
    marginBlock: 0,
    marginInlineEnd: 0,
    borderRadius: { default: grasp.shellCardCorner, [NARROW]: 0 },
    // A layer over the page's content: the Dialog's lift, and in dark the shell's raised ground (a
    // step above the page's card, as its menus), so it reads as lying over the page, not beside it.
    backgroundColor: { default: grasp.shellPopup, [NARROW]: "transparent" },
    boxShadow: { default: grasp.liftHigh, [NARROW]: "none" },
    [cardLine.width]: { default: grasp.hairline, [NARROW]: "0px" },
  },
  at: (x: number, y: number, width: number, height: number) => ({
    insetInlineEnd: { default: `${x}px`, [NARROW]: 0 },
    insetBlockEnd: { default: `${y}px`, [NARROW]: 0 },
    width: { default: `${width}px`, [NARROW]: "auto" },
    height: { default: `${height}px`, [NARROW]: "auto" },
  }),
  // Full screen from a window: the box full-screen panels take (panels.tsx `panelsCovering`, and
  // `panelsAfterReopen`: after the folded sidebar's reopen button), the card's margin in.
  fullBox: {
    insetInlineEnd: grasp.shellInset,
    insetBlockEnd: grasp.shellInset,
    height: `calc(100% - 2 * ${grasp.shellInset})`,
    width: {
      default: `calc(100% - 2 * ${grasp.shellInset})`,
      [stylex.when.ancestor("[data-sidebar-folded]")]:
        `calc(100% - 2 * ${grasp.shellInset} - ${grasp.shellPageInline} - ${grasp.shellIcon} - ${grasp.space3})`,
    },
  },
  // In the docked panel's box, as the docked card looks: its ground, no lift.
  flat: { backgroundColor: grasp.shellCard, boxShadow: "none" },
  // The move between the two shapes: place, size, lift and ground together, on the interface's time.
  moving: {
    transitionProperty:
      "inset-inline-end, inset-block-end, width, height, box-shadow, background-color",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  // Where a window let go now would dock: the docked panel's box, a quiet ground with a line.
  ghost: {
    position: "absolute",
    zIndex: `calc(${grasp.shellPageLayer} + 1)`,
    boxSizing: "border-box",
    borderRadius: grasp.shellCardCorner,
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: { default: grasp.shellCardLine, [media.forced]: "Highlight" },
    backgroundColor: grasp.shellCardLine,
    pointerEvents: "none",
    display: { default: "block", [NARROW]: "none" },
  },
  // The edges that resize it: its start edge (its width) and its top (its height), a few pixels
  // inside its edge, over what it holds, and their corner. Only the resize cursor marks them, and the
  // focus ring for the keys, as the docked gutter.
  edge: {
    position: "absolute",
    boxSizing: "border-box",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    zIndex: `calc(${grasp.shellPageLayer} + 2)`,
    display: { default: "block", [NARROW]: "none" },
    touchAction: "none",
  },
  start: {
    insetBlock: grasp.shellCardCorner,
    insetInlineStart: 0,
    width: grasp.space2,
    cursor: "ew-resize",
  },
  top: {
    insetInline: grasp.shellCardCorner,
    insetBlockStart: 0,
    height: grasp.space2,
    cursor: "ns-resize",
  },
  corner: {
    insetBlockStart: 0,
    insetInlineStart: 0,
    width: grasp.shellCardCorner,
    height: grasp.shellCardCorner,
    cursor: { default: "nwse-resize", ":dir(rtl)": "nesw-resize" },
  },
});

/** How far toward the end side a pointer is, whichever way the page reads. */
const endward = (clientX: number, backward: boolean) =>
  backward ? -clientX : clientX;

/**
 * The wall at the shell's end, as a drag meets it: once the card is pushed against it, the pointer's
 * furthest reach toward the end is kept, and the card counts as against the wall until the pointer
 * draws back from that reach by more than the slack (DOCK_SLACK).
 */
const createWall = () => {
  let reach: number | null = null;
  return {
    see: (pushed: boolean, at: number) => {
      if (pushed) {
        reach = reach === null ? at : Math.max(reach, at);
        return true;
      }
      if (reach !== null && reach - at <= DOCK_SLACK) {
        return true;
      }
      reach = null;
      return false;
    },
  };
};

/** The shell the column stands in: the window's room is the shell, sidebar and bar included. */
const shellOf = (column: HTMLElement) =>
  column.closest("[data-slot=app-shell]") ?? column;

/** The window's room in the column: the shell's edges and the margin (floating.ts `FloatRoom`). */
const roomOf = (column: HTMLElement): FloatRoom => {
  const outer = column.getBoundingClientRect();
  const shell = shellOf(column).getBoundingClientRect();
  const left = shell.left - outer.left + FLOAT_MARGIN;
  const right = outer.right - shell.right + FLOAT_MARGIN;
  const backward = readsBackward(column);
  return {
    width: outer.width,
    height: outer.height,
    end: backward ? left : right,
    start: backward ? right : left,
    top: shell.top - outer.top + FLOAT_MARGIN,
    foot: outer.bottom - shell.bottom + FLOAT_MARGIN,
  };
};

/** Watches the column and the shell. Returns the clean-up. */
const watchRoom = (column: HTMLElement, setRoom: (room: FloatRoom) => void) => {
  const observer = new ResizeObserver(() => {
    setRoom(roomOf(column));
  });
  observer.observe(column);
  observer.observe(shellOf(column));
  return () => {
    observer.disconnect();
  };
};

/** The window's room, watched: `UNMEASURED` before the column is measured (and on a server). */
const useRoom = (column: RefObject<HTMLDivElement | null>) => {
  const [room, setRoom] = useState(UNMEASURED);
  useEffect(() => {
    const element = column.current;
    return element === null || typeof ResizeObserver === "undefined"
      ? undefined
      : watchRoom(element, setRoom);
  }, [column]);
  return room;
};

/** The first stop in it that can be seen: the phone's Menu button is in the card but hidden on a
 * wide shell. */
const seen = (root: Element | null | undefined) =>
  [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find((stop) =>
    stop.checkVisibility()
  );

/** Gives focus back to the page: where it came from into the window, else the page's first stop,
 * else the card's (its bar's first crumb) when the page holds nothing to focus. */
const backToPage = (column: HTMLElement | null, from: HTMLElement | null) => {
  if (from !== null && from.isConnected) {
    from.focus();
    return;
  }
  const card = column?.querySelector("[data-slot=app-shell-card]");
  (
    seen(card?.querySelector("[data-slot=app-shell-page]")) ?? seen(card)
  )?.focus();
};

/** Notes the element in the page that focus came from into the window, for Escape to go back to. */
const watchFrom = (
  column: HTMLElement,
  from: RefObject<HTMLElement | null>
) => {
  const panels = column.querySelector<HTMLElement>(
    "[data-slot=app-shell-panels]"
  );
  const card = column.querySelector<HTMLElement>("[data-slot=app-shell-card]");
  const enter = (event: FocusEvent) => {
    if (
      event.relatedTarget instanceof HTMLElement &&
      card?.contains(event.relatedTarget) === true
    ) {
      from.current = event.relatedTarget;
    }
  };
  panels?.addEventListener("focusin", enter);
  return () => {
    panels?.removeEventListener("focusin", enter);
  };
};

/** The shapes the panels' card takes: beside the page, a window over it, or full screen from a window. */
type Shape = "docked" | "floating" | "full";

/**
 * Where the card is in moving from one shape to another: laid over the box it had for a frame
 * (`from`), then moving to the new one (`to`); null at rest.
 */
interface Morph {
  from: Shape;
  step: "from" | "to";
}

/** How long the card's move takes, in milliseconds, read from its own transition: 0 with reduced motion. */
const moveTime = (column: HTMLElement | null) => {
  const card = column?.querySelector("[data-slot=app-shell-panels]");
  if (card === null || card === undefined) {
    return 0;
  }
  const [first = "0s"] = getComputedStyle(card).transitionDuration.split(",");
  const time = first.trim();
  const value = Number(time.replace(/m?s$/u, ""));
  if (Number.isNaN(value)) {
    return 0;
  }
  return time.endsWith("ms") ? value : value * 1000;
};

/** Runs `done` once the start of the move has been drawn: two frames on. Returns the clean-up. */
const afterFrames = (done: () => void) => {
  let second = 0;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(done);
  });
  return () => {
    cancelAnimationFrame(first);
    cancelAnimationFrame(second);
  };
};

/** Runs `done` once the move has run its time. Returns the clean-up. */
const afterTime = (time: number, done: () => void) => {
  const timer = setTimeout(done, time + 20);
  return () => {
    clearTimeout(timer);
  };
};

/** The next step of a move under way: from its first frame to the move, from the move to rest. */
const stepMorph = (
  morph: Morph,
  column: HTMLElement | null,
  setMorph: (morph: Morph | null) => void
) => {
  if (morph.step === "from") {
    return afterFrames(() => {
      setMorph({ from: morph.from, step: "to" });
    });
  }
  return afterTime(moveTime(column), () => {
    setMorph(null);
  });
};

/** The move from one shape to another, started each time the shape changes. */
const useMorph = (
  shape: Shape,
  column: RefObject<HTMLDivElement | null>,
  measured: boolean
) => {
  const [was, setWas] = useState(shape);
  const [morph, setMorph] = useState<Morph | null>(null);
  if (was !== shape) {
    setWas(shape);
    // Before the column is measured there is no box to move from: at once.
    setMorph(measured ? { from: was, step: "from" } : null);
  }
  useEffect(
    () =>
      morph === null ? undefined : stepMorph(morph, column.current, setMorph),
    [morph, column]
  );
  return morph;
};

interface FloatOptions {
  column: RefObject<HTMLDivElement | null>;
  placement?: PanelPlacement;
  onPlacementChange?: (placement: PanelPlacement) => void;
  /** On a phone, or full screen by the host's word: no window, the docked behaviour. */
  narrow: boolean;
  covered: boolean;
  width?: number;
  min: number;
  max: number;
  onWidthChange?: (width: number) => void;
  position?: PanelPosition;
  onPositionChange?: (position: PanelPosition) => void;
  height?: number;
  onHeightChange?: (height: number) => void;
  /** The docked panels' width, for the docked box the card moves to and from, and the ghost. */
  docked: number;
}

/** What a drag or a resize shows until the host's value comes back: none at rest. */
interface Live {
  position?: PanelPosition;
  width?: number;
  height?: number;
}

type Box = ReturnType<typeof styles.at> | typeof styles.fullBox;

/** The card's shape: a window, full screen from a window, or docked. */
const shapeOf = (on: boolean, full: boolean): Shape => {
  if (on) {
    return "floating";
  }
  return full ? "full" : "docked";
};

/** A shape's box and look: the window lifted, the docked panel and full screen flat on the card's ground. */
const boxLook = (shape: Shape, boxes: Record<Shape, Box>) =>
  shape === "floating" ? [boxes.floating] : [boxes[shape], styles.flat];

/** The card's look for where it is: a window at rest, nothing of ours at rest docked or full screen
 * (the panels' own look), and on its way from one box to the other. */
const lookOf = (
  shape: Shape,
  morph: Morph | null,
  boxes: Record<Shape, Box>
) => {
  if (morph === null) {
    return shape === "floating" ? [styles.window, boxes.floating] : [];
  }
  return morph.step === "from"
    ? [styles.window, ...boxLook(morph.from, boxes)]
    : [styles.window, ...boxLook(shape, boxes), styles.moving];
};

/**
 * The floating window: whether the panels float, their look, the edges that resize them, the ghost
 * of where they would dock, and what a head is told (`PanelPlaceContext`).
 */
export const useFloat = (options: FloatOptions) => {
  const { column, placement = "docked", min, max } = options;
  const words = useWords("app-shell-panel", appShellPanelWords);
  // Before the column is measured (on a server, the first frame) the window takes its given or first
  // size and place; the CSS keeps it inside the shell (`window`'s most).
  const room = useRoom(column);
  const measured = Number.isFinite(room.height);
  const [live, setLive] = useState<Live | null>(null);
  const [hint, setHint] = useState(false);
  const from = useRef<HTMLElement | null>(null);
  const allowed = !options.narrow && !options.covered;
  const on = placement === "floating" && allowed;
  // Full screen from a window (the host's `covered`): the card moves from the window's box to the
  // whole card's and back, as between docked and floating.
  const full = placement === "floating" && options.covered && !options.narrow;
  const shape = shapeOf(on, full);
  const morph = useMorph(shape, column, measured);
  useEffect(() => {
    const element = column.current;
    return on && element !== null ? watchFrom(element, from) : undefined;
  }, [on, column]);

  const width = floatWidth(live?.width ?? options.width, min, max, room);
  const height = floatHeight(live?.height ?? options.height, room);
  const place = floatPlace(
    live?.position ?? options.position,
    { width, height },
    room
  );
  const backward = () =>
    column.current !== null && readsBackward(column.current);
  const shellBox = () =>
    column.current === null
      ? null
      : shellOf(column.current).getBoundingClientRect();
  const dock = () => {
    options.onPlacementChange?.("docked");
  };

  // Floating: a drag on the head moves the window; near the shell's end edge the ghost shows where
  // it would dock, and letting go there docks it.
  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    const start = place;
    const wall = createWall();
    let showing = false;
    followPointer(
      event,
      (dx, dy, pointer) => {
        const wanted = start.x + (backward() ? dx : -dx);
        const next = floatPlace(
          { x: wanted, y: start.y - dy },
          { width, height },
          room
        );
        setLive({ position: next });
        const shell = shellBox();
        // The ghost shows once the card can go no further toward the end (its end edge at the shell's
        // end bound), or the pointer is near the end edge, whichever comes first; back away from the
        // wall by more than the slack and it goes.
        const against = wall.see(
          wanted <= room.end,
          endward(pointer.clientX, backward())
        );
        showing =
          options.onPlacementChange !== undefined &&
          (against ||
            (shell !== null && nearEnd(pointer.clientX, shell, backward())));
        setHint(showing);
        options.onPositionChange?.(next);
      },
      () => {
        setLive(null);
        setHint(false);
        if (showing) {
          dock();
        }
      }
    );
  };
  // Docked: a pull on the head of more than PULL lifts the panels into a window under the pointer,
  // and the drag goes on moving it.
  const pull = (event: ReactPointerEvent<HTMLElement>) => {
    const card = column.current
      ?.querySelector("[data-slot=app-shell-panels]")
      ?.getBoundingClientRect();
    const box = column.current?.getBoundingClientRect();
    if (card === undefined || box === undefined) {
      return;
    }
    const grabbed = {
      x: backward() ? card.right - event.clientX : event.clientX - card.left,
      y: event.clientY - card.top,
    };
    let lifted: { place: PanelPosition; dx: number; dy: number } | null = null;
    followPointer(
      event,
      (dx, dy, pointer) => {
        if (lifted === null) {
          if (Math.hypot(dx, dy) < PULL) {
            return;
          }
          const first = floatPlace(
            placeUnder(pointer, grabbed, { width, height }, box, backward()),
            { width, height },
            room
          );
          lifted = { place: first, dx, dy };
          setLive({ position: first });
          options.onPositionChange?.(first);
          options.onPlacementChange?.("floating");
          return;
        }
        const next = floatPlace(
          {
            x: lifted.place.x + (backward() ? dx - lifted.dx : lifted.dx - dx),
            y: lifted.place.y - (dy - lifted.dy),
          },
          { width, height },
          room
        );
        setLive({ position: next });
        options.onPositionChange?.(next);
      },
      () => {
        setLive(null);
      }
    );
  };
  const press = (event: ReactPointerEvent<HTMLElement>) => {
    if (!draggable(event)) {
      return;
    }
    if (on) {
      drag(event);
    } else if (allowed && options.onPlacementChange !== undefined) {
      pull(event);
    }
  };
  const key = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!on || event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      backToPage(column.current, from.current);
      return;
    }
    // End docks it: toward the end side, where the docked panels stand.
    if (event.key === "End" && options.onPlacementChange !== undefined) {
      event.preventDefault();
      dock();
      return;
    }
    const next = placeByKey(event.key, event.shiftKey, place, backward());
    if (next !== undefined) {
      event.preventDefault();
      options.onPositionChange?.(floatPlace(next, { width, height }, room));
    }
  };
  // A resize from an edge: the end and the foot stay where they are; only the size changes.
  const resize =
    (edges: { width: boolean; height: boolean }) =>
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const start = { width, height };
      followPointer(
        event,
        (dx, dy) => {
          const next: Live = {
            width: edges.width
              ? floatWidth(
                  start.width + (backward() ? dx : -dx),
                  min,
                  max,
                  room
                )
              : undefined,
            height: edges.height
              ? floatHeight(start.height - dy, room)
              : undefined,
          };
          setLive(next);
          if (next.width !== undefined) {
            options.onWidthChange?.(next.width);
          }
          if (next.height !== undefined) {
            options.onHeightChange?.(next.height);
          }
        },
        () => {
          setLive(null);
        }
      );
    };
  const resizeByKey =
    (edge: "width" | "height") => (event: ReactKeyboardEvent<HTMLElement>) => {
      const next = sizeByKey(
        event.key,
        event.shiftKey,
        edge,
        edge === "width" ? width : height,
        backward()
      );
      if (next === undefined) {
        return;
      }
      event.preventDefault();
      if (edge === "width") {
        options.onWidthChange?.(floatWidth(next, min, max, room));
      } else {
        options.onHeightChange?.(floatHeight(next, room));
      }
    };

  const value: PanelPlaceValue = {
    placement,
    floating: on,
    setPlacement: options.onPlacementChange,
    handleMovePress: press,
    handleMoveKey: key,
    dragging: live?.position !== undefined,
    pullable: !on && allowed && options.onPlacementChange !== undefined,
  };
  const edges = on ? (
    <>
      <button
        type="button"
        aria-label={words.width}
        data-slot="app-shell-float-width"
        onPointerDown={resize({ width: true, height: false })}
        onKeyDown={resizeByKey("width")}
        {...stylex.props(styles.edge, styles.start, focus.ring)}
      />
      <button
        type="button"
        aria-label={words.height}
        data-slot="app-shell-float-height"
        onPointerDown={resize({ width: false, height: true })}
        onKeyDown={resizeByKey("height")}
        {...stylex.props(styles.edge, styles.top, focus.ring)}
      />
      <span
        aria-hidden="true"
        data-slot="app-shell-float-corner"
        onPointerDown={resize({ width: true, height: true })}
        {...stylex.props(styles.edge, styles.corner)}
      />
    </>
  ) : null;
  // The docked box, in the column: the card's margins (the token shell-inset, 6) in from its end, top
  // and foot, and the side's width less the margin at its end, as the docked card stands.
  const inset = 6;
  const boxes: Record<Shape, Box> = {
    docked: styles.at(
      inset,
      inset,
      options.docked - inset,
      room.height - 2 * inset
    ),
    floating: styles.at(place.x, place.y, width, height),
    full: styles.fullBox,
  };
  const ghost = hint ? (
    <span
      aria-hidden="true"
      data-slot="app-shell-float-ghost"
      {...stylex.props(styles.ghost, boxes.docked)}
    />
  ) : null;
  return {
    on,
    /** On its way between two shapes: the page's side eases with it, and the gutter rests. */
    moving: morph !== null,
    value,
    edges,
    ghost,
    look: lookOf(shape, morph, boxes),
  };
};
