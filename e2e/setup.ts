import type { FullConfig } from "@playwright/test";

import { seedConnections } from "./connections-seed.ts";
import { signInCast } from "./people.ts";
import { warmPlatform } from "./platform-warm-up.ts";

/**
 * Signs in everyone the tests need, and writes the connections they find,
 * for each attempt at a test, then loads the platform's code once
 * (`warmPlatform`). Playwright runs it once the web server is up and
 * before any test.
 */
const setup = async (config: FullConfig): Promise<void> => {
  const retries = config.projects.map((project) => project.retries);
  const cast = await signInCast(Math.max(0, ...retries) + 1);
  await seedConnections(cast);
  const builder = cast[0]?.platformWarmUp?.builder;
  if (builder === undefined) {
    throw new Error("Nobody is signed in to warm the platform up");
  }
  await warmPlatform(builder);
};

export default setup;
