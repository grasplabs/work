// A row of an ItemGroup, marked so the hairline inside it can stand back on the first row.
import * as stylex from "@stylexjs/stylex";

export const itemRowMarker = stylex.defineMarker();

// An item's row in the parts shape (release step 6), so its mark can stand centred when the row has
// no description, read from the row itself.
export const itemMarker = stylex.defineMarker();
