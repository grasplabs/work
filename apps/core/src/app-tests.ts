// oxlint-disable max-classes-per-file -- one suite's host, and the session it opens for each test
import {
  appModuleName,
  isAppTestSuite,
  kitModuleName,
  workflowSdkModules,
} from "@grasp-os/compiler";
import { manifestText } from "@grasp-os/sdk/host";
import { maxAppTests, testNamePattern } from "@grasp-os/sdk/testing";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import type { OperationResult } from "@grasp-os/shared/operations";
import { boundedRpcTarget } from "@grasp-os/shared/rpc-target";
import { rpcArgumentDepth } from "@grasp-os/shared/screens";
import { eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  hostedRelease,
  noStore,
  publicOperationOf,
  readFunctionRequest,
  refusalOf,
} from "./app-functions.ts";
import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { discardFixtureStore, openFixtureStore } from "./data-stores.ts";
import type { OpenStore } from "./data-stores.ts";
import { appTestFixtures } from "./db/core/schema.ts";
import { callOperation } from "./operations.ts";
import type { Invocation } from "./operations.ts";
import { sandbox } from "./sandbox.ts";
import { requireBoundedHere } from "./sandboxed.ts";
import { buildAppTests } from "./screens.ts";
import { startFailure } from "./workflows/code.ts";

// The trusted test runner for an App's tests (spec 28.2): every suite in
// `tests/*.test.ts` runs when a version of the App is made current, and a
// failing test refuses it (`requireAppTestsPass`, apps.ts). The suites are
// App code, written with `appTest` (`@grasp-os/sdk/testing`); the host
// they call is core's, and real. Threat model, and how each is closed:
//
// - Test code reaches what it shouldn't: it runs in a Loader isolate with
//   no env and no network, as App code does, holding only the host below.
//   The compiler holds it to the SDK's root and testing modules, its own
//   files, the schema and the public `#grasp` references (app-code.ts):
//   never the App's handlers, so a test can't run a function except
//   through the host.
// - A test's calls skip what a real call goes through: each is resolved
//   against the App's release exactly as a screen's is
//   (`publicOperationOf`: public functions only, of this release and
//   contract), then run through the operation host (`callOperation`) on
//   the release's own runner, isolate and store host. Only the principal
//   and the store are the fixture's.
// - Tests read or change the App's data: each test runs on a store of its
//   own, created empty for it with the release's schema and discarded
//   after it. A fixture store is never in the store inventory, so
//   nothing opens or binds it as a business store, and its object refuses
//   to be discarded once it is listed (`DataStore.discardFixture`). Its
//   principals are the fixture's (`fixture-<name>`), never a person of
//   the organization, and no resource (connection, Knowledge, model) is
//   bound for them: a function that reaches one is refused, as outside
//   systems aren't the tests' to touch.
// - A test run dies half-way and leaves its stores: each is recorded
//   (`app_test_fixtures`) before its object is first touched, and the row
//   goes only once the object is discarded, so the quarter-hour sweep
//   discards what a run left (`sweepTestFixtures`).
// - Test code spins, hangs or answers nonsense: its isolate has a CPU
//   limit, each test and the whole suite a deadline (the SDK's and
//   `suiteTimeoutMs`), and the report is read through a bounded schema;
//   a call on a session that has ended is refused, so a test that ran
//   past its deadline changes nothing more.

/** An App's files at one version, by path. */
type AppFiles = Readonly<Record<string, string>>;

/** How an App's tests run: as App code, with more CPU than one call. */
const testSandbox = {
  ...sandbox,
  limits: { cpuMs: 30_000 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/** The longest one suite may run, in milliseconds, all its tests together. */
export const suiteTimeoutMs = 120_000;

/** How long a test run may take before its leftover stores are swept. */
const fixtureLeftAfterMs = 60 * 60_000;

/** Most leftover fixture stores one sweep discards. */
const sweepPage = 50;

/** Most failures core keeps of one version's tests. */
const maxFailures = 50;

/** The most of one failure's text core keeps. */
const maxFailureLength = 2000;

const mainModule = "grasp-app-tests.js";

/** The main module that runs suite `path` over core's host. */
const testsMain = (
  path: string
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import { runAppSuite } from ${JSON.stringify(kitModuleName("@grasp-os/sdk/testing"))};
import suite from ${JSON.stringify(appModuleName(path))};
export class AppTests extends WorkerEntrypoint {
  async run(host) {
    try {
      return { ok: true, value: JSON.parse(JSON.stringify(await runAppSuite(suite, host))) };
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) };
    }
  }
}
`;

interface AppTestsEntrypoint extends Rpc.WorkerEntrypointBranded {
  run: (host: FixtureHost) => Promise<unknown>;
}

/** What the suite's isolate answers, as far as core reads it. */
const outcomeSchema = z.union([
  z.object({
    ok: z.literal(true),
    value: z.object({
      fixtures: z.string(),
      results: z
        .array(
          z.object({
            name: z.string().max(200),
            failures: z.array(z.string()).max(maxFailures),
          })
        )
        .max(maxAppTests),
    }),
  }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);

/** A fixture as `tests/fixtures/<name>.json` declares it. */
const fixtureSchema = z.strictObject({
  /** Who the tests act as, by the name `t.as` takes, and their App role. */
  principals: z
    .record(
      z.string().regex(testNamePattern),
      z.strictObject({ role: z.enum(["user", "builder"]) })
    )
    .refine(
      (principals) => {
        const count = Object.keys(principals).length;
        return count > 0 && count <= 20;
      },
      { message: "A fixture names between 1 and 20 principals." }
    ),
});

type Fixture = z.infer<typeof fixtureSchema>;

/** Where fixture `name` is among an App's files. */
const fixturePath = (name: string): string => `tests/fixtures/${name}.json`;

/** Fixture `name` from `files`, or why it can't be read. */
const fixtureOf = (
  files: AppFiles,
  name: string
): { fixture: Fixture } | { error: string } => {
  const path = fixturePath(name);
  const text = Object.hasOwn(files, path) ? files[path] : undefined;
  if (text === undefined) {
    return { error: `its fixture ${path} doesn't exist` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: `its fixture ${path} isn't JSON` };
  }
  const parsed = fixtureSchema.safeParse(data);
  return parsed.success
    ? { fixture: parsed.data }
    : {
        error: `its fixture ${path} isn't { "principals": { "<name>": { "role": "user" | "builder" } } }: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      };
};

/**
 * Creates fixture store `id` for a test of `release`: recorded first, so
 * the sweep finds it whatever happens next, then its tables defined with
 * the release's schema, for the release, as a seal defines them.
 */
const createFixtureStore = async (
  env: Env,
  release: Release
): Promise<OpenStore> => {
  // A release's resource ID is the App it was sealed for.
  const app = appIdSchema.parse(release.manifest.resourceId);
  const id = storeIdSchema.parse(crypto.randomUUID());
  await drizzle(env.DB).insert(appTestFixtures).values({
    storeId: id,
    appId: app,
    version: release.manifest.resourceVersion,
    createdAt: new Date(),
  });
  const store = openFixtureStore(env, id);
  await store.defineTables(manifestText(release.app.schema), {
    resourceId: app,
    resourceVersion: release.manifest.resourceVersion,
  });
  return store;
};

/**
 * Discards fixture store `id`, then forgets it. Failing, it is left
 * recorded, for the sweep.
 */
const discardFixture = async (env: Env, id: StoreId): Promise<void> => {
  try {
    await discardFixtureStore(env, id);
    await drizzle(env.DB)
      .delete(appTestFixtures)
      .where(eq(appTestFixtures.storeId, id));
  } catch (error) {
    log.error("app_tests.discard_failed", { store: id, ...errorFields(error) });
  }
};

/**
 * What an untrusted test isolate reaches of core: every argument within
 * the bounds of one call's request, however it was sent.
 */
const TestTarget = boundedRpcTarget({
  depth: rpcArgumentDepth,
  size: functionRequestMaxBytes,
});

/** One test's session: its principals' calls, on a fixture store of its own. */
class FixtureSession extends TestTarget {
  readonly #env: Env;
  readonly #release: Release;
  readonly #fixtures: string;
  readonly #fixture: Fixture;
  #store: Promise<OpenStore> | undefined;
  #closed = false;

  constructor(env: Env, release: Release, fixtures: string, fixture: Fixture) {
    super();
    this.#env = env;
    this.#release = release;
    this.#fixtures = fixtures;
    this.#fixture = fixture;
  }

  /** The role principal `name` has in the fixture; throws for none. */
  #roleOf(name: unknown): "user" | "builder" {
    const principal =
      typeof name === "string" && Object.hasOwn(this.#fixture.principals, name)
        ? this.#fixture.principals[name]
        : undefined;
    if (principal === undefined) {
      throw new Error(
        `The fixture "${this.#fixtures}" has no principal ${JSON.stringify(name)}: name it in ${fixturePath(this.#fixtures)}.`
      );
    }
    return principal.role;
  }

  /** The session's store, created on first use. */
  async #storeOf(): Promise<OpenStore> {
    if (this.#release.store === null) {
      return noStore();
    }
    this.#store ??= createFixtureStore(this.#env, this.#release);
    return await this.#store;
  }

  /**
   * Why principal `name` can't be used, nothing when it can: answered,
   * never thrown, so the session stays whole and only the test fails.
   */
  // oxlint-disable-next-line require-await
  async principal(name: unknown): Promise<string | undefined> {
    try {
      this.#roleOf(name);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Calls a function as principal `name`, as a screen's call is resolved
   * and run, and answers its result's JSON text. Never throws for the
   * call: a refusal is its result, as the caller would get it.
   */
  async call(name: unknown, request: unknown): Promise<string> {
    if (this.#closed) {
      throw new Error("This test has ended: its calls change nothing more.");
    }
    const role = this.#roleOf(name);
    const requestId = crypto.randomUUID();
    let result: OperationResult;
    try {
      const call = readFunctionRequest(request);
      const path = publicOperationOf(this.#release, call.reference);
      const invocation: Invocation = {
        principal: `fixture-${String(name)}`,
        consumer: {
          resourceId: this.#release.manifest.resourceId,
          resourceVersion: this.#release.manifest.resourceVersion,
        },
        store: await this.#storeOf(),
        requestId,
        deadline: Date.now() + 60_000,
        runId: null,
        // The fixture's role, which nothing changes while the test runs.
        authorize: async () =>
          await Promise.resolve({
            appMember: true,
            appBuilder: role === "builder",
          }),
        // No resources: outside systems aren't the tests' to reach.
      };
      result = await callOperation(
        hostedRelease(this.#env, this.#release),
        invocation,
        { path, kind: call.reference.kind },
        call.input,
        call.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: call.idempotencyKey }
      );
    } catch (error) {
      result = { ok: false, error: refusalOf(error, requestId) };
    }
    return JSON.stringify(result);
  }

  /** Ends the session, discarding its store. */
  async close(): Promise<void> {
    this.#closed = true;
    const store = this.#store;
    this.#store = undefined;
    if (store === undefined) {
      return;
    }
    let id: StoreId;
    try {
      ({ id } = await store);
    } catch {
      // Never created: whatever was recorded, the sweep discards.
      return;
    }
    await discardFixture(this.#env, id);
  }
}

/** Core's side of one suite's run: its sessions, one per test. */
class FixtureHost extends TestTarget {
  readonly #env: Env;
  readonly #release: Release;
  readonly #files: AppFiles;
  readonly #sessions = new Set<FixtureSession>();

  constructor(env: Env, release: Release, files: AppFiles) {
    super();
    this.#env = env;
    this.#release = release;
    this.#files = files;
  }

  /**
   * A session for one test, on fixture `fixtures`: one of the App's own
   * files, whichever the suite names. Throws for one the App doesn't have
   * or that isn't a fixture, which fails the suite.
   */
  // oxlint-disable-next-line require-await
  async open(fixtures: unknown, _name: unknown): Promise<FixtureSession> {
    if (typeof fixtures !== "string" || !testNamePattern.test(fixtures)) {
      throw new Error("A suite names its fixture by a name like `notes`.");
    }
    const read = fixtureOf(this.#files, fixtures);
    if ("error" in read) {
      throw new Error(read.error);
    }
    const session = new FixtureSession(
      this.#env,
      this.#release,
      fixtures,
      read.fixture
    );
    this.#sessions.add(session);
    return session;
  }

  /** Closes every session still open, such as a test's that ran past its deadline. */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.#sessions].map(async (s) => {
        await s.close();
      })
    );
    this.#sessions.clear();
  }
}

/** What `work` answers, or a rejection once `ms` have passed. */
const within = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  const limit = deadline(ms);
  try {
    return await Promise.race([work, whenAborted(limit.signal)]);
  } catch (error) {
    if (limit.stopped() === "timeout") {
      throw new Error(`didn't finish within ${ms / 1000} seconds`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    limit.clear();
  }
};

/**
 * Why suite `path` fails, one line per failing test: run in an isolate of
 * its own, which loads the suite and runs it over a host of its own.
 */
const suiteFailures = async (
  env: Env,
  release: Release,
  files: AppFiles,
  path: string,
  modules: Record<string, string>
): Promise<string[]> => {
  const failed = (failure: string): string[] => [
    `${path}: ${failure}`.slice(0, maxFailureLength),
  ];
  const host = new FixtureHost(env, release, files);
  const entry = env.LOADER.get(null, () => ({
    ...testSandbox,
    mainModule,
    modules: { ...modules, [mainModule]: testsMain(path) },
    env: {},
  })).getEntrypoint<AppTestsEntrypoint>("AppTests");
  let answer: unknown;
  try {
    answer = await within(entry.run(host), suiteTimeoutMs);
  } catch (error) {
    const cause = startFailure(error);
    return failed(
      cause === undefined
        ? `it stopped: ${error instanceof Error ? error.message : String(error)}`
        : `its code doesn't load: ${cause}`
    );
  } finally {
    await host.closeAll();
  }
  const outcome = outcomeSchema.safeParse(answer);
  if (!outcome.success) {
    return failed("it didn't report as appTest does");
  }
  if (!outcome.data.ok) {
    return failed(outcome.data.message);
  }
  return outcome.data.value.results.flatMap(({ name, failures }) =>
    failures.map((failure) =>
      `${path}, "${name}": ${failure}`.slice(0, maxFailureLength)
    )
  );
};

/**
 * Runs the App tests in `files` (release `release`'s version) and says
 * what fails, one line each: nothing when all pass, or there are none.
 * One suite after another, each in an isolate of its own with no name,
 * which goes once it is done.
 */
export const appTestFailures = async (
  env: Env,
  release: Release,
  files: AppFiles
): Promise<string[]> => {
  const suites = Object.keys(files).filter(isAppTestSuite).toSorted();
  if (suites.length === 0) {
    return [];
  }
  requireBoundedHere(env, "an App's tests");
  const build = await buildAppTests(env, { ...files });
  if (!build.ok) {
    return build.diagnostics
      .slice(0, maxFailures)
      .map(({ file, line, message }) =>
        `${file ?? "tests"}${line === undefined ? "" : `:${line}`}: ${message}`.slice(
          0,
          maxFailureLength
        )
      );
  }
  const sdk = await workflowSdkModules(env.ASSETS);
  // The platform's modules last: no App module takes one's name.
  const modules = {
    ...build.modules,
    ...release.modules,
    ...sdk.modules,
    ...release.sdk,
  };
  const failures: string[] = [];
  for (const path of suites) {
    // One suite at a time: each runs its own isolate and stores.
    // oxlint-disable-next-line no-await-in-loop -- see above
    failures.push(...(await suiteFailures(env, release, files, path, modules)));
  }
  return failures.slice(0, maxFailures);
};

/**
 * Refuses version `version` of App `app` (with its `files`) while any of
 * its App tests fails (`version.tests_failed`, with the failures): run
 * as a version is made current. A version without tests passes.
 */
export const requireAppTestsPass = async (
  env: Env,
  app: AppId,
  version: number,
  files: AppFiles
): Promise<void> => {
  if (!Object.keys(files).some(isAppTestSuite)) {
    return;
  }
  const release = await loadRelease(env, app, version);
  const failures = await appTestFailures(env, release, files);
  if (failures.length > 0) {
    throw versionErrors.create("version.tests_failed", { version, failures });
  }
};

/**
 * Discards the fixture stores test runs left: recorded longer ago than
 * any run takes, at most a page at a time. Run every quarter hour.
 */
export const sweepTestFixtures = async (env: Env, now: Date): Promise<void> => {
  const left = await drizzle(env.DB)
    .select({ storeId: appTestFixtures.storeId })
    .from(appTestFixtures)
    .where(
      lt(
        appTestFixtures.createdAt,
        new Date(now.getTime() - fixtureLeftAfterMs)
      )
    )
    .limit(sweepPage)
    .all();
  for (const { storeId } of left) {
    // One at a time: each is a store object's whole storage.
    // oxlint-disable-next-line no-await-in-loop -- see above
    await discardFixture(env, storeIdSchema.parse(storeId));
  }
};
