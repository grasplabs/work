import { useEffect, useRef } from "react";

import {
  bucketOf,
  dotAlpha,
  dotShare,
  palette,
  shimmerAt,
} from "../brain/dot-ink.ts";
import { makingLight } from "./making-dots.ts";
import { fieldOf, PITCH } from "./pile-dots.ts";

// A block while Grasp makes or changes its widget (making-dots.ts): its
// dots over it, a light crossing them, until the widget is there. Nothing
// is said here: the block says Grasp is making it, for a screen reader.

const TAU = Math.PI * 2;

/** How lit the dots are where the light isn't. */
const LIT = 0.35;

/** How warm the light makes a dot, 0 to 1. */
const WARMTH = 0.5;

/** Draws the dots on `element`, the light crossing them; returns how to stop. */
const playMaking = (element: HTMLCanvasElement): (() => void) => {
  const context = element.getContext("2d");
  if (context === null) {
    return () => {
      // Nothing was drawn.
    };
  }
  const box = element.getBoundingClientRect();
  // As sharp as the screen is dense, read when it is drawn.
  const sharp = Math.min(window.devicePixelRatio || 1, 2);
  element.width = Math.round(box.width * sharp);
  element.height = Math.round(box.height * sharp);
  context.setTransform(sharp, 0, 0, sharp, 0, 0);
  const styles = palette(element);
  const dots = fieldOf(box.width, box.height);
  // Still where the person asked for less motion: the dots, no light.
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let frame = 0;
  const draw = (ms: number) => {
    const now = ms / 1000;
    context.clearRect(0, 0, box.width, box.height);
    const lists = new Map<number, number[]>();
    for (const dot of dots) {
      const light = still ? 0 : makingLight(dot, box.width, now);
      const radius =
        PITCH * dotShare(dot.ink, false, dot.grain) * (1 + 0.3 * light);
      const alpha = Math.max(
        dotAlpha(dot.ink, LIT, false) * shimmerAt(dot.seed, now),
        0.6 * light
      );
      const bucket = bucketOf(alpha, WARMTH * light);
      if (bucket !== 0) {
        const list = lists.get(bucket) ?? [];
        lists.set(bucket, list);
        list.push(dot.x, dot.y, radius);
      }
    }
    for (const [bucket, list] of lists) {
      const style = styles[bucket];
      if (style !== undefined) {
        context.fillStyle = style;
        context.beginPath();
        for (let index = 0; index + 2 < list.length; index += 3) {
          const x = list[index] ?? 0;
          const y = list[index + 1] ?? 0;
          const radius = list[index + 2] ?? 0;
          context.moveTo(x + radius, y);
          context.arc(x, y, radius, 0, TAU);
        }
        context.fill();
      }
    }
    if (!still) {
      frame = requestAnimationFrame(draw);
    }
  };
  frame = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(frame);
  };
};

/** Dots over the block they stand in, while Grasp makes its widget. */
export const MakingDots = () => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    return element === null ? undefined : playMaking(element);
  }, []);
  return (
    <div
      aria-hidden="true"
      className="bg-card pointer-events-none absolute inset-0 z-10 rounded-xl"
    >
      <canvas className="size-full" ref={canvas} />
    </div>
  );
};
