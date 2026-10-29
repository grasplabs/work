import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";

import {
  dockDrawer,
  setDockDrawerWidth,
  widestDockDrawer,
} from "./dock-mode.ts";

// The chat drawer's left edge, as a handle, as in the prototype
// (`components/chat/drawer-edge.tsx`): dragged, the drawer gets wider or
// narrower, never narrower than it reads at; pulled well past that, it
// closes to the small chat. The arrow keys move it too.

/** How far an arrow key moves the edge, in pixels. */
const step = 24;

/** How much of the pull past its least width the drawer still follows: it resists. */
const resistance = 0.3;

/** How far the drawer's right edge is in from the window's, in pixels (its `right-2`). */
const margin = 8;

export const DrawerEdge = ({
  width,
  dragging,
  onDragging,
  onClose,
}: {
  width: number;
  dragging: boolean;
  /** Whether it is being dragged: nothing may ease meanwhile, so the edge stays under the pointer. */
  onDragging: (dragging: boolean) => void;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  return (
    <button
      aria-label={t`Drag to make the chat wider or narrower`}
      className="group/edge absolute inset-y-0 -left-1.5 z-10 flex w-3 cursor-col-resize touch-none justify-center outline-none"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }
        // The arrows are the edge's own here: the page under it doesn't move.
        event.preventDefault();
        event.stopPropagation();
        setDockDrawerWidth(
          event.key === "ArrowLeft"
            ? Math.min(widestDockDrawer(), width + step)
            : Math.max(dockDrawer.least, width - step)
        );
      }}
      onPointerCancel={() => {
        onDragging(false);
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) {
          return;
        }
        const wanted = window.innerWidth - margin - event.clientX;
        // Pulled well past its least width it closes then and there.
        if (wanted < dockDrawer.least - dockDrawer.give) {
          event.currentTarget.releasePointerCapture(event.pointerId);
          onDragging(false);
          onClose();
          setDockDrawerWidth(dockDrawer.normal);
          return;
        }
        setDockDrawerWidth(
          wanted < dockDrawer.least
            ? dockDrawer.least - (dockDrawer.least - wanted) * resistance
            : Math.min(widestDockDrawer(), wanted)
        );
      }}
      onPointerUp={() => {
        onDragging(false);
        // Let go while it was giving way: back to its least width.
        if (width < dockDrawer.least) {
          setDockDrawerWidth(dockDrawer.least);
        }
      }}
      type="button"
    >
      <span
        aria-hidden="true"
        className={cn(
          "group-hover/edge:bg-foreground/40 group-focus-visible/edge:bg-foreground/40 h-full w-px transition-colors",
          dragging ? "bg-foreground/40" : "bg-transparent"
        )}
      />
    </button>
  );
};
