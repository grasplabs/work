import { leadsOfTeam } from "@grasp-os/shared/onboarding";
import type { Roster } from "@grasp-os/shared/onboarding";

// The story's days and people (plan-story.tsx), read from what the admin
// just chose: the plan's days and the teams' leads. Pure.

/** An ISO day as a date, at noon, so no time zone moves it. */
export const dayAt = (day: string): Date =>
  new Date(`${day.slice(0, 10)}T12:00:00Z`);

/** A day that falls on a weekend, moved to the Monday after; a weekday as it is. As an ISO day. */
export const weekdayOf = (day: string): string => {
  const date = dayAt(day);
  const weekday = date.getUTCDay();
  if (weekday === 6 || weekday === 0) {
    date.setUTCDate(date.getUTCDate() + (weekday === 6 ? 2 : 1));
  }
  return date.toISOString().slice(0, 10);
};

/** The teams that take part, and their leads by name, the first first: those who go first. */
export const leadsOf = (
  roster: Roster | null
): { team: string; leads: string[] }[] =>
  (roster?.teams ?? [])
    .filter((team) => !team.off)
    .map((team) => ({
      team: team.name,
      leads: leadsOfTeam(team).flatMap((id) => {
        const name =
          roster?.people
            .find((person) => person.id === id && !person.away)
            ?.name.trim() ?? "";
        return name === "" ? [] : [name];
      }),
    }));
