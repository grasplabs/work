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
import { compileExpression } from "@grasp-os/workflow-expressions/evaluate";
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
import { stopModelProviders } from "./model-provider.ts";
import { closeOpenSockets } from "./open-sockets.ts";
import { resetStorage } from "./reset-storage.ts";
import { connectDb, testBinding } from "./test-env.ts";

// Every module core loads on first use rather than at startup (each
// `await import(` under src, and jq in @grasp-os/workflow-expressions),
// loaded here up front, for two reasons. A core module that adds one adds
// it here.
//
// Transform time: Vite transforms a module the first time a test imports
// it, seconds for some, which would land in the middle of a test's timing.
// On a laptop the agent loop took 1.6 s at a chat's first turn and the
// channels' door 0.3 s at their first message; on loaded CI runners,
// together, long enough that a streamed answer's first words missed their
// 15 s (channels-stream.test.ts).
//
// Imports cut off mid-load: a module whose first import starts inside a
// Durable Object can never load at all. A workflow step imports
// postal-mime or jq, a workspace imports the agent loop at a chat's first
// turn. The module runner keeps that import's
// promise for every later import of the module in this runtime, but the
// next file's reset (reset-storage.ts) aborts the object mid-import, so
// the promise never settles: each later import, such as a test running
// the quarter-hour tasks itself (maintenance.ts), waited until its test
// timed out. Loaded here, in the runner's own context and before any
// object runs, they are already evaluated when one asks.
await Promise.all([
  // models.ts (model-catalog.ts)
  import("@earendil-works/pi-ai/api/anthropic-messages"),
  import("@earendil-works/pi-ai/api/openai-responses"),
  import("@earendil-works/pi-ai/api/openai-completions"),
  // auth/auth.ts
  import("@better-auth/sso"),
  // channels/teams.ts
  import("../src/channels/teams-adapter.ts"),
  // entry.ts, clock.ts, agent-workflows.ts
  import("../src/channels/door.ts"),
  import("../src/channels/answer.ts"),
  import("../src/channels/workflow-offers.ts"),
  // workflows/kept-email.ts
  import("postal-mime"),
  // workspace.ts
  import("../src/agent.ts"),
  import("../src/agent-thinking.ts"),
  // builtins.ts
  import("#blueprints"),
  // apps.ts, lazy because these modules import it back
  import("../src/app-candidates.ts"),
  import("../src/migration-evidence.ts"),
  import("../src/app-tests.ts"),
  import("../src/app-activation.ts"),
  import("../src/app-releases.ts"),
  import("../src/screen-references.ts"),
  // jq (workflow-expressions' jq.ts), which only a compile or run loads:
  // compiling a literal no test uses loads its runtime and WebAssembly.
  compileExpression('"start-each-file"', {
    stage: "taskDefinition",
    scope: [],
    pointer: "",
  }),
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
/** How long the built-ins' audit events may take to leave the outboxes. */
const installDrainedWithinMs = 30_000;

/** How often the outboxes are read again while events are left in them. */
const installDrainPollMs = 50;

/** How many audit events wait in core's and Knowledge's outboxes. */
const outboxed = async (): Promise<number> => {
  const counts = await Promise.all(
    [env.DB, env.KNOWLEDGE].map(
      async (database) =>
        (await database
          .prepare("SELECT count(*) AS left FROM audit_outbox")
          .first<number>("left")) ?? 0
    )
  );
  return counts.reduce((total, count) => total + count, 0);
};

/**
 * Waits until the built-ins' audit events have left the outboxes, then
 * for the calls that drained them to go quiet. The install's events drain
 * in the background (`waitUntil`), each drain reading the outbox, calling
 * the AuditLog object and settling the rows, after the install's request
 * ended. A reset that aborts an object mid-call leaves the module
 * runner's import for it pending for good (see the imports above), and
 * every request after it waited until its test timed out. On a loaded CI
 * runner the drains were still going when the reset came: experiment
 * E02, first on its shard, hung on its first sign-in for all its tests.
 * Fails, rather than resetting under them, if they never finish.
 */
const installDrained = async (): Promise<void> => {
  const deadline = Date.now() + installDrainedWithinMs;
  // oxlint-disable-next-line no-await-in-loop -- read until empty
  while ((await outboxed()) > 0) {
    if (Date.now() > deadline) {
      throw new Error("The built-ins' audit events never left the outboxes");
    }
    // oxlint-disable-next-line no-await-in-loop -- read again after a pause
    await scheduler.wait(installDrainPollMs);
  }
  await backgroundCallsQuiet();
};

// The built-ins' install, once per runtime, then empty storage again once
// what it left going is done.
if (await installBuiltinsFirst()) {
  await installDrained();
  await startEmpty();
}

afterEach(closeOpenSockets);

// The model providers a file's tests answer for stop looking for requests
// once its tests are done (model-provider.ts).
afterAll(stopModelProviders);

// Setup files' afterAll hooks run last: once the file's tests and their
// hooks are done, it waits for the calls they left going
// (background-calls.ts).
afterAll(backgroundCallsQuiet, quietHookMs);
