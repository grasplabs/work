// The areas with a navigation of their own, each a level of the sidebar
// (Damsko's SidebarLevels) while one of its pages is open, in place of the
// main one: by the addresses it holds. The router says which is shown. An
// area adds its level here and its SidebarLevel in app-sidebar.tsx; the way
// out of every level (way-out.tsx) follows.

/** The levels, by value, and the pages each holds. */
const levels = [{ value: "settings", at: /^\/settings(?:\/|$)/u }] as const;

/** A level of the sidebar: the main one, or an area's. */
export type Level = "main" | (typeof levels)[number]["value"];

/** The level the sidebar shows beside the page at `pathname`. */
export const levelAt = (pathname: string): Level =>
  levels.find(({ at }) => at.test(pathname))?.value ?? "main";
