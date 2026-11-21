// Calendar's own words, in English, shared by Date picker and Date range picker, which draw its
// months. The product gives them in its languages through GraspWords (src/words); a caller's
// `previousLabel`, `nextLabel` (and the day's still's `label`) still win until the breaking
// release's step 5. The months' and days' names come from the locale, not from here.
export const calendarWords = {
  /** The button to the month before. */
  previous: "Previous month",
  /** The button to the month after. */
  next: "Next month",
  /** The grid's name in a picture of one day (CalendarDayStill). */
  day: "Day",
};

export type CalendarWords = typeof calendarWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    calendar: CalendarWords;
  }
}
