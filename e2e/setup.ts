import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

import { seedConnections } from "./connections-seed.ts";
import { signInCast } from "./people.ts";
import { warmPlatform } from "./platform-warm-up.ts";
import { objectDatabases, origin } from "./stack.ts";

/**
 * The clock's task that has the question embedder load its model
 * (apps/core/src/clock.ts, src/embedder.ts).
 */
const embedderWarmUp = "embed.warm";

/**
 * How long the stack may take to warm the question embedder: its first
 * load copied the model's 99 MB token table in 8 to 10 s on a CI runner
 * (November 2026); without the model's files it ends at once.
 */
const warmWithinMs = 120_000;

/** How often the clock's record is read while it hasn't run the warm-up. */
const readEveryMs = 250;

/**
 * Whether the clock whose database is `file` has run `embedderWarmUp` to
 * its end, by its own record: only core's clock has the task. A file
 * without the clock's table (Miniflare's `metadata.sqlite`) hasn't.
 */
const warmUpRanIn = (file: string): boolean => {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const hasTasks =
      database
        .prepare(
          "select 1 from sqlite_master where type = 'table' and name = 'clock_tasks'"
        )
        .get() !== undefined;
    return (
      hasTasks &&
      database
        .prepare("select 1 from clock_tasks where name = ? and runs > 0")
        .get(embedderWarmUp) !== undefined
    );
  } finally {
    database.close();
  }
};

/**
 * Resolves once core's clock has warmed the question embedder up
 * (`embedderWarmUp`), which its first tick does a second after the stack's
 * first request. With the model's files there, that first load copies the
 * model into the embedder's storage and holds the stack's one workerd
 * thread for seconds: core answers nothing meanwhile. A sign-in's callback
 * caught in it had its fetch of the IdP's keys time out after the 5 s the
 * SSO plugin gives it, and was refused as `token_not_verified` (merge
 * queue, November 2026). So the setup sends the first request itself, here,
 * and signs nobody in before the clock records the warm-up as run. Throws,
 * with what it last met, when that takes longer than `warmWithinMs`.
 */
const stackWarm = async (): Promise<void> => {
  const deadline = AbortSignal.timeout(warmWithinMs);
  // Any request starts the clock (apps/core/src/entry.ts).
  const first = await fetch(new URL("/health", origin), { signal: deadline });
  await first.body?.cancel();
  if (!first.ok) {
    throw new Error(`Core answered /health with ${first.status}`);
  }
  let met = "no run of it recorded yet";
  while (!deadline.aborted) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- read until it has run
      const clocks = await objectDatabases("Clock");
      if (clocks.some(warmUpRanIn)) {
        return;
      }
      met = "no run of it recorded yet";
    } catch (error) {
      // The state's folders before core first writes them, or a database
      // core holds at that moment: read again.
      met = String(error);
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- read until it has run
      await sleep(readEveryMs, undefined, { signal: deadline });
    } catch {
      // The deadline passed while waiting.
    }
  }
  throw new Error(
    `Core's clock did not run ${embedderWarmUp} within ${warmWithinMs / 1000} s (last: ${met})`
  );
};

/**
 * Waits for the stack to warm the question embedder up (`stackWarm`), then
 * signs in the configured admin, the warm-up's builder and the connections
 * scene, connects the stack's AI providers, writes the connections every
 * test finds, then loads the platform's code once (`warmPlatform`). Each
 * test file's other people are signed in as it starts (`fileCast`,
 * e2e/contexts.ts). The brain-meaning part skips the platform's warm-up.
 * Playwright runs it once the web server is up and before any test.
 */
const setup = async (): Promise<void> => {
  await stackWarm();
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
