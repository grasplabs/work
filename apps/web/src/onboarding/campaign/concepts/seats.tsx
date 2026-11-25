// Concepts only: a team's people as the brand draws them, one square a
// person on a pixel canvas of a fixed size. Who talked is ink, who talked
// today is pine, who is still to talk an empty outline, and the people of
// a team under five, whom the admin doesn't see, a quiet dither.
import * as stylex from "@stylexjs/stylex";

import { bayerAt, usePixels } from "../pixels.ts";
import type { Put, Tone } from "../pixels.ts";
import type { Seat } from "../reading.ts";

const styles = stylex.create({
  canvas: (width: number, height: number) => ({
    display: "block",
    flexShrink: 0,
    width: `${width}px`,
    height: `${height}px`,
    imageRendering: "pixelated",
  }),
});

/** A square `side` cells wide at (x, y): filled, outlined, or dithered half. */
export const square = (
  put: Put,
  x: number,
  y: number,
  side: number,
  tone: Tone,
  fill: "solid" | "outline" | "dither"
) => {
  for (let dx = 0; dx < side; dx += 1) {
    for (let dy = 0; dy < side; dy += 1) {
      const edge = dx === 0 || dy === 0 || dx === side - 1 || dy === side - 1;
      if (
        fill === "solid" ||
        (fill === "outline" && edge) ||
        (fill === "dither" && bayerAt(x + dx, y + dy) < 0.5)
      ) {
        put(x + dx, y + dy, tone);
      }
    }
  }
};

/** One person's square, as their seat says. */
export const seat = (
  put: Put,
  x: number,
  y: number,
  side: number,
  each: Seat
) => {
  if (each === "talked") {
    square(put, x, y, side, "foreground", "solid");
  } else if (each === "today") {
    square(put, x, y, side, "pine", "solid");
  } else if (each === "waiting") {
    square(put, x, y, side, "muted-foreground", "outline");
  } else {
    square(put, x, y, side, "border", "dither");
  }
};

/** How big a block of seats draws: `across` squares a line, `side` cells a square, a cell apart. */
export const seatsSize = (
  count: number,
  across: number,
  side: number,
  cell: number
): { width: number; height: number } => {
  const pitch = side + 1;
  const lines = Math.max(1, Math.ceil(count / across));
  const wide = Math.min(across, Math.max(1, count));
  return {
    width: (wide * pitch - 1) * cell,
    height: (lines * pitch - 1) * cell,
  };
};

const drawSeats =
  (seats: readonly Seat[], across: number, side: number) =>
  (_columns: number, _rows: number, put: Put) => {
    const pitch = side + 1;
    for (const [index, each] of seats.entries()) {
      seat(
        put,
        (index % across) * pitch,
        Math.floor(index / across) * pitch,
        side,
        each
      );
    }
  };

/** A block of seats, `across` a line; at least `wide` squares wide, so blocks in a list line up. */
export const Seats = ({
  seats,
  across,
  side = 4,
  cell = 3,
  wide,
}: {
  seats: readonly Seat[];
  across: number;
  side?: number;
  cell?: number;
  wide?: number;
}) => {
  const canvas = usePixels(cell, drawSeats(seats, across, side));
  const { width, height } = seatsSize(
    Math.max(seats.length, wide ?? 0),
    across,
    side,
    cell
  );
  return (
    <canvas
      aria-hidden
      ref={canvas}
      {...stylex.props(styles.canvas(width, height))}
    />
  );
};

/** A single square, for a key or a marker. */
export const Mark = ({ each, size = 4 }: { each: Seat; size?: number }) => (
  <Seats across={1} cell={3} seats={[each]} side={size} />
);
