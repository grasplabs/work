/**
 * `set` where it is a whole number above 0 and below `most`, else `most`:
 * a limit a deployment's configuration may lower, never raise (core's
 * `STATISTICS_READ_LIMITS`, `LIVE_READ_LIMITS`, `APP_TEST_LIMITS_MS`).
 */
export const loweredLimit = (set: number | undefined, most: number): number =>
  set !== undefined && Number.isInteger(set) && set > 0 && set < most
    ? set
    : most;
