/**
 * Now, as the release import reads it to tell which month's ids have
 * begun (`YY.MM.N`, @grasp-os/shared/release-id). Its own module so that
 * the tests, whose releases are each test file's own month far ahead,
 * run in that month (test/release-clock.ts, by an alias in
 * vite.test.config.ts).
 */
import "@tanstack/react-start/server-only";

export const releaseNow = (): Date => new Date();
