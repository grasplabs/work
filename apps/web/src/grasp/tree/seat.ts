// Where a tree's chevron stands. On its own, a Tree gives every row a chevron column before its icon.
// A host whose rows already stand on their own columns (Sidebar's group content) seats the chevron
// in the icon's place instead: the icon shows, and a branch's chevron takes its place under a
// pointer, with the keys on it, while it is open, and always on a touch screen.
import { createContext } from "react";

/** Where the chevron stands: a column of its own, or in the icon's place. */
export type TreeChevronSeat = "column" | "icon";

/** Where the tree's chevrons stand. */
export const TreeChevronSeated = createContext<TreeChevronSeat>("column");
