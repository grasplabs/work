// The voice's hill (prompt-input.tsx): the sound a dictation or a spoken conversation is heard
// with, drawn on one canvas as the system's dither rising from the card's foot. Loaded when a
// voice first starts, never with the prompt input itself. It stands in the field's place
// (prompt-input-voice-field.ts), whose grade and whose way from raw sound to drawn level it keeps.
//
// At rest it is one fine row of dots along the foot. While a voice is heard a body rises from the
// row, tallest near the middle, its humps drifting so it never stands the same way twice. A cell's
// dot grows and deepens through the grade's stops (sea, mint, pine on paper) with how deep it lies
// under the surface, and Bayer's threshold thins the surface, so its edge is the same pixels as
// every dither in the system and never a hard line. The other voice's hill stops one stop short of
// the person's. Unheard it is low, muted it is the row alone, and while what was said is written
// down it draws in to its middle.
//
// Values are read from the host's sampler at each frame and never pass through React. With reduced
// motion it holds still and steps with the level four times a second.
import { BAYER_MATRIX } from "../lib/utils";
import { gradeOf, quietOf } from "./prompt-input-voice-field";
import type {
  VoiceField,
  VoiceFieldMode,
  VoiceFieldOptions,
} from "./prompt-input-voice-field";
import { shaper } from "./prompt-input-voice-motion";

/** The grid: one cell every PITCH pixels; a dot from DOT_MIN to DOT_MAX across. */
const PITCH = 3;
const DOT_MIN = 1;
const DOT_MAX = 2;
/** How far the lowest row stands from the canvas's foot. */
const FOOT = 2;
/** A column follows a rise in about this long, and a fall in about this long, in seconds. */
const RISE = 0.05;
const FALL = 0.24;
/** How much of the voice reaches the hill, and how wide it stands, by what it is doing. */
const VOICE: Record<VoiceFieldMode, number> = {
  listening: 1,
  speaking: 1,
  unheard: 0.35,
  muted: 0,
  thinking: 0.3,
};
const REACH: Record<VoiceFieldMode, number> = {
  listening: 1,
  speaking: 1,
  unheard: 1,
  muted: 1,
  thinking: 0.25,
};

/** Bayer's 4×4 threshold, 0 to 1, by cell: the system's one dither (lib/utils.ts). */
const threshold = (column: number, row: number): number =>
  ((BAYER_MATRIX[row % 4]?.[column % 4] ?? 7.5) + 0.5) / 16;

/** A number from 0 to 1 that is always the same for the same two numbers. */
const hash = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43_758.5453;
  return s - Math.floor(s);
};

/** Smooth noise along a line, 0 to 1: the hill's drifting humps. */
const drift = (x: number, seed: number): number => {
  const whole = Math.floor(x);
  const part = x - whole;
  const eased = part * part * (3 - 2 * part);
  return hash(whole, seed) * (1 - eased) + hash(whole + 1, seed) * eased;
};

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/** The hill, started on the voice's canvas. */
export const startVoiceHill = (
  canvas: HTMLCanvasElement,
  options: VoiceFieldOptions
): VoiceField => {
  const context = canvas.getContext("2d");
  const shape = shaper();
  let mode: VoiceFieldMode = "listening";
  let grade = gradeOf(canvas);
  let columns = new Float32Array(0);
  let rows = 0;
  let width = 0;
  let height = 0;
  let ratio = 1;
  let frame = 0;
  let timer = 0;
  let running = false;
  let last = 0;
  // Smoothed: how much of the voice reaches it, and how wide it stands.
  let voice = 1;
  let reach = 1;

  const fit = () => {
    const box = canvas.getBoundingClientRect();
    ratio = Math.min(3, window.devicePixelRatio || 1);
    ({ width, height } = box);
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.max(0, Math.floor(width / PITCH));
    if (count !== columns.length) {
      columns = new Float32Array(count);
    }
    rows = Math.max(1, Math.floor((height - FOOT) / PITCH));
  };

  const columnX = (column: number): number =>
    (width - (columns.length - 1) * PITCH) / 2 + column * PITCH;
  const rowY = (row: number): number => height - FOOT - row * PITCH;

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

  /** The columns' heights, each on its way to where the sound puts it. */
  const rise = (level: number, seconds: number, dt: number) => {
    const middle = (columns.length - 1) / 2;
    for (let column = 0; column < columns.length; column += 1) {
      const away =
        middle === 0 ? 0 : Math.abs(column - middle) / (middle * reach);
      // Tallest in the middle, down to the row at the ends.
      const hill = away >= 1 ? 0 : (1 - away * away) ** 1.6;
      // Two drifts, one broad and slow and one fine and quick: the humps wander, the surface is rough.
      const humps =
        0.62 * drift(column * 0.06 + seconds * 0.55, 1) +
        0.38 * drift(column * 0.2 - seconds * 1.3, 2);
      const to = clamp(level * 2.2) ** 0.7 * hill * (0.25 + 0.95 * humps);
      const was = columns[column] ?? 0;
      const pull = 1 - Math.exp(-dt / (to > was ? RISE : FALL));
      columns[column] = was + (clamp(to) - was) * pull;
    }
  };

  const paint = () => {
    if (context === null) {
      return;
    }
    context.clearRect(0, 0, width, height);
    const stops = mode === "speaking" ? quietOf(grade) : grade;
    const levels = stops.length - 1;
    const centre = (columns.length - 1) / 2;
    // By colour, so the fill is set once for each stop.
    for (let colour = 1; colour <= levels; colour += 1) {
      context.fillStyle = stops[colour] ?? "transparent";
      for (let column = 0; column < columns.length; column += 1) {
        const x = columnX(column);
        const tall = (columns[column] ?? 0) * rows;
        const away = centre === 0 ? 0 : Math.abs(column - centre) / centre;
        // The row at the foot, always: the dither's finest dot in its first stop.
        if (colour === 1 && tall < 1) {
          square(x, rowY(0), DOT_MIN);
        }
        for (let row = 0; row < rows && tall - row > 0; row += 1) {
          const under = tall - row;
          const bayer = threshold(column, row);
          // The surface is thinned by the threshold, never a hard line.
          if (under >= 1 || under > bayer) {
            // Deep under the surface and near the middle it is brightest.
            const light =
              clamp(under / (rows * 0.38)) * (0.4 + 0.6 * (1 - away * away));
            const scaled = light * levels;
            const lower = Math.floor(scaled);
            const index = Math.max(
              1,
              Math.min(levels, scaled - lower > bayer ? lower + 1 : lower)
            );
            if (index === colour) {
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

  const step = (now: number, dt: number, seconds: number) => {
    const ease = 1 - Math.exp(-dt / 0.18);
    voice += (VOICE[mode] - voice) * ease;
    reach += (REACH[mode] - reach) * ease;
    const { level } = shape.step(
      mode === "muted" ? undefined : options.sample(),
      dt
    );
    options.onLevel?.(level * voice);
    // A breath at rest, so a silent room is still a living row.
    rise(Math.max(level, mode === "muted" ? 0 : 0.03) * voice, seconds, dt);
    paint();
    last = now;
  };

  const loop = (now: number) => {
    if (!running) {
      return;
    }
    step(
      now,
      last === 0 ? 0.016 : Math.min(0.1, (now - last) / 1000),
      now / 1000
    );
    frame = requestAnimationFrame(loop);
  };
  /** Reduced motion: it holds still, and steps with the level four times a second. */
  const stillTick = () => {
    step(performance.now(), 1, 0);
  };

  const run = (on: boolean) => {
    if (on === running) {
      return;
    }
    running = on;
    cancelAnimationFrame(frame);
    clearInterval(timer);
    last = 0;
    if (!on) {
      return;
    }
    if (options.still) {
      stillTick();
      timer = window.setInterval(stillTick, 250);
    } else {
      frame = requestAnimationFrame(loop);
    }
  };

  const recolour = () => {
    grade = gradeOf(canvas);
  };
  const themeWatch = new MutationObserver(recolour);
  themeWatch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-mode", "class", "style"],
  });
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", recolour);
  const forced = matchMedia("(forced-colors: active)");
  forced.addEventListener("change", recolour);
  // Sizing the canvas clears it: drawn again at once, so no frame is bare.
  const resized = new ResizeObserver(() => {
    fit();
    if (running) {
      paint();
    }
  });
  resized.observe(canvas);
  fit();

  return {
    mode: (next) => {
      mode = next;
      // Muted is still at once: the voice drops out within the frame.
      if (next === "muted") {
        shape.reset();
        voice = 0;
      }
    },
    run,
    stop: () => {
      run(false);
      themeWatch.disconnect();
      scheme.removeEventListener("change", recolour);
      forced.removeEventListener("change", recolour);
      resized.disconnect();
    },
  };
};
