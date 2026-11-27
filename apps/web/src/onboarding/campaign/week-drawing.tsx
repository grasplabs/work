// One team's week, drawn in pixels as the brand draws: a square for every
// person who talked, piled day by day on a quiet ground line. Today's
// column stands in the light, dithered as the brand shades; the days to
// come wait on a dotted ground. The rows sit edge to edge, so today's
// light runs down the whole week as one band.
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import * as stylex from "@stylexjs/stylex";

import { bayerAt } from "../dither.ts";
import { usePixels } from "./pixels.ts";
import type { Put } from "./pixels.ts";

const styles = stylex.create({
  frame: { position: "relative", width: "100%", height: "100%" },
  canvas: {
    position: "absolute",
    inset: 0,
    display: "block",
    width: "100%",
    height: "100%",
    imageRendering: "pixelated",
  },
});

/** A day's squares pile two wide and up to four high, a cell apart. */
const WIDE = 2;
const HIGH = 4;

/** A square's side in cells: five, four where a day is too narrow for five (a phone). */
const sideFor = (dayWidth: number): number => (dayWidth < 16 ? 4 : 5);

/** The drawing's cell: three pixels, two on a phone's narrow week. */
const cellFor = (width: number): number => (width < 320 ? 2 : 3);

const square = (put: Put, x: number, y: number, side: number) => {
  for (let dx = 0; dx < side; dx += 1) {
    for (let dy = 0; dy < side; dy += 1) {
      put(x + dx, y + dy, "foreground");
    }
  }
};

/** One team's week, `counts` by day, `today` from 0. */
const drawWeek =
  (counts: readonly number[], today: number) =>
  (columns: number, rows: number, put: Put) => {
    const width = columns / counts.length;
    const side = sideFor(width);
    const pitch = side + 1;
    const pile = WIDE * pitch - 1;
    // The pile's foot: the pile, four high at most, stands in the row's middle.
    const top = Math.max(0, Math.floor((rows - HIGH * pitch) / 2));
    const foot = top + (HIGH - 1) * pitch;
    const ground = foot + side + 1;
    for (const [day, count] of counts.entries()) {
      const start = Math.floor(day * width);
      const end = Math.floor((day + 1) * width);
      const left = Math.floor(start + (width - pile) / 2);
      if (day === today) {
        // Today in the light: the brand's dither, thickest at the ground.
        for (let x = left - 3; x < left + pile + 3; x += 1) {
          for (let y = 0; y < rows; y += 1) {
            const near = 1 - Math.abs(y - ground) / rows;
            if (bayerAt(x, rows - y) < 0.06 + 0.22 * near * near) {
              put(x, y, "sea");
            }
          }
        }
      }
      // The ground: a line under the days gone by, dots under the days to come.
      for (let x = start + 2; x < end - 2; x += 1) {
        if (day <= today || x % 2 === 0) {
          put(x, ground, "border");
        }
      }
      // A day to come holds nothing yet: its dotted ground alone.
      const shown = day > today ? 0 : Math.min(count, WIDE * HIGH);
      for (let i = 0; i < shown; i += 1) {
        // From the foot up, as a pile.
        const x = left + (i % WIDE) * pitch;
        const y = foot - Math.floor(i / WIDE) * pitch;
        square(put, x, y, side);
      }
    }
  };

/** A team's week as a drawing, said in words to a screen reader. */
export const WeekDrawing = ({
  counts,
  today,
  label,
}: {
  counts: readonly number[];
  today: number;
  label: string;
}) => {
  const canvas = usePixels(cellFor, drawWeek(counts, today));
  return (
    <div {...stylex.props(styles.frame)}>
      <span {...stylex.props(visuallyHidden)}>{label}</span>
      <canvas aria-hidden ref={canvas} {...stylex.props(styles.canvas)} />
    </div>
  );
};
