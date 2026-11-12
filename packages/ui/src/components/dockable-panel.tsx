"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { useHouseSpring } from "@grasp-os/ui/hooks/use-house-spring";
import { useIsMobile } from "@grasp-os/ui/hooks/use-mobile";
import { useOpenChangeComplete } from "@grasp-os/ui/hooks/use-open-change-complete";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import { GripVerticalIcon } from "lucide-react";
import { motion, useAnimate, useDragControls } from "motion/react";
import type { DragControls } from "motion/react";
import * as React from "react";

// One panel, in one of three places: docked into the app shell's right
// Panel, full screen over the shell's main area beside its sidebar, or floating over the page as a
// window the person moves anywhere by its header; on a phone, docked or full
// screen, it takes the whole screen. It is a single element that stays
// mounted, open or not, so what it holds never renders again as it opens,
// closes or moves. It comes in growing from its centre into place and goes
// the same way reversed; `onOpenChangeComplete` says when it has, so a move
// to or from floating reads as one: close it, change `placement`, open it.
// Between docked and full screen it moves open, its left edge gliding out
// to where the main area's card starts and back, while the shell's page fades under it
// (AppShellMain's `covered`). Floating, it opens where it was last put,
// lifts as it is picked up, gives at the window's edges and settles back
// inside them; a window too small for where it was put draws it inside, and
// it goes back once there is room. Where it was put is the page's to keep
// (`defaultOffset`, `onOffsetChange`).
//
// Docked, it can be dragged out of its dock by its grip to float, where
// the page lets it (`onDetach`).
//
// Two layers: the outer one stands where the panel is and is what drag moves
// (Motion); the inner one is the card, which the browser itself fades, moves
// and scales (CSS transitions, on the compositor), so it stays smooth while
// the page beside it reflows.
//
//   <DockablePanel open placement="floating" label="Chat" defaultOffset={kept} onOffsetChange={keep}>
//     <DockablePanelHeader>
//       <DockablePanelHandle label="Move the chat" />
//       …buttons
//     </DockablePanelHeader>
//     …content
//   </DockablePanel>

/**
 * Where it is: docked into the shell's right Panel, full screen over the
 * shell's main area beside its sidebar, or floating over the page.
 */
type DockablePlacement = "docked" | "fullscreen" | "floating";

/**
 * Where it stands when floating: how far it was moved from the bottom right
 * corner, in pixels (so never more than 0).
 */
interface FloatingOffset {
  x: number;
  y: number;
}

/** How far it may move from its corner and stay inside the window. */
interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** How far it keeps off the window's edges when floating (`right-4 bottom-4`). */
const EDGE = 16;
/** How far an arrow key moves it; with Shift, further. */
const STEP = 24;
const BIG_STEP = 96;
/** What in the header is pressed for itself, not to move the panel. */
const CONTROLS = "button, a, input, textarea, [role=menuitem]";
/** Let go past an edge, how it settles back inside. */
const SETTLE = { bounceStiffness: 500, bounceDamping: 40 };
const ORIGIN: FloatingOffset = { x: 0, y: 0 };
/**
 * How far past the window's right edge, where it stops, a drag of it
 * floating pushes it to dock it, in pixels: wherever it is held, it floats
 * anywhere up to that edge, its own corner included, and a short push on
 * docks it.
 */
const DOCK_PUSH = 32;
/** How big it is floating (`w-100 h-136`), where a window has room for that. */
const FLOATING_SIZE = { width: 400, height: 544 };
/** Until it is measured: no room to move. */
const NO_BOUNDS: Bounds = { left: 0, right: 0, top: 0, bottom: 0 };

/** Where the panel stands, and how big it is, in each place. */
const panelVariants = cva("z-40", {
  variants: {
    placement: {
      // The right Panel it sits in, inside the shell's gap on its outer
      // edges; against the page, the page's own margin is the gap. It
      // stands fixed so that going full screen moves only its left edge.
      docked:
        "ease-sidebar fixed inset-y-(--app-shell-gap) right-(--app-shell-gap) left-[calc(100vw-var(--panel-size))] transition-[left] duration-(--motion-duration) in-data-resizing:transition-none motion-reduce:transition-none",
      // The shell's main area too, from where its card starts (beside the
      // sidebar), over the card, which stays as its ground.
      fullscreen:
        "ease-sidebar fixed inset-y-(--app-shell-gap) right-(--app-shell-gap) left-[var(--app-shell-main-left,var(--app-shell-gap))] transition-[left] duration-(--motion-duration) motion-reduce:transition-none",
      // A phone has no room beside the page: docked or full screen, it takes
      // the whole screen.
      phone: "fixed inset-0",
      floating:
        "fixed right-4 bottom-4 h-136 max-h-[calc(100svh-2rem)] w-100 max-w-[calc(100vw-2rem)]",
    },
    visible: {
      true: "",
      false: "pointer-events-none",
    },
  },
});

/**
 * The card, and how it comes and goes, the same in every place: it comes in
 * growing from its centre into place as it fades in, and goes the same way
 * reversed, in the same time on the sidebar's curve, as everything that
 * opens and closes beside the page moves; `delayed`
 * lets it wait for what moves before it.
 */
const cardVariants = cva(
  "ease-sidebar flex size-full flex-col overflow-hidden rounded-xl text-sm motion-reduce:transition-none",
  {
    variants: {
      placement: {
        // The page's own ground beside it and under it, so going full screen
        // reads as one surface; floating, a lifted card over the page.
        docked:
          "bg-background text-foreground shadow-sm dark:border dark:shadow-xl",
        fullscreen:
          "bg-background text-foreground shadow-sm dark:border dark:shadow-xl",
        phone: "bg-background text-foreground rounded-none",
        floating: "bg-card text-card-foreground shadow-lifted border",
      },
      visible: {
        true: "visible scale-100 opacity-100 transition-[opacity,scale] duration-(--motion-duration)",
        // Gone, it is hidden too, from assistive technology as from the eye:
        // at once as it comes, so it can take the cursor; once it has gone
        // as it goes.
        false:
          "invisible scale-95 opacity-0 transition-[opacity,scale,visibility] duration-(--motion-duration)",
      },
      delayed: {
        true: "delay-(--motion-stagger)",
        false: "",
      },
    },
  }
);

interface DockablePanelContextProps {
  placement: DockablePlacement;
  controls: DragControls;
  nudge: (dx: number, dy: number) => void;
  /** Takes it out of its dock to float, where it can be (`onDetach`). */
  detach: (() => void) | undefined;
  /** Docks it from floating, where it can be (`onDock`). */
  dock: (() => void) | undefined;
  /** Whether it is being dragged now. */
  dragging: boolean;
}

const DockablePanelContext =
  React.createContext<DockablePanelContextProps | null>(null);

function useDockablePanel() {
  const context = React.useContext(DockablePanelContext);
  if (!context) {
    throw new Error("useDockablePanel must be used within a DockablePanel.");
  }
  return context;
}

/** How far `panel` may move from its corner in the window as it is now. */
function boundsOf(panel: HTMLElement): Bounds {
  return {
    left: Math.min(0, panel.offsetWidth + 2 * EDGE - window.innerWidth),
    right: 0,
    top: Math.min(0, panel.offsetHeight + 2 * EDGE - window.innerHeight),
    bottom: 0,
  };
}

/**
 * Starts a drag of the panel from `event`, the pointer captured by `by`
 * (what was pressed, by default): its moves and its release keep coming
 * there wherever it goes, over a frame of another document (an App's page)
 * too, which would otherwise take them, and the drag would stop there,
 * held. Clicks land on `by` too, so the grip, pressed, keeps its own.
 */
function pickUp(
  event: React.PointerEvent,
  controls: DragControls,
  by: Element = event.currentTarget
) {
  by.setPointerCapture(event.pointerId);
  controls.start(event);
}

/** A point on the screen, or in the panel from its top left. */
interface Point {
  x: number;
  y: number;
}

/** `offset`, kept inside `bounds`. */
function clamp(offset: FloatingOffset, bounds: Bounds): FloatingOffset {
  return {
    x: Math.round(Math.min(bounds.right, Math.max(bounds.left, offset.x))),
    y: Math.round(Math.min(bounds.bottom, Math.max(bounds.top, offset.y))),
  };
}

/**
 * Where it stands floating so that `grab`, the point of it the person
 * holds, is at `point`: dropped out of its dock, it floats where it was let
 * go, held where it was picked up, inside the window.
 */
function floatingAt(point: Point, grab: Point): FloatingOffset {
  const width = Math.min(FLOATING_SIZE.width, window.innerWidth - 2 * EDGE);
  const height = Math.min(FLOATING_SIZE.height, window.innerHeight - 2 * EDGE);
  // Its corner, which the offset is from: the window's bottom right.
  const cornerLeft = window.innerWidth - EDGE - width;
  const cornerTop = window.innerHeight - EDGE - height;
  return clamp(
    {
      x: point.x - Math.min(grab.x, width) - cornerLeft,
      y: point.y - Math.min(grab.y, height) - cornerTop,
    },
    {
      left: Math.min(0, width + 2 * EDGE - window.innerWidth),
      right: 0,
      top: Math.min(0, height + 2 * EDGE - window.innerHeight),
      bottom: 0,
    }
  );
}

function DockablePanel({
  open,
  placement,
  label,
  defaultOffset,
  onOffsetChange,
  onOpenChangeComplete,
  onDetach,
  onDock,
  delayed = false,
  className,
  children,
}: {
  open: boolean;
  /** Where it is: between docked and full screen it glides; to or from floating, change it while closed. */
  placement: DockablePlacement;
  /** The panel's name, read out by screen readers. */
  label: string;
  /** Where it was last put when floating, read as it mounts; the bottom right corner when not given. */
  defaultOffset?: FloatingOffset;
  /** Where it was put now, once a drag or a key press settled it. */
  onOffsetChange?: (offset: FloatingOffset) => void;
  /** Once it has finished coming in or going. */
  onOpenChangeComplete?: (open: boolean) => void;
  /**
   * Docked, it can be taken out of its dock to float: dragged by its grip
   * and let go outside it (where it was let go is its offset, told by
   * `onOffsetChange`), or the grip double-clicked or pressed. The page
   * moves it (`placement="floating"`).
   */
  onDetach?: () => void;
  /**
   * Floating, it can be docked: pushed past the window's right edge (a
   * drop zone shows where it will stand as it is) and let go there,
   * or its grip double-clicked or pressed. The page moves it
   * (`placement="docked"`).
   */
  onDock?: () => void;
  /** Comes or goes a beat after what moves with it (the theme's `--motion-stagger`). */
  delayed?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const spring = useHouseSpring();
  const controls = useDragControls();
  const isMobile = useIsMobile();
  // Motion owns where it stands, as drag moves it; `place` sets it.
  const [panel, place] = useAnimate<HTMLDivElement>();
  const card = React.useRef<HTMLElement>(null);
  // Where the person put it, which the window may be too small to show.
  const put = React.useRef<FloatingOffset>(defaultOffset ?? ORIGIN);
  const [bounds, setBounds] = React.useState<Bounds>(NO_BOUNDS);
  const [dragging, setDragging] = React.useState(false);
  const floating = placement === "floating";
  const stands = !floating && isMobile ? "phone" : placement;
  // Docked beside a page (not a phone's screen), it can be dragged out.
  const detachable =
    onDetach !== undefined && placement === "docked" && !isMobile;
  // Where it stood and where it was held as a drag out of its dock began.
  const pickedUp = React.useRef<{ from: DOMRect; grab: Point } | null>(null);
  const dockable = onDock !== undefined && floating;
  // Floating, where a drag began from its corner, and whether it has
  // pushed it past the window's right edge to its dock.
  const dragFrom = React.useRef<FloatingOffset>(ORIGIN);
  const [overDock, setOverDock] = React.useState(false);
  // Where Motion has drawn it: moved to another place, it comes in only once
  // it stands there, so it never shows, however faintly, where it was.
  const [placed, setPlaced] = React.useState(floating);
  const visible = open && placed === floating;
  // Told to open or close, it says when it has, at once if nothing moved
  // (opened before it stands in its new place, say), so what waits for it
  // never waits for nothing.
  useOpenChangeComplete(card, open, onOpenChangeComplete);

  // Floating, it is drawn where it was put as far as the window lets it, now
  // and as the window resizes; docked, it fills its box.
  const fit = React.useEffectEvent(async (isFloating: boolean) => {
    let shownAt = ORIGIN;
    if (isFloating) {
      const next = boundsOf(panel.current);
      setBounds(next);
      shownAt = clamp(put.current, next);
    }
    await place(panel.current, { x: shownAt.x, y: shownAt.y }, { duration: 0 });
    setPlaced(isFloating);
  });
  React.useLayoutEffect(() => {
    void fit(floating);
    const onResize = () => {
      void fit(floating);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [floating]);

  /**
   * Puts it `dx`, `dy` from where it shows, inside the window, and says so;
   * `glide` moves it there (a drag has already).
   */
  const moveBy = (dx: number, dy: number, glide: boolean) => {
    const from = clamp(put.current, bounds);
    put.current = clamp({ x: from.x + dx, y: from.y + dy }, bounds);
    if (glide) {
      void place(panel.current, { x: put.current.x, y: put.current.y }, spring);
    }
    onOffsetChange?.(put.current);
  };
  const nudge = (dx: number, dy: number) => {
    moveBy(dx, dy, true);
  };
  const context: DockablePanelContextProps = {
    placement,
    controls,
    nudge,
    detach: detachable ? onDetach : undefined,
    dock: dockable ? onDock : undefined,
    dragging,
  };
  return (
    // The React Compiler memoizes the value; nothing here does by hand (AGENTS.md).
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <DockablePanelContext.Provider value={context}>
      {dockable ? (
        // Where it will dock, as a drag pushes it past the window's edge.
        <div
          aria-hidden="true"
          data-slot="dockable-panel-dock-zone"
          data-over={dragging && overDock}
          className="ease-sidebar bg-foreground/5 ring-foreground/10 pointer-events-none fixed inset-y-(--app-shell-gap) right-(--app-shell-gap) z-30 w-[calc(var(--panel-size,25rem)-var(--app-shell-gap))] scale-98 rounded-xl opacity-0 ring-1 transition-[opacity,scale] duration-(--motion-duration) data-[over=true]:scale-100 data-[over=true]:opacity-100 motion-reduce:transition-none"
        />
      ) : null}
      <motion.div
        ref={panel}
        data-slot="dockable-panel"
        data-placement={placement}
        data-dragging={dragging}
        className={panelVariants({ placement: stands, visible })}
        drag={floating || detachable}
        dragControls={controls}
        dragListener={false}
        dragConstraints={floating ? bounds : false}
        dragElastic={0.12}
        dragMomentum={false}
        dragTransition={SETTLE}
        onDragStart={(_event, info) => {
          setDragging(true);
          dragFrom.current = clamp(put.current, bounds);
          const from = panel.current.getBoundingClientRect();
          pickedUp.current = floating
            ? null
            : {
                from,
                grab: {
                  x: info.point.x - from.left,
                  y: info.point.y - from.top,
                },
              };
        }}
        onDrag={(_event, info) => {
          // Where the drag would put it, were the window's edge not there.
          setOverDock(
            dockable && dragFrom.current.x + info.offset.x > DOCK_PUSH
          );
        }}
        onDragEnd={(_event, info) => {
          setDragging(false);
          const out = pickedUp.current;
          pickedUp.current = null;
          if (overDock && onDock !== undefined) {
            // Let go over its dock: it docks, and floats again from where
            // it was before this drag.
            setOverDock(false);
            onDock();
            return;
          }
          if (out === null) {
            // Floating, Motion settles it inside the window itself.
            moveBy(info.offset.x, info.offset.y, false);
            return;
          }
          const { from, grab } = out;
          const leftItsDock =
            info.point.x < from.left ||
            info.point.x > from.right ||
            info.point.y < from.top ||
            info.point.y > from.bottom;
          if (leftItsDock && onDetach !== undefined) {
            put.current = floatingAt(info.point, grab);
            onOffsetChange?.(put.current);
            onDetach();
            return;
          }
          // Let go inside its dock, it goes back there.
          void place(panel.current, { ...ORIGIN }, spring);
        }}
        whileDrag={{ scale: 1.02, transition: spring }}
      >
        <section
          data-slot="dockable-panel-card"
          data-state={visible ? "open" : "closed"}
          aria-label={label}
          inert={!open}
          ref={card}
          className={cn(
            cardVariants({ placement: stands, visible, delayed }),
            className
          )}
        >
          {children}
        </section>
      </motion.div>
    </DockablePanelContext.Provider>
  );
}

/** The panel's header; floating, it moves the panel when dragged. */
function DockablePanelHeader({
  className,
  onPointerDown,
  ...props
}: React.ComponentProps<"header">) {
  const { placement, controls } = useDockablePanel();
  return (
    <header
      data-slot="dockable-panel-header"
      className={cn(
        "flex h-12 flex-none items-center gap-1 border-b px-2 select-none in-data-[dragging=true]:cursor-grabbing in-data-[placement=floating]:cursor-grab in-data-[placement=floating]:touch-none",
        className
      )}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        // Buttons in the header keep their press (the grip excepted).
        const target = event.target instanceof Element ? event.target : null;
        const grip =
          target?.closest("[data-slot=dockable-panel-handle]") ?? null;
        const pressesControl =
          target !== null && target.closest(CONTROLS) !== null && grip === null;
        if (placement === "floating" && event.button === 0 && !pressesControl) {
          // From the grip, it keeps the pointer: a double click there docks.
          pickUp(event, controls, grip ?? event.currentTarget);
        }
      }}
      {...props}
    />
  );
}

/**
 * The panel's grip, named and explained by `label`, also its tooltip
 * (never while the panel is being dragged).
 * Floating, dragged or moved with the arrow keys, it moves the panel, and
 * double-clicked or pressed, it docks it (`onDock`). Docked where it can
 * float (`onDetach`), dragged out of the dock, or double-clicked or
 * pressed, it takes the panel out to float.
 */
function DockablePanelHandle({
  label,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "children"> & {
  /** The grip's name and tooltip: what dragging it does. */
  label: string;
}) {
  const { placement, controls, nudge, detach, dock, dragging } =
    useDockablePanel();
  // Its tooltip, shown on hover or focus, never while it is being dragged.
  const [hinted, setHinted] = React.useState(false);
  const floating = placement === "floating";
  // Floating it docks, docked it floats: where the page lets it.
  const toOther = floating ? dock : detach;
  if (!floating && detach === undefined) {
    return null;
  }
  return (
    <Tooltip onOpenChange={setHinted} open={hinted && !dragging}>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-slot="dockable-panel-handle"
            aria-label={label}
            aria-keyshortcuts={
              floating
                ? "ArrowUp ArrowDown ArrowLeft ArrowRight Enter"
                : "Enter"
            }
            className={cn(
              "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex h-8 w-5 flex-none cursor-grab touch-none items-center justify-center rounded-md outline-hidden transition-colors focus-visible:ring-3 in-data-[dragging=true]:cursor-grabbing [&_svg]:size-4",
              className
            )}
            onDoubleClick={toOther}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toOther?.();
                return;
              }
              if (!floating) {
                return;
              }
              const step = event.shiftKey ? BIG_STEP : STEP;
              const moves: Record<string, [number, number]> = {
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
              };
              const move = moves[event.key];
              if (move) {
                event.preventDefault();
                nudge(...move);
              }
            }}
            onPointerDown={(event) => {
              // Floating, its header picks the panel up; docked, only it does.
              if (!floating && event.button === 0) {
                pickUp(event, controls);
              }
            }}
            {...props}
          />
        }
      >
        <GripVerticalIcon />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export {
  DockablePanel,
  DockablePanelHandle,
  DockablePanelHeader,
  useDockablePanel,
};
export type { DockablePlacement, FloatingOffset };
