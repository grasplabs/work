import { colors, media } from "@grasp-os/ui/lib/tokens.stylex";
import { BAYER_MATRIX, DITHER_LEVELS } from "@grasp-os/ui/lib/utils";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

// A pencil writing, dithered as an agent's figure is (Ruben, 19 Nov 2026:
// "a dither pencil that is writing"): it writes a line of joined loops,
// lifts, the line fades, and it writes again. Drawn on a canvas in 2px
// cells, each lit by the Bayer threshold between two of its lights, from
// the theme's own tokens, so it reads on a light page and a dark one.
// Only while in view; with reduced motion one still, part written. In
// forced colours it is left out: the card's words say what it is.

/** One cell's side, in CSS pixels. */
const PITCH = 2;
/** A pass: writing, holding the line, and its fading, in seconds. */
const WRITE = 3.4;
const HOLD = 1;
const FADE = 0.6;
const CYCLE = WRITE + HOLD + FADE;

/**
 * Its lights, deep to bright, then the line it writes: the pencil's
 * body in the brand's greens, its wood, its point and the line in the
 * page's ink, so both read on either ground.
 */
const lights = [
  colors.mintDeep,
  colors.brandPine,
  colors.mint,
  colors.brandSea,
  colors.brandLime,
  `color-mix(in oklch, ${colors.foreground} 22%, ${colors.background})`,
  `color-mix(in oklch, ${colors.foreground} 45%, ${colors.background})`,
  colors.foreground,
] as const;
/** The codes of the lights above, by what they colour. */
const BODY = [0, 1, 2, 3, 4] as const;
const WOOD = [5, 6] as const;
const POINT = 7;
const LINE = 7;

const styles = stylex.create({
  canvas: {
    // Over an aura behind it, which is positioned.
    position: "relative",
    display: { default: "block", [media.forcedColors]: "none" },
    width: "100%",
    height: "100%",
    imageRendering: "pixelated",
  },
});

/** Each light as a CSS colour the canvas takes, read in the theme it is shown in. */
const resolve = (host: HTMLElement): string[] => {
  const probe = document.createElement("span");
  host.append(probe);
  const resolved = lights.map((colour) => {
    probe.style.color = colour;
    return getComputedStyle(probe).color;
  });
  probe.remove();
  return resolved;
};

/** The line's point at `s` (0 to 1) of the way, in cells: loops joined along a baseline. */
const lineAt = (
  s: number,
  columns: number,
  rows: number
): { x: number; y: number } => {
  const loops = 5;
  const radius = rows * 0.07;
  const angle = s * loops * Math.PI * 2;
  return {
    x: columns * 0.14 + s * columns * 0.54 - radius * Math.sin(angle),
    y: rows * 0.66 - radius * 1.3 * (0.5 - 0.5 * Math.cos(angle)),
  };
};

/** Whether the threshold at a cell lets a level's fraction through. */
const lit = (fraction: number, column: number, row: number): boolean =>
  fraction * DITHER_LEVELS > (BAYER_MATRIX[row % 4]?.[column % 4] ?? 0);

/** Picks between a ramp's two lights round `level` (0 to 1), by the cell's threshold. */
const ramp = (
  codes: readonly number[],
  level: number,
  column: number,
  row: number
): number => {
  const scaled = Math.min(0.999, Math.max(0, level)) * (codes.length - 1);
  const low = Math.floor(scaled);
  const step = lit(scaled - low, column, row) ? 1 : 0;
  return codes[low + step] ?? codes[low] ?? 0;
};

/**
 * The pencil's code at a cell, its point at `tip`, leaning up and to the
 * right; -1 off it. Along it from the point: the graphite, the wood
 * sharpened to it, the body, a band and the end.
 */
const pencilAt = (
  column: number,
  row: number,
  tip: { x: number; y: number },
  rows: number
): number => {
  const length = rows * 0.46;
  const half = rows * 0.065;
  const lean = -Math.PI / 4.2;
  const dx = column - tip.x;
  const dy = row - tip.y;
  // Along the pencil from its point, and across it, -1 to 1.
  const along = dx * Math.cos(lean) + dy * Math.sin(lean);
  const across = (-dx * Math.sin(lean) + dy * Math.cos(lean)) / half;
  const u = along / length;
  if (u < 0 || u > 1) {
    return -1;
  }
  // Sharpened: the point and the wood narrow to nothing at the tip.
  const width = u < 0.2 ? u / 0.2 : 1;
  if (Math.abs(across) > width) {
    return -1;
  }
  // The light falls from above: brighter on the upper side.
  const shade = 0.55 - across * 0.4;
  if (u < 0.06) {
    return POINT;
  }
  if (u < 0.2) {
    return ramp(WOOD, shade, column, row);
  }
  if (u > 0.9) {
    return ramp(BODY, 0.95 - Math.abs(across) * 0.3, column, row);
  }
  if (u > 0.84) {
    return ramp(WOOD, shade + 0.3, column, row);
  }
  // Facets down the body, as a hexagonal pencil has.
  const facet = Math.abs(across) > 0.5 ? -0.18 : 0;
  return ramp(BODY, shade + facet, column, row);
};

/** Draws the pencil on `canvas` while it is in view; returns its stop. */
const mountPen = (canvas: HTMLCanvasElement): (() => void) => {
  const ctx = canvas.getContext("2d");
  const host = canvas.parentElement ?? canvas;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let colours = resolve(host);
  let columns = 0;
  let rows = 0;
  let frame = 0;
  let started = performance.now();
  let shown = false;
  const size = () => {
    const box = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    columns = Math.max(1, Math.ceil(box.width / PITCH));
    rows = Math.max(1, Math.ceil(box.height / PITCH));
    canvas.width = columns * PITCH * ratio;
    canvas.height = rows * PITCH * ratio;
    ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  const draw = (seconds: number) => {
    if (ctx === null) {
      return;
    }
    const at = seconds % CYCLE;
    const written = Math.min(1, at / WRITE);
    // The line fades in the pass's last part, cell by cell in the dither's order.
    const fading = at > WRITE + HOLD ? (at - WRITE - HOLD) / FADE : 0;
    const tip = lineAt(written, columns, rows);
    const byCode = new Map<number, number[]>();
    const mark = (code: number, column: number, row: number) => {
      const cells = byCode.get(code) ?? [];
      cells.push(column, row);
      byCode.set(code, cells);
    };
    // The line, as far as it is written: a stroke a cell and a half wide.
    const steps = Math.ceil(written * columns * 3);
    const inked = new Set<number>();
    for (let step = 0; step <= steps; step += 1) {
      const point = lineAt(
        (step / Math.max(1, steps)) * written,
        columns,
        rows
      );
      for (const [ox, oy] of [
        [0, 0],
        [1, 0],
        [0, 1],
      ] as const) {
        const column = Math.round(point.x) + ox;
        const row = Math.round(point.y) + oy;
        if (!lit(fading, column, row)) {
          inked.add(row * columns + column);
        }
      }
    }
    for (const cell of inked) {
      mark(LINE, cell % columns, Math.floor(cell / columns));
    }
    // The pencil, over the line, in the box round it only.
    const reach = Math.ceil(rows * 0.7);
    const fromColumn = Math.max(0, Math.floor(tip.x) - 2);
    const toColumn = Math.min(columns - 1, Math.ceil(tip.x) + reach);
    const fromRow = Math.max(0, Math.floor(tip.y) - reach);
    const toRow = Math.min(rows - 1, Math.ceil(tip.y) + 2);
    for (let row = fromRow; row <= toRow; row += 1) {
      for (let column = fromColumn; column <= toColumn; column += 1) {
        const code = pencilAt(column, row, tip, rows);
        if (code >= 0) {
          mark(code, column, row);
        }
      }
    }
    ctx.clearRect(0, 0, columns * PITCH, rows * PITCH);
    for (const [code, cells] of byCode) {
      ctx.fillStyle = colours[code] ?? "transparent";
      for (let index = 0; index < cells.length; index += 2) {
        ctx.fillRect(
          (cells[index] ?? 0) * PITCH,
          (cells[index + 1] ?? 0) * PITCH,
          PITCH,
          PITCH
        );
      }
    }
  };
  const tick = (now: number) => {
    draw((now - started) / 1000);
    frame = requestAnimationFrame(tick);
  };
  const play = () => {
    cancelAnimationFrame(frame);
    if (reduced) {
      // One still: most of the line written, the pencil on it.
      draw(WRITE * 0.7);
      return;
    }
    if (shown) {
      frame = requestAnimationFrame(tick);
    }
  };
  size();
  const seen = new IntersectionObserver(([entry]) => {
    shown = entry?.isIntersecting ?? false;
    if (shown) {
      started = performance.now();
    }
    play();
  });
  seen.observe(canvas);
  const resized = new ResizeObserver(() => {
    size();
    play();
  });
  resized.observe(canvas);
  // The theme's lights again when the scheme changes.
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const rescheme = () => {
    colours = resolve(host);
    play();
  };
  scheme.addEventListener("change", rescheme);
  return () => {
    cancelAnimationFrame(frame);
    seen.disconnect();
    resized.disconnect();
    scheme.removeEventListener("change", rescheme);
  };
};

/** A pencil writing, dithered; decorative, beside words that say what it stands for. */
export const PenFigure = () => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (
      element === null ||
      typeof IntersectionObserver === "undefined" ||
      typeof ResizeObserver === "undefined"
    ) {
      return () => {
        // Nothing was mounted.
      };
    }
    return mountPen(element);
  }, []);
  return (
    <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.canvas)} />
  );
};
