import { signInCast } from "./people.ts";
import { warmPlatform } from "./platform-warm-up.ts";

/**
 * Signs in the configured admin and the warm-up's builder, connects the
 * stack's AI providers, then loads the platform's code once
 * (`warmPlatform`). Each test file's people are signed in as it starts
 * (`fileCast`, e2e/contexts.ts). Playwright runs it once the web server is
 * up and before any test.
 */
const setup = async (): Promise<void> => {
  const [first] = await signInCast();
  const builder = first?.platformWarmUp?.builder;
  if (builder === undefined) {
    throw new Error("Nobody is signed in to warm the platform up");
  }
  await warmPlatform(builder);
};

export default setup;
