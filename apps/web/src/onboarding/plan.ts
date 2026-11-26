// The plan's days (plan-story.tsx), counted from today: core plans no campaign yet.

/** The moments of the campaign, by how many days after today: until core plans one. */
export const after = { first: 2, everyone: 6, close: 9, findings: 13 } as const;

export type Moment = keyof typeof after;

/** Today, as the day the plan counts from: at noon, so no time zone moves it. */
export const planStart = (today: string): Date =>
  new Date(`${today}T12:00:00Z`);

/** The day of a moment of the plan: a weekday, so one that falls on a weekend moves to the Monday after. */
export const dateOf = (start: Date, moment: Moment): Date => {
  const date = new Date(start);
  date.setUTCDate(start.getUTCDate() + after[moment]);
  const weekday = date.getUTCDay();
  if (weekday === 6 || weekday === 0) {
    date.setUTCDate(date.getUTCDate() + (weekday === 6 ? 2 : 1));
  }
  return date;
};
