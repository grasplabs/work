import { useEffect, useRef } from "react";

import { bucketOf, DOT_MOST, dotShare, palette } from "../brain/dot-ink.ts";
import { useLessMotion } from "../brain/less-motion.ts";
import { seeded } from "../brain/reveal-motion.ts";

// Sound as a wave of dots, flowing (prototype `voice-wave.tsx`): the same
// print the interviewer is made of. It follows whoever talks, as loud as
// they are: the interviewer in ink, the person warm, by the microphone.
// With nobody talking it is a quiet line that breathes. Still for people
// who ask for less motion. Decorative: what it shows is said in words
// beside it.

const tau = Math.PI * 2;
/** The distance between neighbouring dots, in pixels. */
const pitch = 6;
/** How warm the wave is while the person talks. */
const warmth = 0.6;
/** How much of a wave there is when nobody makes a sound, so it is seen to be alive. */
const atRest = 0.07;

/** Whose sound the wave shows: the person's, the interviewer's, or nobody's. */
export type WaveOf = "person" | "interviewer" | "quiet";

interface Wave {
  of: WaveOf;
  level: () => number;
  still: boolean;
}

/** As wide and high as its box, and as sharp as the screen is dense. */
const fitted = (
  element: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  was: { width: number; height: number; sharp: number }
): { width: number; height: number; sharp: number } => {
  const box = element.getBoundingClientRect();
  const sharp = Math.min(window.devicePixelRatio || 1, 2);
  if (
    box.width === was.width &&
    box.height === was.height &&
    sharp === was.sharp
  ) {
    return was;
  }
  element.width = Math.round(box.width * sharp);
  element.height = Math.round(box.height * sharp);
  context.setTransform(sharp, 0, 0, sharp, 0, 0);
  return { width: box.width, height: box.height, sharp };
};

/** A frame of the wave: its box, the time, how loud and how warm, and whether it moves. */
interface Frame {
  width: number;
  height: number;
  now: number;
  amount: number;
  warm: number;
  still: boolean;
}

/** One frame's dots, by colour: each one's x, y and radius, one after the other. */
const gather = (
  { width, height, now, amount, warm, still }: Frame,
  grain: Float32Array,
  lists: Map<number, number[]>
): void => {
  // An odd number of rows, centred, so the line at rest runs through one row of dots.
  const fits = Math.floor(height / pitch);
  const rows = Math.max(1, fits - (fits % 2 === 0 ? 1 : 0));
  const columns = Math.floor(width / pitch);
  const top = (height - rows * pitch) / 2;
  const left = (width - columns * pitch) / 2;
  const middle = height / 2;
  const reach = middle - pitch * 0.75;
  const thick = pitch * (0.75 + 0.9 * amount);
  for (const list of lists.values()) {
    list.length = 0;
  }
  for (let row = 0; row < rows; row += 1) {
    const y = top + (row + 0.5) * pitch;
    const shift = row % 2 === 0 ? 0 : pitch / 2;
    for (let column = 0; column < columns; column += 1) {
      const x = left + (column + 0.5) * pitch + shift;
      // The line is pinned at both ends and swings most in the middle; it flows to the right.
      const span =
        Math.sin(Math.PI * Math.min(1, Math.max(0, x / width))) ** 0.6;
      const flow = still
        ? 0
        : 0.62 * Math.sin(x / 29 - now * 2.6) +
          0.38 * Math.sin(x / 15.5 + now * 3.9 + 1.3);
      const at = middle + reach * amount * span * flow;
      const ink = Math.max(0, 1 - Math.abs(y - at) / thick);
      const bucket = bucketOf((0.25 + 0.7 * ink) * span ** 0.5, warm);
      if (x <= width && ink > 0.02 && bucket !== 0) {
        const own = grain[(row * 131 + column) % grain.length] ?? 0;
        const share = dotShare(ink, true, own);
        const radius = pitch * Math.min(DOT_MOST, share * (0.55 + 0.75 * ink));
        const list = lists.get(bucket) ?? [];
        lists.set(bucket, list);
        list.push(x, y, radius);
      }
    }
  }
};

/** Prints a frame's dots, a fill per colour. */
const paint = (
  context: CanvasRenderingContext2D,
  lists: Map<number, number[]>,
  styles: string[],
  { width, height }: { width: number; height: number }
): void => {
  context.clearRect(0, 0, width, height);
  for (const [bucket, list] of lists) {
    if (list.length > 0) {
      context.fillStyle = styles[bucket] ?? "transparent";
      context.beginPath();
      for (let index = 0; index < list.length; index += 3) {
        const dotX = list[index] ?? 0;
        const dotY = list[index + 1] ?? 0;
        const radius = list[index + 2] ?? 0;
        context.moveTo(dotX + radius, dotY);
        context.arc(dotX, dotY, radius, 0, tau);
      }
      context.fill();
    }
  }
};

/** Draws the wave, frame by frame, until stopped. */
const animate = (
  element: HTMLCanvasElement,
  live: { current: Wave }
): (() => void) => {
  const context = element.getContext("2d");
  if (context === null) {
    return () => {
      // Nothing to draw on.
    };
  }
  let styles = palette(element);
  // Each dot has a grain of its own, the same every time, so the wave prints unevenly, like ink.
  const random = seeded(23);
  const grain = Float32Array.from({ length: 4096 }, () => random() ** 2);
  let box = { width: 0, height: 0, sharp: 0 };
  // How loud and how warm, eased, so it flows instead of flickering.
  let loud = 0;
  let warm = 0;
  const lists = new Map<number, number[]>();

  const draw = (now: number): void => {
    box = fitted(element, context, box);
    const { width, height } = box;
    if (width === 0 || height === 0) {
      return;
    }
    const { of, level, still } = live.current;
    const heard = of === "quiet" ? 0 : level();
    // Quick to rise with a voice, slow to fall.
    let ease = heard > loud ? 0.35 : 0.07;
    if (still) {
      ease = 1;
    }
    loud += (heard - loud) * ease;
    warm += ((of === "person" ? warmth : 0) - warm) * (still ? 1 : 0.12);
    const amount = Math.min(1, atRest + loud * 1.25);
    gather({ width, height, now, amount, warm, still }, grain, lists);
    paint(context, lists, styles, box);
  };

  let frame = 0;
  const run = (ms: number): void => {
    frame = requestAnimationFrame(run);
    draw(ms / 1000);
  };
  frame = requestAnimationFrame(run);
  // It prints in the brain's colours, which change with the theme.
  const themes = new MutationObserver(() => {
    styles = palette(element);
  });
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });
  return () => {
    cancelAnimationFrame(frame);
    themes.disconnect();
  };
};

/** The wave of `of`'s sound, as loud as `level` says, filling its box. */
export const VoiceWave = ({
  of,
  level,
}: {
  of: WaveOf;
  level: () => number;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const still = useLessMotion();
  const live = useRef<Wave>({ of, level, still });
  useEffect(() => {
    live.current = { of, level, still };
  });
  useEffect(() => {
    const element = canvas.current;
    return element === null ? undefined : animate(element, live);
  }, []);
  return (
    <canvas
      aria-hidden="true"
      className="pointer-events-none block size-full"
      ref={canvas}
    />
  );
};
