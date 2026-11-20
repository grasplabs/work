// An image (PNG, JPEG, WebP, GIF, AVIF, or SVG shown as an image, where its scripts never run),
// centred on the ground, fitted to the width or at a zoom.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useImperativeHandle, useState } from "react";

import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "../../../empty/empty";
import { grasp, media } from "../../../tokens/tokens.stylex";
import type { RendererProps } from "../../types";

const styles = stylex.create({
  box: {
    display: "grid",
    // One column the full width, so a fitted image's percentage width has a width to be of.
    gridTemplateColumns: "minmax(0, 1fr)",
    placeItems: "center",
    minHeight: "100%",
  },
  // Zoomed past the room: as wide as the image, so it scrolls sideways.
  wide: { width: "max-content", minWidth: "100%" },
  image: {
    display: "block",
    borderRadius: grasp.cornerMark,
    boxShadow: grasp.edge,
    // A light checker in both themes, as image viewers draw it: a dark logo, or a picture with
    // see-through parts, reads on it in dark as well as light.
    backgroundColor: grasp.viewerImageGround,
    backgroundImage: `conic-gradient(${grasp.viewerImageCheck} 25%, transparent 0 50%, ${grasp.viewerImageCheck} 0 75%, transparent 0)`,
    backgroundSize: `calc(${grasp.viewerImageCheckSize} * 2) calc(${grasp.viewerImageCheckSize} * 2)`,
    opacity: { default: 1, ":is([data-loading])": 0 },
    transitionProperty: "opacity",
    transitionDuration: {
      default: grasp.durationArrive,
      [media.reduced]: "0s",
    },
    transitionTimingFunction: grasp.ease,
  },
  // Fitted: as wide as the room, never wider than the image itself. An SVG may have no width of
  // its own (only a viewBox), so it fits to the page's width instead.
  fit: (most: string) => ({ width: `min(100%, ${most})`, height: "auto" }),
  // The image and the boxes on it: the boxes are placed in fractions of its size.
  frame: { position: "relative", display: "block", lineHeight: 0 },
  drawable: { cursor: "crosshair", touchAction: "none", userSelect: "none" },
  whole: { width: "100%", height: "auto" },
  // A box a comment holds on to: a soft fill and a hairline, as it marks a picture, not words.
  mark: (box: Box) => ({
    position: "absolute",
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
    boxSizing: "border-box",
    padding: 0,
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.mintDeep,
    borderRadius: grasp.cornerMark,
    backgroundColor: `color-mix(in srgb, ${grasp.viewerComment} 45%, transparent)`,
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `${grasp.ringWidth} solid ${grasp.ring}`,
    },
    outlineOffset: grasp.ringOffset,
  }),
  // A small box is still a finger's width to press: an unseen area round it, never smaller.
  hit: {
    "::before": {
      content: '""',
      position: "absolute",
      insetBlock: `min(0px, calc(50% - ${grasp.tap} / 2))`,
      insetInline: `min(0px, calc(50% - ${grasp.tap} / 2))`,
    },
  },
  markActive: {
    backgroundColor: `color-mix(in srgb, ${grasp.viewerCommentActive} 55%, transparent)`,
  },
  sized: (width: string) => ({ width, maxWidth: "none", height: "auto" }),
});

// A box on the image, in fractions of its size.
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Where a press is on the image, in fractions of its size.
const at = (event: React.PointerEvent<HTMLElement>): [number, number] => {
  const rect = event.currentTarget.getBoundingClientRect();
  return [
    Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  ];
};
const boxFrom = (
  [x1, y1]: [number, number],
  [x2, y2]: [number, number]
): Box => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  w: Math.abs(x2 - x1),
  h: Math.abs(y2 - y1),
});

// An image is one row: there is nowhere to scroll it to.
const stay = () => {
  // Nothing to do.
};

const ImageRenderer = ({
  artifact,
  labels,
  zoom,
  onSections,
  onRows,
  onRow,
  onMatches,
  control,
  commenting,
  notes,
  onOpenThread,
  onDrawAnchor,
}: RendererProps) => {
  // A box being drawn, from where the press started.
  const [drawing, setDrawing] = useState<{
    from: [number, number];
    box: Box;
  } | null>(null);
  const [natural, setNatural] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const svg = artifact.blob.type === "image/svg+xml";
  useEffect(() => {
    onRows(1);
    onSections([]);
    onMatches(0);
    onRow(0);
  }, [onRows, onSections, onMatches, onRow]);
  useImperativeHandle(control, () => ({ scrollToRow: stay }));
  // Zoomed: the image's own width times the zoom; an SVG's "own width" is the page's width.
  const most =
    svg || natural === null || natural === 0
      ? grasp.viewerPageWidth
      : `${natural}px`;
  const width =
    zoom === "fit" || natural === null ? null : `calc(${most} * ${zoom / 100})`;
  if (failed) {
    return (
      <Empty tone="danger">
        <EmptyHeader>
          <EmptyMedia />
          <EmptyTitle>{labels.notOpened}</EmptyTitle>
          <EmptyDescription>{labels.imageFailed}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div {...stylex.props(styles.box, width !== null && styles.wide)}>
      {/* With comments on, a drag on the image draws a box to comment on. */}
      <div
        data-slot="artifact-viewer-image"
        onPointerDown={
          commenting === true
            ? (event) => {
                if (
                  event.button !== 0 ||
                  (event.target instanceof Element &&
                    event.target.closest("[data-thread]") !== null)
                ) {
                  return;
                }
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                const from = at(event);
                setDrawing({ from, box: boxFrom(from, from) });
              }
            : undefined
        }
        onPointerMove={
          drawing
            ? (event) => {
                setDrawing({
                  from: drawing.from,
                  box: boxFrom(drawing.from, at(event)),
                });
              }
            : undefined
        }
        onPointerUp={
          drawing
            ? () => {
                // Too small to be meant: a click, not a box.
                if (drawing.box.w > 0.01 && drawing.box.h > 0.01) {
                  onDrawAnchor?.({ kind: "rect", ...drawing.box });
                }
                setDrawing(null);
              }
            : undefined
        }
        {...stylex.props(
          styles.frame,
          width === null ? styles.fit(most) : styles.sized(width),
          commenting === true && styles.drawable
        )}
      >
        <img
          src={artifact.url}
          alt={artifact.name}
          draggable={false}
          data-loading={natural === null ? "" : undefined}
          onLoad={(event) => {
            setNatural(event.currentTarget.naturalWidth);
          }}
          onError={() => {
            setFailed(true);
          }}
          {...stylex.props(styles.image, styles.whole)}
        />
        {(notes ?? []).map((note) =>
          note.anchor.kind === "rect" ? (
            <button
              key={note.id}
              type="button"
              data-thread={note.id}
              aria-label={labels.showBoxComment}
              onClick={() => onOpenThread?.(note.id)}
              {...stylex.props(
                styles.mark(note.anchor),
                styles.hit,
                note.active && styles.markActive
              )}
            />
          ) : null
        )}
        {drawing ? (
          <div
            aria-hidden="true"
            {...stylex.props(styles.mark(drawing.box), styles.markActive)}
          />
        ) : null}
      </div>
    </div>
  );
};

export default ImageRenderer;
