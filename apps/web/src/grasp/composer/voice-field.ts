// The voice's field (voice.tsx): the light a dictation is written with, drawn on one canvas.
//
// It lies in a band directly under the words and stays where it is: one body of light centred on
// the band, symmetric left and right, that breathes with the voice in place. Nothing travels
// sideways. It spans the band end to end; its height follows the level (ordinary speech about half its height, only a
// raised voice the top, about 28px; at rest about 6px, barely moving); the release of the level is
// its afterglow, fading in place in about 300ms. The body has volume: a gradient inside it, the
// brightest stop only along its centre line, then Bayer's threshold thins it through the grade's
// stops to its edge, as the backdrop and the Composer's working edge draw, so it reads as the same
// material. Low bands thicken the core; high bands add a fine sparkle at its two ends, never a cell
// more than one away from the body.
//
// Values are read from the host's sampler at each frame and never pass through React. It draws at
// the display's rate while it is in view and the tab is shown, and holds otherwise. With reduced
// motion it is a still band whose brightness steps with the level at most four times a second.
import { shaper } from "./voice-motion";
import type { VoiceReading, VoiceShape } from "./voice-motion";

/** What the field is doing, from the dictation's phase. */
export type VoiceFieldMode =
  | "listening"
  | "silent"
  | "unheard"
  | "muted"
  | "thinking"
  | "leaving"
  | "off";

/** A field being drawn. */
export interface VoiceField {
  mode: (mode: VoiceFieldMode) => void;
  /** Draw on, or hold (out of view, tab hidden). */
  run: (on: boolean) => void;
  stop: () => void;
}

/** What the field is given besides its canvas. */
export interface VoiceFieldOptions {
  /** Read at each frame: the sound now. Undefined is silence. */
  sample: () => VoiceReading | undefined;
  /** Reduced motion: a still band, stepping with the level at most four times a second. */
  still: boolean;
  /** Called at each frame with the drawn level, 0 to 1 (the card's edge and the meter follow it). */
  onLevel?: (level: number) => void;
  /** The band's height in CSS pixels, at the foot of the canvas. */
  band: number;
}

/** The grid: one dot in every PITCH square, DOT across, as the working edge's (composer-dither). */
const PITCH = 3;
const DOT_MIN = 1.5;
/** Half the body's height at rest and at its loudest, in pixels: about 6px and 28px tall. */
const REST_HALF = 3;
const LOUD_HALF = 14;
/**
 * Half the body's width, as a share of the band's: at rest, and how much more at its loudest. The
 * body spans the whole band, end to end, at every level (Ruben, 17 November: the band fills the
 * footer's room between the time and the controls); the voice moves its height and brightness. A
 * little past half, so its tapering tail meets the band's ends rather than stopping short of them.
 */
const REST_WIDTH = 0.58;
const LOUD_WIDTH = 0;
/** The rest's breath: one slow swell every few seconds, so at silence it barely moves. */
const BREATH = 7;
/** The centre line's half width, in pixels: where the brightest stop lives. */
const CENTRE_LINE = 2.4;
/** Where along the body (as a share of its half width) the high bands sparkle: its two ends. */
const SPARKLE_FROM = 0.72;

/** Bayer's 4×4 threshold, 0 to 1, by cell. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
  (value) => (value + 0.5) / 16
);
const threshold = (column: number, row: number) =>
  BAYER[(row % 4) * 4 + (column % 4)] ?? 0.5;

/** A steady hash for a cell, 0 to 1. */
const hash = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43_758.5453;
  return s - Math.floor(s);
};

const clamp = (value: number, low = 0, high = 1) =>
  Math.min(high, Math.max(low, value));
const smooth = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** The grade, from no dot to the core, as the tokens resolve here. */
const gradeOf = (canvas: HTMLCanvasElement): string[] => {
  const style = getComputedStyle(canvas);
  const stop = (name: string) =>
    style.getPropertyValue(`--grasp-light-${name}`).trim();
  // The canvas's colour is the ink: light ink means a dark page. Painted once to read it as sRGB,
  // whatever form the colour is written in (oklch, light-dark()).
  const probe = document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  let dark = false;
  if (probe !== null) {
    probe.fillStyle = style.color;
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
    dark = r + g + b > 384;
  }
  // On night the light rises through pine and mint to lime; on paper it deepens from sea through
  // mint to pine, the ink-green end, so the core holds 3:1 on the card.
  return dark
    ? ["", stop("pine"), stop("mint"), stop("sea"), stop("lime")]
    : ["", stop("sea"), stop("mint"), stop("pine")];
};

/** What every column of a picture shares: the sound now, and how the field stands. */
interface Scene {
  sound: VoiceShape;
  seconds: number;
  /** How open the band is, 0 to 1. */
  scale: number;
  middle: number;
  breathing: boolean;
  voice: number;
  thin: number;
  lift: number;
}

/** A column's body: its half height, how flat its top is, how bright, and its sparkle. */
interface Look {
  half: number;
  flat: number;
  bright: number;
  /** How much of the light is the core's gradient: none at rest, all of its share once the voice is up. */
  core: number;
  sparkle: number;
}

/** How present the field is in each mode: gone, dim when muted, else whole. */
const PRESENCE: Record<VoiceFieldMode, number> = {
  listening: 1,
  silent: 1,
  unheard: 1,
  thinking: 1,
  muted: 0.4,
  leaving: 0,
  off: 0,
};
/** How much of the voice reaches it: all while it listens, half when a stretch is unheard. */
const VOICE: Record<VoiceFieldMode, number> = {
  listening: 1,
  silent: 1,
  unheard: 0.5,
  thinking: 0,
  muted: 0,
  leaving: 0,
  off: 0,
};

/** Eases a value toward its goal at a steady pace: from one end to the other in `seconds`. */
const ease = (
  value: { now: number; goal: number },
  dt: number,
  seconds: number
) => {
  const step = dt / seconds;
  value.now =
    value.now < value.goal
      ? Math.min(value.goal, value.now + step)
      : Math.max(value.goal, value.now - step);
};

/** The body over one column, `across` its half width from the centre (0) to its end (1). */
const columnLook = (across: number, scene: Scene): Look => {
  const { sound } = scene;
  const heard = sound.level * scene.voice;
  // Rounded at both ends, the same on either side. With the voice the ends draw in sooner (a lens,
  // not a capsule): the middle keeps its height, so the shape shows without the body growing.
  const shaped = Math.min(1, heard * 2.5);
  const taper = (1 - across * across) ** (1.1 + 1.1 * shaped);
  // The rest: lying low, one slow swell.
  const wave = scene.breathing
    ? 0.5 + 0.5 * Math.sin((scene.seconds / BREATH) * Math.PI * 2)
    : 0.5;
  const restHalf = REST_HALF * (0.85 + 0.3 * wave) * (1 - scene.thin * 0.4);
  // Brightest at the middle of the length and falling to the ends, once the voice is up.
  const along = 1 - 0.45 * shaped * across ** 2.6;
  return {
    // Loudness swells it more than linearly, so a stressed syllable stands out of the phrase.
    half:
      (restHalf + heard ** 1.3 * (LOUD_HALF - REST_HALF)) * taper * scene.scale,
    // How flat the top is, so how much of it is solid: flatter at rest, and with the low bands.
    flat: 3.2 - 1.4 * Math.min(1, heard * 2) + 0.8 * sound.low * scene.voice,
    // Calm at rest, the brightest stop when the voice is up.
    bright:
      Math.min(
        1.05,
        0.48 +
          0.08 * wave * (1 - heard) +
          0.9 * heard ** 1.1 +
          0.1 * sound.mid * scene.voice +
          scene.lift
      ) *
      (1 - scene.thin * 0.25) *
      along,
    core: shaped,
    // The high bands, at the body's two ends only.
    sparkle:
      across < 0.94
        ? sound.high * scene.voice * smooth(SPARKLE_FROM, 0.92, across)
        : 0,
  };
};

/** One cell's light, 0 to 1: the rounded body, the sparkle one cell past it at most, thinned when unheard. */
const cellLight = (
  away: number,
  look: Look,
  column: number,
  row: number,
  scene: Scene
) => {
  let light = 0;
  if (away <= look.half) {
    // A body with a gradient inside it: rounded to its edge, and the brightest stop only along its
    // centre line, a second stop round that, so a loud syllable is never one flat colour.
    // The core grows with the body: its gradient spans about a third of the body's height (never
    // under CENTRE_LINE), so at ordinary speech the inside shows, not only the outline.
    const across = away / Math.max(0.5, look.half);
    const coreWidth =
      CENTRE_LINE + look.core * Math.max(0, look.half / 3 - CENTRE_LINE);
    const centreLine = Math.exp(-((away / coreWidth) ** 2));
    const share = 0.18 + 0.22 * look.core;
    light =
      look.bright *
      ((1 - share) *
        (1 - across ** look.flat) *
        (1 - 0.35 * look.core * across) +
        share * centreLine);
  } else if (
    look.half > 2 &&
    away <= look.half + PITCH &&
    look.sparkle > 0.15 &&
    hash(column + Math.floor(scene.seconds * 12) * 0.11, row) <
      (look.sparkle - 0.15) * 0.9
  ) {
    light = 0.3;
  }
  // Unheard: the band thins, cells let go.
  return scene.thin > 0.01 && hash(column, row) < scene.thin * 0.45
    ? light * 0.4
    : light;
};

/**
 * How much of a cell the body covers, `away` from the middle row, and whether it lights. Whole
 * inside; a share in the row the edge crosses. In the middle rows (the line itself) a cell lights
 * when the body reaches its centre, with no dither, so the line runs out as one dim tail, never a dot
 * past a gap. In an outer row a share is lit or not by Bayer's threshold, so where the height crosses
 * a row line the row thins in over several columns: a soft shoulder, not a rectangle's square end.
 * It may light only against the body: the cell inside it, toward the middle row, is covered whole
 * (so lit), never a row out with a gap under it. The dither is keyed by the row's distance from the
 * middle, so the top and the bottom match.
 */
const coverOf = (away: number, half: number, mirror: number) => {
  const cover = clamp((half - away) / PITCH + 0.5);
  const line = away < PITCH;
  const touches =
    line || cover >= 1 || clamp((half - away + PITCH) / PITCH + 0.5) >= 1;
  const ring = Math.round((away / PITCH) * 2);
  const edgeLit =
    cover >= 1 ||
    (line ? cover >= 0.5 : touches && cover > threshold(mirror + 2, ring));
  return { cover, touches, edgeLit };
};

/** Paints the cells: one colour at a time, each dot snapped to the device's pixels and centred in its cell. */
const drawCells = (
  ctx: CanvasRenderingContext2D,
  cells: {
    columns: number;
    rows: number;
    paint: Uint8Array;
    sizes: Uint8Array;
  },
  grade: string[],
  ratio: number,
  width: number,
  height: number
) => {
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  // Five sizes, from DOT_MIN to a whole cell.
  const sized = Array.from(
    { length: 5 },
    (_, step) =>
      Math.max(
        1,
        Math.round((DOT_MIN + ((PITCH - DOT_MIN) * step) / 4) * ratio)
      ) / ratio
  );
  const { columns, rows, paint: marks, sizes } = cells;
  for (let colour = 1; colour < grade.length; colour += 1) {
    ctx.fillStyle = grade[colour] ?? "transparent";
    for (let cell = 0; cell < columns * rows; cell += 1) {
      if (marks[cell] === colour) {
        const size = sized[sizes[cell] ?? 0] ?? 1;
        const inset = Math.round(((PITCH - size) / 2) * ratio) / ratio;
        ctx.fillRect(
          Math.round((cell % columns) * PITCH * ratio) / ratio + inset,
          Math.round(Math.floor(cell / columns) * PITCH * ratio) / ratio +
            inset,
          size,
          size
        );
      }
    }
  }
};

/** A field with nothing to draw on. */
const nothingDrawn: VoiceField = {
  mode: () => {
    // No canvas.
  },
  run: () => {
    // No canvas.
  },
  stop: () => {
    // Nothing held.
  },
};

/** Starts the field on `canvas`. */
export const startVoiceField = (
  canvas: HTMLCanvasElement,
  options: VoiceFieldOptions
): VoiceField => {
  const context2d = canvas.getContext("2d");
  if (context2d === null) {
    return nothingDrawn;
  }
  const ctx = context2d;
  const shape = shaper();
  let mode: VoiceFieldMode = "listening";
  let sound: VoiceShape = { level: 0, low: 0, mid: 0, high: 0, centroid: 0.5 };
  // Smoothed scalars: how present the field is, how much of the voice reaches it, how much of its
  // width is left (it drains to its middle), and how thin it is.
  const presence = { now: 0, goal: 1 };
  const voice = { now: 1, goal: 1 };
  const length = { now: 1, goal: 1 };
  const thin = { now: 0, goal: 0 };
  let stillStep = 0;
  let grade = gradeOf(canvas);
  let width = 0;
  let height = 0;
  let ratio = 1;
  // How much of the band is open now: it opens and closes with the room (voice.tsx), and the body
  // grows and shrinks with it.
  let bandNow = 0;
  let frame = 0;
  let timer = 0;
  let running = false;
  let last = 0;
  const begun = performance.now();
  const cells = {
    columns: 0,
    rows: 0,
    paint: new Uint8Array(0),
    sizes: new Uint8Array(0),
  };

  const fit = () => {
    const box = canvas.getBoundingClientRect();
    ratio = Math.min(3, window.devicePixelRatio || 1);
    ({ width, height } = box);
    const room = canvas.parentElement;
    // The computed padding is in px ("47.6px").
    bandNow =
      room === null
        ? options.band
        : Number(getComputedStyle(room).paddingBottom.replace("px", "")) || 0;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    cells.columns = Math.ceil(width / PITCH);
    cells.rows = Math.ceil(height / PITCH);
    cells.paint = new Uint8Array(cells.columns * cells.rows);
    cells.sizes = new Uint8Array(cells.columns * cells.rows);
  };

  /** The light in every cell, as a grade index and a dot size, then painted. */
  const paint = (now: number) => {
    const { columns, rows, paint: marks, sizes } = cells;
    marks.fill(0);
    const levels = grade.length - 1;
    const scene: Scene = {
      sound,
      seconds: (now - begun) / 1000,
      middle: height - bandNow / 2,
      scale: Math.min(1, bandNow / options.band),
      breathing: mode !== "muted" && !options.still,
      voice: voice.now,
      thin: thin.now,
      lift: options.still ? stillStep * 0.35 : 0,
    };
    // One body, centred, its width following the level; writing it down drains it to its middle.
    const reach =
      width * (REST_WIDTH + LOUD_WIDTH * sound.level * voice.now) * length.now;
    const centreColumn = (columns - 1) / 2;
    if (presence.now > 0.002 && reach > PITCH) {
      for (let column = 0; column < columns; column += 1) {
        // Measured from the middle cell, so the two sides are mirror images.
        const across = (Math.abs(column - centreColumn) * PITCH) / reach;
        if (across < 1) {
          const look = columnLook(across, scene);
          // The sparkle and the thinning mirror too: their hash is by distance from the middle.
          const mirror = Math.round(Math.abs(column - centreColumn) * 2);
          const firstRow = Math.max(
            0,
            Math.floor((scene.middle - look.half - PITCH) / PITCH)
          );
          const lastRow = Math.min(
            rows - 1,
            Math.ceil((scene.middle + look.half + PITCH) / PITCH)
          );
          for (let row = firstRow; row <= lastRow; row += 1) {
            const away = Math.abs(row * PITCH + PITCH / 2 - scene.middle);
            const { cover, touches, edgeLit } = coverOf(
              away,
              look.half,
              mirror
            );
            const light =
              cellLight(away, look, mirror, row, scene) * presence.now * cover;
            if (
              ((light > 0.02 && touches) || (edgeLit && cover > 0)) &&
              presence.now > 0.02
            ) {
              const scaled = clamp(light) * levels;
              const lower = Math.floor(scaled);
              // The colour's dither keyed by distance from the middle too: the lens mirrors whole.
              const index =
                scaled - lower >
                threshold(mirror, Math.round((away / PITCH) * 2))
                  ? lower + 1
                  : lower;
              const cell = row * columns + column;
              // A lit cell inside the body is never blank: at least the first stop. A cell the
              // edge only crosses takes it where the dither lets it, and no more than its light.
              marks[cell] = edgeLit
                ? Math.max(1, Math.min(levels, index))
                : Math.min(levels, index);
              // The dot grows with the light, from a fine point at the edge to a whole cell in the
              // core, so the body thins in size as well as colour.
              sizes[cell] = Math.round(clamp((light - 0.55) / 0.5) ** 1.6 * 4);
            }
          }
        }
      }
    }
    drawCells(ctx, cells, grade, ratio, width, height);
    canvas.dataset.drawn = String(Number(canvas.dataset.drawn ?? "0") + 1);
  };

  const listening = () =>
    mode === "listening" || mode === "unheard" || mode === "silent";

  const tick = (now: number) => {
    const dt = last === 0 ? 1 / 60 : Math.min(0.1, (now - last) / 1000);
    last = now;
    sound = shape.step(listening() ? options.sample() : undefined, dt);
    // Muted is flat and dim within 160ms; writing it down drains in 300ms; Cancel fades in 240ms.
    ease(presence, dt, mode === "leaving" ? 0.24 : 0.16);
    ease(voice, dt, 0.16);
    ease(length, dt, 0.3);
    ease(thin, dt, 0.3);
    paint(now);
    options.onLevel?.(sound.level * voice.now * presence.now);
  };

  /** Reduced motion: the band alone, its brightness one of four steps, at most four times a second. */
  const stillTick = () => {
    const reading = listening() ? options.sample() : undefined;
    const raw = shape.step(reading, 0.25);
    stillStep = Math.round(raw.level * 3) / 3;
    sound = { level: 0, low: 0, mid: 0, high: 0, centroid: 0.5 };
    presence.now = presence.goal;
    voice.now = 0;
    length.now = length.goal;
    thin.now = thin.goal;
    paint(performance.now());
    options.onLevel?.(stillStep);
  };

  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    tick(now);
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
    attributeFilter: ["data-theme", "class", "style"],
  });
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", recolour);
  // Sizing the canvas clears it, and the observer runs after the frame was drawn: drawn again at
  // once, so no frame is bare while the band opens or closes.
  const resized = new ResizeObserver(() => {
    fit();
    if (options.still && running) {
      stillTick();
    } else if (running) {
      paint(performance.now());
    }
  });
  resized.observe(canvas);
  fit();

  const goals = (next: VoiceFieldMode) => {
    presence.goal = PRESENCE[next];
    voice.goal = VOICE[next];
    length.goal = next === "thinking" ? 0 : 1;
    thin.goal = next === "unheard" ? 1 : 0;
  };
  goals(mode);

  return {
    mode: (next) => {
      mode = next;
      goals(next);
      // Muted is still at once: the voice drops out within the frame.
      if (next === "muted") {
        shape.reset();
        voice.now = 0;
      }
    },
    run,
    stop: () => {
      run(false);
      themeWatch.disconnect();
      scheme.removeEventListener("change", recolour);
      resized.disconnect();
    },
  };
};
