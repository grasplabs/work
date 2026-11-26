// The guide's light (guide.tsx): Stephen's dither pooling round the one
// control the guide is telling about, on a canvas over the whole window
// that never catches a press. It is the system's own dither (Bayer's 4×4,
// 2px squares on a 3px pitch, as the header's texture and the voice's
// hill), brightest at the control's edge and thinning out to nothing, so
// it has no edge of its own; the control itself stays clear, a small gap
// round it, so nothing it says is drawn over. Moved to the next control,
// the light glides there, its squares lighting and going out as it passes
// over the window's fixed grid; it breathes, slowly, while it rests. With
// reduced motion it jumps and holds still. Read from the page at each
// frame (where the control is, in what colour), never through React.
import { BAYER_MATRIX } from "@grasp-os/ui/lib/utils";

/** The grid: one square every PITCH pixels, DOT across. */
const PITCH = 3;
const DOT = 2;
/**
 * How far the light reaches from the control's edge, at most and at least
 * (a small control's light stays its own, clear of its neighbours), and
 * the clear gap kept round it, in px.
 */
const REACH = 56;
const REACH_MIN = 26;
const GAP = 3;
/** How quickly the light follows to the next control, and fades in or out: a time constant, in ms. */
const FOLLOW_MS = 130;
const FADE_MS = 220;
/** One slow breath, in ms, and how deep it goes. */
const BREATH_MS = 3600;
const BREATH = 0.14;

/** Bayer's threshold for a cell, 0 to 1: the system's one dither. */
const threshold = (column: number, row: number): number =>
  ((BAYER_MATRIX[row % 4]?.[column % 4] ?? 7.5) + 0.5) / 16;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How far a point lies outside a rounded box (negative inside). */
const outside = (px: number, py: number, box: Box, radius: number): number => {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const qx = Math.abs(px - cx) - box.w / 2 + radius;
  const qy = Math.abs(py - cy) - box.h / 2 + radius;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    radius
  );
};

const boxOf = (element: Element): Box | null => {
  const rect = element.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0
    ? null
    : { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
};

const approach = (from: number, to: number, step: number): number =>
  from + (to - from) * step;

export interface Light {
  /** Where the light goes: a control, or nowhere (it fades). */
  aim: (target: Element | null) => void;
  stop: () => void;
}

/**
 * Lights `canvas` (fixed over the window) round the control it is aimed
 * at, in the colour `colour` reads, until stopped; `still` under reduced
 * motion.
 */
export const startLight = (
  canvas: HTMLCanvasElement,
  colour: () => string,
  still: boolean
): Light => {
  const context = canvas.getContext("2d");
  let target: Element | null = null;
  let shown: Box | null = null;
  let alpha = 0;
  let last = performance.now();
  let frame = 0;
  let paint = "";
  let paintAt = -Infinity;
  let drawn = "";

  const fit = (): number => {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(window.innerWidth * ratio);
    const height = Math.round(window.innerHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      drawn = "";
    }
    return ratio;
  };

  const draw = (now: number): void => {
    frame = requestAnimationFrame(draw);
    if (context === null) {
      return;
    }
    const ratio = fit();
    const dt = Math.min(80, now - last);
    last = now;
    const aimed = target === null ? null : boxOf(target);
    // Follows the control as it is now: a layout that moves takes the light with it.
    if (aimed !== null) {
      if (shown === null || still || alpha < 0.02) {
        shown = { ...aimed };
      } else {
        const step = 1 - Math.exp(-dt / FOLLOW_MS);
        shown = {
          x: approach(shown.x, aimed.x, step),
          y: approach(shown.y, aimed.y, step),
          w: approach(shown.w, aimed.w, step),
          h: approach(shown.h, aimed.h, step),
        };
      }
    }
    const wanted = aimed === null ? 0 : 1;
    alpha = still
      ? wanted
      : approach(alpha, wanted, 1 - Math.exp(-dt / FADE_MS));
    if (now - paintAt > 400) {
      paint = colour();
      paintAt = now;
    }
    const breath = still
      ? 1
      : 1 - BREATH + BREATH * Math.sin((now / BREATH_MS) * Math.PI * 2);
    const strength = alpha * breath;
    const key =
      shown === null
        ? "none"
        : `${shown.x.toFixed(1)},${shown.y.toFixed(1)},${shown.w.toFixed(1)},${shown.h.toFixed(1)},${strength.toFixed(3)},${paint}`;
    // Nothing moved: nothing to draw again.
    if (key === drawn) {
      return;
    }
    drawn = key;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (shown === null || strength < 0.01) {
      return;
    }
    const box = shown;
    const radius = Math.min(box.h / 2, box.w / 2, 18);
    const reach = Math.max(
      REACH_MIN,
      Math.min(REACH, Math.min(box.w, box.h) * 0.9)
    );
    context.fillStyle = paint;
    const fromColumn = Math.max(0, Math.floor((box.x - reach) / PITCH));
    const toColumn = Math.ceil((box.x + box.w + reach) / PITCH);
    const fromRow = Math.max(0, Math.floor((box.y - reach) / PITCH));
    const toRow = Math.ceil((box.y + box.h + reach) / PITCH);
    for (let row = fromRow; row <= toRow; row += 1) {
      for (let column = fromColumn; column <= toColumn; column += 1) {
        const x = column * PITCH;
        const y = row * PITCH;
        const away = outside(x + DOT / 2, y + DOT / 2, box, radius) - GAP;
        if (away < 0 || away > reach) {
          continue;
        }
        const level = (1 - away / reach) ** 1.8 * strength;
        if (level > threshold(column, row)) {
          context.fillRect(x, y, DOT, DOT);
        }
      }
    }
  };

  frame = requestAnimationFrame(draw);
  return {
    aim: (next) => {
      target = next;
    },
    stop: () => {
      cancelAnimationFrame(frame);
    },
  };
};
