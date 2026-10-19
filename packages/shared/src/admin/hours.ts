/**
 * The one place hours and euros are calculated. Screens never store or type a total; they call
 * these functions. Counting rule from the Playbook: ten forms a day at fifteen minutes of active
 * work is 2.5 hours a day, and people only multiply when each handles their own volume.
 */

export const WEEKS_PER_MONTH = 52 / 12;

/**
 * What the hours are worth per month at the given hourly cost. This is the value of time spent
 * or freed, not realised savings: finance confirms savings.
 */
export const valuePerMonth = (
  hoursPerWeekValue: number,
  hourlyCost: number
): number => hoursPerWeekValue * WEEKS_PER_MONTH * hourlyCost;
