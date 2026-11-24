// Item's marker: the row carries it, so a part inside can answer the row's own state (its media
// centred when the row has no description, its actions shown while the row is hovered or holds
// focus). StyleX resolves a marker only when it is imported straight from a .stylex.ts file.
import * as stylex from "@stylexjs/stylex";

export const itemMarker = stylex.defineMarker();
