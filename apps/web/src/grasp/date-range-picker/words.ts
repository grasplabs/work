// Date range picker's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `presetsLabel` still win until the breaking release's step 5.
export const dateRangePickerWords = {
  /** The name of the group of preset ranges. Its months' buttons are Calendar's. */
  presets: "Presets",
  /** The four preset ranges' names, in order (`presetLabels` gives all four at once). */
  today: "Today",
  last7: "Last 7 days",
  last30: "Last 30 days",
  thisMonth: "This month",
};

export type DateRangePickerWords = typeof dateRangePickerWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    dateRangePicker: DateRangePickerWords;
  }
}
