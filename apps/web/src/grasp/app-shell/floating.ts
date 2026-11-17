// The floating panel: App shell's panels as a window over the page, moved by its head and resized from
// its start edge and its top, kept inside the shell. Its place is measured from the shell's end and
// foot (`panelPosition`, { x, y } in pixels), so it stays in its corner as the window resizes, and
// lives with the host, as its width and height do; nothing here stores it. Unset, it stands in its
// first place: the bottom end corner, the shell's margins from its edges.
//
// Pure helpers and the pointer's drag, outside the components (the product's React Compiler wants
// no ref read in render and no try/finally in a component).

/** Where a floating panel stands: its end edge `x` from the shell's end, its foot `y` from the shell's foot. */
export interface PanelPosition {
  x: number;
  y: number;
}

/** The floating window's first width, in pixels, before anyone resizes it (the product's). */
export const FLOAT_WIDTH = 400;
/** Its first height, in pixels, never more than the shell has. */
export const FLOAT_HEIGHT = 560;
/** Its least height, in pixels: its head, a few lines and a Composer. */
export const FLOAT_MIN_HEIGHT = 280;
/** How far the window keeps inside the shell, in pixels, on every side: it may lie anywhere over the
 * shell, the page's bar and a sidebar included (Ruben, 17 November), but its head never leaves it. */
export const FLOAT_MARGIN = 12;
/** How near the shell's end edge, in pixels, a dragged window's pointer docks it when let go. */
export const DOCK_ZONE = 64;
/** How far, in pixels, a docked panel's head must be pulled before it lifts into a window. */
export const PULL = 24;
/** How far an arrow key moves or resizes it, in pixels; with Shift, five times as far. */
const KEY_STEP = 24;

/**
 * The room the window has, in pixels: the column's size, and how far in from each of the column's
 * edges the window may stand (the page card's edge or the foot of its bar, and the margin). `end` and
 * `start` follow the reading direction.
 */
export interface FloatRoom {
  width: number;
  height: number;
  end: number;
  start: number;
  top: number;
  foot: number;
}

/** Before the column is measured (on a server, the first frame): any size, the card's usual margins. */
export const UNMEASURED: FloatRoom = {
  width: Number.POSITIVE_INFINITY,
  height: Number.POSITIVE_INFINITY,
  end: 6 + FLOAT_MARGIN,
  start: 6 + FLOAT_MARGIN,
  top: 6 + FLOAT_MARGIN,
  foot: 6 + FLOAT_MARGIN,
};

const within = (wanted: number, least: number, most: number) =>
  Math.round(Math.max(least, Math.min(Math.max(least, most), wanted)));

/** Its width, inside the host's limits and its room. */
export const floatWidth = (
  wanted: number | undefined,
  min: number,
  max: number,
  room: FloatRoom
) => {
  const most = room.width - room.start - room.end;
  return within(
    wanted ?? FLOAT_WIDTH,
    Math.min(min, most),
    Math.min(max, most)
  );
};

/** Its height, inside its least and its room. */
export const floatHeight = (wanted: number | undefined, room: FloatRoom) => {
  const most = room.height - room.top - room.foot;
  return within(
    wanted ?? Math.min(FLOAT_HEIGHT, most),
    Math.min(FLOAT_MIN_HEIGHT, most),
    most
  );
};

/** Its place, whole inside its room: the given one, or its first place (the room's end and foot). */
export const floatPlace = (
  wanted: PanelPosition | undefined,
  size: { width: number; height: number },
  room: FloatRoom
): PanelPosition => ({
  x: within(
    wanted?.x ?? room.end,
    room.end,
    room.width - room.start - size.width
  ),
  y: within(
    wanted?.y ?? room.foot,
    room.foot,
    room.height - room.top - size.height
  ),
});

/** The step an arrow key takes: [along the line, across it] toward the end and the foot. */
const arrowStep = (
  key: string,
  shift: boolean
): [number, number] | undefined => {
  const step = shift ? KEY_STEP * 5 : KEY_STEP;
  const steps: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  return steps[key];
};

/** Whether the page reads right to left at this element. */
export const readsBackward = (element: Element) =>
  getComputedStyle(element).direction === "rtl";

/**
 * The place an arrow key moves the window to, or undefined for any other key. On the screen: right
 * moves it right, whichever way the page reads; x counts from the end, y from the foot.
 */
export const placeByKey = (
  key: string,
  shift: boolean,
  from: PanelPosition,
  backward: boolean
): PanelPosition | undefined => {
  const step = arrowStep(key, shift);
  if (step === undefined) {
    return undefined;
  }
  const [across, down] = step;
  return { x: from.x + (backward ? across : -across), y: from.y - down };
};

/** The size an arrow key resizes an edge to: the start edge by left and right, the top by up and down. */
export const sizeByKey = (
  key: string,
  shift: boolean,
  edge: "width" | "height",
  from: number,
  backward: boolean
): number | undefined => {
  const step = arrowStep(key, shift);
  if (step === undefined) {
    return undefined;
  }
  const [across, down] = step;
  if (edge === "height") {
    return down === 0 ? undefined : from - down;
  }
  if (across === 0) {
    return undefined;
  }
  // The start edge: away from the end widens it (left in left to right, right in right to left).
  return from + (backward ? across : -across);
};

/** What a press on the head starts a drag from: not a control in it. */
const CONTROL =
  "button, a, input, textarea, select, [contenteditable], [role=button], [role=link], [data-no-drag]";

/** Whether a press on the head may start a drag: the main button, on the head itself, not a control. */
export const draggable = (event: {
  button: number;
  target: EventTarget | null;
  currentTarget: Element;
}) => {
  if (event.button !== 0 || !(event.target instanceof Element)) {
    return false;
  }
  // The control the press is on may be the one listening (the head's move control, the panel's name,
  // which is a control only for its double-click and its keys); any other control keeps its press.
  const control = event.target.closest(CONTROL);
  return (
    control === null ||
    control === event.currentTarget ||
    !event.currentTarget.contains(control)
  );
};

/** How far a pointer must travel before a press becomes a drag, in pixels: a double-click is not one. */
const THRESHOLD = 3;

/**
 * Follows the pointer from a press until it is let go: `move` with how far it has travelled on the
 * screen (dx right, dy down), once it has travelled past the threshold, and `end` when it is let go.
 * Returns the clean-up.
 */
export const followPointer = (
  start: { pointerId: number; clientX: number; clientY: number },
  move: (
    dx: number,
    dy: number,
    pointer: { clientX: number; clientY: number }
  ) => void,
  end: (moved: boolean, pointer?: { clientX: number; clientY: number }) => void
) => {
  const listening = new AbortController();
  let moved = false;
  window.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerId !== start.pointerId) {
        return;
      }
      const dx = event.clientX - start.clientX;
      const dy = event.clientY - start.clientY;
      if (!moved && Math.hypot(dx, dy) < THRESHOLD) {
        return;
      }
      moved = true;
      event.preventDefault();
      move(dx, dy, event);
    },
    { passive: false, signal: listening.signal }
  );
  const stop = (event: PointerEvent) => {
    if (event.pointerId === start.pointerId) {
      listening.abort();
      end(moved, moved ? event : undefined);
    }
  };
  window.addEventListener("pointerup", stop, { signal: listening.signal });
  window.addEventListener("pointercancel", stop, { signal: listening.signal });
  return () => {
    listening.abort();
  };
};

/** Whether a pointer is near the shell's end edge (the docked panels' side), in the reading direction. */
export const nearEnd = (clientX: number, shell: DOMRect, backward: boolean) =>
  (backward ? clientX - shell.left : shell.right - clientX) < DOCK_ZONE;

/**
 * The window's place when a docked panel is pulled off: under the pointer, held where the head was
 * grabbed (its start, at most a head's height down), in the column's measure (x from its end, y from
 * its foot).
 */
export const placeUnder = (
  pointer: { clientX: number; clientY: number },
  grabbed: { x: number; y: number },
  size: { width: number; height: number },
  column: DOMRect,
  backward: boolean
): PanelPosition => {
  const left = pointer.clientX - Math.min(grabbed.x, size.width - 40);
  const top = pointer.clientY - Math.min(grabbed.y, 40);
  return {
    x: backward ? left - column.left : column.right - (left + size.width),
    y: column.bottom - (top + size.height),
  };
};
