import { seedConnections } from "./connections-seed.ts";
import { signInCast } from "./people.ts";
import { warmPlatform } from "./platform-warm-up.ts";

/**
 * Signs in everyone the tests need for their first attempt, and writes the
 * connections they find, then loads the platform's code once
 * (`warmPlatform`). A retry signs in its own (`signInRetry`). Playwright
 * runs it once the web server is up and before any test.
 */
const setup = async (): Promise<void> => {
  const [first] = await signInCast();
  if (first === undefined) {
    throw new Error("Nobody is signed in for the first attempt");
  }
  await seedConnections(first, 0);
  const builder = first.platformWarmUp?.builder;
  if (builder === undefined) {
    throw new Error("Nobody is signed in to warm the platform up");
  }
  await warmPlatform(builder);
};

export default setup;
