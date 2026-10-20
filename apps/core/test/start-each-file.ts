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
 * How long a file waits for its audit drains. One in an object a test
 * aborted never settles; one still running past this is let go, as a
 * reset lets go of a wake (reset-storage.ts).
 */
const drainsTimeoutMs = 5000;

/** The drains this file starts: those from here on. */
const firstDrain = drainsStarted();

// A change drains its audit outbox in the background, and each drain calls
// the AuditLog object, which in this pool goes through Vitest's RPC
// channel (every call into a Durable Object imports the Worker's module
// through it). Vitest closes the file's channel once its tests end,
// failing a drain still out with "Closing rpc while "resolve" was
// pending", so a file waits for its drains. Setup files' afterAll hooks
// run last.
afterAll(async () => {
  const timeUp = Promise.withResolvers<"time up">();
  const timer = setTimeout(() => {
    timeUp.resolve("time up");
  }, drainsTimeoutMs);
  await Promise.race([drainsSettled(firstDrain), timeUp.promise]);
  clearTimeout(timer);
});
