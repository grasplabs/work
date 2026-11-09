import { test as base } from "@playwright/test";
import type {
  BrowserContext,
  BrowserContextOptions,
  Page,
} from "@playwright/test";

import { seedConnections } from "./connections-seed.ts";
import { signInFile, signInTo } from "./people.ts";
import type { Person } from "./people.ts";

/**
 * The people the running test's file looks up, signed in for its attempt
 * (`signInFile`), and the connections scene's connections written once
 * its people are. A file whose `beforeAll` looks people up calls it there,
 * as that runs before any fixture.
 */
export const fileCast = async (): Promise<void> => {
  await signInFile(async (scenes, attempt) => {
    if (scenes.connections !== undefined) {
      await seedConnections(scenes, attempt);
    }
  });
};

/**
 * How long a file's people may take to sign in, apart from its test's own
 * time: up to a few dozen sign-ins on a loaded stack.
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
  /** Signs the file's people in before the test (`fileCast`); gives nothing. */
  fileSignedIn: undefined;
  /** A browser context of the test's own, closed when the test ends. */
  newContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
  /**
   * A page signed in as `person`, in a browser context of its own, closed
   * when the test ends.
   */
  pageOf: (person: Person, options?: BrowserContextOptions) => Promise<Page>;
}>({
  fileSignedIn: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from its first parameter's pattern, and this one has none
    async ({}, provide) => {
      await fileCast();
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Playwright's `use` takes the fixture's value, and this fixture has none
      await provide(undefined);
    },
    // Its own time, not the test's: a file's first test signs its people in.
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
