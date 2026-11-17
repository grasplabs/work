// Owner picker's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `placeholder`, `empty` and `triggerLabel` still win until the breaking release's step 5.
export const ownerPickerWords = {
  /** What the field says while no one is chosen. */
  placeholder: "Choose an owner",
  /** Said in the list when no one matches. */
  empty: "No one has that name",
  /** The name of the button that opens the list of people. */
  trigger: "Show the people",
};

export type OwnerPickerWords = typeof ownerPickerWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    ownerPicker: OwnerPickerWords;
  }
}

/** What it tells an agent that chose someone outside the list: the agent reads English, so this is kept here and not in the catalogue. */
export const ownerPickerNotices = {
  notOwner: (value: string) =>
    `${value} is not one of the people who can own it`,
};
