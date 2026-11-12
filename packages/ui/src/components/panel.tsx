"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { useOpenChangeComplete } from "@grasp-os/ui/hooks/use-open-change-complete";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import * as React from "react";

// A region on one edge of a layout that opens and collapses, taking its space
// from what is beside it rather than covering it: the app's sidebar on the
// left of the shell, the chat docked on its right, a page's own sidebar on
// the left of its content; one on the top or bottom works the same way. Open,
// it is `size`; collapsed, `collapsedSize`: a rail of icons, or nothing (0).
// It moves on the sidebar's curve, and not at all under reduced
// motion (the theme's `--motion-duration`); `delayed` starts it a beat
// after what moves with it, and
// `onOpenChangeComplete` says when it has, for what moves next.
// Given `onSizeChange` (and a pixel `size`), its inner edge resizes it, by
// dragging or with the arrow keys. What it holds lays itself out.
//
//   <Panel side="left" open={open} size="16rem" collapsedSize="3rem">…</Panel>
//   <Panel side="right" open={docked} size={width} onSizeChange={keep} resizeLabel="Resize" />

type PanelSide = "left" | "right" | "top" | "bottom";

/** How far an arrow key resizes it, in pixels. */
const RESIZE_STEP = 24;

const panelVariants = cva(
  "ease-sidebar relative shrink-0 overflow-hidden duration-(--motion-duration) data-resizing:transition-none motion-reduce:transition-none",
  {
    variants: {
      side: {
        left: "",
        right: "",
        top: "",
        bottom: "",
      },
      // A line on its inner edge, between it and what it opens from.
      bordered: {
        true: "",
        false: "",
      },
      // A beat after what moves with it (the theme's `--motion-stagger`).
      delayed: {
        true: "delay-(--motion-stagger)",
        false: "",
      },
    },
    compoundVariants: [
      {
        side: ["left", "right"],
        class:
          "w-(--panel-collapsed-size) transition-[width] data-open:w-(--panel-size)",
      },
      {
        side: ["top", "bottom"],
        class:
          "h-(--panel-collapsed-size) transition-[height] data-open:h-(--panel-size)",
      },
      { side: "left", bordered: true, class: "border-r" },
      { side: "right", bordered: true, class: "border-l" },
      { side: "top", bordered: true, class: "border-b" },
      { side: "bottom", bordered: true, class: "border-t" },
    ],
  }
);

/** Its resize handle sits on its inner edge, the one beside what it opens from. */
const handleVariants = cva(
  "focus-visible:ring-ring/50 absolute z-50 touch-none rounded-full outline-hidden select-none focus-visible:ring-3",
  {
    variants: {
      side: {
        left: "inset-y-2 right-0 w-2 cursor-col-resize",
        right: "inset-y-2 left-0 w-2 cursor-col-resize",
        top: "inset-x-2 bottom-0 h-2 cursor-row-resize",
        bottom: "inset-x-2 top-0 h-2 cursor-row-resize",
      },
    },
  }
);

/** `px` as a CSS length; a string is one already. */
const lengthOf = (size: number | string): string =>
  typeof size === "number" ? `${size}px` : size;

/**
 * The panel's resize handle: dragged or moved with the arrow keys, it makes
 * the panel larger or smaller, between `min` and `max` and never past half
 * the window. Nothing marks it but the resize cursor, and the focus ring
 * for the keyboard. While dragged, the panel follows the pointer
 * (`onPreview`); where it was let go is told once (`onResize`).
 */
function PanelHandle({
  side,
  label,
  size,
  min,
  max,
  onPreview,
  onResize,
}: {
  side: PanelSide;
  label: string;
  size: number;
  min: number;
  max: number;
  onPreview: (size: number | null) => void;
  onResize: (size: number) => void;
}) {
  const horizontal = side === "left" || side === "right";
  // Toward what it opens from, it grows: a right or bottom panel grows as its
  // edge moves left or up.
  const grows = side === "left" || side === "top" ? 1 : -1;
  const largest = () =>
    Math.max(
      min,
      Math.min(max, (horizontal ? window.innerWidth : window.innerHeight) / 2)
    );
  const fit = (wanted: number) =>
    Math.round(Math.max(min, Math.min(largest(), wanted)));
  const keys: Record<string, number> = horizontal
    ? { ArrowRight: RESIZE_STEP * grows, ArrowLeft: -RESIZE_STEP * grows }
    : { ArrowDown: RESIZE_STEP * grows, ArrowUp: -RESIZE_STEP * grows };
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={largest()}
      tabIndex={0}
      data-slot="panel-handle"
      className={handleVariants({ side })}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        const from = horizontal ? event.clientX : event.clientY;
        let next = size;
        const move = (moved: PointerEvent) => {
          const at = horizontal ? moved.clientX : moved.clientY;
          next = fit(size + (at - from) * grows);
          onPreview(next);
        };
        // Let go, cancelled, or gone with the panel: the drag ends.
        const drop = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("lostpointercapture", drop);
          onPreview(null);
          onResize(next);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("lostpointercapture", drop);
      }}
      onKeyDown={(event) => {
        const steps: Record<string, number> = {
          ...keys,
          Home: min - size,
          End: largest() - size,
        };
        const step = steps[event.key];
        if (step !== undefined) {
          event.preventDefault();
          onResize(fit(size + step));
        }
      }}
    />
  );
}

/** Resizable: a pixel `size`, and what to call its handle. */
interface PanelResizing {
  size: number;
  /** Where its edge was let go, or moved to with the keys. */
  onSizeChange: (size: number) => void;
  minSize?: number;
  maxSize?: number;
  /** The resize handle's name, read out by screen readers. */
  resizeLabel: string;
}

/** Not resizable. */
interface PanelFixed {
  onSizeChange?: undefined;
  minSize?: undefined;
  maxSize?: undefined;
  resizeLabel?: undefined;
}

type PanelProps = useRender.ComponentProps<"div"> & {
  /** The edge it is on: what it opens from, and which way it grows. */
  side: PanelSide;
  open: boolean;
  /** How large it is open: pixels, or a CSS length. */
  size: number | string;
  /** How large it is collapsed: pixels, or a CSS length; 0, gone, by default. */
  collapsedSize?: number | string;
  /** Starts a beat after what moves with it (the theme's `--motion-stagger`). */
  delayed?: boolean;
  /** Once it has finished opening or collapsing. */
  onOpenChangeComplete?: (open: boolean) => void;
  /** A line on its inner edge, between it and what it opens from. */
  bordered?: boolean;
} & (PanelResizing | PanelFixed);

function Panel({
  side,
  open,
  size,
  collapsedSize = 0,
  minSize = 0,
  maxSize = Number.POSITIVE_INFINITY,
  onSizeChange,
  resizeLabel,
  delayed = false,
  onOpenChangeComplete,
  bordered = false,
  render,
  className,
  children,
  ...props
}: PanelProps) {
  const panel = React.useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = React.useState(false);
  // A drag cut short by the panel collapsing ends there.
  if (resizing && !open) {
    setResizing(false);
  }
  useOpenChangeComplete(panel, open, onOpenChangeComplete);
  const show = (shown: number | string) => {
    panel.current?.style.setProperty("--panel-size", lengthOf(shown));
  };
  return useRender({
    defaultTagName: "div",
    ref: (element: HTMLDivElement | null) => {
      panel.current = element;
      element?.style.setProperty("--panel-size", lengthOf(size));
      element?.style.setProperty(
        "--panel-collapsed-size",
        lengthOf(collapsedSize)
      );
    },
    props: mergeProps<"div">(
      {
        className: cn(panelVariants({ side, bordered, delayed }), className),
        children: (
          <>
            {children}
            {/* The types give all three together, or none. */}
            {open &&
            onSizeChange !== undefined &&
            resizeLabel !== undefined &&
            typeof size === "number" ? (
              <PanelHandle
                label={resizeLabel}
                max={maxSize}
                min={minSize}
                onPreview={(previewed) => {
                  setResizing(previewed !== null);
                  show(previewed ?? size);
                }}
                onResize={(next) => {
                  show(next);
                  onSizeChange(next);
                }}
                side={side}
                size={size}
              />
            ) : null}
          </>
        ),
      },
      props
    ),
    render,
    state: {
      slot: "panel",
      side,
      open,
      closed: !open,
      resizing,
    },
  });
}

export { Panel };
export type { PanelSide };
