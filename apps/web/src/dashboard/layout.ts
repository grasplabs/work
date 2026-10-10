import { standardWidgetIds } from "@grasp-os/shared/dashboard";
import type { StandardWidgetId } from "@grasp-os/shared/dashboard";

// The widget board's layout, as a person changes it (widget-board.tsx):
// which widgets are on it, in what order, moved, taken off and added, as
// the prototype's (`data/dashboard.ts`, `components/dashboard/
// widget-board.tsx`). Each change is a new list; the board saves it whole.

/** The board as it begins, and as it is for anyone who never changed theirs. */
export const defaultWidgets: readonly StandardWidgetId[] = standardWidgetIds;

/**
 * Moves `id` to place `to`, as dragging it there does: the ones between
 * each move one place over. A place past either end is that end; a widget
 * not on the board leaves it as it is.
 */
export const placeWidget = (
  widgets: readonly StandardWidgetId[],
  id: StandardWidgetId,
  to: number
): readonly StandardWidgetId[] => {
  const from = widgets.indexOf(id);
  const at = Math.min(Math.max(to, 0), widgets.length - 1);
  if (from === -1 || from === at) {
    return widgets;
  }
  const others = widgets.filter((widget) => widget !== id);
  return [...others.slice(0, at), id, ...others.slice(at)];
};

/** Moves `id` this many places earlier (negative) or later, and not past either end. */
export const moveWidget = (
  widgets: readonly StandardWidgetId[],
  id: StandardWidgetId,
  by: number
): readonly StandardWidgetId[] => {
  const from = widgets.indexOf(id);
  return from === -1 ? widgets : placeWidget(widgets, id, from + by);
};

/** The board without `id`. */
export const removeWidget = (
  widgets: readonly StandardWidgetId[],
  id: StandardWidgetId
): readonly StandardWidgetId[] => widgets.filter((widget) => widget !== id);

/** The board with `id` added last; never twice. */
export const addWidget = (
  widgets: readonly StandardWidgetId[],
  id: StandardWidgetId
): readonly StandardWidgetId[] =>
  widgets.includes(id) ? widgets : [...widgets, id];

/** Whether the board is other than it began: other widgets, or in another order. */
export const differsFromDefault = (
  widgets: readonly StandardWidgetId[]
): boolean =>
  widgets.length !== defaultWidgets.length ||
  widgets.some((widget, index) => widget !== defaultWidgets[index]);

/** The widgets Grasp has that aren't on the board, in the order the board begins with. */
export const missingWidgets = (
  widgets: readonly StandardWidgetId[]
): StandardWidgetId[] =>
  defaultWidgets.filter((widget) => !widgets.includes(widget));

/**
 * The grid of blocks as it stands on screen: where it is, its columns,
 * how large one block and the room between two are, and how many blocks.
 */
export interface GridShape {
  left: number;
  top: number;
  columns: number;
  width: number;
  height: number;
  gap: number;
  count: number;
}

/**
 * The place in the grid a point is over, counted as the blocks are; null
 * outside the grid and in the room between two blocks, so a block being
 * dragged doesn't jump back and forth on its way across. A place past the
 * last block is the last.
 */
export const slotAt = (
  shape: GridShape,
  x: number,
  y: number
): number | null => {
  if (shape.count === 0 || shape.columns === 0) {
    return null;
  }
  const column = Math.floor((x - shape.left) / (shape.width + shape.gap));
  const row = Math.floor((y - shape.top) / (shape.height + shape.gap));
  const rows = Math.ceil(shape.count / shape.columns);
  if (column < 0 || column >= shape.columns || row < 0 || row >= rows) {
    return null;
  }
  const inColumn = x - shape.left - column * (shape.width + shape.gap);
  const inRow = y - shape.top - row * (shape.height + shape.gap);
  if (inColumn > shape.width || inRow > shape.height) {
    return null;
  }
  return Math.min(row * shape.columns + column, shape.count - 1);
};
