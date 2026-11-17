// Input's own words, in English. The product gives them in its languages through GraspWords
// (src/words); PasswordInput's `showLabel` and `hideLabel` still win until the breaking release's step 5.
export const inputWords = {
  /** The password field's button while the password is hidden. */
  showPassword: "Show password",
  /** The same button while the password shows. */
  hidePassword: "Hide password",
};

export type InputWords = typeof inputWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    input: InputWords;
  }
}
