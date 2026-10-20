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

import {
  backgroundCallsQuiet,
  countBackgroundCalls,
  quietHookMs,
} from "./background-calls.ts";
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

countBackgroundCalls();
await startEmpty();
// The built-ins' install, once per runtime, then empty storage again.
if (await installBuiltinsFirst()) {
  await startEmpty();
}

afterEach(closeOpenSockets);

// Setup files' afterAll hooks run last: once the file's tests and their
// hooks are done, it waits for the calls they left going
// (background-calls.ts).
afterAll(backgroundCallsQuiet, quietHookMs);
