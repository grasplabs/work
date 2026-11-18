// Drawer's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `gripLabel` still win until the breaking release's step 5.
export const drawerWords = {
  /** The grip at the drawer's edge that resizes it. */
  resize: "Resize",
};

export type DrawerWords = typeof drawerWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    drawer: DrawerWords;
  }
}
