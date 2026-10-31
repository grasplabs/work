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

// What core loads on first use rather than at startup (models.ts,
// auth/auth.ts, channels/teams.ts, clock.ts, workflows/kept-email.ts,
// workspace.ts, entry.ts), loaded here up front: Vite transforms a module
// the first time a test imports it, seconds for these, which would land in
// the middle of a test's timing. On a laptop the agent loop took 1.6 s at
// a chat's first turn and the channels' door 0.3 s at their first
// message; on loaded CI runners, together, long enough that a streamed
// answer's first words missed their 15 s (channels-stream.test.ts).
//
// And a module whose first import starts inside a Durable Object can
// never load at all. The clock's alarm imports the Gmail channel for its
// quarter-hour tasks as soon as a test arms it, a workflow step imports
// postal-mime to read a kept message, and a workspace imports the agent
// loop at a chat's first turn. The module runner keeps
// that import's promise for every later import of the module in this
// runtime, but the next file's reset (reset-storage.ts) aborts the object
// mid-import, so the promise never settles: each later import, such as a
// test running the quarter-hour tasks itself (maintenance.ts), waited
// until its test timed out. Loaded here, in the runner's own context and
// before any object runs, they are already evaluated when one asks.
await Promise.all([
  import("@earendil-works/pi-ai/api/anthropic-messages"),
  import("@earendil-works/pi-ai/api/openai-responses"),
  import("@earendil-works/pi-ai/api/openai-completions"),
  import("@better-auth/sso"),
  import("../src/channels/teams-adapter.ts"),
  import("../src/channels/gmail.ts"),
  import("postal-mime"),
  import("../src/agent.ts"),
  import("../src/agent-thinking.ts"),
  import("../src/channels/door.ts"),
]);

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
