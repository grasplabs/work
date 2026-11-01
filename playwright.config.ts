import { defineConfig, devices } from "@playwright/test";
import type { Project } from "@playwright/test";

import { localSignIn } from "./apps/core/test/sign-in-config.ts";
import {
  testAuthSecret,
  testCapabilityKey,
  testTokenKey,
} from "./e2e/people.ts";
import {
  corePort,
  e2eModel,
  e2eThinkingModel,
  connectConfig,
  idpOrigin,
  idpPort,
  modelFakePort,
  origin,
  stateDir,
} from "./e2e/stack.ts";

/**
 * What the browser's own sandbox and policy hold, run in every browser
 * engine: a screen's attacks on its frame, and the product page's refusal
 * of screen modules and package files.
 */
const browserPolicyTests = /(?:screen-attacks|product-page-scripts)\.e2e\.ts$/u;
/**
 * Grasp's go (e2e/onboarding.e2e.ts): taking it back closes the deployment,
 * which signs out everyone the other tests signed in. So it runs last, in
 * a project of its own after all the others, one test at a time.
 */
export const onboardingTests = /onboarding\.e2e\.ts$/u;
/**
 * Someone's own interview (e2e/interview.e2e.ts): its link goes out once
 * the agreements are in, which tells the team, and the onboarding's tests
 * expect links that wait. So it runs after them, one test at a time.
 */
export const interviewTests = /interview\.e2e\.ts$/u;
/**
 * The journeys that matter most, end to end (e2e/*-journey.e2e.ts): the
 * admin's onboarding, an employee's interview on a phone, a lead's by
 * voice. Each sends links, which tells the team, and replaces the roster
 * the tests before read, so they run last, one at a time.
 */
export const journeyTests = /journey\.e2e\.ts$/u;
/**
 * What grants, retires or revokes package approvals: each bumps the
 * deployment's shared policy generation in the one database every worker
 * uses, so a decision another worker's browser already shows is refused as
 * stale. They run in a project of their own, one test at a time.
 */
const packageApprovalTests = /(?:dashboard|engine-packages|inbox)\.e2e\.ts$/u;
/**
 * The admin's journeys (e2e/admin): they run on a stack of their
 * own (playwright.admin.config.ts).
 */
const adminTests = /\/e2e\/admin\//u;
const ci = process.env.CI === "true";

/** A `--var` for wrangler dev, quoted once for the shell. */
const devVar = (name: string, value: string): string =>
  `--var '${name}:${value}'`;

/**
 * The projects that run side by side, from the start: the product's tests
 * in Chromium, the package approvals one at a time, and the browser policy
 * tests in each engine.
 */
const parallelProjects: Project[] = [
  {
    name: "chromium",
    use: { ...devices["Desktop Chrome"] },
    testIgnore: [
      onboardingTests,
      packageApprovalTests,
      interviewTests,
      journeyTests,
      adminTests,
    ],
  },
  {
    name: "package-approvals",
    use: { ...devices["Desktop Chrome"] },
    testMatch: packageApprovalTests,
    workers: 1,
  },
  // A screen's frame and the product page are held by the browser's own
  // sandbox and policy, so what they can't do is shown in each engine:
  // only those files, as the rest tests the product, not the browser.
  {
    name: "firefox",
    use: { ...devices["Desktop Firefox"] },
    testMatch: browserPolicyTests,
  },
  {
    name: "webkit",
    use: { ...devices["Desktop Safari"] },
    testMatch: browserPolicyTests,
  },
];

/**
 * The projects that run one after another, after `before` on the same
 * stack: Grasp's go, then the interviews, then the journeys, each changing
 * what every test after it sees.
 */
const serialProjects = (before: string[]): Project[] => [
  {
    name: "onboarding",
    // Never tried again (below), so a trace is kept of the run that failed.
    use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
    testMatch: onboardingTests,
    dependencies: before,
    workers: 1,
    // Not tried again: once a link is out the team is told, and nothing
    // undoes that (the agreements stay as they were), so a second try
    // would only fail on what the first one did. A failure shows as itself.
    retries: 0,
  },
  {
    name: "interview",
    use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
    testMatch: interviewTests,
    dependencies: ["onboarding"],
    workers: 1,
  },
  {
    name: "journeys",
    // Never tried again: a flaky journey shows as itself, with the trace
    // of the run that failed.
    use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
    testMatch: journeyTests,
    dependencies: ["interview"],
    workers: 1,
    retries: 0,
  },
];

/**
 * Which part of the suite runs (`GRASP_E2E_PART`): all of it, on one
 * stack, unless CI splits it. Playwright runs a project's dependencies in
 * full on every shard, so `--shard` alone can't split a suite whose
 * serial tail depends on everything before it. CI runs the parallel part
 * in parts (`parallel`, with the files of each), and each serial project
 * on a stack of its own (`onboarding`, `interview`, `journeys`, the
 * journeys a file a stack with `--shard`): they run one after another
 * only so that what one does can't change what the next sees, and a
 * stack of its own sees nothing before it. One stack held all three, 18
 * tests one at a time, about 7 minutes (October 2026, GRA-1094). `serial`
 * runs the three in turn on one stack. Locally all of it runs on one
 * stack, the serial projects last.
 */
const e2eProjects = (): Project[] => {
  const part = process.env.GRASP_E2E_PART;
  if (part === undefined || part === "") {
    return [
      ...parallelProjects,
      ...serialProjects(parallelProjects.map(({ name }) => name ?? "")),
    ];
  }
  if (part === "parallel") {
    return parallelProjects;
  }
  if (part === "serial") {
    return serialProjects([]);
  }
  const alone = serialProjects([]).find(({ name }) => name === part);
  if (alone !== undefined) {
    return [{ ...alone, dependencies: [] }];
  }
  throw new Error(
    `GRASP_E2E_PART is "${part}": leave it unset, or set "parallel", "serial", "onboarding", "interview" or "journeys".`
  );
};

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  // Must cover a test's longest waits one after another. The decision
  // test's are the longest (e2e/decisions.e2e.ts): up to 30 s for the ask,
  // 15 s for each of three page loads and the answer, then 30 s for the
  // run to end: 2 minutes, before its clicks and sign-ins.
  timeout: 180_000,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  // Two workers, locally as in CI: one local dev server serves every test,
  // and more at once slow it past the tests' waits (pages, live updates).
  workers: 2,
  globalSetup: "./e2e/setup.ts",
  reporter: ci ? "github" : "list",
  use: {
    baseURL: origin,
    trace: "on-first-retry",
  },
  projects: e2eProjects(),
  // Never a server already running: on this checkout's ports (e2e/stack.ts)
  // that is a stale run or another checkout's stack, with state the tests
  // don't expect. Playwright then fails, naming the port.
  webServer: [
    // The full local stack: core serves the built frontend, as in
    // production. `--local` keeps remote bindings off, so it runs without
    // Cloudflare credentials. It starts from empty state, as in CI, kept
    // apart from `vp run dev`'s. This can't wait for the global setup,
    // which Playwright runs once the servers are up. People sign in through
    // the fake IdP below (e2e/people.ts).
    {
      command: [
        // Connect's config, which sends the AI providers' requests to the
        // fake ones below (e2e/connect-config.ts).
        "node e2e/connect-config.ts &&",
        // The dir comes from `env` below, so no path is ever shell syntax.
        'rm -rf "$DEV_PERSIST_TO" &&',
        `vp run --filter @grasp-os/core dev --local --port ${corePort}`,
        devVar("BETTER_AUTH_SECRET", testAuthSecret),
        ...Object.entries(localSignIn(origin, idpOrigin)).map(([name, value]) =>
          devVar(
            name,
            typeof value === "string" ? value : JSON.stringify(value)
          )
        ),
        // A run waits on its person (a held change, or a call whose answer
        // was lost) checking every 2 s at first, not every minute, so a
        // test sees it go on once they decided.
        devVar("WORKFLOW_OFF_WAIT_MS", "2000"),
        // The Models page shows the rules and budgets.
        devVar(
          "MODEL_GATEWAY",
          JSON.stringify({
            eu: { models: [e2eModel, e2eThinkingModel], deployment: true },
            budgets: { deployment: { limit: 250 }, user: { limit: 20 } },
          })
        ),
      ].join(" "),
      env: {
        DEV_PERSIST_TO: stateDir,
        // Core's dev script runs connect with it (e2e/connect-config.ts).
        CONNECT_WRANGLER_CONFIG: connectConfig,
        // Core signs each connector call's capability and connect checks
        // it: from the environment, which wrangler gives both Workers, as
        // a `--var` reaches core alone.
        CAPABILITY_SIGNING_KEY: testCapabilityKey,
        // Connect seals the AI provider keys the stack connects with it.
        TOKEN_ENCRYPTION_KEY: testTokenKey,
      },
      port: corePort,
      reuseExistingServer: false,
      // Building the frontend and starting wrangler takes about 120 s on a
      // CI runner, so a runner a few seconds slower missed a 120 s limit
      // before any test ran.
      timeout: 240_000,
    },
    // Stands in for the AI providers: connect sends every model request
    // here, so none leaves the machine (e2e/model-fake.ts).
    {
      command: "node e2e/model-fake.ts",
      port: modelFakePort,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    // Stands in for the client's Entra tenant.
    {
      command: `node_modules/.bin/wrangler dev -c apps/core/test/idp.wrangler.jsonc --port ${idpPort}`,
      port: idpPort,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
