// Panel's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `closeLabel`, `viewsLabel` and PanelText's `openLabel` still win until the breaking release's step 5.
export const panelWords = {
  /** The header's close button. */
  close: "Close",
  /** The name of the header's views, as tabs. */
  views: "Views",
  /** PanelText's button that opens a long text in place. */
  showAll: "Show all",
};

export type PanelWords = typeof panelWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    panel: PanelWords;
  }
}
