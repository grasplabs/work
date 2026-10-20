/**
 * Runs before each test file. Files share a runtime, one per Vitest worker
 * (`isolate: false` in vite.config.ts), so each starts from empty storage,
 * the env as configured, real timers, no spies, and the databases at the
 * committed migrations. Module state in core's isolate carries over, as it
 * does between requests in production: caches keyed by IDs a reset never
 * reuses, and once-per-isolate state, such as the built-ins' install,
 * which the first file's setup runs and waits for (builtins-first.ts), and
 * the missing-table warning (platform-updates.test.ts), which only that
 * file may trip.
 */
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, vi } from "vite-plus/test";
import { z } from "zod";

import { drainsSettled, drainsStarted } from "../src/audit-outbox.ts";
import { installBuiltinsFirst } from "./builtins-first.ts";
import { configuredEnv } from "./configured-env.ts";
import { closeOpenSockets } from "./open-sockets.ts";
import { resetStorage } from "./reset-storage.ts";
import { connectDb, testBinding } from "./test-env.ts";

/** Migrations, read by vite.config.ts into bindings. */
const migrationsSchema = z.array(
  z.object({ name: z.string(), queries: z.array(z.string()) })
);

/** Empty storage, the env as configured, and the databases migrated. */
const startEmpty = async (): Promise<void> => {
  // Every Durable Object's storage, and with it every D1 database, R2 bucket
  // and workflow, connect's included: they are all Durable Objects locally.
  // Objects that went quiet are woken first, or the reset misses them
  // (reset-storage.ts).
  await resetStorage();

  // What a test changed in the env and didn't put back: restore it.
  for (const name of Object.keys(env)) {
    if (!configuredEnv.has(name)) {
      Reflect.deleteProperty(env, name);
    }
  }
  for (const [name, value] of configuredEnv) {
    Reflect.set(env, name, value);
  }

  vi.useRealTimers();
  vi.restoreAllMocks();

  await applyD1Migrations(
    env.DB,
    migrationsSchema.parse(testBinding("CORE_MIGRATIONS"))
  );
  await applyD1Migrations(
    env.KNOWLEDGE,
    migrationsSchema.parse(testBinding("KNOWLEDGE_MIGRATIONS"))
  );

  // Connect's database too: core's tests call the real connect Worker, which
  // reads its connection registry there.
  await applyD1Migrations(
    connectDb(),
    migrationsSchema.parse(testBinding("CONNECT_MIGRATIONS"))
  );
};

await startEmpty();
// The built-ins' install, once per runtime, then empty storage again.
if (await installBuiltinsFirst()) {
  await startEmpty();
}

afterEach(closeOpenSockets);

/**
 * How many rounds a file waits for its audit drains to go quiet: each
 * {@link quietMs} or two, so about 5 seconds at most, within a hook's 10. A drain in an object a test aborted
 * (`abortAllDurableObjects`, an eviction) never settles, and never calls
 * anything again either: its request is gone. So the wait gives up on
 * those, as a reset gives up on a wake (reset-storage.ts). A live drain
 * takes milliseconds; one taking this long would be a bug of its own.
 */
const quietRounds = 12;

/**
 * How long no drain may start for the file's background work to count as
 * quiet: a run a test left going takes its next step within it.
 */
const quietMs = 200;

/** The drains this file starts: those from here on. */
const firstDrain = drainsStarted();

/**
 * Waits, at most {@link quietRounds} rounds, until the drains the file
 * started have settled and none started for {@link quietMs}. On
 * `scheduler.wait`, which a test's fake timers leave alone.
 */
const drainsQuiet = async (): Promise<void> => {
  for (let round = 0; round < quietRounds; round += 1) {
    const started = drainsStarted();
    // Rounds one after another: each waits for what the last one left.
    // oxlint-disable-next-line no-await-in-loop
    const settled = await Promise.race([
      drainsSettled(firstDrain).then(() => true),
      scheduler.wait(quietMs).then(() => false),
    ]);
    if (settled) {
      // oxlint-disable-next-line no-await-in-loop
      await scheduler.wait(quietMs);
      if (drainsStarted() === started) {
        return;
      }
    }
  }
};

// A change drains its audit outbox in the background, and each drain calls
// the AuditLog object, which in this pool goes through Vitest's RPC
// channel (every call into a Durable Object imports the Worker's module
// through it). Vitest closes the file's channel once its tests end,
// failing a drain still out with "Closing rpc while "resolve" was
// pending". A file's drains aren't only its tests' own: a workflow run a
// test left going takes its next steps after the last test, and audits
// each one (GRA-880). So a file waits until its drains have gone quiet.
// Aborting every object instead stops the pool's own runner object too.
// Setup files' afterAll hooks run last.
afterAll(drainsQuiet);
