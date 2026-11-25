import { media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import { bayerAt, readTones } from "./campaign/pixels.ts";
import type { Tone } from "./campaign/pixels.ts";
import type { PlanDay } from "./plan-drawing.tsx";

// The plan's story (plan-story.tsx) told over the whole window: while
// Stephen's own light behind the page moves to a new place for every part
// of it (the story poses his field), this layer draws the people of the
// campaign in the same dithered grain, over all of the window and round
// his words. The same squares fly from figure to figure, each on its own
// arc and in its own moment: you, under his light; the few who know the
// work best, talking in turn; the whole company, all over the window,
// lighting up as they talk; the two weeks along the foot of the window,
// each day's talkers piled on it; what he learned, rising in four columns
// of light, team by team; one finding, a laptop drawn over his words,
// waiting for its days; and last they fly into his light at the edge,
// where he rests on this step. Decoration only (the words say it all),
// hidden in forced colours; the story is not told under reduced motion.

const styles = stylex.create({
  layer: {
    position: "fixed",
    inset: 0,
    zIndex: -1,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    imageRendering: "pixelated",
    display: { default: "block", [media.forcedColors]: "none" },
  },
});

/** The figures of the story, in its order. */
export type Scene =
  | "you"
  | "first"
  | "everyone"
  | "close"
  | "learned"
  | "finding"
  | "rest";

interface Dot {
  x: number;
  y: number;
  side: number;
  tone: Tone;
  alpha: number;
}

/** The room a figure has, in cells: the window, its bar, and the box the words stand in. */
interface Room {
  columns: number;
  rows: number;
  bar: number;
  words: { left: number; top: number; right: number; bottom: number };
}

type Put = (x: number, y: number, tone: Tone, alpha: number) => void;

/** A cell of the grain, in CSS pixels: a little coarser than his light, so the people read. */
const CELL = 3;

/** How long a figure takes to become the next, in ms. */
const FLY_MS = 1300;

const hash = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43_758.5453;
  return s - Math.floor(s);
};

const ease = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

const clamp = (t: number): number => Math.min(1, Math.max(0, t));

const sideOf = ({ columns }: Room): number => (columns < 160 ? 4 : 5);

const gone = (x: number, y: number): Dot => ({
  x,
  y,
  side: 1,
  tone: "mint",
  alpha: 0,
});

/** Over the words, in the middle. */
const above = (room: Room, by: number): number =>
  Math.max(room.bar + 4, room.words.top - by);

/** You: one square under his light, over the words. */
const youFigure = (room: Room, count: number): Dot[] => {
  const side = sideOf(room);
  const x = Math.round(room.columns / 2 - side / 2);
  const y = above(room, 26);
  return Array.from({ length: count }, (_, at) =>
    at === 0 ? { x, y, side, tone: "foreground", alpha: 1 } : gone(x, y)
  );
};

/** The few who know the work best, in a row over the words. */
const firstFigure = (room: Room, count: number): Dot[] => {
  const side = sideOf(room);
  const gap = side + 7;
  const y = above(room, 26);
  const left = Math.round(room.columns / 2 - gap - side / 2);
  return Array.from({ length: count }, (_, at) =>
    at < 3
      ? { x: left + at * gap, y, side, tone: "foreground", alpha: 1 }
      : gone(room.columns / 2, y)
  );
};

/** The whole company, all over the window, clear of the bar and of the words. */
const everyoneFigure = (room: Room, count: number): Dot[] => {
  const side = sideOf(room);
  const { words } = room;
  const top = room.bar + 6;
  const height = room.rows - top - 6;
  // A grid of places a little larger than needed, each square jittered in its own; the words' box is left out.
  const across = Math.ceil(Math.sqrt((count * 1.9 * room.columns) / height));
  const down = Math.ceil((count * 1.9) / across);
  const places: Dot[] = [];
  for (let row = 0; row < down; row += 1) {
    for (let column = 0; column < across; column += 1) {
      const seed = row * 97 + column;
      const x = Math.round(
        ((column + 0.2 + hash(seed) * 0.6) / across) * (room.columns - 8) + 4
      );
      const y = Math.round(
        top + ((row + 0.2 + hash(seed + 41) * 0.6) / down) * height
      );
      const inWords =
        x > words.left - side - 12 &&
        x < words.right + 12 &&
        y > words.top - side - 10 &&
        y < words.bottom + 16;
      if (!inWords) {
        places.push({ x, y, side, tone: "foreground", alpha: 1 });
      }
    }
  }
  // Taken spread out, not in reading order: every other place first.
  const order = places
    .map((place, at) => ({ place, key: hash(at + 5) }))
    .toSorted((a, b) => a.key - b.key);
  return Array.from(
    { length: count },
    (_, at) => order[at]?.place ?? gone(room.columns / 2, room.rows / 2)
  );
};

/** Where the two weeks stand: along the foot of the window. */
const weeksOf = (room: Room, days: readonly PlanDay[]) => {
  const margin = Math.round(room.columns * 0.06);
  const width = room.columns - margin * 2;
  return {
    margin,
    dayWidth: width / days.length,
    ground: room.rows - 8,
  };
};

/** The two weeks: every day a column at the foot of the window, its talkers piled on it. */
const closeFigure = (
  room: Room,
  count: number,
  days: readonly PlanDay[]
): Dot[] => {
  const { margin, dayWidth, ground } = weeksOf(room, days);
  const side = dayWidth < 18 ? 4 : 5;
  const pitch = side + 1;
  const pile = 2 * pitch - 1;
  const slots: Dot[] = [];
  for (const [index, day] of days.entries()) {
    if (day.kind === "talks") {
      const left = Math.floor(
        margin + index * dayWidth + (dayWidth - pile) / 2
      );
      for (let at = 0; at < Math.min(day.count, 8); at += 1) {
        slots.push({
          x: left + (at % 2) * pitch,
          y: ground - side - 1 - Math.floor(at / 2) * pitch,
          side,
          tone: "foreground",
          alpha: 1,
        });
      }
    }
  }
  return Array.from(
    { length: count },
    (_, at) => slots[at] ?? gone(margin, ground)
  );
};

/** The share of what he learned each team holds: four teams, largest first. */
const teams = [0.34, 0.28, 0.22, 0.16];

const teamMiddle = (room: Room, team: number): number =>
  room.columns / 2 + (team - 1.5) * Math.max(30, room.columns * 0.16);

/** What he learned, team by team: four piles of the light at the foot of the window. */
const learnedFigure = (room: Room, count: number): Dot[] => {
  const side = sideOf(room);
  const pitch = side + 1;
  const ground = room.rows - 8;
  const dots: Dot[] = [];
  for (const [team, share] of teams.entries()) {
    const many =
      team === teams.length - 1
        ? count - dots.length
        : Math.round(share * count);
    const middle = teamMiddle(room, team);
    for (let at = 0; at < many; at += 1) {
      dots.push({
        x: Math.round(middle - pitch * 1.5) + (at % 3) * pitch,
        y: ground - side - 1 - Math.floor(at / 3) * pitch,
        side,
        tone: "mint",
        alpha: 1,
      });
    }
  }
  return dots;
};

/** The laptop a finding is about, over the words. */
const laptopOf = (room: Room) => {
  const width = Math.round(Math.min(room.columns * 0.3, 110));
  const space = room.words.top - room.bar - 14;
  const height = Math.max(14, Math.min(Math.round(width * 0.58), space - 10));
  const left = Math.round((room.columns - width) / 2);
  const base = room.words.top - 10;
  const top = base - 3 - height;
  return { left, top, width, height, base };
};

/** One finding: the squares trace the laptop's screen. */
const findingFigure = (room: Room, count: number): Dot[] => {
  const { left, top, width, height } = laptopOf(room);
  const sides: [number, number, number, number][] = [
    [left, top, left + width, top],
    [left + width, top, left + width, top + height],
    [left + width, top + height, left, top + height],
    [left, top + height, left, top],
  ];
  const lengths = sides.map(([x0, y0, x1, y1]) => Math.hypot(x1 - x0, y1 - y0));
  const total = lengths.reduce((sum, each) => sum + each, 0);
  return Array.from({ length: count }, (_, at) => {
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
  });
};

/** Last, into his light at the window's edge, where he rests on this step. */
const restFigure = (room: Room, count: number): Dot[] =>
  Array.from({ length: count }, (_, at) =>
    gone(2 + hash(at) * 10, room.rows * (0.35 + hash(at + 3) * 0.3))
  );

const figureOf = (
  scene: Scene,
  room: Room,
  count: number,
  days: readonly PlanDay[]
): Dot[] => {
  const figures: Record<Scene, () => Dot[]> = {
    you: () => youFigure(room, count),
    first: () => firstFigure(room, count),
    everyone: () => everyoneFigure(room, count),
    close: () => closeFigure(room, count, days),
    learned: () => learnedFigure(room, count),
    finding: () => findingFigure(room, count),
    rest: () => restFigure(room, count),
  };
  return figures[scene]();
};

/** A soft dither of his light round a point: someone talking. */
const halo = (put: Put, x: number, y: number, r: number, much: number) => {
  for (let dx = -r; dx <= r; dx += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      const near = 1 - Math.hypot(dx, dy) / r;
      const threshold = bayerAt(x + dx, y + dy);
      if (near > 0 && threshold < much * near) {
        put(x + dx, y + dy, threshold < much * near * 0.4 ? "mint" : "sea", 1);
      }
    }
  }
};

/** Who is talking now, of the few or of the company: a wave that runs through them. */
const talking = (scene: Scene, at: number, time: number): number => {
  if (scene === "first") {
    return at < 3 ? clamp(Math.sin(time * 2.4 - at * 2.1) * 1.4 - 0.4) : 0;
  }
  if (scene === "everyone") {
    return clamp(Math.sin(time * 1.6 + hash(at + 11) * 20) * 1.6 - 0.9);
  }
  return 0;
};

/** The two weeks' dotted ground, and today in his light at its start. */
const drawWeeks = (
  put: Put,
  room: Room,
  days: readonly PlanDay[],
  alpha: number
) => {
  const { margin, dayWidth, ground } = weeksOf(room, days);
  for (const [index] of days.entries()) {
    const start = Math.floor(margin + index * dayWidth);
    for (let x = start + 2; x < start + dayWidth - 2; x += 2) {
      put(x, ground, "border", alpha);
    }
  }
  // Today, in his light: where it all starts.
  const today = margin + dayWidth / 2;
  for (let x = Math.floor(today - 8); x < today + 8; x += 1) {
    for (let y = ground - 30; y <= ground; y += 1) {
      const near = 1 - (ground - y) / 30;
      if (bayerAt(x, y) < 0.5 * near * near) {
        put(x, y, "mint", alpha);
      }
    }
  }
};

/** The teams' ground, and over every team a column of light. */
const drawTeams = (put: Put, room: Room, alpha: number, time: number) => {
  const ground = room.rows - 8;
  for (let x = 2; x < room.columns - 2; x += 2) {
    put(x, ground, "border", alpha);
  }
  // Over every team a column of light, rising and breathing.
  for (const [team, share] of teams.entries()) {
    const middle = teamMiddle(room, team);
    const height = Math.round(
      (room.rows * 0.45 + share * room.rows) *
        (0.92 + 0.08 * Math.sin(time * 1.4 + team))
    );
    for (let x = Math.floor(middle - 11); x < middle + 11; x += 1) {
      for (let y = ground - height; y < ground; y += 1) {
        const up = (ground - y) / height;
        const side = 1 - Math.abs(x - middle) / 11;
        if (bayerAt(x, y) < 0.42 * (1 - up) ** 1.2 * side) {
          put(x, y, up < 0.25 ? "mint" : "sea", alpha);
        }
      }
    }
  }
};

/** The laptop's screen and base, and the days it is waited for. */
const drawLaptop = (put: Put, room: Room, alpha: number, time: number) => {
  const { left, top, width, height, base } = laptopOf(room);
  for (let x = left + 2; x < left + width - 2; x += 1) {
    for (let y = top + 2; y < top + height - 2; y += 1) {
      if (bayerAt(x, y) < 0.1) {
        put(x, y, "sea", alpha);
      }
    }
  }
  for (let x = left - 8; x < left + width + 10; x += 1) {
    put(x, base, "foreground", alpha);
    put(x, base + 1, "foreground", alpha * 0.5);
  }
  // The days the laptop is waited for: one, two, three, again.
  const waited = Math.floor(time * 1.3) % 4;
  const block = 5;
  const middle = left + width / 2;
  for (let day = 0; day < 3; day += 1) {
    const x0 = Math.round(middle + (day - 1) * (block + 4) - block / 2);
    const y0 = Math.round(top + height / 2 - block / 2);
    for (let dx = 0; dx < block; dx += 1) {
      for (let dy = 0; dy < block; dy += 1) {
        put(x0 + dx, y0 + dy, day < waited ? "mint" : "border", alpha);
      }
    }
  }
};

/** What stands behind a figure besides its people: the days' ground, the teams' light, the laptop. */
const drawSetting = (
  put: Put,
  room: Room,
  scene: Scene,
  days: readonly PlanDay[],
  alpha: number,
  time: number
) => {
  if (alpha <= 0.01) {
    return;
  }
  if (scene === "close") {
    drawWeeks(put, room, days, alpha);
  } else if (scene === "learned") {
    drawTeams(put, room, alpha, time);
  } else if (scene === "finding") {
    drawLaptop(put, room, alpha, time);
  }
};

export const PlanFlight = ({
  scene,
  days,
  words,
}: {
  scene: Scene;
  /** What each day from today to the findings holds, as the plan has it. */
  days: readonly PlanDay[];
  /** The box his words stand in: the figures keep clear of it. */
  words: RefObject<HTMLElement | null>;
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
    let tones = readTones(element);
    const count = Math.max(
      40,
      days.reduce((sum, day) => sum + Math.min(day.count, 8), 0)
    );
    let shown: Scene = wanted.current;
    let previous: Scene = shown;
    let from: Dot[] | null = null;
    let since = performance.now();
    let frame = 0;
    let latest: { from: Dot[] | null; whole: number } | null = null;
    const partOf = (at: number, whole: number) =>
      ease(clamp((whole - hash(at + 7) * 0.45) / 0.55));
    const between = (origin: Dot, target: Dot, part: number): Dot => ({
      x: origin.x + (target.x - origin.x) * part,
      y: origin.y + (target.y - origin.y) * part,
      side: origin.side + (target.side - origin.side) * part,
      tone: part < 0.5 ? origin.tone : target.tone,
      alpha: origin.alpha + (target.alpha - origin.alpha) * part,
    });
    const roomOf = (width: number, height: number): Room => {
      const box = words.current?.getBoundingClientRect();
      const columns = Math.floor(width / CELL);
      const rows = Math.floor(height / CELL);
      return {
        columns,
        rows,
        bar: Math.round(72 / CELL),
        words:
          box === undefined
            ? {
                left: columns * 0.3,
                top: rows * 0.45,
                right: columns * 0.7,
                bottom: rows * 0.6,
              }
            : {
                left: Math.floor(box.left / CELL),
                top: Math.floor(box.top / CELL),
                right: Math.ceil(box.right / CELL),
                bottom: Math.ceil(box.bottom / CELL),
              },
      };
    };
    const paint = (now: number) => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const ratio = Math.min(window.devicePixelRatio, 2);
      const wide = Math.round(width * ratio);
      const high = Math.round(height * ratio);
      if (element.width !== wide || element.height !== high) {
        element.width = wide;
        element.height = high;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const room = roomOf(width, height);
      const put: Put = (x, y, tone, alpha) => {
        if (x < 0 || y < 0 || x >= room.columns || y >= room.rows) {
          return;
        }
        context.globalAlpha = alpha;
        context.fillStyle = tones[tone];
        context.fillRect(x * CELL, y * CELL, CELL, CELL);
      };
      const time = now / 1000;
      if (wanted.current !== shown) {
        // Asked mid-flight, the squares fly on from wherever they are.
        const was = figureOf(shown, room, count, days);
        const flying = latest?.from ?? null;
        const whole = latest?.whole ?? 1;
        from =
          flying === null || whole >= 1
            ? was
            : was.map((target, at) =>
                between(flying[at] ?? target, target, partOf(at, whole))
              );
        previous = shown;
        shown = wanted.current;
        since = now;
      }
      const to = figureOf(shown, room, count, days);
      const whole = clamp((now - since) / FLY_MS);
      if (from !== null && whole < 1) {
        drawSetting(put, room, previous, days, 1 - whole, time);
      }
      drawSetting(put, room, shown, days, from === null ? 1 : whole, time);
      const start = from ?? to;
      const dots = to.map((target, at) => {
        const part = partOf(at, whole);
        const dot = between(start[at] ?? target, target, part);
        // Each flies a little arc of its own on the way.
        return {
          ...dot,
          y: dot.y - Math.sin(Math.PI * part) * (6 + hash(at + 31) * 14),
          part,
        };
      });
      for (const [at, dot] of dots.entries()) {
        const voice = dot.part === 1 ? talking(shown, at, time) : 0;
        if (voice > 0) {
          const side = Math.round(dot.side);
          halo(
            put,
            Math.round(dot.x + side / 2),
            Math.round(dot.y + side / 2),
            side + 6,
            0.6 * voice
          );
        }
      }
      for (const dot of dots) {
        if (dot.alpha > 0.02) {
          const side = Math.max(1, Math.round(dot.side));
          context.globalAlpha = dot.alpha;
          context.fillStyle = tones[dot.tone];
          context.fillRect(
            Math.round(dot.x) * CELL,
            Math.round(dot.y) * CELL,
            side * CELL,
            side * CELL
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
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    const repaint = () => {
      tones = readTones(element);
    };
    const modes = new MutationObserver(repaint);
    modes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-mode"],
    });
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", repaint);
    return () => {
      modes.disconnect();
      scheme.removeEventListener("change", repaint);
      cancelAnimationFrame(frame);
    };
  }, [days, words]);
  return (
    <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.layer)} />
  );
};
