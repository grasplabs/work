import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";
import { BAYER, GEOMETRY, LEVELS } from "./dither";
import { ditherEdges } from "./dither-edges";

export { LEVELS } from "./dither";

export type ChartTexture = "pixels" | "dots";

/** How a bar or an area is filled: plain token colour, or a dither in one of two textures. */
export type ChartFill = "plain" | "dither-pixels" | "dither-dots";

// Both textures, in the order their patterns are drawn.
const TEXTURES: readonly ChartTexture[] = ["pixels", "dots"];

const styles = stylex.create({
  ground: { fill: grasp.chartDitherGround },
  lit: { fill: grasp.chartDitherLit },
  // Cells on whole pixels, never smoothed into each other.
  crisp: { shapeRendering: "crispEdges" },
});

/** The id of one level's pattern, for `fill="url(#…)"`. */
export const patternId = (
  chart: string,
  texture: ChartTexture,
  level: number
) => `${chart}-${texture}-${level}`;

/**
 * Every level of both textures, once per chart. Drawn into the chart's own defs, hidden from
 * screen readers with the rest of the drawing.
 */
export const ChartPatterns = ({ id }: { id: string }) => (
  <defs>
    {TEXTURES.flatMap((texture) => {
      const { pitch, square } = GEOMETRY[texture];
      const tile = pitch * 4;
      const offset = (pitch - square) / 2;
      return Array.from({ length: LEVELS + 1 }, (_, level) => (
        <pattern
          key={`${texture}-${level}`}
          id={patternId(id, texture, level)}
          width={tile}
          height={tile}
          patternUnits="userSpaceOnUse"
          {...stylex.props(styles.crisp)}
        >
          <rect width={tile} height={tile} {...stylex.props(styles.ground)} />
          {BAYER.flatMap((row, y) =>
            row.map((threshold, x) =>
              threshold < level ? (
                <rect
                  key={`${x}-${y}`}
                  x={x * pitch + offset}
                  y={y * pitch + offset}
                  width={square}
                  height={square}
                  {...stylex.props(styles.lit)}
                />
              ) : null
            )
          )}
        </pattern>
      ));
    })}
  </defs>
);

// Where band `index` starts, from `top` to `bottom`. Each inner edge sits on a cell's edge in the
// chart's own grid, so no cell is cut in half and no seam shows where two levels meet.
const bandEdge = (
  index: number,
  top: number,
  bottom: number,
  height: number,
  pitch: number
) => {
  if (index === 0) {
    return top;
  }
  if (index === LEVELS) {
    return bottom;
  }
  return Math.round((top + (index * height) / LEVELS) / pitch) * pitch;
};

/**
 * The bands of a dither fill from `top` (the value: most lit) to `bottom` (the floor: least lit),
 * across `x` to `x + width`. The caller clips them to the mark's shape.
 */
export const DitherBands = ({
  chart,
  texture,
  x,
  width,
  top,
  bottom,
}: {
  chart: string;
  texture: ChartTexture;
  x: number;
  width: number;
  top: number;
  bottom: number;
}) => {
  const { pitch } = GEOMETRY[texture];
  const height = Math.max(0, bottom - top);
  return (
    <>
      {Array.from({ length: LEVELS }, (_, index) => {
        const from = bandEdge(index, top, bottom, height, pitch);
        const to = bandEdge(index + 1, top, bottom, height, pitch);
        return to > from ? (
          <rect
            key={index}
            x={x}
            y={from}
            width={width}
            height={to - from}
            fill={`url(#${patternId(chart, texture, LEVELS - index)})`}
            {...stylex.props(styles.crisp)}
          />
        ) : null;
      })}
    </>
  );
};

/**
 * The bands of a dither fill laid across: from `lit` (the bar's tip, most lit) to `floor` (where it
 * starts, least lit), either way round, from `y` to `y + height`. The caller clips them.
 */
export const DitherAcross = ({
  chart,
  texture,
  y,
  height,
  lit,
  floor,
}: {
  chart: string;
  texture: ChartTexture;
  y: number;
  height: number;
  lit: number;
  floor: number;
}) => {
  const edges = ditherEdges(lit, floor, GEOMETRY[texture].pitch);
  return (
    <>
      {edges.slice(0, -1).map((from, index) => {
        const to = edges[index + 1] ?? from;
        const left = Math.min(from, to);
        const width = Math.abs(to - from);
        return width > 0 ? (
          <rect
            key={index}
            x={left}
            y={y}
            width={width}
            height={height}
            fill={`url(#${patternId(chart, texture, LEVELS - index)})`}
            {...stylex.props(styles.crisp)}
          />
        ) : null;
      })}
    </>
  );
};

// The texture each fill draws with: none for plain.
const TEXTURE_OF: Record<ChartFill, ChartTexture | null> = {
  plain: null,
  "dither-pixels": "pixels",
  "dither-dots": "dots",
};

export const textureOf = (fill: ChartFill): ChartTexture | null =>
  TEXTURE_OF[fill];
