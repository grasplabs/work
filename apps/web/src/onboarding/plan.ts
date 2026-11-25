// The plan's days (plan-story.tsx, plan-demo.tsx), counted from today: core plans no campaign yet.

/** The moments of the campaign, by how many days after today: until core plans one. */
export const after = { first: 2, everyone: 6, close: 9, findings: 13 } as const;

export type Moment = keyof typeof after;

/** Today, as the day the plan counts from: at noon, so no time zone moves it. */
export const planStart = (today: string): Date =>
  new Date(`${today}T12:00:00Z`);

/** The day of a moment of the plan. */
export const dateOf = (start: Date, moment: Moment): Date => {
  const date = new Date(start);
  date.setUTCDate(start.getUTCDate() + after[moment]);
  return date;
};

/** A day of the plan as the admin reads it: "Fri, Nov 27" in their language. */
export const planDateFormat = (locale: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
