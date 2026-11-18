// Context menu's own words, in English, shared with Menubar, which draws its menus from the same
// parts. The product gives them in its languages through GraspWords (src/words); a caller's
// `failedLabel` (and an action's own) still wins until the breaking release's step 5.
export const contextMenuWords = {
  /** Shown on an action and said when it failed, unless the action gives its own words. */
  failed: "Failed",
};

export type ContextMenuWords = typeof contextMenuWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    contextMenu: ContextMenuWords;
  }
}
