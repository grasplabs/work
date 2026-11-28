/**
 * The release clock the tests run on, in place of src/releases/release-clock.ts
 * (an alias in vite.test.config.ts): mid-month in a month of each test
 * file's own, far in the future, so that each new release a file
 * publishes is the newest in the bucket the files share (test/releases.ts),
 * and its ids are of the month the import takes as this one.
 */
const MONTHS = 12;

/** The 15th of this test file's month, UTC. */
export const testReleaseMonth = new Date(
  Date.UTC(
    2030 + Math.floor(Math.random() * 60),
    Math.floor(Math.random() * MONTHS),
    15
  )
);

export const releaseNow = (): Date => testReleaseMonth;
