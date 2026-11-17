// The Sidebar's words for a row's own menu and its rename (row-actions.tsx): every word is a prop on
// the row, with these English defaults, so a product can translate all of it.

/** The three dots' name: which row's menu they open. */
export const defaultActionsLabel = (label: string): string =>
  `More for ${label}`;

/** The rename field's name: which row it renames. */
export const defaultRenameLabel = (label: string): string => `Rename ${label}`;

/** What a screen reader hears once a row is renamed. */
export const defaultRenamedLabel = (name: string): string =>
  `Renamed to ${name}`;
