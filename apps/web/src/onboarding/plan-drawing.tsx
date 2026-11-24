import { media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import { bayerAt, readTones } from "./campaign/pixels.ts";
import type { Tone } from "./campaign/pixels.ts";

// The plan's two weeks as a drawing, in the pixels the campaign page later
// draws each team's week in (campaign/week-drawing.tsx): a column for
// every day from today to the findings, on a dotted ground. The people who
// will talk are squares piled on their day, a few at first, the whole
// company after; weekends stay empty, as they will. After the interviews a
// haze where Stephen reads, and on the last day what he learned, a block
// of the light. Today stands in the light, as it does on the campaign page.
// It grows in once, day after day; a moment of the plan under the pointer
// lights its own days and lets the others rest. Under reduced motion it is
// drawn once, still. A picture only: the plan's rows say it in words.

const styles = stylex.create({
  canvas: {
    display: { default: "block", [media.forcedColors]: "none" },
    width: "100%",
    height: "6rem",
    imageRendering: "pixelated",
  },
});

/** What a day holds. */
type Kind = "quiet" | "talks" | "reads" | "findings";

export interface PlanDay {
  kind: Kind;
  /** How many squares stand on it: people who talk. */
  count: number;
}

/** A day's squares pile two wide and up to four high, a cell apart: the campaign page's piles. */
const WIDE = 2;
const HIGH = 4;

/** A square's side in cells: five, four where a day is narrow (a phone). */
const sideFor = (dayWidth: number): number => (dayWidth < 16 ? 4 : 5);

/** The drawing's cell: three pixels, two on a phone. */
const cellFor = (width: number): number => (width < 400 ? 2 : 3);

/** How long the days take to grow in, all of them, in ms. */
const GROW_MS = 300;

/** How much of itself a day keeps while another is lit. */
const RESTING = 0.28;

/** Eased in and out, 0 to 1. */
const ease = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

interface Paint {
  columns: number;
  rows: number;
  put: (x: number, y: number, tone: Tone, alpha: number) => void;
}

/** Where a day's picture stands in its column, in cells. */
interface Spot {
  put: Paint["put"];
  left: number;
  ground: number;
  side: number;
  pitch: number;
  pile: number;
  rows: number;
  grown: number;
  alpha: number;
}

/** Today in the light: the brand's dither, thickest at the ground. */
const drawToday = ({ put, left, ground, pile, rows, grown, alpha }: Spot) => {
  for (let x = left - 3; x < left + pile + 3; x += 1) {
    for (let y = 0; y <= ground; y += 1) {
      const near = 1 - (ground - y) / rows;
      if (bayerAt(x, rows - y) < (0.06 + 0.22 * near * near) * grown) {
        put(x, y, "sea", alpha);
      }
    }
  }
};

/** The people who talk: squares piled two wide from the foot up. */
const drawTalks = (spot: Spot, count: number) => {
  const { put, left, ground, side, pitch, grown, alpha } = spot;
  const foot = ground - side - 1;
  const shown = Math.round(Math.min(count, WIDE * HIGH) * grown);
  for (let i = 0; i < shown; i += 1) {
    const x = left + (i % WIDE) * pitch;
    const y = foot - Math.floor(i / WIDE) * pitch;
    for (let dx = 0; dx < side; dx += 1) {
      for (let dy = 0; dy < side; dy += 1) {
        put(x + dx, y + dy, "foreground", alpha);
      }
    }
  }
};

/** Stephen reading: a haze over the ground, thin at the top. */
const drawReads = ({ put, left, ground, pitch, pile, grown, alpha }: Spot) => {
  const height = Math.round(HIGH * pitch * grown);
  for (let x = left; x < left + pile; x += 1) {
    for (let y = ground - height; y < ground; y += 1) {
      const low = (ground - y) / (HIGH * pitch);
      if (bayerAt(x, y) < 0.42 * (1 - low) ** 1.4) {
        put(x, y, "mint", alpha);
      }
    }
  }
};

/** What he learned: a block of the light, its glow rising over it. */
const drawFindings = (spot: Spot) => {
  const { put, left, ground, pitch, pile, grown, alpha } = spot;
  const height = Math.round(HIGH * pitch * grown);
  const block = Math.round(height * 0.6);
  for (let x = left; x < left + pile; x += 1) {
    for (let y = ground - block; y < ground; y += 1) {
      put(x, y, bayerAt(x, y) < 0.18 ? "sea" : "mint", alpha);
    }
  }
  const glow = height - block + 6;
  for (let x = left - 2; x < left + pile + 2; x += 1) {
    const beside = x < left || x >= left + pile;
    for (let y = ground - height - 6; y < ground - block; y += 1) {
      const above = (ground - block - y) / glow;
      const much = beside ? 0.12 * (1 - above) : 0.6 * (1 - above) ** 1.3;
      if (bayerAt(x, y) < much) {
        put(x, y, "mint", alpha);
      }
    }
  }
};

/** One day's picture in its column, `grown` 0 to 1, at `alpha`. */
const drawDay = (
  { rows, put }: Paint,
  day: PlanDay,
  geometry: { start: number; end: number; width: number },
  { today, grown, alpha }: { today: boolean; grown: number; alpha: number }
) => {
  const { start, end, width } = geometry;
  const side = sideFor(width);
  const pitch = side + 1;
  const pile = WIDE * pitch - 1;
  // The ground a cell above the drawing's foot, the light rising over the piles.
  const ground = rows - 2;
  const left = Math.floor(start + (width - pile) / 2);
  const spot: Spot = {
    put,
    left,
    ground,
    side,
    pitch,
    pile,
    rows,
    grown,
    alpha,
  };
  if (today) {
    drawToday(spot);
  }
  // Every day is still to come: a dotted ground.
  for (let x = start + 2; x < end - 2; x += 2) {
    put(x, ground, "border", alpha);
  }
  if (day.kind === "talks") {
    drawTalks(spot, day.count);
  } else if (day.kind === "reads") {
    drawReads(spot);
  } else if (day.kind === "findings") {
    drawFindings(spot);
  }
};

export const PlanDrawing = ({
  days,
  lit,
}: {
  days: readonly PlanDay[];
  /** The days of the moment under the pointer, from 0, first and last; null for none. */
  lit: readonly [number, number] | null;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wanted = useRef<readonly [number, number] | null>(lit);
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element === null || context === null || context === undefined) {
      return () => {
        // Nothing drawn.
      };
    }
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    let tones = readTones(element);
    const begun = performance.now();
    // Each day's share of the light: all of it at rest, less while another is lit.
    const shares = days.map(() => 1);
    let frame = 0;
    let last = begun;
    const paint = (now: number): boolean => {
      const { width, height } = element.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      const wide = Math.round(width * ratio);
      const high = Math.round(height * ratio);
      if (element.width !== wide || element.height !== high) {
        element.width = wide;
        element.height = high;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const size = cellFor(width);
      const columns = Math.floor(width / size);
      const rows = Math.floor(height / size);
      const offset = (width - columns * size) / 2;
      const put: Paint["put"] = (x, y, tone, alpha) => {
        if (x < 0 || y < 0 || x >= columns || y >= rows) {
          return;
        }
        context.globalAlpha = alpha;
        context.fillStyle = tones[tone];
        context.fillRect(offset + x * size, y * size, size, size);
      };
      const dayWidth = columns / days.length;
      const elapsed = Math.min(now - last, 64);
      last = now;
      let settled = true;
      for (const [index, day] of days.entries()) {
        // Day after day: each starts a little after the one before.
        const delay = (index / days.length) * GROW_MS * 0.5;
        const grown = still.matches
          ? 1
          : ease(
              Math.min(1, Math.max(0, (now - begun - delay) / (GROW_MS * 0.5)))
            );
        const lighted = wanted.current;
        const target =
          lighted === null || (index >= lighted[0] && index <= lighted[1])
            ? 1
            : RESTING;
        const share = still.matches
          ? target
          : target + ((shares[index] ?? 1) - target) * 0.5 ** (elapsed / 40);
        shares[index] = Math.abs(share - target) < 0.01 ? target : share;
        if (grown < 1 || shares[index] !== target) {
          settled = false;
        }
        drawDay(
          { columns, rows, put },
          day,
          {
            start: Math.floor(index * dayWidth),
            end: Math.floor((index + 1) * dayWidth),
            width: dayWidth,
          },
          { today: index === 0, grown, alpha: shares[index] ?? 1 }
        );
      }
      context.globalAlpha = 1;
      return settled;
    };
    const step = (now: number) => {
      frame = paint(now) ? 0 : requestAnimationFrame(step);
    };
    wake.current = () => {
      if (frame === 0) {
        last = performance.now();
        frame = requestAnimationFrame(step);
      }
    };
    const repaint = () => {
      tones = readTones(element);
      paint(performance.now());
    };
    wake.current();
    const resized = new ResizeObserver(repaint);
    resized.observe(element);
    // Light or dark: its colours read again.
    const modes = new MutationObserver(repaint);
    modes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-mode"],
    });
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", repaint);
    return () => {
      resized.disconnect();
      modes.disconnect();
      scheme.removeEventListener("change", repaint);
      cancelAnimationFrame(frame);
      wake.current = null;
    };
  }, [days]);
  useEffect(() => {
    wanted.current = lit;
    wake.current?.();
  }, [lit]);
  return (
    <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.canvas)} />
  );
};
