// Names set beside each other along one direction, never touching: each wants to stand at its
// own place (a line's last point), and where two would touch they are pushed apart as little as
// they must, kept in order and inside the room. Pure, so it is tested (scripts/chart-layout.test.ts).

/**
 * Where each name stands, in the order given: as near `want` as it can be, at least `gap` from its
 * neighbours, between `from` and `to`. When the room is too small for all of them, they share it
 * evenly from `from`.
 */
export const spread = (
  want: readonly number[],
  gap: number,
  from: number,
  to: number
): number[] => {
  const order = want
    .map((place, index) => ({ place, index }))
    .toSorted((a, b) => a.place - b.place);
  const placed = order.map((item) => Math.min(Math.max(item.place, from), to));
  // Down: each at least a gap after the one before.
  for (let index = 1; index < placed.length; index += 1) {
    placed[index] = Math.max(
      placed[index] ?? 0,
      (placed[index - 1] ?? 0) + gap
    );
  }
  // Up: the last inside the room, each at least a gap before the one after.
  const last = placed.length - 1;
  if (last >= 0) {
    placed[last] = Math.min(placed[last] ?? 0, to);
  }
  for (let index = last - 1; index >= 0; index -= 1) {
    placed[index] = Math.min(
      placed[index] ?? 0,
      (placed[index + 1] ?? 0) - gap
    );
  }
  // Too many for the room: evenly from the start.
  if ((placed[0] ?? from) < from) {
    for (const [index] of placed.entries()) {
      placed[index] = from + index * gap;
    }
  }
  const out: number[] = Array.from({ length: want.length }, () => 0);
  for (const [rank, item] of order.entries()) {
    out[item.index] = placed[rank] ?? item.place;
  }
  return out;
};
