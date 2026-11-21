// Code block's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's text props still win until the breaking release's step 5.
export const codeBlockWords = {
  /** The copy button's name. */
  copy: "Copy code",
  /** What the copy button says once the code is copied. */
  copied: "Copied",
  /** What the copy button says when it could not copy. */
  copyFailed: "Could not copy",
  /** The words in the head while it is still being written. */
  writing: "Writing",
  /** Show more's words. */
  more: "Show more",
  /** Show less's words. */
  less: "Show less",
};

export type CodeBlockWords = typeof codeBlockWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    codeBlock: CodeBlockWords;
  }
}
