// A command's row, marked so its More can answer a pointer anywhere on the row.
import * as stylex from "@stylexjs/stylex";

export const commandRow = stylex.defineMarker();

// A command list, marked so its rows can tell whether one of them is the open one (`current`).
export const commandMarking = stylex.defineMarker();
