import { seedConnections } from "./connections-seed.ts";
import { signInCast } from "./people.ts";
import { warmPlatform } from "./platform-warm-up.ts";

/**
 * Signs in the configured admin, the warm-up's builder and the connections
 * scene, connects the stack's AI providers, writes the connections every
 * test finds, then loads the platform's code once (`warmPlatform`). Each
 * test file's other people are signed in as it starts (`fileCast`,
 * e2e/contexts.ts). The brain-meaning part skips the warm-up. Playwright runs it once the web server is up and
 * before any test.
 */
const setup = async (): Promise<void> => {
  const [first] = await signInCast();
  if (first === undefined) {
    throw new Error("Nobody is signed in for the first attempt");
  }
  await seedConnections(first, 0);
  // The brain-meaning part writes no App, so it needs the platform's code
  // never; its stack's model loads instead (playwright.config.ts).
  if (process.env.GRASP_E2E_PART === "brain-meaning") {
    return;
  }
  const builder = first.platformWarmUp?.builder;
  if (builder === undefined) {
    throw new Error("Nobody is signed in to warm the platform up");
  }
  await warmPlatform(builder);
};

export default setup;
