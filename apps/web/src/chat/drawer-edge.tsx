import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { useRef, useSyncExternalStore } from "react";

import {
  draggedDrawerWidth,
  dockDrawer,
  setDockDrawerWidth,
  settledDrawerWidth,
  steppedDrawerWidth,
  widestDockDrawer,
} from "./dock-mode.ts";

// The chat drawer's left edge, as in the prototype
// (`components/chat/drawer-edge.tsx`): a separator between the page and the
// drawer, which a person drags, or moves with the arrow keys, to make the
// drawer wider or narrower, never narrower than it reads at; pulled well
// past that, it closes to the small chat. While it is dragged, only the
// drawer follows (`onPreview`, its CSS variable); the width is kept, and
// the pages that make room for the drawer move, when it is let go.

/** How far the drawer's right edge is in from the window's, in pixels (its `right-2`). */
const margin = 8;

const onResize = (listener: () => void): (() => void) => {
  addEventListener("resize", listener);
  return () => {
    removeEventListener("resize", listener);
  };
};

/** The widest the drawer may be in the window as it is now, again as the window is resized. */
const useWidest = (): number =>
  useSyncExternalStore(onResize, () => widestDockDrawer(innerWidth));

export const DrawerEdge = ({
  width,
  dragging,
  onDragging,
  onPreview,
  onClose,
}: {
  width: number;
  dragging: boolean;
  /** Whether it is being dragged: nothing may ease meanwhile, so the edge stays under the pointer. */
  onDragging: (dragging: boolean) => void;
  /** Shows the drawer `width` pixels wide while the edge is dragged. */
  onPreview: (width: number) => void;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const widest = useWidest();
  // Where the drag has the drawer now, kept when it is let go.
  const dragged = useRef(width);
  return (
    <div
      aria-label={t`Chat width`}
      aria-orientation="vertical"
      aria-valuemax={widest}
      aria-valuemin={dockDrawer.least}
      aria-valuenow={width}
      className="group/edge focus-visible:ring-ring/50 absolute inset-y-0 -left-1.5 z-10 flex w-3 cursor-col-resize touch-none justify-center rounded-full outline-none focus-visible:ring-3"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }
        // The arrows are the edge's own here: the page under it doesn't move.
        event.preventDefault();
        event.stopPropagation();
        setDockDrawerWidth(steppedDrawerWidth(width, event.key, widest));
      }}
      onPointerCancel={() => {
        onPreview(width);
        onDragging(false);
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        dragged.current = width;
        onDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) {
          return;
        }
        const next = draggedDrawerWidth(
          innerWidth - margin - event.clientX,
          widest
        );
        if (next === "closed") {
          event.currentTarget.releasePointerCapture(event.pointerId);
          onDragging(false);
          onClose();
          setDockDrawerWidth(dockDrawer.normal);
          return;
        }
        dragged.current = next;
        onPreview(next);
      }}
      onPointerUp={() => {
        onDragging(false);
        // Let go while it was giving way: back to its least width.
        const settled = settledDrawerWidth(dragged.current, widest);
        onPreview(settled);
        setDockDrawerWidth(settled);
      }}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a focusable separator is a widget, and <hr> can't hold focus or children
      role="separator"
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className={cn(
          "group-hover/edge:bg-foreground/40 group-focus-visible/edge:bg-ring h-full w-px transition-colors",
          dragging ? "bg-foreground/40" : "bg-transparent"
        )}
      />
    </div>
  );
};
