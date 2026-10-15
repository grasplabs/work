import { readFileSync } from "node:fs";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defaultExclude, defineProject } from "vite-plus";
import type { UserWorkspaceConfig } from "vite-plus";

import { testComposioKey } from "../connect/test/provider-config.ts";
import { testBlueprintsModule } from "./build-blueprints.ts";
import { connectBundle } from "./test/build-connect.ts";
import { testVersionModule } from "./test/compiler-version.ts";
import {
  connectClient,
  connectProvidersScript,
} from "./test/connect-providers.ts";
import { testSignIn } from "./test/sign-in-config.ts";

// V8's background JavaScript compilation off in the tests' workerd. Each
// package build loads a fresh Loader isolate (esbuild's WebAssembly), which
// then sits idle in the runtime that `isolate: false` keeps for the whole
// worker. A Maglev or concurrent Sparkplug job of such an isolate that
// needs a garbage collection waits on a V8 worker thread for the isolate's
// main thread to run it, which workerd only does when it runs code in that
// isolate again: never. On CI's 4-vCPU runners workerd has three worker
// threads; once three jobs wait like that, the runtime stops, and Vitest
// never times its test out (GRA-554: the stalls of package-builds and
// package-artifacts, each runtime's three worker threads parked in
// `CollectionBarrier::AwaitCollectionBackground`). Compiled on the main
// thread, no job waits. Miniflare passes this variable on to every workerd
// it starts; on CI the build-heavy files took as long with it as without.
const noBackgroundCompile = [
  "--no-concurrent-recompilation",
  "--no-concurrent-sparkplug",
];
process.env.MINIFLARE_WORKERD_V8_FLAGS = [
  ...new Set([
    ...(process.env.MINIFLARE_WORKERD_V8_FLAGS ?? "").split(" "),
    ...noBackgroundCompile,
  ]),
]
  .filter((flag) => flag !== "")
  .join(" ");

const coreMigrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/core/migrations`
);
const knowledgeMigrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/knowledge/migrations`
);
const connectMigrations = await readD1Migrations(
  `${import.meta.dirname}/../connect/src/db/migrations`
);

/**
 * Core's step limit in tests: well above what any test workflow takes,
 * but low enough to reach.
 */
const testStepLimit = 60;

/** Shared by core and connect, as in a deployment. */
const capabilitySigningKey = "test-capability-signing-key-of-32-chars-or-more";

/**
 * The tests that run the compiler on whole Apps: the screen compiler's,
 * and the App sandbox's, which builds each App's server code. They run as
 * their own project (vite.screens.config.ts), after the others, so their
 * long compiles don't starve the light tests of CPU.
 */
export const screenTests = [
  "test/screen*.test.ts",
  "test/app-sandbox.test.ts",
  "test/app-releases.test.ts",
  "test/migration-transform.test.ts",
  "test/custom-migration-runs.test.ts",
  "test/app-functions.test.ts",
  "test/app-invocation-isolation.test.ts",
  "test/release-retention.test.ts",
  "test/app-activation.test.ts",
  "test/app-tests.test.ts",
  "test/app-test-live.test.ts",
  "test/app-function-route.test.ts",
  "test/portable-client.test.ts",
  "test/resource-bindings.test.ts",
  "test/resource-connectors.test.ts",
  "test/run-functions.test.ts",
  "test/agent-apps.test.ts",
  "test/agent-app-functions.test.ts",
  "test/agent-builds.test.ts",
  "test/build-jobs.test.ts",
  "test/app-preview.test.ts",
  "test/preview-repairs.test.ts",
  "test/workflows.test.ts",
  "test/workflow-chaos.test.ts",
  "test/reviewed-calls.test.ts",
  "test/held-runs.test.ts",
  "test/unknown-outcome-runs.test.ts",
  "test/decisions.test.ts",
  "test/decision-deadlines.test.ts",
  "test/workflow-params.test.ts",
  "test/build-on-save.test.ts",
  "test/workflow-overview.test.ts",
  "test/triggers.test.ts",
  "test/email-triggers.test.ts",
  "test/event-triggers.test.ts",
  "test/event-sources.test.ts",
  "test/orphaned-runs.test.ts",
  "test/run-retention.test.ts",
  "test/run-controls.test.ts",
  "test/run-summary.test.ts",
  "test/run-history.test.ts",
  "test/rpc-targets.test.ts",
];

/** Core's Worker test setup, shared by each of core's test projects. */
export const coreProject = (
  test: UserWorkspaceConfig["test"],
  {
    sandboxSocket,
  }: {
    /**
     * For the on-prem project: the sandbox supervisor's socket, read when
     * its pool starts, which core's `SANDBOX_HOST` is bound to, as on-prem
     * binds it, instead of running App code unbounded.
     */
    sandboxSocket?: () => string;
  } = {}
) =>
  defineProject({
    test: {
      // Writes the assets the tests serve and bundles connect, once per run,
      // so each project also runs on its own.
      globalSetup: [
        "./test/global-setup.ts",
        ...(sandboxSocket === undefined ? [] : ["./test/sandbox-setup.ts"]),
      ],
      // A worker's test files share one runtime, which loads core once:
      // starting workerd and loading core took longer than most files'
      // tests. Each file still starts with empty storage and the env as
      // configured here (start-each-file.ts), after a check that the
      // runtime is workerd.
      isolate: false,
      setupFiles: [
        "../../scripts/assert-workerd.ts",
        "./test/start-each-file.ts",
      ],
      // Logs go straight to workerd's output, not to Vitest over RPC. A log
      // from another request (a workflow run, a cron run, a Durable
      // Object) can't use the test's socket, so the pool holds it until the
      // test next sends something; one logged after the file's last message
      // was never sent, and the file waited for its reply forever.
      disableConsoleIntercept: true,
      // Tests here build Apps and run workflows in workerd, which takes far
      // longer than Vitest's 5 s default, most of all on a loaded CI runner.
      testTimeout: 60_000,
      ...test,
      // Setup files one after another, as listed (Vitest's default runs
      // them at once): the check of the runtime reports before
      // start-each-file.ts fails on its `cloudflare:` imports.
      sequence: { ...test?.sequence, setupFiles: "list" },
    },
    // The built-ins the global setup embeds, the tests' own included, in a
    // module of their own: core's build ships dist/blueprints.js. The
    // version of the compiler it builds into the tests' assets likewise.
    resolve: {
      alias: [
        { find: /^#blueprints$/u, replacement: testBlueprintsModule },
        { find: /^#version$/u, replacement: testVersionModule },
      ],
    },
    plugins: [
      // Read when the pool starts, after the global setup wrote the bundle.
      cloudflareTest(() => ({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Tests run fully local, including in CI without Cloudflare credentials.
        remoteBindings: false,
        miniflare: {
          bindings: {
            ROUTER_SECRET: "test-router-secret",
            BETTER_AUTH_SECRET: "test-better-auth-secret-of-32-chars-or-more",
            CAPABILITY_SIGNING_KEY: capabilitySigningKey,
            // The audit log works out when to purge archives from its own
            // env: the shortest archive retention the console may set.
            AUDIT_ARCHIVE_RETENTION_DAYS: "365",
            ...testSignIn,
            // Few enough statistics points to reach each bound in a test.
            STATISTICS_POINT_LIMITS: "10/25",
            STATISTICS_READ_LIMITS: "20/60",
            // One memory limit set, the others at their defaults.
            MEMORY_LIMITS: { "USER.md": 500 },
            // Package limits a test can reach with packages it publishes
            // on the fake npm registry (test/packages.test.ts).
            PACKAGE_LIMITS: {
              graphDepth: 4,
              graphPackages: 12,
              graphArchiveBytes: 512 * 1024,
              extractedBytes: 1024 * 1024,
              extractedEntries: 64,
              graphExtractedBytes: 2 * 1024 * 1024,
              artifactBytes: 256 * 1024,
              appLocks: 3,
            },
            // The gateway runs call the model through; tests fake the AI binding.
            MODEL_GATEWAY: {
              gateway: "grasp-os-test",
              models: ["workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
            },
            // workerd doesn't implement Durable Object jurisdictions.
            DURABLE_OBJECT_JURISDICTION: "none",
            // Plain workerd: no CPU limit on Code Mode's isolates.
            RUNTIME_PROFILE: "workerd",
            // No sandbox supervisor in tests but the on-prem project's: App
            // code is inspected in the test's own workerd, where a busy loop
            // would hold it (src/sandboxed.ts). scripts/workerd-sandbox.test.ts
            // tests the supervisor on plain workerd. The on-prem project
            // accepts it too, for what no sandbox runs yet (the screen
            // compiler, App tests, an App's server object): wherever one
            // does, a bound SANDBOX_HOST comes first, so App code still runs
            // in its sessions there.
            SANDBOX_IN_PROCESS: "unbounded",
            // So the test of a call that never ends doesn't wait a minute.
            APP_CALL_TIMEOUT_MS: "10000",
            // The quota policy, its step limit lowered so a test reaches it
            // (src/workflows/quotas.ts); tests of the others set their own.
            QUOTA_LIMITS: {
              generation: 1,
              limits: { workflowSteps: testStepLimit },
            },
            // So a run waiting on a held side effect checks again at once.
            WORKFLOW_OFF_WAIT_MS: "250",
            CORE_MIGRATIONS: coreMigrations,
            KNOWLEDGE_MIGRATIONS: knowledgeMigrations,
            CONNECT_MIGRATIONS: connectMigrations,
          },
          // Connect's database, as CONNECT_DB, so the setup can migrate it.
          d1Databases: { CONNECT_DB: "grasp-os-connect" },
          // The outside systems connect reaches, so tests can plan how
          // they answer and read what they did (test/mail-server.ts).
          serviceBindings: {
            CONNECT_PROVIDERS: "connect-providers",
            ...(sandboxSocket === undefined
              ? {}
              : {
                  SANDBOX_HOST: {
                    external: { address: `unix:${sandboxSocket()}`, http: {} },
                  },
                }),
          },
          // A stand-in frontend and the screen compiler, written by the
          // global setup.
          assets: { directory: "./dist/test-assets" },
          // The real connect Worker behind the CONNECT service binding,
          // bundled by the global setup. Given as a script: a `scriptPath`
          // fails to start in the test pool.
          workers: [
            {
              name: "grasp-os-connect",
              modules: true,
              script: readFileSync(connectBundle, "utf-8"),
              compatibilityDate: "2026-09-15",
              compatibilityFlags: [
                "nodejs_compat",
                "global_fetch_strictly_public",
              ],
              bindings: {
                CAPABILITY_SIGNING_KEY: capabilitySigningKey,
                TOKEN_ENCRYPTION_KEY: btoa("test-token-key-of-exactly-32-b!!"),
                MICROSOFT_CLIENT_ID: connectClient.id,
                MICROSOFT_CLIENT_SECRET: connectClient.secret,
                COMPOSIO_API_KEY: testComposioKey,
              },
              d1Databases: { DB: "grasp-os-connect" },
              // Its native connectors, each loaded into an isolate of its
              // own per call (connect's src/connectors.ts), as deployed.
              workerLoaders: { LOADER: {} },
              // Entra and Composio, as connect reaches them
              // (test/connect-providers.ts).
              outboundService: "connect-providers",
            },
            {
              name: "connect-providers",
              modules: true,
              script: connectProvidersScript,
              compatibilityDate: "2026-09-15",
            },
          ],
        },
      })),
    ],
  });

export default coreProject({
  // The build step's own test, and the test that bundles core's host module
  // with Wrangler, run in Node, in the root config's "scripts" project.
  exclude: [
    ...defaultExclude,
    ...screenTests,
    // With the sandbox supervisor bound: vite.on-prem.config.ts.
    "test/on-prem/**",
    "build-blueprints.test.ts",
    "host-json.bundle.test.ts",
  ],
});
