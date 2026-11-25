// Item's marker: the row carries it, so a part inside can answer the row's own state (its media
// centred when the row has no description, its actions shown while the row is hovered or holds
// focus). StyleX resolves a marker only when it is imported straight from a .stylex.ts file.
import * as stylex from "@stylexjs/stylex";

export const itemMarker = stylex.defineMarker();

// What an Item reads from its list. `actionRoom`: the room a row in a side panel's card keeps at its
// end for an action it does not have, an action's (a 28px button and its gap) where some row of its
// list holds one, else none. `lineAbove`: a hairline's width when a separator stands before its
// row, which in a side panel's card is the row's own top, else 0.
export const itemVars = stylex.defineVars({
  actionRoom: "0px",
  lineAbove: "0px",
});
