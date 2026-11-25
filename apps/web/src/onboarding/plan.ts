// The plan's days (plan-story.tsx, plan-scenes.ts), counted from today: core plans no campaign yet.

/** The moments of the campaign, by how many days after today: until core plans one. */
export const after = { first: 2, everyone: 6, close: 9, findings: 13 } as const;

export type Moment = keyof typeof after;

/** What a day of the plan holds, and how many talk on it. */
export interface PlanDay {
  kind: "quiet" | "talks" | "reads" | "findings";
  count: number;
}

/** Who talks on a weekday of the interviews: a few at first, the whole company after, tailing off on the last day. */
const talkersOn = (day: number): number => {
  if (day < after.everyone) {
    return 2 + ((day - after.first) % 2);
  }
  if (day === after.close) {
    return 3;
  }
  return [6, 8, 7, 8][(day - after.everyone) % 4] ?? 6;
};

/** What each day from today to the findings holds. */
export const planDays = (today: Date): PlanDay[] =>
  Array.from({ length: after.findings + 1 }, (_, day) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() + day);
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    if (day === after.findings) {
      return { kind: "findings", count: 0 };
    }
    if (weekend || day < after.first) {
      return { kind: "quiet", count: 0 };
    }
    if (day <= after.close) {
      return { kind: "talks", count: talkersOn(day) };
    }
    return { kind: "reads", count: 0 };
  });

/** Today, as the day the plan counts from: at noon, so no time zone moves it. */
export const planStart = (today: string): Date =>
  new Date(`${today}T12:00:00Z`);

/** The day of a moment of the plan. */
export const dateOf = (start: Date, moment: Moment): Date => {
  const date = new Date(start);
  date.setUTCDate(start.getUTCDate() + after[moment]);
  return date;
};
