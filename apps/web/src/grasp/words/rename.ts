// The words of renaming a thing in place, shared by every part that renames: App shell's panel title
// (a small popup with a field) and the Sidebar's row (the row becomes a field). One entry, so a
// product translates "Rename" once. The keys are the same in both: F2 or a double-click opens it,
// Enter saves, Escape cancels.

export const renameWords = {
  /** The popup's heading, and the name of the way to open it. */
  rename: "Rename",
  /** The field's name, for a screen reader. */
  field: "Name",
  /** The button that keeps the new name. */
  save: "Save",
  /** The button that keeps the old one. */
  cancel: "Cancel",
  /** Said of a name that can be renamed, after its own words. */
  hint: "Double-click or press F2 to rename",
};

export type RenameWords = typeof renameWords;

declare module "./words" {
  interface GraspWordsCatalog {
    rename: RenameWords;
  }
}
