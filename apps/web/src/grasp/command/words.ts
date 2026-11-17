// Command's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's text props still win until the breaking release's step 5.
export const commandWords = {
  /** The search field's words before anything is typed. */
  placeholder: "Search",
  /** What the list says when nothing matches. */
  empty: "No results",
  /** What a failed command says when it has no `failedLabel` of its own. */
  failed: "Failed",
  /** What the list says while results load. */
  loading: "Searching",
  /** The More button's name, from the command's words. */
  more: (label: string) => `More for ${label}`,
  /** How to reach a result's More, said once to a screen reader. */
  moreHint: "Right arrow for more",
  /** CommandDialog's trigger: the words on its button. */
  dialogTrigger: "Search",
  /** CommandDialog's search field before anything is typed: a verb and the thing. */
  dialogPlaceholder: "Type a command or search",
};

export type CommandWords = typeof commandWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    command: CommandWords;
  }
}
