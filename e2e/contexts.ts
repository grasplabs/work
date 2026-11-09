import { test as base } from "@playwright/test";
import type {
  BrowserContext,
  BrowserContextOptions,
  Page,
} from "@playwright/test";

import { seedConnections } from "./connections-seed.ts";
import { signInRetry, signInTo } from "./people.ts";
import type { Person } from "./people.ts";

/**
 * A retry's own cast, signed in before the test (`signInRetry`); a first
 * attempt's the global setup signed in. A file whose `beforeAll` looks
 * people up calls `signInRetry` there, as it runs before any fixture.
 */
export const retryCast = async (): Promise<void> => {
  await signInRetry(seedConnections);
};

/**
 * How long a retry's cast may take to sign in, apart from its test's own
 * time: over a hundred sign-ins on a loaded stack.
 */
const castSignInMs = 120_000;

/**
 * Playwright's `test`, with the browser contexts a test opens beyond its
 * own `page`. Every context these open is closed when the test ends,
 * passed or failed, so none outlives it: an open context keeps its
 * session, its `/rpc` connection and its live subscriptions going, which
 * loads the one local stack for the rest of the worker's run and can reach
 * into later tests (a person's watch caps, "signed in elsewhere" fences).
 */
export const test = base.extend<{
  /** Signs a retry's cast in before the test (`retryCast`); gives nothing. */
  retrySignedIn: undefined;
  /** A browser context of the test's own, closed when the test ends. */
  newContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
  /**
   * A page signed in as `person`, in a browser context of its own, closed
   * when the test ends.
   */
  pageOf: (person: Person, options?: BrowserContextOptions) => Promise<Page>;
}>({
  retrySignedIn: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from its first parameter's pattern, and this one has none
    async ({}, provide) => {
      await retryCast();
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Playwright's `use` takes the fixture's value, and this fixture has none
      await provide(undefined);
    },
    // Its own time, not the test's: a retry signs in a whole cast.
    { auto: true, timeout: castSignInMs },
  ],
  newContext: async ({ browser }, provide) => {
    const opened: BrowserContext[] = [];
    await provide(async (options) => {
      const context = await browser.newContext(options);
      opened.push(context);
      return context;
    });
    await Promise.all(
      opened.map(async (context) => {
        await context.close();
      })
    );
  },
  pageOf: async ({ newContext }, provide) => {
    await provide(async (person, options) => {
      const context = await newContext(options);
      await signInTo(context, person);
      return await context.newPage();
    });
  },
});
