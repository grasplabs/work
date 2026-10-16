// oxlint-disable max-classes-per-file -- one suite's host, and the session it opens for each test
import {
  appModuleName,
  isAppTestSuite,
  isUnderAppTests,
  strayTestFileMessage,
  strayTestFiles,
  kitModuleName,
  workflowSdkModules,
} from "@grasp-os/compiler";
import { manifestText } from "@grasp-os/sdk/host";
import {
  appTestTimeoutMs,
  maxAppTestName,
  maxAppTests,
  testNamePattern,
} from "@grasp-os/sdk/testing";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { operationErrors } from "@grasp-os/shared/operations";
import type { OperationResult } from "@grasp-os/shared/operations";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { boundedRpcTarget } from "@grasp-os/shared/rpc-target";
import { rpcArgumentDepth } from "@grasp-os/shared/screens";
import type { QuerySnapshotPush } from "@grasp-os/shared/screens";
import { eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
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
import { QuerySubscriptions } from "./query-subscriptions.ts";
import type {
  LiveRead,
  Reader,
  SnapshotCallback,
} from "./query-subscriptions.ts";
import { hostedRelease, noStore } from "./release-runner.ts";
import { RunSubscription } from "./run-subscription.ts";
import { sandbox } from "./sandbox.ts";
import { buildAppTests } from "./screens.ts";
import { startFailure } from "./workflows/code.ts";

// The trusted test runner for an App's tests (spec 28.2): every suite in
// `tests/**.test.ts` runs whenever a version of the App is made current,
// rollbacks included, and a failing test refuses it (`requireAppTestsPass`,
// called by `setCurrentVersion` in apps.ts). The suites are
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
//   and the store are the fixture's. A principal's live query
//   (`subscribe`) is followed by the realtime manager a screen's page
//   follows one through (query-subscriptions.ts), each principal as a
//   connection of its own: only who reads, the release and the store are
//   the fixture's, so its snapshots are read as that principal, gated and
//   ordered as a screen's are.
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
//   limit; each test, each suite and the whole run a deadline (`limitsOf`),
//   and an App at most `maxAppTestSuites` suites; the report is read
//   through a bounded schema and must hold one result for each test the
//   suite opened, by name, in order, or the suite fails. A call on a
//   session that has ended is refused, and a store discarded refuses
//   every call after, so a test that ran past its deadline changes
//   nothing more.
// - Live queries outlive their test: a session releases every one its
//   test didn't before it discards its store, and its principals' reads
//   are refused from then on, which ends any read already under way.
// - App tests run where nothing bounds them: off Cloudflare they need the
//   sandbox host, which doesn't run them yet (GRA-529); there a version
//   with App tests is refused (`version.tests_unavailable`), saying so.

/** An App's files at one version, by path. */
type AppFiles = Readonly<Record<string, string>>;

/** How an App's tests run: as App code, with more CPU than one call. */
const testSandbox = {
  ...sandbox,
  limits: { cpuMs: 30_000 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/** How long a test, a suite and a version's whole test run may take. */
interface TestLimits {
  testMs: number;
  suiteMs: number;
  runMs: number;
  /** How long a suite's cleanup may take: discarding its stores. */
  cleanupMs: number;
}

/**
 * The limits on an App's tests: one test the SDK's `appTestTimeoutMs`,
 * one suite 2 minutes, and all of a version's suites 10 minutes, checked
 * before each suite starts; after each suite, discarding its stores 10
 * seconds, so at most 20 suites add 200 s to the run. `APP_TEST_LIMITS_MS`
 * (tests only) lowers them.
 */
const defaultLimits: TestLimits = {
  testMs: appTestTimeoutMs,
  suiteMs: 120_000,
  runMs: 10 * 60_000,
  cleanupMs: 10_000,
};

/**
 * How long ago a fixture store must have been recorded for the sweep to
 * discard it: well past the longest a version's test run may take
 * (`defaultLimits.runMs`), so the sweep never discards the store of a
 * test still running. Raise it with the run's limit.
 */
const fixtureLeftAfterMs = 60 * 60_000;

/** `set` where it is a whole number of milliseconds below `most`, else `most`. */
const lower = (set: number | undefined, most: number): number =>
  set !== undefined && Number.isInteger(set) && set > 0 && set < most
    ? set
    : most;

/** The limits in force: the defaults, or lower ones where tests set them. */
const limitsOf = (env: Pick<Env, "APP_TEST_LIMITS_MS">): TestLimits => {
  const [testMs, suiteMs, runMs, cleanupMs] = (env.APP_TEST_LIMITS_MS ?? "")
    .split("/")
    .map(Number);
  return {
    testMs: lower(testMs, defaultLimits.testMs),
    suiteMs: lower(suiteMs, defaultLimits.suiteMs),
    runMs: lower(runMs, defaultLimits.runMs),
    cleanupMs: lower(cleanupMs, defaultLimits.cleanupMs),
  };
};

/** Most leftover fixture stores one sweep discards. */
const sweepPage = 50;

/** Most failures core keeps of one version's tests. */
const maxFailures = 50;

/** The most of one failure's text core keeps. */
const maxFailureLength = 2000;

const mainModule = "grasp-app-tests.js";

/** The main module that runs suite `path` over core's host. */
const testsMain = (
  path: string,
  testMs: number
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import { runAppSuite } from ${JSON.stringify(kitModuleName("@grasp-os/sdk/testing"))};
import suite from ${JSON.stringify(appModuleName(path))};
export class AppTests extends WorkerEntrypoint {
  async run(host) {
    try {
      return { ok: true, value: JSON.parse(JSON.stringify(await runAppSuite(suite, host, { testTimeoutMs: ${testMs} }))) };
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

/** What ends a test's call or live read once its session closed. */
const sessionEnded = (): Error =>
  new Error("This test has ended: its calls change nothing more.");

/** Releases `stub` when it is an RPC stub; anything else holds nothing. */
const disposeStub = (stub: object): void => {
  const dispose: unknown = Reflect.get(stub, Symbol.dispose);
  if (typeof dispose === "function") {
    Reflect.apply(dispose, stub, []);
  }
};

/**
 * `given`, a test isolate's callback, kept past the call that passed it:
 * an RPC stub is let go of when that call returns unless it is
 * duplicated.
 */
const keptCallback = (given: object): object => {
  const dup: unknown = Reflect.get(given, "dup");
  const kept: unknown =
    typeof dup === "function" ? Reflect.apply(dup, given, []) : given;
  if (typeof kept !== "function") {
    throw new TypeError("A live query's callback is a function.");
  }
  return kept;
};

/** How long a test's `onLost` may take before its stubs are let go of anyway. */
const lostNoticeMs = 10_000;

/** Calls `kept`, a test's callback (`keptCallback`), with `args`. */
const callBack = async (kept: object, ...args: unknown[]): Promise<void> => {
  if (typeof kept === "function") {
    await Reflect.apply(kept, undefined, args);
  }
};

/**
 * A test's two callbacks as the realtime manager holds a page's
 * (`SnapshotCallback`): each push goes to `onSnapshot`, and once the
 * manager lets go of the last hold it took (`dup`), `onLost` is told, as
 * a page is when core lets go of its stub; then both of the test's stubs
 * are released. They are kept only once the manager takes its hold, in
 * the call that passed them: a subscription refused before then holds
 * nothing. Once its test has `ended`, nothing more is sent to the test's
 * isolate: nobody there listens, and the isolate may be done with its run.
 */
const testCallback = (
  onSnapshot: object,
  onLost: object,
  ended: () => boolean
): SnapshotCallback => {
  let kept: { readonly snapshot: object; readonly lost: object } | undefined;
  let holds = 0;
  const lost = async (): Promise<void> => {
    if (kept === undefined) {
      return;
    }
    const { snapshot, lost: toLost } = kept;
    const { promise: noticed, resolve } = Promise.withResolvers<null>();
    // Waited for `lostNoticeMs` at most: a test that never answers still
    // has both of its stubs let go of.
    const timer = setTimeout(() => {
      resolve(null);
    }, lostNoticeMs);
    const notice = async (): Promise<void> => {
      try {
        if (!ended()) {
          await callBack(toLost);
        }
      } catch {
        // The test's isolate is gone already.
      }
      resolve(null);
    };
    try {
      void notice();
      await noticed;
    } finally {
      clearTimeout(timer);
      disposeStub(snapshot);
      disposeStub(toLost);
    }
  };
  const hold = (): SnapshotCallback => {
    holds += 1;
    let held = true;
    return Object.assign(
      async (push: QuerySnapshotPush): Promise<void> => {
        if (!held || ended() || kept === undefined) {
          throw new Error("This live query was let go of.");
        }
        await callBack(kept.snapshot, push);
      },
      {
        dup: (): SnapshotCallback => {
          if (kept === undefined) {
            const snapshot = keptCallback(onSnapshot);
            try {
              kept = { snapshot, lost: keptCallback(onLost) };
            } catch (error) {
              // Neither is kept: the one already duplicated is let go of.
              disposeStub(snapshot);
              throw error;
            }
          }
          return hold();
        },
        [Symbol.dispose]: (): void => {
          if (!held) {
            return;
          }
          held = false;
          holds -= 1;
          if (holds === 0) {
            void lost();
          }
        },
      }
    );
  };
  return hold();
};

/** One principal's live queries: a connection of its own, and who it is. */
interface PrincipalQueries {
  readonly queries: QuerySubscriptions<Reader>;
  readonly reader: Reader;
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

/** What a suite's sessions are opened with. */
interface SessionContext {
  readonly env: Env;
  readonly release: Release;
  /** How long discarding a session's store may take (`TestLimits`). */
  readonly cleanupMs: number;
}

/** One test's session: its principals' calls, on a fixture store of its own. */
class FixtureSession extends TestTarget {
  readonly #env: Env;
  readonly #release: Release;
  readonly #cleanupMs: number;
  readonly #fixtures: string;
  readonly #fixture: Fixture;
  #store: Promise<OpenStore> | undefined;
  #closed = false;
  /** Each principal's live queries, by name (`subscribe`). */
  readonly #queries = new Map<string, PrincipalQueries>();
  /** The live queries not released yet, which `close` releases. */
  readonly #following = new Set<RunSubscription>();

  constructor(context: SessionContext, fixtures: string, fixture: Fixture) {
    super();
    this.#env = context.env;
    this.#release = context.release;
    this.#cleanupMs = context.cleanupMs;
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
    // Closed meanwhile (a test past its deadline): no store is made that
    // nothing would discard but the sweep.
    if (this.#closed) {
      throw sessionEnded();
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
      throw sessionEnded();
    }
    const role = this.#roleOf(name);
    return JSON.stringify(await this.#invoke(String(name), role, request));
  }

  /**
   * Runs the call `request` names as principal `name`, with `role`, as a
   * screen's call is resolved and run: its result, a refusal included.
   * A live read (`live`) runs only a query, by its deadline, and is told
   * what the query read of the session's store.
   */
  async #invoke(
    name: string,
    role: "user" | "builder",
    request: unknown,
    live?: {
      readonly deadline: number;
      readonly observe: (
        storeId: StoreId,
        readSet: Record<string, number>
      ) => void;
    }
  ): Promise<OperationResult> {
    const requestId = crypto.randomUUID();
    try {
      const call = readFunctionRequest(request);
      // A live query follows a query only, as a screen's does.
      if (live !== undefined && call.reference.kind !== "query") {
        throw operationErrors.create("contract.invalid_request");
      }
      const path = publicOperationOf(this.#release, call.reference);
      const store = await this.#storeOf();
      const wallEnd = Date.now() + platformLimits.serverInvocationWallMs;
      const invocation: Invocation = {
        principal: `fixture-${name}`,
        consumer: {
          resourceId: this.#release.manifest.resourceId,
          resourceVersion: this.#release.manifest.resourceVersion,
        },
        store,
        requestId,
        deadline: Math.min(wallEnd, live?.deadline ?? wallEnd),
        runId: null,
        // The fixture's role, which nothing changes while the test runs.
        authorize: async () =>
          await Promise.resolve({
            appMember: true,
            appBuilder: role === "builder",
          }),
        // No resources: outside systems aren't the tests' to reach.
        ...(live === undefined || this.#release.store === null
          ? {}
          : {
              observeReads: (readSet: Record<string, number>) => {
                live.observe(store.id, readSet);
              },
            }),
      };
      return await callOperation(
        hostedRelease(this.#env, this.#release),
        invocation,
        { path, kind: call.reference.kind },
        call.input,
        call.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: call.idempotencyKey }
      );
    } catch (error) {
      return { ok: false, error: refusalOf(error, requestId) };
    }
  }

  /**
   * Principal `name`'s live queries: a connection of its own to the
   * realtime manager, as a screen's page has (query-subscriptions.ts),
   * read as the principal, with its role, on the session's store, until
   * the session closes. Its reads are the test's own and bounded by its
   * deadline, so none is charged to a budget.
   */
  #queriesOf(name: string, role: "user" | "builder"): PrincipalQueries {
    const known = this.#queries.get(name);
    if (known !== undefined) {
      return known;
    }
    // One object for the session's life: the manager's gate is keyed by it.
    const reader: Reader = Object.freeze({ userId: `fixture-${name}` });
    const roles = canonicalJson({
      appMember: true,
      appBuilder: role === "builder",
    });
    const queries = new QuerySubscriptions<Reader>(this.#env, {
      check: async () => {
        if (this.#closed) {
          throw sessionEnded();
        }
        return await Promise.resolve(reader);
      },
      access: async () =>
        await Promise.resolve(this.#closed ? ("role" as const) : "open"),
      roles: async () => await Promise.resolve(roles),
      admit: async () => await Promise.resolve(true),
      revocable: false,
      forget: () => {
        // The reader is fixed for the session's life.
      },
      evaluate: async (
        _by,
        _app,
        _artifact,
        request,
        readBy
      ): Promise<LiveRead> => {
        let reads: LiveRead["reads"];
        const result = await this.#invoke(name, role, request, {
          deadline: readBy,
          observe: (storeId, readSet) => {
            reads = { storeId, readSet };
          },
        });
        return { result, reads };
      },
    });
    const made = { queries, reader };
    this.#queries.set(name, made);
    return made;
  }

  /**
   * Follows a public query as principal `name`: `request` is the call's
   * JSON text, as `call` takes it. Each push of core's (`{ revision,
   * result }`) goes to `onSnapshot`, and `onLost` is called once core lets
   * go of the subscription. Answers what releases it, or the refusal's
   * result as JSON text, such as `screen.too_many_queries`; the session
   * releases whatever its test didn't as it closes. A refusal is
   * answered, never thrown: workerd takes a call that rejects once it was
   * passed callbacks for one that hung, and cancels it.
   */
  // oxlint-disable-next-line require-await
  async subscribe(
    name: unknown,
    request: unknown,
    onSnapshot: unknown,
    onLost: unknown
  ): Promise<{ subscription: RunSubscription } | { refusal: string }> {
    try {
      if (this.#closed) {
        throw sessionEnded();
      }
      const role = this.#roleOf(name);
      if (
        typeof request !== "string" ||
        request.length > functionRequestMaxBytes ||
        typeof onSnapshot !== "function" ||
        typeof onLost !== "function"
      ) {
        throw new Error(
          "A live query is followed with its request and two callbacks."
        );
      }
      const { queries, reader } = this.#queriesOf(String(name), role);
      const callback = testCallback(onSnapshot, onLost, () => this.#closed);
      // Refused (`screen.too_many_queries`), it throws before it holds the
      // callback, which then holds nothing of the test's.
      const held = queries.subscribe(
        reader,
        appIdSchema.parse(this.#release.manifest.resourceId),
        undefined,
        request,
        callback
      );
      // The manager holds a callback of its own; this one is let go of.
      callback[Symbol.dispose]();
      const subscription: RunSubscription = new RunSubscription(async () => {
        this.#following.delete(subscription);
        await held.release();
      });
      this.#following.add(subscription);
      return { subscription };
    } catch (error) {
      const refused: OperationResult = {
        ok: false,
        error: refusalOf(error, crypto.randomUUID()),
      };
      return { refusal: JSON.stringify(refused) };
    }
  }

  /**
   * Ends the session, discarding its store within the cleanup's deadline:
   * a store or D1 that stalls holds the test no longer, and the store
   * stays recorded (`app_test_fixtures`), for the sweep. That alone fails
   * no test.
   */
  async close(): Promise<void> {
    this.#closed = true;
    // Its live queries first: nothing follows a store being discarded.
    await Promise.all(
      [...this.#following].map(async (subscription) => {
        await subscription.release();
      })
    );
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
    await within(discardFixture(this.#env, id), this.#cleanupMs).catch(
      (error: unknown) => {
        log.warn("app_tests.discard_unfinished", {
          store: id,
          ...errorFields(error),
        });
      }
    );
  }
}

/** Core's side of one suite's run: its sessions, one per test. */
class FixtureHost extends TestTarget {
  readonly #context: SessionContext;
  readonly #files: AppFiles;
  readonly #sessions = new Set<FixtureSession>();
  /** The tests the suite opened, by name, in order: what it must report. */
  readonly opened: string[] = [];
  #closed = false;

  constructor(context: SessionContext, files: AppFiles) {
    super();
    this.#context = context;
    this.#files = files;
  }

  /**
   * A session for one test, on fixture `fixtures`: one of the App's own
   * files, whichever the suite names. Throws for one the App doesn't have
   * or that isn't a fixture, which fails the suite.
   */
  // oxlint-disable-next-line require-await
  async open(fixtures: unknown, name: unknown): Promise<FixtureSession> {
    // A suite past its deadline opens nothing more, and no suite opens
    // more sessions than it may have tests: each may make a store.
    if (this.#closed || this.opened.length >= maxAppTests) {
      throw new Error("This suite may open no more tests.");
    }
    if (typeof name !== "string" || name.length > maxAppTestName) {
      throw new Error("A test is opened by its name.");
    }
    this.opened.push(name);
    if (typeof fixtures !== "string" || !testNamePattern.test(fixtures)) {
      throw new Error("A suite names its fixture by a name like `notes`.");
    }
    const read = fixtureOf(this.#files, fixtures);
    if ("error" in read) {
      throw new Error(read.error);
    }
    const session = new FixtureSession(this.#context, fixtures, read.fixture);
    this.#sessions.add(session);
    return session;
  }

  /** Closes every session still open, such as a test's that ran past its deadline. */
  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#sessions].map(async (s) => {
        await s.close();
      })
    );
    this.#sessions.clear();
  }
}

/**
 * Core's side of one suite's run of `release`'s tests, with the App's
 * `files`: the host the suite's isolate calls (`AppTestHost`), each
 * session's store discarded within `cleanupMs`.
 */
export const fixtureHostFor = (
  env: Env,
  release: Release,
  files: AppFiles,
  cleanupMs = defaultLimits.cleanupMs
): FixtureHost => new FixtureHost({ env, release, cleanupMs }, files);

/**
 * Why suite `path` fails, one line per failing test: run in an isolate of
 * its own, which loads the suite and runs it over a host of its own.
 */
const suiteFailures = async (
  env: Env,
  release: Release,
  files: AppFiles,
  path: string,
  modules: Record<string, string>,
  {
    testMs,
    suiteMs,
    cleanupMs,
  }: Pick<TestLimits, "testMs" | "suiteMs" | "cleanupMs">
): Promise<string[]> => {
  const failed = (failure: string): string[] => [
    `${path}: ${failure}`.slice(0, maxFailureLength),
  ];
  const host = fixtureHostFor(env, release, files, cleanupMs);
  const entry = env.LOADER.get(null, () => ({
    ...testSandbox,
    mainModule,
    modules: { ...modules, [mainModule]: testsMain(path, testMs) },
    env: {},
  })).getEntrypoint<AppTestsEntrypoint>("AppTests");
  let answer: unknown;
  try {
    answer = await within(entry.run(host), suiteMs);
  } catch (error) {
    const cause = startFailure(error);
    return failed(
      cause === undefined
        ? `it stopped: ${error instanceof Error ? error.message : String(error)}`
        : `its code doesn't load: ${cause}`
    );
  } finally {
    // Cleanup has a deadline of its own: a store or D1 that stalls holds
    // the activation no longer. Whatever it didn't discard stays recorded
    // (`app_test_fixtures`), for the sweep; that alone fails no test.
    await within(host.closeAll(), cleanupMs).catch((error: unknown) => {
      log.warn("app_tests.cleanup_unfinished", errorFields(error));
    });
  }
  const outcome = outcomeSchema.safeParse(answer);
  if (!outcome.success) {
    return failed("it didn't report as appTest does");
  }
  if (!outcome.data.ok) {
    return failed(outcome.data.message);
  }
  // One result for each test the suite opened, by name, in order: a report
  // that leaves one out, or adds one, isn't the run's, and fails closed.
  const { results } = outcome.data.value;
  const reported = results.map(({ name }) => name);
  if (
    reported.length === 0 ||
    reported.length !== host.opened.length ||
    reported.some((name, index) => name !== host.opened[index])
  ) {
    return failed(
      `its report doesn't hold one result for each of the ${host.opened.length} tests it ran`
    );
  }
  return results.flatMap(({ name, failures }) =>
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
  app: AppId,
  release: Release,
  files: AppFiles
): Promise<string[]> => {
  // What under tests/ is no suite, helper or fixture is refused by its
  // path alone, with no runtime: nothing there is passed over.
  const strays = strayTestFiles(files);
  if (strays.length > 0) {
    return strays
      .slice(0, maxFailures)
      .map((file) => `${file}: ${strayTestFileMessage(file)}`);
  }
  // Only suites need the runtime: fixtures and helpers alone run nothing.
  const suites = Object.keys(files).filter(isAppTestSuite).toSorted();
  if (suites.length === 0) {
    return [];
  }
  // Only where the runtime bounds App code's CPU, or a deployment accepts
  // that nothing does: on-prem the sandbox host doesn't run tests yet.
  if (
    env.RUNTIME_PROFILE !== "cloudflare" &&
    env.SANDBOX_IN_PROCESS !== "unbounded"
  ) {
    throw versionErrors.create("version.tests_unavailable");
  }
  const limits = limitsOf(env);
  const build = await buildAppTests(env, { ...files }, app);
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
  // The suites' time: the build is the compiler's, bounded on its own.
  const started = Date.now();
  for (const path of suites) {
    // Within the run's deadline, checked before each suite, which gets
    // what is left of it at most: a suite that can't start fails.
    const left = limits.runMs - (Date.now() - started);
    if (left <= 0) {
      failures.push(
        `${path}: didn't run: the version's tests ran past their ${limits.runMs / 1000} seconds`
      );
    } else {
      failures.push(
        // One suite at a time: each runs its own isolate and stores.
        // oxlint-disable-next-line no-await-in-loop -- see above
        ...(await suiteFailures(env, release, files, path, modules, {
          testMs: limits.testMs,
          suiteMs: Math.min(limits.suiteMs, left),
          cleanupMs: limits.cleanupMs,
        }))
      );
    }
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
  if (!Object.keys(files).some(isUnderAppTests)) {
    return;
  }
  const release = await loadRelease(env, app, version);
  const failures = await appTestFailures(env, app, release, files);
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
