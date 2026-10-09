import { useEffect, useRef } from "react";

import {
  bucketOf,
  dotAlpha,
  dotShare,
  palette,
  shimmerAt,
} from "../brain/dot-ink.ts";
import { dotAt, FAREWELL_ENDS, fieldOf, PITCH } from "./pile-dots.ts";
import type { Printed } from "./pile-dots.ts";

// The last card of the pile, leaving, as the prototype draws it
// (`components/dashboard/todo-dots.tsx`): it stands for a moment as dots,
// in the brain's own print (`brain/dot-ink.ts`), in ink where its name and
// its buttons stood, and a wave from the left carries them off, warm where
// they let go. Nothing is said: that the pile is done is said beside it,
// for a screen reader.

const TAU = Math.PI * 2;

/** How lit the card's dots are: it is flat, so all the same. */
const LIT = 0.6;

/** The room around the card the dots drift into, in pixels: the canvas is this much larger on every side (`-inset-10`). */
const ROOM = 40;

/** How warm a dot gets as it lets go, 0 to 1: a glow at the wave's edge, not a fire. */
const WARMTH = 0.55;

/** Prints dots, listed by colour as x, y and radius: one path per colour, as the brain is drawn. */
const print = (
  context: CanvasRenderingContext2D,
  styles: readonly string[],
  lists: ReadonlyMap<number, number[]>
): void => {
  for (const [bucket, list] of lists) {
    const style = styles[bucket];
    if (list.length > 0 && style !== undefined) {
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
};

/**
 * Plays the farewell on `element`, a canvas `ROOM` larger than the card on
 * every side; `onGone` follows once the last dot is gone. Returns how to
 * stop it.
 */
const playFarewell = (
  element: HTMLCanvasElement,
  printed: readonly Printed[],
  onGone: () => void
): (() => void) => {
  const context = element.getContext("2d");
  if (context === null) {
    onGone();
    return () => {
      // Nothing was drawn.
    };
  }
  const box = element.getBoundingClientRect();
  const width = box.width - 2 * ROOM;
  const height = box.height - 2 * ROOM;
  // As sharp as the screen is dense, read when it is drawn.
  const sharp = Math.min(window.devicePixelRatio || 1, 2);
  element.width = Math.round(box.width * sharp);
  element.height = Math.round(box.height * sharp);
  context.setTransform(sharp, 0, 0, sharp, ROOM * sharp, ROOM * sharp);
  const styles = palette(element);
  const dots = fieldOf(width, height, printed);
  const lists = new Map<number, number[]>();
  let began: number | undefined;
  let frame = 0;
  const draw = (ms: number) => {
    const now = ms / 1000;
    began ??= now;
    const at = now - began;
    context.clearRect(-ROOM, -ROOM, box.width, box.height);
    if (at >= FAREWELL_ENDS) {
      onGone();
      return;
    }
    frame = requestAnimationFrame(draw);
    for (const list of lists.values()) {
      list.length = 0;
    }
    for (const dot of dots) {
      const state = dotAt(dot, width, at);
      // A dot shrinks as it goes, and swells a little while it is warm.
      const radius =
        PITCH *
        dotShare(dot.ink, dot.inked, dot.grain) *
        (0.4 + 0.6 * state.there) *
        (1 + 0.35 * state.heat);
      const alpha =
        Math.max(
          dotAlpha(dot.ink, LIT, dot.inked) * shimmerAt(dot.seed, now),
          0.45 * state.heat
        ) * state.there;
      const bucket = bucketOf(alpha, WARMTH * state.heat);
      if (state.there >= 0.01 && bucket !== 0) {
        const list = lists.get(bucket) ?? [];
        lists.set(bucket, list);
        list.push(dot.x + state.dx, dot.y + state.dy, radius);
      }
    }
    print(context, styles, lists);
  };
  frame = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(frame);
  };
};

/** The last card's dots, over the room it stood in; `onGone` once they are gone. */
export const PileFarewell = ({
  printed,
  onGone,
}: {
  printed: readonly Printed[];
  onGone: () => void;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ printed, onGone });
  useEffect(() => {
    latest.current = { printed, onGone };
  });
  // Played once, with the card as it stood.
  useEffect(() => {
    const element = canvas.current;
    return element === null
      ? undefined
      : playFarewell(element, latest.current.printed, () => {
          latest.current.onGone();
        });
  }, []);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute -inset-10">
      <canvas className="size-full" ref={canvas} />
    </div>
  );
};
