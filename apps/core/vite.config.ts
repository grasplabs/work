import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defaultExclude, defineProject } from "vite-plus";
import type { UserWorkspaceConfig } from "vite-plus";

import { oxcParseTestConfig } from "../../packages/runtime/oxc-parse-test-config.ts";
import { testComposioKey } from "../connect/test/provider-config.ts";
import { digestModuleOf, testBlueprintsModule } from "./build-blueprints.ts";
import { connectBundle } from "./test/build-connect.ts";
import { testVersionModule } from "./test/compiler-version.ts";
import {
  connectClient,
  connectProvidersScript,
  connectVersionMetadata,
  platformAnthropicKey,
  platformElevenLabsKey,
  directoryClient,
  documentsClient,
  googleConnectClient,
  platformOpenAiKey,
  slackApp,
  teamsBot,
} from "./test/connect-providers.ts";
import { testSignIn } from "./test/sign-in-config.ts";
import { testAssets } from "./test/test-run.ts";
import { withNoBackgroundCompile } from "./workerd-v8-flags.ts";

// Background compilation off in the tests' workerd (workerd-v8-flags.ts).
process.env.MINIFLARE_WORKERD_V8_FLAGS = withNoBackgroundCompile(
  process.env.MINIFLARE_WORKERD_V8_FLAGS
);

const coreMigrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/core/migrations`
);
const knowledgeMigrations = await readD1Migrations(
  `${import.meta.dirname}/../../packages/brain/src/db/migrations`
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
 * The tests that run the compiler on whole Apps: the App compiler's,
 * and the App sandbox's, which builds each App's server code. They run as
 * their own project (vite.pages.config.ts), after the others, so their
 * long compiles don't starve the light tests of CPU.
 */
export const pageTests = [
  "test/page*.test.ts",
  "test/app-releases*.test.ts",
  "test/migration-run.test.ts",
  "test/app-functions.test.ts",
  "test/app-packages.test.ts",
  "test/app-invocation-isolation.test.ts",
  "test/release-retention.test.ts",
  "test/release-controls.test.ts",
  "test/app-publish-stores.test.ts",
  "test/app-publish.test.ts",
  "test/draft-publish.test.ts",
  "test/app-tests.test.ts",
  "test/app-test-live*.test.ts",
  "test/draft-runs.test.ts",
  "test/app-files-*.test.ts",
  "test/resource-bindings*.test.ts",
  "test/brain-recall-code.test.ts",
  "test/resource-connectors*.test.ts",
  "test/http-connections.test.ts",
  "test/sealed-workflow-starts*.test.ts",
  "test/definition-export.test.ts",
  "test/workflow-query-subscriptions.test.ts",
  "test/agent-apps.test.ts",
  "test/agent-app-functions.test.ts",
  "test/workflow-app-functions.test.ts",
  "test/workflow-app-calls.test.ts",
  "test/agent-builds*.test.ts",
  "test/app-chat-build.test.ts",
  "test/app-preview.test.ts",
  "test/workflow-ai-steps.test.ts",
  "test/decisions.test.ts",
  "test/decision-confirmations.test.ts",
  "test/decision-deadlines.test.ts",
  "test/build-on-save.test.ts",
  "test/workflow-overview.test.ts",
  "test/email-trigger-messages.test.ts",
  "test/mail-ingress.test.ts",
  "test/run-retention.test.ts",
  "test/run-controls.test.ts",
  "test/run-summary.test.ts",
  "test/run-history.test.ts",
  "test/run-object.test.ts",
  "test/rpc-targets.test.ts",
  "test/statistics.test.ts",
  "test/guests*.test.ts",
  "test/app-function-calls.test.ts",
  "test/workflow-schema-builds.test.ts",
  "test/type-check-parity.test.ts",
];

/** Core's Worker test setup, shared by each of core's test projects. */
export const coreProject = (
  test: UserWorkspaceConfig["test"],
  {
    sandboxSocket,
    bindings = {},
    services = {},
    plugins = [],
    main,
    durableObjects,
  }: {
    /**
     * For the on-prem project: the sandbox supervisor's socket, read when
     * its pool starts, which core's `SANDBOX_HOST` is bound to, as on-prem
     * binds it, instead of running App code unbounded.
     */
    sandboxSocket?: () => string;
    /** Bindings a project adds to the tests' env, such as a run's size. */
    bindings?: Record<string, unknown>;
    /**
     * Services a project binds, each answered in Node, such as the
     * evaluation's local model files (vite.brain-eval.config.ts).
     */
    services?: Record<string, (request: Request) => Response>;
    /** Vite plugins a project adds before the test pool's. */
    plugins?: UserWorkspaceConfig["plugins"];
    /**
     * The Worker a project runs instead of core's own: core's, with test
     * classes beside it (test/meaning-worker.ts).
     */
    main?: string;
    /** Durable Object bindings a project gives other classes of that Worker. */
    durableObjects?: Record<string, { className: string; useSQLite: true }>;
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
      // Microsoft's Teams SDK, under the Teams adapter, is CommonJS that
      // requires dual packages (msal-node, lru-cache) the tests' module
      // fallback can't load: bundled first, as Wrangler bundles it for the
      // Worker, so each require resolves. Node's built-ins stay imports,
      // which workerd's nodejs_compat serves.
      //
      // The rest are bundled for speed: each worker's runtime fetches every
      // module it loads from Vitest one request at a time, and these
      // libraries are thousands of small ones (pi-ai's TypeBox alone over
      // 500). Bundled, a worker loads core in less than half the requests
      // (some 1,400 instead of 3,400), which six workers on a CI runner
      // all make at once. Every specifier core imports from them is
      // listed: one left off still loads, module by module, but as a second
      // copy of the library next to the bundled one.
      deps: {
        optimizer: {
          ssr: {
            enabled: true,
            include: [
              "@chat-adapter/teams",
              "zod",
              "drizzle-orm",
              "drizzle-orm/d1",
              "drizzle-orm/sqlite-core",
              "drizzle-orm/batch",
              "drizzle-orm/durable-sqlite",
              "@earendil-works/pi-ai",
              "@earendil-works/pi-ai/utils/transcript",
              "@earendil-works/pi-ai/models",
              "@earendil-works/pi-ai/utils/estimate",
              "@earendil-works/pi-ai/utils/event-stream",
              "@earendil-works/pi-ai/providers/faux",
              "@earendil-works/pi-ai/providers/anthropic.models",
              "@earendil-works/pi-ai/providers/openrouter.models",
              "@earendil-works/pi-ai/providers/openai.models",
              "@earendil-works/pi-ai/providers/mistral.models",
              "@earendil-works/pi-ai/api/anthropic-messages",
              "@earendil-works/pi-ai/api/openai-completions",
              "@earendil-works/pi-ai/api/openai-responses",
              "@earendil-works/pi-agent-core",
              "@earendil-works/pi-durable",
              "@earendil-works/pi-durable/storage/sqlite/cloudflare",
              "@earendil-works/chord",
              "@earendil-works/chord/context",
              "better-auth/minimal",
              "better-auth/api",
              "better-auth/plugins/organization",
              "better-auth/plugins/organization/access",
              "better-auth/adapters/drizzle",
              "@better-auth/sso",
              "jose",
              "yaml",
              "typebox/value",
              "@orama/orama",
              "chat",
              "postal-mime",
              "csv-parse/sync",
            ],
            exclude: ["@opentelemetry/api"],
            rolldownOptions: {
              external: [
                ...builtinModules,
                ...builtinModules.map((name) => `node:${name}`),
              ],
            },
          },
        },
      },
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
        {
          find: /^#blueprints-digest$/u,
          replacement: digestModuleOf(testBlueprintsModule),
        },
        { find: /^#version$/u, replacement: testVersionModule },
        ...oxcParseTestConfig.alias,
      ],
    },
    plugins: [
      ...plugins,
      // Read when the pool starts, after the global setup wrote the bundle.
      cloudflareTest(() => ({
        wrangler: { configPath: "./wrangler.jsonc" },
        ...(main === undefined ? {} : { main }),
        // Tests run fully local, including in CI without Cloudflare credentials.
        miniflare: {
          // The embed package's test model's files as bytes, for the
          // Brain's permission harness (test/brain-next-surfaces.ts).
          modulesRules: [
            ...oxcParseTestConfig.modulesRules,
            { type: "Data", include: ["**/*.bin"] },
          ],
          ...(durableObjects === undefined ? {} : { durableObjects }),
          bindings: {
            ROUTER_SECRET: "test-router-secret",
            BETTER_AUTH_SECRET: "test-better-auth-secret-of-32-chars-or-more",
            CAPABILITY_SIGNING_KEY: capabilitySigningKey,
            ...testSignIn,
            // The client's Teams bot, so its door is open
            // (src/channels/door.ts).
            TEAMS_BOT_ID: teamsBot.id,
            // The client's Slack app, so its door is open too.
            SLACK_SIGNING_SECRET: slackApp.signingSecret,
            // Few enough statistics points to reach each bound in a test.
            STATISTICS_READ_LIMITS: "20/60",
            // A live-read budget a test spends in dozens of reads
            // (src/app.ts, test/page-client-load.test.ts).
            LIVE_READ_LIMITS: "50/300",
            // The gateway runs call the model through; tests fake the AI binding.
            // Who core's mail is from (src/mail.ts); tests capture what
            // the EMAIL binding is given (test/mail-capture.ts).
            MAIL_FROM: {
              name: "Stephen at Grasp",
              address: "onboarding@mail.grasp.test",
            },
            // workerd doesn't implement Durable Object jurisdictions.
            DURABLE_OBJECT_JURISDICTION: "none",
            // Plain workerd: no CPU limit on Code Mode's isolates.
            RUNTIME_PROFILE: "workerd",
            // No sandbox supervisor in tests but the on-prem project's: App
            // code is inspected in the test's own workerd, where a busy loop
            // would hold it (src/sandboxed.ts). scripts/workerd-sandbox.test.ts
            // tests the supervisor on plain workerd. The on-prem project
            // accepts it too, for what no sandbox runs yet (the page
            // compiler, App tests, an App's server object): wherever one
            // does, a bound SANDBOX_HOST comes first, so App code still runs
            // in its sessions there.
            SANDBOX_IN_PROCESS: "unbounded",
            // So the test of a call that never ends doesn't wait a minute.
            APP_CALL_TIMEOUT_MS: "10000",
            // The quota limits, the step limit lowered so a test reaches it
            // (src/workflows/quotas.ts); tests of the others set their own.
            TEST_QUOTA_LIMITS: { workflowSteps: testStepLimit },
            // So a run waiting on a held side effect checks again at once.
            WORKFLOW_OFF_WAIT_MS: "250",
            CORE_MIGRATIONS: coreMigrations,
            KNOWLEDGE_MIGRATIONS: knowledgeMigrations,
            CONNECT_MIGRATIONS: connectMigrations,
            ...bindings,
          },
          // Connect's database, as CONNECT_DB, so the setup can migrate it.
          d1Databases: { CONNECT_DB: "grasp-os-connect" },
          // The outside systems connect reaches, so tests can plan how
          // they answer and read what they did (test/mail-server.ts).
          serviceBindings: {
            ...services,
            CONNECT_PROVIDERS: "connect-providers",
            ...(sandboxSocket === undefined
              ? {}
              : {
                  SANDBOX_HOST: {
                    external: { address: `unix:${sandboxSocket()}`, http: {} },
                  },
                }),
          },
          // A stand-in frontend and the App compiler, written by the
          // global setup into this run's own directory.
          assets: { directory: testAssets },
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
                DURABLE_OBJECT_JURISDICTION: "none",
                // Its version metadata, as Cloudflare gives a deployed
                // connect: the version core names for it.
                CF_VERSION_METADATA: connectVersionMetadata,
                CAPABILITY_SIGNING_KEY: capabilitySigningKey,
                TOKEN_ENCRYPTION_KEY: btoa("test-token-key-of-exactly-32-b!!"),
                MICROSOFT_CLIENT_ID: connectClient.id,
                MICROSOFT_CLIENT_SECRET: connectClient.secret,
                MICROSOFT_DIRECTORY_CLIENT_ID: directoryClient.id,
                MICROSOFT_DIRECTORY_CLIENT_SECRET: directoryClient.secret,
                MICROSOFT_DOCUMENTS_CLIENT_ID: documentsClient.id,
                MICROSOFT_DOCUMENTS_CLIENT_SECRET: documentsClient.secret,
                // Google Workspace's, which the fake Google there knows:
                // Stephen's eval on Google connects through it.
                GOOGLE_CLIENT_ID: googleConnectClient.id,
                GOOGLE_CLIENT_SECRET: googleConnectClient.secret,
                COMPOSIO_API_KEY: testComposioKey,
                // The client's Teams bot, which Entra and the Bot Connector
                // in test/connect-providers.ts know.
                TEAMS_BOT_ID: teamsBot.id,
                TEAMS_BOT_TENANT_ID: teamsBot.tenant,
                TEAMS_BOT_SECRET: teamsBot.secret,
                // Its Slack app, which the fake Slack there knows.
                SLACK_BOT_TOKEN: slackApp.botToken,
                // Grasp's own keys at OpenAI, Anthropic and ElevenLabs for
                // platform features, which the fakes there take once a test
                // plans for them (OpenAI's transcription and ElevenLabs'
                // speech answer unplanned).
                OPENAI_API_KEY: platformOpenAiKey,
                ANTHROPIC_API_KEY: platformAnthropicKey,
                ELEVENLABS_API_KEY: platformElevenLabsKey,
              },
              d1Databases: { DB: "grasp-os-connect" },
              // Its clock (connect's src/clock.ts).
              durableObjects: {
                CLOCK: { className: "Clock", useSQLite: true },
              },
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
              // A fake provider sees its sender drop a request: a bridged
              // one its caller going away, any other connect stopping it
              // (test/ai-providers-fake.ts).
              compatibilityFlags: ["enable_request_signal"],
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
    ...pageTests,
    // With the sandbox supervisor bound: vite.on-prem.config.ts.
    "test/on-prem/**",
    // The Brain baseline's larger scale sizes, on request only:
    // vite.brain-scale.config.ts.
    "test/brain-scale-sizes.test.ts",
    // How fast the Brain's store scans vector codes, on request only:
    // vite.brain-vectors.config.ts.
    "test/brain-next-vector-timings.test.ts",
    // The Brain baseline against a real model, which costs money, on
    // request only: vite.brain-model.config.ts.
    "test/brain-real-model.test.ts",
    // Experiment E02 against a real reranking model, likewise:
    // vite.brain-recall-model.config.ts.
    "test/brain-recall-real-model.test.ts",
    // The Brain baseline, its CI scale size and experiment E02, in a group
    // of their own: vite.brain.config.ts.
    "test/brain-baseline*.test.ts",
    "test/brain-recall-e02.test.ts",
    "test/brain-scale-*-of-*.test.ts",
    // The Brain evaluation, on request only: vite.brain-eval.config.ts.
    "test/brain-eval.test.ts",
    // The Brain evaluation against a real model, which costs money, on
    // request only: vite.brain-eval-model.config.ts.
    "test/brain-eval-model.test.ts",
    // Recall by meaning through core, with a test model as if it shipped:
    // vite.brain-meaning.config.ts.
    "test/brain-next-meaning.test.ts",
    // Stephen's eval, in a group of its own: vite.stephen.config.ts.
    "test/stephen-eval*.test.ts",
    // Stephen's eval against a real model, which costs money, on request
    // only: vite.stephen-model.config.ts.
    "test/stephen-real-model.test.ts",
    "build-blueprints.test.ts",
    "host-json.bundle.test.ts",
  ],
});
