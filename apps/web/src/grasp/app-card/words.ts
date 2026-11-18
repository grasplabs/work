// App card's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `labels` still win until the breaking release's step 5.
import type { AppCardLabels } from "./labels";

/** The English words, used for any a caller leaves out. */
export const englishLabels: AppCardLabels = {
  more: "More actions",
  building: "Being built",
  failed: "Didn't start",
  empty: "No preview yet",
};

declare module "../words/words" {
  interface GraspWordsCatalog {
    appCard: AppCardLabels;
  }
}
