// Connection row's own words, in English. The product gives them in its languages through
// GraspWords (src/words); a caller's text prop still wins.
export const connectionRowWords = {
  /** The info mark's name beside the name, for who can fix it. */
  whoCanFix: "Who can fix this",
  /** Said for a broken row that has no sentence of its own. */
  notWorking: "Not working",
};

export type ConnectionRowWords = typeof connectionRowWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    connectionRow: ConnectionRowWords;
  }
}
