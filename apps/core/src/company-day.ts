import { defaultTimeZone, nextScheduledRun } from "@grasp-os/shared/workflows";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "./auth/membership-sql.ts";
import { organizations } from "./db/core/schema.ts";

// The company's day: a day in the time zone the organization works in,
// from one midnight there to the next. Apart from the organization's
// settings (organization.ts), so what counts by day, the model gateway's
// spend among it, reads the zone without the settings' sign-in code.

/** The time zone the organization works in, as stored. */
export const organizationTimeZone = async (db: D1Database): Promise<string> => {
  const [row] = await drizzle(db)
    .select({ timeZone: organizations.timeZone })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.timeZone ?? defaultTimeZone;
};

/** Midnight, each day: read in the company's time zone, where its day begins. */
export const midnight = { cron: "0 0 * * *" };

/**
 * The time zone the company's days are read in: the stored one, or UTC
 * should it no longer be one the runtime knows.
 */
export const companyDayZone = async (db: D1Database): Promise<string> => {
  const stored = await organizationTimeZone(db);
  const known =
    nextScheduledRun({ ...midnight, timeZone: stored }, new Date()) !==
    undefined;
  return known ? stored : defaultTimeZone;
};

/**
 * When each of the company's days begins after `from` and before `until`:
 * the midnights in its time zone between them, the earliest first, and
 * the zone they were read in. Read in UTC should the stored zone no longer
 * be one the runtime knows. A day the clocks change on is 23 or 25 hours
 * long, so the midnights are found, never counted in 24 hours.
 */
export const companyMidnightsBetween = async (
  db: D1Database,
  from: Date,
  until: Date
): Promise<{ midnights: Date[]; timeZone: string }> => {
  const timeZone = await companyDayZone(db);
  const midnights: Date[] = [];
  for (
    let next = nextScheduledRun({ ...midnight, timeZone }, from);
    next !== undefined && next.getTime() < until.getTime();
    next = nextScheduledRun({ ...midnight, timeZone }, next)
  ) {
    midnights.push(next);
  }
  return { midnights, timeZone };
};
