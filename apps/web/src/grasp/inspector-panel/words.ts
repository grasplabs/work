// Inspector panel's own words, in English. The product gives them in its languages through
// GraspWords (src/words); a caller's `words` still win until the breaking release's step 5.
import type { InspectorPanelWords } from "./types";

/** The panel's own words, in English. */
export const englishWords: InspectorPanelWords = {
  add: "Add",
  addTo: (label) => `Add ${label.toLowerCase()}`,
  remove: (name) => `Remove ${name}`,
  showAll: (label) => `Show all the ${label.toLowerCase()}`,
  close: "Close",
  views: "Views",
};

declare module "../words/words" {
  interface GraspWordsCatalog {
    inspectorPanel: InspectorPanelWords;
  }
}
