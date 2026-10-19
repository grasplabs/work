// The mosaic's layout, as the prototype draws it (`lib/treemap.ts`).
// Layout geometry adapted from ParthJadhav/liveline-swift (MIT): its
// deterministic squarified treemap layout.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const worstAspectRatio = (
  row: readonly number[],
  extra: number | null,
  side: number,
  areas: readonly number[]
): number => {
  const values = row.map((index) => areas[index] ?? 0);
  if (extra !== null) {
    values.push(extra);
  }
  const sum = values.reduce((total, value) => total + value, 0);
  const maximum = Math.max(...values);
  const minimum = Math.min(...values);
  if (sum <= 0 || side <= 0 || !Number.isFinite(minimum)) {
    return Number.POSITIVE_INFINITY;
  }
  const sideSquared = side * side;
  const sumSquared = sum * sum;
  return Math.max(
    (sideSquared * maximum) / sumSquared,
    sumSquared / (sideSquared * minimum)
  );
};

/**
 * Deterministic squarified treemap layout. Values are sorted internally by
 * weight with stable index tie-breaking, then returned in their original
 * input order. Invalid and non-positive values get an empty rectangle.
 */
export const squarify = (values: readonly number[], rect: Rect): Rect[] => {
  const result: Rect[] = values.map(() => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  }));
  if (rect.width <= 0 || rect.height <= 0) {
    return result;
  }
  const items = values
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => Number.isFinite(value) && value > 0)
    .toSorted((a, b) => b.value - a.value || a.index - b.index);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0 || items.length === 0) {
    return result;
  }

  const scale = (rect.width * rect.height) / total;
  const areas = items.map((item) => item.value * scale);
  let remaining = { ...rect };
  let row: number[] = [];

  const closeRow = () => {
    if (row.length === 0) {
      return;
    }
    const rowArea = row.reduce((sum, index) => sum + (areas[index] ?? 0), 0);
    const vertical = remaining.width >= remaining.height;
    const along = vertical ? remaining.height : remaining.width;
    if (along <= 0 || rowArea <= 0) {
      row = [];
      return;
    }
    const thickness = rowArea / along;
    let offset = vertical ? remaining.y : remaining.x;
    for (const index of row) {
      const extent =
        ((areas[index] ?? 0) / rowArea) *
        (vertical ? remaining.height : remaining.width);
      const item = items[index];
      if (item !== undefined) {
        result[item.index] = vertical
          ? { x: remaining.x, y: offset, width: thickness, height: extent }
          : { x: offset, y: remaining.y, width: extent, height: thickness };
      }
      offset += extent;
    }
    remaining = vertical
      ? {
          x: remaining.x + thickness,
          y: remaining.y,
          width: Math.max(remaining.width - thickness, 0),
          height: remaining.height,
        }
      : {
          x: remaining.x,
          y: remaining.y + thickness,
          width: remaining.width,
          height: Math.max(remaining.height - thickness, 0),
        };
    row = [];
  };

  let index = 0;
  while (index < areas.length) {
    const side = Math.min(remaining.width, remaining.height);
    const withNext = worstAspectRatio(row, areas[index] ?? 0, side, areas);
    const withoutNext =
      row.length === 0
        ? Number.POSITIVE_INFINITY
        : worstAspectRatio(row, null, side, areas);
    if (row.length === 0 || withNext <= withoutNext) {
      row.push(index);
      index += 1;
    } else {
      closeRow();
      if (remaining.width <= 0 || remaining.height <= 0) {
        return result;
      }
    }
  }
  closeRow();
  return result;
};

/** `rect` with `inset` taken off each side. */
export const insetRect = (rect: Rect, inset: number): Rect => ({
  x: rect.x + inset,
  y: rect.y + inset,
  width: Math.max(0, rect.width - inset * 2),
  height: Math.max(0, rect.height - inset * 2),
});
