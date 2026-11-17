// Avatar group's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `words` still win until the breaking release's step 5. The group's name
// is a function of the names shown and how many more there are, as a language joins a list its own
// way.
import type { AvatarGroupWords } from "./group";

export const avatarGroupWords: AvatarGroupWords = {
  more: (count) => `+${count}`,
  name: (shown, rest) => {
    if (rest > 0) {
      return `${shown.join(", ")} and ${rest === 1 ? "1 other" : `${rest} others`}`;
    }
    if (shown.length < 2) {
      return shown.join("");
    }
    return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1) ?? ""}`;
  },
};

declare module "../words/words" {
  interface GraspWordsCatalog {
    avatarGroup: AvatarGroupWords;
  }
}
