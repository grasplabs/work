// The cursors' names in the order the layouts draw them. The words themselves are in words.ts.
import type { AppBuildingCursors } from "./words";

export type { AppBuildingCursors } from "./words";
export { englishCursors, englishLabel } from "./words";

/** The cursors' names in the order the layouts number them (layouts.ts, builderOf). */
export const cursorNames = (names: AppBuildingCursors): readonly string[] => [
  names.layout,
  names.data,
  names.copy,
];
