// Identity card's own words, in English. The product gives them in its languages through
// GraspWords (src/words), or one instance gives its own through `words`.
export const identityCardWords = {
  /** The facts' list, named for a screen reader. */
  facts: "Details",
};

export type IdentityCardWords = typeof identityCardWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    identityCard: IdentityCardWords;
  }
}
