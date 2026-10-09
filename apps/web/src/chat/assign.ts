// Pairs every row with a column of its own so that the summed cost is as
// low as it can be (the Hungarian method, in the form that keeps a price
// per row and per column), from the prototype (grasplabs/prototype
// `lib/assign.ts`). Grasp's sign uses it to send each of its dots into a
// figure along the shortest ways.

/** Reads a typed array where the index is known to be inside it. */
const at = (values: ArrayLike<number>, index: number): number =>
  values[index] ?? 0;

/**
 * Each row's column, for the least summed cost. There must be at least as
 * many columns as rows; `cost` holds row after row.
 */
export const leastCostPairs = (
  rows: number,
  columns: number,
  cost: ArrayLike<number>
): Int32Array => {
  if (rows > columns) {
    throw new Error("leastCostPairs needs at least as many columns as rows");
  }
  // Everything is counted from 1, with 0 as "none", as the method is
  // usually written.
  const rowPrice = new Float64Array(rows + 1);
  const columnPrice = new Float64Array(columns + 1);
  const rowOf = new Int32Array(columns + 1);
  const cameFrom = new Int32Array(columns + 1);
  const least = new Float64Array(columns + 1);
  const used = new Uint8Array(columns + 1);
  for (let row = 1; row <= rows; row += 1) {
    rowOf[0] = row;
    let column = 0;
    least.fill(Number.POSITIVE_INFINITY);
    used.fill(0);
    // Grows a path from the new row to a free column, cheapest step first.
    do {
      used[column] = 1;
      const from = at(rowOf, column);
      const base = (from - 1) * columns - 1;
      let step = Number.POSITIVE_INFINITY;
      let next = 0;
      for (let other = 1; other <= columns; other += 1) {
        if (at(used, other) === 0) {
          const reduced =
            at(cost, base + other) -
            at(rowPrice, from) -
            at(columnPrice, other);
          if (reduced < at(least, other)) {
            least[other] = reduced;
            cameFrom[other] = column;
          }
          if (at(least, other) < step) {
            step = at(least, other);
            next = other;
          }
        }
      }
      for (let other = 0; other <= columns; other += 1) {
        if (at(used, other) === 0) {
          least[other] = at(least, other) - step;
        } else {
          const owner = at(rowOf, other);
          rowPrice[owner] = at(rowPrice, owner) + step;
          columnPrice[other] = at(columnPrice, other) - step;
        }
      }
      column = next;
    } while (at(rowOf, column) !== 0);
    // Walks the path back, moving each row on it to the column it reached.
    do {
      const before = at(cameFrom, column);
      rowOf[column] = at(rowOf, before);
      column = before;
    } while (column !== 0);
  }
  const columnOf = new Int32Array(rows);
  for (let column = 1; column <= columns; column += 1) {
    const row = at(rowOf, column);
    if (row !== 0) {
      columnOf[row - 1] = column - 1;
    }
  }
  return columnOf;
};
