import { media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import { bayerAt, readTones } from "./campaign/pixels.ts";
import type { Tone } from "./campaign/pixels.ts";
import type { PlanDay } from "./plan-drawing.tsx";

// The plan told as a story (plan-story.tsx) flies through one picture in
// the brand's pixels: the same squares, the people of the campaign, fly
// from one figure to the next as the story goes, and Stephen's light, the
// dithered glow, travels with them. Today it is you and him; then the few
// who know the work best; then the whole company; then they settle into
// the two weeks as the plan draws them (plan-drawing.tsx), on the same
// days; then what he learned, team by team, in the light; last one
// finding, a laptop waiting for its days. Each square takes its own path
// and its own moment, so the figure flows rather than jumps. Between the
// lines the picture stays alive: a few of the company talk, the light
// breathes. Under reduced motion the story is never told (the plan is
// shown summed up), and this draws each figure still. A picture only: the
// story's words say it all.

const styles = stylex.create({
  canvas: {
    display: { default: "block", [media.forcedColors]: "none" },
    width: "100%",
    height: { default: "11rem", [media.maxSm]: "9rem" },
    imageRendering: "pixelated",
  },
});

/** The figures of the story, in its order. */
export type Scene =
  | "today"
  | "first"
  | "everyone"
  | "close"
  | "learned"
  | "finding";

/** One square, in cells: where, how large, in what tone, how much of it shows. */
interface Dot {
  x: number;
  y: number;
  side: number;
  tone: Tone;
  alpha: number;
}

/** Stephen's light: its middle and reach in cells, and how much of it shows. */
interface Light {
  x: number;
  y: number;
  r: number;
  strength: number;
}

interface Grid {
  columns: number;
  rows: number;
}

interface Figure {
  dots: Dot[];
  light: Light;
}

type Put = (x: number, y: number, tone: Tone, alpha: number) => void;

/** How long a figure takes to become the next, in ms: each square within it in its own moment. */
const FLY_MS = 1400;

/** A number from 0 to 1 that belongs to `n`: the same on every frame. */
const hash = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43_758.5453;
  return s - Math.floor(s);
};

const ease = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

const clamp = (t: number): number => Math.min(1, Math.max(0, t));

/** A person's side in cells: five, four where the drawing is narrow (a phone). */
const sideOf = ({ columns }: Grid): number => (columns < 150 ? 4 : 5);

/** The drawing's cell: three pixels, two on a phone. */
const cellFor = (width: number): number => (width < 400 ? 2 : 3);

/** Not there: folded into the light. */
const tucked = (light: Light): Dot => ({
  x: light.x,
  y: light.y,
  side: 1,
  tone: "foreground",
  alpha: 0,
});

/** Today: you, beside Stephen's light. */
const todayFigure = (grid: Grid, count: number): Figure => {
  const side = sideOf(grid);
  const light = {
    x: Math.round(grid.columns * 0.46),
    y: Math.round(grid.rows * 0.52),
    r: grid.rows * 0.42,
    strength: 0.9,
  };
  const you: Dot = {
    x: Math.round(grid.columns * 0.54),
    y: Math.round(grid.rows * 0.52 - side / 2),
    side,
    tone: "foreground",
    alpha: 1,
  };
  return {
    light,
    dots: Array.from({ length: count }, (_, at) =>
      at === 0 ? you : tucked(light)
    ),
  };
};

/** The first few, the people who know the work best, in a row before the light. */
const firstFigure = (grid: Grid, count: number): Figure => {
  const side = sideOf(grid);
  const light = {
    x: Math.round(grid.columns * 0.32),
    y: Math.round(grid.rows * 0.52),
    r: grid.rows * 0.46,
    strength: 0.85,
  };
  const lift = [1, -2, 0];
  return {
    light,
    dots: Array.from({ length: count }, (_, at) =>
      at < 3
        ? {
            x: Math.round(grid.columns * 0.5) + at * (side + 5),
            y: Math.round(grid.rows * 0.52 - side / 2) + (lift[at] ?? 0),
            side,
            tone: "foreground",
            alpha: 1,
          }
        : tucked(light)
    ),
  };
};

/** The whole company, a loose crowd around the light. */
const everyoneFigure = (grid: Grid, count: number): Figure => {
  const side = sideOf(grid);
  const across = side + 4;
  const down = side + 3;
  const lines = Math.max(
    2,
    Math.min(5, Math.floor((grid.rows - 8) / down), Math.ceil(count / 9))
  );
  const perLine = Math.ceil(count / lines);
  const width = perLine * across;
  const left = Math.round((grid.columns - width) / 2);
  const top = Math.round((grid.rows - lines * down) / 2);
  return {
    light: {
      x: Math.round(grid.columns / 2),
      y: Math.round(grid.rows / 2),
      r: grid.rows * 0.62,
      strength: 0.7,
    },
    dots: Array.from({ length: count }, (_, at) => {
      const line = Math.floor(at / perLine);
      const place = at % perLine;
      // The lines staggered like bricks, each square a cell or so off its place: people, not a table.
      return {
        x:
          left +
          place * across +
          (line % 2) * Math.round(across / 2) +
          Math.round((hash(at) - 0.5) * 3),
        y: top + line * down + Math.round((hash(at + 99) - 0.5) * 2),
        side,
        tone: "foreground",
        alpha: 1,
      };
    }),
  };
};

/** The two weeks as the plan draws them: every day a column, the people who talk piled on theirs. */
const closeFigure = (grid: Grid, count: number, days: readonly PlanDay[]) => {
  const dayWidth = grid.columns / days.length;
  const side = dayWidth < 16 ? 4 : 5;
  const pitch = side + 1;
  const pile = 2 * pitch - 1;
  const ground = grid.rows - 2;
  const slots: Dot[] = [];
  for (const [index, day] of days.entries()) {
    if (day.kind === "talks") {
      const left = Math.floor(index * dayWidth + (dayWidth - pile) / 2);
      const foot = ground - side - 1;
      for (let at = 0; at < Math.min(day.count, 8); at += 1) {
        slots.push({
          x: left + (at % 2) * pitch,
          y: foot - Math.floor(at / 2) * pitch,
          side,
          tone: "foreground",
          alpha: 1,
        });
      }
    }
  }
  const light = {
    x: Math.round(dayWidth / 2),
    y: ground,
    r: grid.rows * 0.55,
    strength: 0.8,
  };
  return {
    light,
    dots: Array.from({ length: count }, (_, at) => slots[at] ?? tucked(light)),
  };
};

/** The share of what he learned that each team holds: four teams, largest first. */
const teams = [0.34, 0.28, 0.22, 0.16];

/** What he learned, team by team: a pile of the light for each. */
const learnedFigure = (grid: Grid, count: number): Figure => {
  const side = sideOf(grid);
  const pitch = side + 1;
  const ground = grid.rows - 2;
  const gap = Math.max(pitch * 5, Math.round(grid.columns * 0.15));
  // Which team each square joins: by the teams' shares, in order.
  let team = 0;
  let inTeam = 0;
  let upTo = (teams[0] ?? 1) * count;
  return {
    light: {
      x: Math.round(grid.columns / 2),
      y: ground,
      r: grid.rows * 0.8,
      strength: 0.75,
    },
    dots: Array.from({ length: count }, (_, at) => {
      while (at >= upTo && team < teams.length - 1) {
        team += 1;
        inTeam = 0;
        upTo += (teams[team] ?? 0) * count;
      }
      const middle = grid.columns / 2 + (team - 1.5) * gap;
      const dot: Dot = {
        x: Math.round(middle - pitch * 1.5) + (inTeam % 3) * pitch,
        y: ground - side - 1 - Math.floor(inTeam / 3) * pitch,
        side,
        tone: "mint",
        alpha: 1,
      };
      inTeam += 1;
      return dot;
    }),
  };
};

/** The laptop a finding is about: its screen and its base, as cells. */
const laptopOf = (grid: Grid) => {
  const width = Math.round(Math.min(grid.columns * 0.34, 70));
  const height = Math.round(width * 0.58);
  const left = Math.round((grid.columns - width) / 2);
  const top = Math.round((grid.rows - height - 5) / 2);
  return { left, top, width, height, base: top + height + 3 };
};

/** One finding: the squares trace a laptop, waiting for its days. */
const findingFigure = (grid: Grid, count: number): Figure => {
  const { left, top, width, height, base } = laptopOf(grid);
  // The screen's edge, round, then the base beneath it, wider: one path.
  const sides: [number, number, number, number][] = [
    [left, top, left + width, top],
    [left + width, top, left + width, top + height],
    [left + width, top + height, left, top + height],
    [left, top + height, left, top],
    [left - 6, base, left + width + 6, base],
  ];
  const lengths = sides.map(([x0, y0, x1, y1]) => Math.hypot(x1 - x0, y1 - y0));
  const total = lengths.reduce((sum, each) => sum + each, 0);
  return {
    light: {
      x: Math.round(grid.columns / 2),
      y: Math.round(top + height / 2),
      r: grid.rows * 0.5,
      strength: 0.55,
    },
    dots: Array.from({ length: count }, (_, at) => {
      let along = (at / count) * total;
      let side = 0;
      while (side < sides.length - 1 && along > (lengths[side] ?? 0)) {
        along -= lengths[side] ?? 0;
        side += 1;
      }
      const [x0, y0, x1, y1] = sides[side] ?? [0, 0, 0, 0];
      const part = along / Math.max(lengths[side] ?? 1, 1);
      return {
        x: Math.round(x0 + (x1 - x0) * part - 1),
        y: Math.round(y0 + (y1 - y0) * part - 1),
        side: 2,
        tone: "foreground",
        alpha: 1,
      };
    }),
  };
};

const figureOf = (
  scene: Scene,
  grid: Grid,
  count: number,
  days: readonly PlanDay[]
): Figure => {
  const figures: Record<Scene, () => Figure> = {
    today: () => todayFigure(grid, count),
    first: () => firstFigure(grid, count),
    everyone: () => everyoneFigure(grid, count),
    close: () => closeFigure(grid, count, days),
    learned: () => learnedFigure(grid, count),
    finding: () => findingFigure(grid, count),
  };
  return figures[scene]();
};

/** Stephen's light: the brand's dither, sea at its edge and mint at its heart, breathing. */
const drawLight = (put: Put, grid: Grid, light: Light, time: number) => {
  const { x, y, r, strength } = light;
  const breath = 1 + 0.07 * Math.sin(time * 1.3);
  const wide = r * 1.7;
  for (let cx = Math.floor(x - wide); cx <= x + wide; cx += 1) {
    for (let cy = Math.floor(y - r); cy <= y + r; cy += 1) {
      if (cx >= 0 && cy >= 0 && cx < grid.columns && cy < grid.rows) {
        const away = Math.hypot((cx - x) / wide, (cy - y) / r);
        const near = Math.max(0, 1 - away);
        const much = 0.55 * near ** 1.5 * strength * breath;
        const threshold = bayerAt(cx, cy);
        if (threshold < much) {
          put(cx, cy, threshold < much * 0.35 ? "mint" : "sea", 1);
        }
      }
    }
  }
};

/** What stands behind a figure besides the light: the days' dotted ground, the screen of the laptop. */
const drawGround = (
  put: Put,
  grid: Grid,
  scene: Scene,
  days: readonly PlanDay[],
  alpha: number,
  time: number
) => {
  if (alpha <= 0) {
    return;
  }
  const ground = grid.rows - 2;
  if (scene === "close") {
    const dayWidth = grid.columns / days.length;
    for (const [index] of days.entries()) {
      const start = Math.floor(index * dayWidth);
      const end = Math.floor((index + 1) * dayWidth);
      for (let x = start + 2; x < end - 2; x += 2) {
        put(x, ground, "border", alpha);
      }
    }
  } else if (scene === "learned") {
    for (let x = 2; x < grid.columns - 2; x += 2) {
      put(x, ground, "border", alpha);
    }
  } else if (scene === "finding") {
    // The screen, faintly lit, and on it the days the laptop is waited for: one, two, three, again.
    const { left, top, width, height, base } = laptopOf(grid);
    // The base, one solid line under the screen, wider than it.
    for (let x = left - 6; x < left + width + 8; x += 1) {
      put(x, base, "foreground", alpha);
      put(x, base + 1, "foreground", alpha * 0.5);
    }
    for (let x = left + 2; x < left + width - 2; x += 1) {
      for (let y = top + 2; y < top + height - 2; y += 1) {
        if (bayerAt(x, y) < 0.08) {
          put(x, y, "sea", alpha);
        }
      }
    }
    const waited = Math.floor(time * 1.2) % 4;
    const block = 4;
    const middle = left + width / 2;
    for (let day = 0; day < 3; day += 1) {
      const x0 = Math.round(middle + (day - 1) * (block + 3) - block / 2);
      const y0 = Math.round(top + height / 2 - block / 2);
      const tone: Tone = day < waited ? "mint" : "border";
      for (let dx = 0; dx < block; dx += 1) {
        for (let dy = 0; dy < block; dy += 1) {
          put(x0 + dx, y0 + dy, tone, alpha);
        }
      }
    }
  }
};

/** A few of the company talk between the lines: a square hops a cell, now and then. */
const hopOf = (scene: Scene, at: number, time: number): number => {
  if (scene !== "everyone" && scene !== "first") {
    return 0;
  }
  return Math.sin(time * 2.1 + at * 1.7) > 0.93 ? -1 : 0;
};

export const PlanFlight = ({
  scene,
  days,
}: {
  scene: Scene;
  /** What each day from today to the findings holds, as the plan has it. */
  days: readonly PlanDay[];
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wanted = useRef(scene);
  useEffect(() => {
    wanted.current = scene;
  }, [scene]);
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
    // Everyone who talks, and never fewer than make a laptop.
    const count = Math.max(
      24,
      days.reduce((sum, day) => sum + Math.min(day.count, 8), 0)
    );
    // Where the figure flies from, where to, and since when.
    let shown: Scene = wanted.current;
    let previous: Scene = shown;
    let from: Figure | null = null;
    let since = performance.now();
    let frame = 0;
    // Where every square stands right now, so a figure asked for mid-flight flies on from there.
    let latest: { from: Figure | null; whole: number } | null = null;
    const current = (grid: Grid): Figure => {
      const figure = figureOf(shown, grid, count, days);
      if (latest === null || latest.from === null || latest.whole >= 1) {
        return figure;
      }
      const { from: was, whole } = latest;
      return {
        light: figure.light,
        dots: figure.dots.map((target, at) => {
          const origin = was.dots[at] ?? target;
          const part = ease(clamp((whole - hash(at + 7) * 0.4) / 0.6));
          return {
            ...target,
            x: origin.x + (target.x - origin.x) * part,
            y: origin.y + (target.y - origin.y) * part,
            side: origin.side + (target.side - origin.side) * part,
            alpha: origin.alpha + (target.alpha - origin.alpha) * part,
            tone: part < 0.5 ? origin.tone : target.tone,
          };
        }),
      };
    };
    const paint = (now: number) => {
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
      const cell = cellFor(width);
      const grid = {
        columns: Math.floor(width / cell),
        rows: Math.floor(height / cell),
      };
      const offset = (width - grid.columns * cell) / 2;
      const put: Put = (x, y, tone, alpha) => {
        if (x < 0 || y < 0 || x >= grid.columns || y >= grid.rows) {
          return;
        }
        context.globalAlpha = alpha;
        context.fillStyle = tones[tone];
        context.fillRect(offset + x * cell, y * cell, cell, cell);
      };
      const time = now / 1000;
      if (wanted.current !== shown) {
        // A new figure: it flies from wherever the squares are now.
        from = current(grid);
        previous = shown;
        shown = wanted.current;
        since = now;
      }
      const to = figureOf(shown, grid, count, days);
      const elapsed = still.matches ? FLY_MS : now - since;
      const whole = clamp(elapsed / FLY_MS);
      const start = from ?? to;
      const light = {
        x: start.light.x + (to.light.x - start.light.x) * ease(whole),
        y: start.light.y + (to.light.y - start.light.y) * ease(whole),
        r: start.light.r + (to.light.r - start.light.r) * ease(whole),
        strength:
          start.light.strength +
          (to.light.strength - start.light.strength) * ease(whole),
      };
      drawLight(put, grid, light, still.matches ? 0 : time);
      if (from !== null && whole < 1) {
        drawGround(put, grid, previous, days, 1 - whole, time);
      }
      drawGround(put, grid, shown, days, whole, still.matches ? 3 : time);
      for (const [at, target] of to.dots.entries()) {
        const origin = start.dots[at] ?? target;
        // Each square leaves in its own moment and flies a little arc of its own.
        const delay = hash(at + 7) * 0.4;
        const part = ease(clamp((whole - delay) / 0.6));
        const arc = Math.sin(Math.PI * part) * (4 + hash(at + 31) * 8);
        const dot: Dot = {
          x: origin.x + (target.x - origin.x) * part,
          y: origin.y + (target.y - origin.y) * part - arc,
          side: origin.side + (target.side - origin.side) * part,
          tone: part < 0.5 ? origin.tone : target.tone,
          alpha: origin.alpha + (target.alpha - origin.alpha) * part,
        };
        if (dot.alpha > 0.02) {
          const side = Math.max(1, Math.round(dot.side));
          const x = Math.round(dot.x);
          const y =
            Math.round(dot.y) +
            (part === 1 && !still.matches ? hopOf(shown, at, time) : 0);
          context.globalAlpha = dot.alpha;
          context.fillStyle = tones[dot.tone];
          context.fillRect(
            offset + x * cell,
            y * cell,
            side * cell,
            side * cell
          );
        }
      }
      context.globalAlpha = 1;
      if (whole === 1) {
        from = null;
      }
      latest = { from, whole };
    };
    const step = (now: number) => {
      paint(now);
      frame = still.matches ? 0 : requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    const repaint = () => {
      tones = readTones(element);
      if (still.matches) {
        paint(performance.now());
      }
    };
    // Under reduced motion it is drawn once per figure; the story asks again when it changes.
    const asked = window.setInterval(() => {
      if (still.matches && wanted.current !== shown) {
        paint(performance.now());
      }
    }, 200);
    const resized = new ResizeObserver(repaint);
    resized.observe(element);
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
      window.clearInterval(asked);
      cancelAnimationFrame(frame);
    };
  }, [days]);
  return (
    <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.canvas)} />
  );
};
