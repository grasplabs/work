// The words App building shows and says, in English. The product gives them in its languages
// through GraspWords (src/words); a caller's `aria-label` and `cursors` still win until the
// breaking release's step 5.

/** The names on the cursors' tags, by what each builds. */
export interface AppBuildingCursors {
  /** The cursor that lays the frame out: the top bar and the sidebar. */
  layout: string;
  /** The cursor that builds the data: the chart and the table. */
  data: string;
  /** The cursor that writes the words: the cards. */
  copy: string;
}

export const englishCursors: AppBuildingCursors = {
  layout: "Layout",
  data: "Data",
  copy: "Copy",
};

/** The whole thing's name, said to a screen reader. */
export const englishLabel = "Building your app";

/** Its words in the catalogue: its name, and the cursors' names. */
export const appBuildingWords = { name: englishLabel, ...englishCursors };

export type AppBuildingWords = typeof appBuildingWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    appBuilding: AppBuildingWords;
  }
}
