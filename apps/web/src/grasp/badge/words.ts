// Badge's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `aria-label` still wins.
export const badgeWords = {
  /** The dot's name when it stands alone (`variant="dot"` with no words), by its tone. */
  dot: {
    neutral: "Note",
    success: "Done",
    attention: "Warning",
    danger: "Error",
    info: "Info",
  },
};

export type BadgeWords = typeof badgeWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    badge: BadgeWords;
  }
}
