// Tag input's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `messages` still win until the breaking release's step 5.
import type { TagInputMessages } from "./tag-input";

/** What it says, in English: the catalogue's `tagInput`. */
export const tagInputWords: TagInputMessages = {
  duplicate: (word) => `"${word}" is already added.`,
  full: (most) => `Up to ${most}.`,
  empty: "Press Enter to add it.",
  invalid: "not valid",
};

declare module "../words/words" {
  interface GraspWordsCatalog {
    tagInput: TagInputMessages;
  }
}
