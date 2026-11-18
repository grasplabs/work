// Key value's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `labels` still win until the breaking release's step 5.
import type { KeyValueLabels } from "./key-value";

/** Its words in English: replace any of them through `labels`. */
export const keyValueWords: KeyValueLabels = {
  copy: (name) => `Copy ${name.toLowerCase()}`,
  copied: "Copied",
  failed: "Could not copy",
  pending: "Loading",
};

declare module "../words/words" {
  interface GraspWordsCatalog {
    keyValue: KeyValueLabels;
  }
}
