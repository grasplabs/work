// Command's markers. StyleX resolves a marker only when it is imported straight from a .stylex.ts
// file, so they live here, beside command.tsx.
import * as stylex from "@stylexjs/stylex";

/** A command's row, marked so its More can answer a pointer anywhere on the row. */
export const commandRowMarker = stylex.defineMarker();

/** A command list, marked so its rows can tell whether one of them is the open one (`current`). */
export const commandMarker = stylex.defineMarker();
