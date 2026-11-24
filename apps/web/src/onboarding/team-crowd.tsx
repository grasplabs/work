import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import { BAYER_MATRIX, DITHER_LEVELS } from "@grasp-os/ui/lib/utils";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

// A team on the leads step as its people: a small pixel figure for each,
// cell by cell in the system's one dither, as the welcome's cards draw
// their flags (flag-picture.tsx). Its lead stands first, a head taller, in
// the page's ink; the rest of the team in the brand's own mint behind them.
// A team too big for its row thins out toward the far end, the last of
// them specks, so a large team reads as large without a number. A team
// without a lead has only an outline where its lead would stand. A team
// switched off sits down, greyed. Drawn again as the theme changes; it
// never moves on its own.

const styles = stylex.create({
  // The lead's ink is the box's own colour, the team's the canvas's: the canvas reads both.
  box: { display: "block", color: colors.foreground },
  canvas: {
    display: "block",
    width: "100%",
    height: "1.25rem",
    color: colors.chart1,
    imageRendering: "pixelated",
  },
});

/** A cell's side in CSS pixels: the flags' own. */
const cell = 4;
/** A figure's width with the room after it, in cells. */
const pitch = 4;

const bayerAt = (x: number, y: number): number =>
  ((BAYER_MATRIX[y % 4]?.[x % 4] ?? 0) + 0.5) / DITHER_LEVELS;

/** Where a figure has cells, from the top of the row, three cells wide: head, shoulders, body, legs; some people a cell shorter. */
const standing = ["...", ".#.", "###", "###", "#.#"];
const shorter = ["...", "...", ".#.", "###", "#.#"];
/** Seated: a team that takes no part. */
const seated = ["...", "...", ".#.", "###", "###"];

/** The cells of a figure: its rows from the top, three cells each. */
const shapeOf = (lead: boolean, off: boolean, short: boolean): string[] => {
  if (off) {
    return seated;
  }
  if (lead) {
    // A lead stands a head taller: its head on the row's top line.
    return [".#.", "###", "###", "###", "#.#"];
  }
  return short ? shorter : standing;
};

/** A number from 0 to 1 for a person, always the same for the same person. */
const seedOf = (id: string): number => {
  let sum = 0;
  for (let at = 0; at < id.length; at += 1) {
    sum += (id.codePointAt(at) ?? 0) * (at + 1);
  }
  const value = Math.sin(sum * 12.9898 + 78.233) * 43_758.5453;
  return value - Math.floor(value);
};

/** How much of a figure stands at `x` cells across a row `columns` wide: whole, until a crowd too big for it thins out. */
const presence = (x: number, columns: number, count: number): number => {
  const needed = count * pitch;
  if (needed <= columns) {
    return 1;
  }
  const whole = columns * 0.55;
  if (x <= whole) {
    return 1;
  }
  const t = (x - whole) / (columns - whole);
  return Math.max(0, 1 - t) ** 1.3;
};

const draw = (
  context: CanvasRenderingContext2D,
  width: number,
  inks: { lead: string; team: string },
  {
    people,
    lead,
    off,
  }: { people: readonly string[]; lead: boolean; off: boolean }
) => {
  const count = people.length;
  const columns = Math.floor(width / cell);
  const fits = Math.floor(columns / pitch);
  const shown = Math.min(count, fits);
  for (let figure = 0; figure < shown; figure += 1) {
    const isLead = figure === 0;
    // Each person their own height and shade, the same every time.
    const seed = seedOf(people[figure] ?? "");
    const shape = shapeOf(isLead, off, seed < 0.3);
    const shade = isLead ? 1 : 0.62 + seed * 0.38;
    const left = figure * pitch;
    const much = presence(left + 1.5, columns, count);
    if (much <= 0.02) {
      break;
    }
    // No lead yet: an outline where they would stand, every other cell.
    const empty = isLead && !lead;
    for (const [row, line] of shape.entries()) {
      for (let at = 0; at < line.length; at += 1) {
        const mark = line.charAt(at);
        const x = left + at;
        if (mark !== "#" || (empty && (x + row) % 2 === 1)) {
          continue;
        }
        if (bayerAt(x, row) >= much * 1.1) {
          continue;
        }
        const side = cell * (0.3 + 0.7 * Math.min(1, much / 0.7) ** 0.6);
        const inset = (cell - side) / 2;
        context.globalAlpha = off ? 0.32 : shade * Math.min(1, 0.25 + much);
        context.fillStyle = isLead || off ? inks.lead : inks.team;
        context.fillRect(x * cell + inset, row * cell + inset, side, side);
      }
    }
  }
  context.globalAlpha = 1;
};

export const TeamCrowd = ({
  people,
  lead,
  off,
}: {
  /** The team's people by their stable ids, its lead first. */
  people: readonly string[];
  /** The team has a lead. */
  lead: boolean;
  /** The team takes no part. */
  off: boolean;
}) => {
  const box = useRef<HTMLSpanElement>(null);
  // Drawn again only when who is in the team changes.
  const key = people.join(" ");
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    const holder = box.current;
    if (
      element === null ||
      holder === null ||
      context === null ||
      context === undefined
    ) {
      return () => {
        // Nothing drawn.
      };
    }
    const everyone = key === "" ? [] : key.split(" ");
    const paint = () => {
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
      // The theme's own inks, resolved: never a copy of the palette.
      const inks = {
        lead: getComputedStyle(holder).color,
        team: getComputedStyle(element).color,
      };
      draw(context, width, inks, { people: everyone, lead, off });
    };
    paint();
    const resized = new ResizeObserver(paint);
    resized.observe(element);
    // Light or dark changes the inks.
    const themed = new MutationObserver(paint);
    themed.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-mode", "style"],
    });
    const system = matchMedia("(prefers-color-scheme: dark)");
    system.addEventListener("change", paint);
    return () => {
      resized.disconnect();
      themed.disconnect();
      system.removeEventListener("change", paint);
    };
  }, [key, lead, off]);
  return (
    <span aria-hidden="true" ref={box} {...stylex.props(styles.box)}>
      <canvas ref={canvas} {...stylex.props(styles.canvas)} />
    </span>
  );
};
