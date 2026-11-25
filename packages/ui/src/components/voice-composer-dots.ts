// The voice composer's dots (voice-composer.tsx), drawn on one canvas that lies over the whole card.
//
// Along the card's foot stands the system's dither (lib/utils.ts: Bayer's 4×4 threshold, square
// dots on a 3px pitch, in the brand's grade as the voice field's): a fine row at rest, and while a
// voice is heard a body that rises from it, tallest near the middle, its humps drifting so it
// never stands the same way twice. A cell's dot grows and deepens through the grade's stops with
// how deep it lies under the surface, and the threshold thins the surface, never a hard line.
//
// A word that is heard is carried up: dots leave the body's surface in one stream, each with a
// short tail, bend toward the word's place in the text and stand there for a moment as a word made
// of dots, while the letters come through the blur (the component's part) and the dots go.
//
// Values are read from the host's sampler at each frame and never pass through React. With reduced
// motion the body stands still, stepping with the level four times a second, and no dot flies.
import { BAYER_MATRIX } from "../lib/utils";
import { gradeOf } from "./prompt-input-voice-field";
import { shaper } from "./prompt-input-voice-motion";
import type { VoiceReading } from "./prompt-input-voice-motion";

/** What the dots follow: a person being heard, another voice speaking, or nothing. */
export type VoiceDotsMode = "listening" | "speaking" | "rest";

/** A place in the card, in its own pixels from its top left corner. */
export interface VoiceDotsPlace {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The dots being drawn. */
export interface VoiceDots {
  mode: (mode: VoiceDotsMode) => void;
  /** Carries a word up to its place in the text, after `delay` ms; `time` is how long the flight takes. */
  fly: (place: VoiceDotsPlace, delay: number) => void;
  stop: () => void;
}

/** What the dots are given besides their canvas. */
export interface VoiceDotsOptions {
  /** Read at each frame: the sound now. Undefined is silence. */
  sample: () => VoiceReading | undefined;
  /** Reduced motion. */
  still: boolean;
  /** Called at each frame with the drawn level, 0 to 1. */
  onLevel?: (level: number) => void;
}

/** How long a dot takes from the body to its word, in ms: the letters start to show as the first land. */
export const FLIGHT_MS = 460;

/** The grid: one cell every PITCH pixels, the body at most ROWS cells tall. */
const PITCH = 3;
const ROWS = 15;
/** The finest dot, in pixels. */
const DOT_MIN = 1;
/** The fullest: short of its cell, so the body stays a grid of dots however loud. */
const DOT_MAX = 2;
/** How far the grid stays in from the card's sides, and its lowest row from the card's foot. */
const INSET = 36;
const FOOT = 4;
/** A column follows a rise in about this long, and a fall in about this long, in seconds. */
const RISE = 0.05;
const FALL = 0.24;
/** A flying dot: how long its departures are spread, how long it stands at the word, how long it fades. */
const SPREAD_MS = 240;
const STAND_MS = 200;
const FADE_MS = 220;
/** How far back along its way a flying dot's tail reaches, as a share of the flight. */
const TAIL = 0.14;

interface Flyer {
  /** From, the bend, and to. */
  x0: number;
  y0: number;
  bx: number;
  by: number;
  x1: number;
  y1: number;
  /** When it leaves, on the page's clock, and how long it flies. */
  at: number;
  time: number;
  side: number;
  stand: number;
}

/** A number from 0 to 1 that is always the same for the same three whole numbers. */
const hash = (a: number, b: number, c: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43_758.5453;
  return s - Math.floor(s);
};

/** Bayer's 4×4 threshold, 0 to 1, by cell: the system's one dither (lib/utils.ts). */
const threshold = (column: number, row: number): number =>
  ((BAYER_MATRIX[row % 4]?.[column % 4] ?? 7.5) + 0.5) / 16;

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Smooth noise along a line, 0 to 1: the body's drifting humps. */
const drift = (x: number, seed: number): number => {
  const whole = Math.floor(x);
  const part = smooth(x - whole);
  return hash(whole, seed, 7) * (1 - part) + hash(whole + 1, seed, 7) * part;
};

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/** Slow to leave, slow to land. */
const ease = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** A point of a flight, `t` of its way along. */
const along = (flyer: Flyer, t: number): [number, number] => {
  const u = 1 - t;
  return [
    u * u * flyer.x0 + 2 * u * t * flyer.bx + t * t * flyer.x1,
    u * u * flyer.y0 + 2 * u * t * flyer.by + t * t * flyer.y1,
  ];
};

/** The dots, started on a canvas that lies over the card. */
export const startVoiceDots = (
  canvas: HTMLCanvasElement,
  { sample, still, onLevel }: VoiceDotsOptions
): VoiceDots => {
  const context = canvas.getContext("2d");
  const shape = shaper();
  let mode: VoiceDotsMode = "rest";
  let width = 0;
  let height = 0;
  let columns = new Float32Array(0);
  let flyers: Flyer[] = [];
  let ink = "#000";
  let grade: string[] = ["", ink];
  let ratio = 1;
  let inkReadAt = -Infinity;
  let frame = 0;
  let before = performance.now();
  let stepped = -Infinity;
  /** How much of the body shows: it comes and goes with the mode, never at once. */
  let presence = 0;
  let stopped = false;

  const fit = () => {
    const box = canvas.getBoundingClientRect();
    ratio = Math.min(window.devicePixelRatio || 1, 3);
    ({ width, height } = box);
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.max(0, Math.floor((width - 2 * INSET) / PITCH) + 1);
    if (count !== columns.length) {
      columns = new Float32Array(count);
    }
  };
  const watcher = new ResizeObserver(fit);
  watcher.observe(canvas);
  fit();

  /** Where a column stands, and where the grid's lowest row does. */
  const columnX = (column: number): number =>
    (width - (columns.length - 1) * PITCH) / 2 + column * PITCH;
  const rowY = (row: number): number => height - FOOT - row * PITCH;

  /** The columns' heights, each on its way to where the sound puts it. */
  const rise = (level: number, now: number, dt: number) => {
    const seconds = now / 1000;
    const middle = (columns.length - 1) / 2;
    for (let column = 0; column < columns.length; column += 1) {
      const away = middle === 0 ? 0 : Math.abs(column - middle) / middle;
      // Tallest in the middle, down to the row at the ends.
      const hill = (1 - away * away) ** 1.6;
      // Two drifts, one broad and slow and one fine and quick, so the humps wander and the surface is rough.
      const humps =
        0.62 * drift(column * 0.06 + seconds * 0.55, 1) +
        0.38 * drift(column * 0.2 - seconds * 1.3, 2);
      const to = clamp(level * 2.2) ** 0.7 * hill * (0.3 + 1.3 * humps);
      const was = columns[column] ?? 0;
      const pull = 1 - Math.exp(-dt / (to > was ? RISE : FALL));
      columns[column] = was + (clamp(to) - was) * pull;
    }
  };

  /** A square of the grid, on whole device pixels. */
  const square = (x: number, y: number, side: number) => {
    const snapped = Math.max(1, Math.round(side * ratio)) / ratio;
    context?.fillRect(
      Math.round((x - snapped / 2) * ratio) / ratio,
      Math.round((y - snapped / 2) * ratio) / ratio,
      snapped,
      snapped
    );
  };

  /** The grid: the fine row at the foot, and the body over it, in the system's dither. */
  const drawBody = () => {
    if (context === null) {
      return;
    }
    const levels = grade.length - 1;
    const centre = (columns.length - 1) / 2;
    // By colour, so the fill is set once for each stop.
    for (let colour = 1; colour <= levels; colour += 1) {
      context.fillStyle = grade[colour] ?? ink;
      for (let column = 0; column < columns.length; column += 1) {
        const x = columnX(column);
        const tall = (columns[column] ?? 0) * ROWS * presence;
        const away = centre === 0 ? 0 : Math.abs(column - centre) / centre;
        // The row at the foot, always: the dither's finest dot in its first stop.
        if (colour === 1 && tall < 1) {
          square(x, rowY(0), DOT_MIN);
        }
        for (let row = 0; row < ROWS; row += 1) {
          const under = tall - row;
          if (under <= 0) {
            break;
          }
          const bayer = threshold(column, row);
          // The surface is thinned by the threshold, never a hard line.
          if (under >= 1 || under > bayer) {
            // Deep under the surface and near the middle it is brightest.
            const light =
              clamp(under / (ROWS * 0.38)) * (0.4 + 0.6 * (1 - away * away));
            const scaled = light * levels;
            const lower = Math.floor(scaled);
            const index = Math.max(
              1,
              Math.min(levels, scaled - lower > bayer ? lower + 1 : lower)
            );
            if (index === colour) {
              // The dot grows with the light, from a fine point to a whole cell.
              square(
                x,
                rowY(row),
                DOT_MIN + (DOT_MAX - DOT_MIN) * clamp(light * 1.25)
              );
            }
          }
        }
      }
    }
  };

  /** The dots on their way to a word, and those standing at it: pixels of the same grid. */
  const drawFlyers = (now: number) => {
    if (context === null || flyers.length === 0) {
      return;
    }
    context.fillStyle = grade.at(-1) ?? ink;
    const left: Flyer[] = [];
    for (const flyer of flyers) {
      const since = now - flyer.at;
      if (since < flyer.time + flyer.stand + FADE_MS) {
        left.push(flyer);
        if (since >= 0) {
          const t = ease(clamp(since / flyer.time));
          const [x, y] = along(flyer, t);
          if (since < flyer.time) {
            // The tail: three pixels back along the way, each finer and fainter.
            for (let back = 3; back >= 1; back -= 1) {
              const [tx, ty] = along(flyer, Math.max(0, t - (TAIL * back) / 3));
              context.globalAlpha = 0.6 - back * 0.15;
              square(tx, ty, flyer.side * (1 - back * 0.18));
            }
            context.globalAlpha = 1;
          } else {
            // At the word: it stands, then goes as the letters come.
            context.globalAlpha = clamp(
              1 - (since - flyer.time - flyer.stand) / FADE_MS
            );
          }
          square(x, y, flyer.side);
          context.globalAlpha = 1;
        }
      }
    }
    flyers = left;
  };

  const draw = (now: number) => {
    frame = 0;
    if (stopped) {
      return;
    }
    const dt = Math.min(0.1, (now - before) / 1000);
    before = now;
    if (now - inkReadAt > 1000) {
      inkReadAt = now;
      ink = getComputedStyle(canvas).color;
      grade = gradeOf(canvas);
    }
    const heard = mode === "rest" ? undefined : sample();
    const { level } = shape.step(heard, dt);
    const wanted = mode === "rest" ? 0 : 1;
    presence += (wanted - presence) * (1 - Math.exp(-dt / 0.18));
    onLevel?.(level * presence);
    // Reduced motion: the body steps four times a second, and holds between.
    if (!still || now - stepped >= 250) {
      stepped = now;
      rise(
        still ? level * 0.8 : Math.max(level, mode === "rest" ? 0 : 0.035),
        still ? 0 : now,
        still ? 1 : dt
      );
    }
    context?.clearRect(0, 0, width, height);
    if (presence > 0.01) {
      context?.save();
      if (context !== null) {
        context.globalAlpha = 1;
      }
      drawBody();
      context?.restore();
    }
    drawFlyers(now);
    // At rest with nothing in the air there is nothing to draw: the loop sleeps until woken.
    if (mode !== "rest" || presence > 0.01 || flyers.length > 0) {
      frame = requestAnimationFrame(draw);
    }
  };

  const wake = () => {
    if (frame === 0 && !stopped) {
      before = performance.now();
      frame = requestAnimationFrame(draw);
    }
  };
  wake();

  /** The column a dot leaves from: one of the tall ones, where the voice is. */
  const leaveFrom = (seed: number): number => {
    let best = Math.floor(columns.length / 2);
    let most = -1;
    for (let tries = 0; tries < 10; tries += 1) {
      const column = Math.floor(hash(seed, tries, 11) * columns.length);
      const tall = (columns[column] ?? 0) + hash(seed, tries, 13) * 0.08;
      if (tall > most) {
        most = tall;
        best = column;
      }
    }
    return best;
  };

  return {
    mode: (next) => {
      mode = next;
      wake();
    },
    fly: (place, delay) => {
      if (still || columns.length === 0) {
        return;
      }
      const now = performance.now() + delay;
      const seed = Math.floor(now * 7 + place.x * 13) % 10_007;
      const count = Math.round(Math.min(36, Math.max(12, place.width / 1.8)));
      // The stream's root: where the body stands tallest, and its dots leave from close around it.
      const root = leaveFrom(seed);
      // One stream: every dot of a word bends the same way, a little apart.
      const side = hash(seed, 1, 17) < 0.5 ? -1 : 1;
      const bend = 0.18 + hash(seed, 2, 17) * 0.22;
      for (let index = 0; index < count; index += 1) {
        const column = Math.round(
          Math.min(
            columns.length - 1,
            Math.max(0, root + (hash(seed, index, 47) - 0.5) * 22)
          )
        );
        const x0 = columnX(column);
        const y0 = rowY(Math.max(0, (columns[column] ?? 0) * ROWS - 0.5));
        const x1 = place.x + hash(seed, index, 19) * place.width;
        const y1 =
          place.y + place.height * (0.28 + hash(seed, index, 23) * 0.5);
        const dx = x1 - x0;
        const dy = y1 - y0;
        const jitter = (hash(seed, index, 29) - 0.5) * 0.12;
        flyers.push({
          x0,
          y0,
          // Off the straight line by a share of its length, to the stream's side.
          bx: (x0 + x1) / 2 - dy * (bend + jitter) * side,
          by: (y0 + y1) / 2 + dx * (bend + jitter) * side * 0.6,
          x1,
          y1,
          at: now + hash(seed, index, 31) * SPREAD_MS,
          time: FLIGHT_MS * (0.8 + hash(seed, index, 37) * 0.45),
          side: 1.8 + hash(seed, index, 41) * 1.4,
          stand: STAND_MS * (0.5 + hash(seed, index, 43)),
        });
      }
      wake();
    },
    stop: () => {
      stopped = true;
      watcher.disconnect();
      cancelAnimationFrame(frame);
      shape.reset();
    },
  };
};
