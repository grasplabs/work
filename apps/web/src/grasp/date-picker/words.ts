// Date picker's own words, in English. The product gives them in its languages through GraspWords
// (src/words); DateTrigger's `fallbackLabel` still wins until the breaking release's step 5. Its
// months' previous and next buttons are Calendar's (`calendar`), and its dates are written in the
// locale.
export const datePickerWords = {
  /** The calendar button's name, when the field gives it none. */
  choose: "Choose date",
};

export type DatePickerWords = typeof datePickerWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    datePicker: DatePickerWords;
  }
}
