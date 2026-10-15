// oxlint-disable max-classes-per-file -- a suite's own definition error, and the two failures a test can have, each a few lines
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { messageOf } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import type {
  ArgsOf,
  Callable,
  ReferenceKind,
  ReturnOf,
} from "./references.ts";

// App tests (spec 28.2), as `@grasp-os/sdk/testing` exports them.
//
// `appTest` describes a suite and runs nothing itself. Core's trusted test
// runner loads an App's `tests/*.test.ts` in a sandboxed isolate, with the
// App's release and its generated `#grasp` references, and runs each suite
// with `runAppSuite` over a host it passes in: every call a test principal
// makes crosses back into core, which runs it through the real operation
// host on a fixture store of the test's own, as it runs a screen's call.
// Nothing here stands in for core; what a test asserts is what the App
// answered.

/** How a fixture or a principal is named: `notes`, `note-owner`. */
export const testNamePattern = /^[a-z][a-z0-9-]{0,63}$/u;

/** The most tests one suite holds. */
export const maxAppTests = 100;

/** The longest a test's name is, in characters. */
export const maxAppTestName = 200;

/**
 * How long one test may run before it fails, in milliseconds, its calls
 * included: they are real calls of the App's functions.
 */
export const appTestTimeoutMs = 30_000;

/** A public function of the App, as `#grasp` generates its reference. */
export type PublicReference<Kind extends ReferenceKind> = Callable<
  Kind,
  "public"
> & {
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly contractId: string;
  readonly fingerprint: string;
};

/** The most snapshots a live query keeps that `next` hasn't taken. */
export const maxBufferedSnapshots = 100;

/**
 * A live query a principal follows (`subscribe`), as a screen follows
 * one: core reads it again after every write that changed what it read,
 * as the principal, and pushes each result in order.
 */
export interface LiveQuery<Value> {
  /**
   * The next snapshot that `predicate` accepts (the next one, without a
   * predicate), passing over those it doesn't. Waits no longer than the
   * test may run. Fails on a refusal core pushes, such as
   * `operation.not_found`, and once core stops following the query.
   */
  next: (predicate?: (value: Value) => boolean) => Promise<Value>;
  /** Stops following it: core releases its subscription. */
  close: () => Promise<void>;
}

/**
 * A fixture principal (`t.as`): someone with the role in the App the
 * suite's fixture gives them. Each call goes to core, which resolves the
 * reference against the App's release as it resolves a screen's, and
 * runs the function through the operation host. A call answers the
 * function's value; a failure fails the test, unless the test expects it
 * with `t.rejectsCode`.
 */
export interface TestPrincipal {
  /** Calls one of the App's public queries. */
  query: <Reference extends PublicReference<"query">>(
    reference: Reference,
    args: ArgsOf<Reference>
  ) => Promise<ReturnOf<Reference>>;
  /** Calls one of the App's public mutations. */
  mutation: <Reference extends PublicReference<"mutation">>(
    reference: Reference,
    args: ArgsOf<Reference>
  ) => Promise<ReturnOf<Reference>>;
  /**
   * Calls one of the App's public actions. A fixture binds no resources,
   * so an action that reaches one is refused (`resource.unavailable`):
   * outside systems aren't the tests' to touch.
   */
  action: <Reference extends PublicReference<"action">>(
    reference: Reference,
    args: ArgsOf<Reference>
  ) => Promise<ReturnOf<Reference>>;
  /**
   * Follows one of the App's public queries, through the realtime
   * subscription a screen follows one through. A test that doesn't
   * `close` it has it closed as it ends.
   */
  subscribe: <Reference extends PublicReference<"query">>(
    reference: Reference,
    args: ArgsOf<Reference>
  ) => Promise<LiveQuery<ReturnOf<Reference>>>;
}

/** What each test of an `appTest` suite gets. */
export interface AppTestContext {
  /**
   * The principal the suite's fixture (`tests/fixtures/<fixtures>.json`)
   * names `name`; the test fails if it names none.
   */
  as: (name: string) => Promise<TestPrincipal>;
  /**
   * Fails the test unless `actual` equals `expected` as JSON: the same
   * values, whatever order an object's keys are in.
   */
  equal: <Value>(actual: Value, expected: Value, message?: string) => void;
  /**
   * Fails the test unless `work` (a call, or a function that makes calls)
   * fails with error `code`, such as `note.not_found` or
   * `permission.denied`.
   */
  rejectsCode: (
    work: Promise<unknown> | (() => Promise<unknown>),
    code: string
  ) => Promise<void>;
}

/** One test: what it does, through `t`. */
export type AppTestFunction = (t: AppTestContext) => Promise<void>;

/** What `appTest` takes. */
export interface AppTestDefinition {
  /** The fixture the suite runs on: `tests/fixtures/<fixtures>.json`. */
  fixtures: string;
  /** Each test by its name, as people read it in a failure. */
  tests: Readonly<Record<string, AppTestFunction>>;
}

/** An App's test suite, as `appTest` describes it. */
export interface AppTestSuite {
  readonly kind: "app";
  readonly fixtures: string;
  readonly tests: Readonly<Record<string, AppTestFunction>>;
}

/** A suite declared wrong: says what to fix. */
export class TestDefinitionError extends Error {
  override name = "TestDefinitionError";
}

const refuseSuite: (message: string) => never = (message) => {
  throw new TestDefinitionError(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The suite `definition` declares, checked and frozen. */
const readSuite = (definition: unknown): AppTestSuite => {
  if (!isRecord(definition)) {
    return refuseSuite("appTest takes { fixtures, tests }.");
  }
  const { fixtures, tests } = definition;
  if (typeof fixtures !== "string" || !testNamePattern.test(fixtures)) {
    return refuseSuite(
      "`fixtures` names a fixture in tests/fixtures/, such as `notes`: lowercase letters, digits and hyphens, starting with a letter."
    );
  }
  if (!isRecord(tests)) {
    return refuseSuite("`tests` maps each test's name to its function.");
  }
  // Defined, never assigned: a test named `__proto__` is a test, not a
  // new prototype that would drop it.
  const checked: Record<string, AppTestFunction> = {};
  for (const [name, test] of Object.entries(tests)) {
    if (name.trim() === "" || name.length > maxAppTestName) {
      return refuseSuite(
        `A test's name is between 1 and ${maxAppTestName} characters.`
      );
    }
    if (typeof test !== "function") {
      return refuseSuite(`Test "${name}" isn't a function.`);
    }
    // A function, checked just above; what it does with `t` is the test's
    // own, and a failure is reported as the test's.
    Object.defineProperty(checked, name, {
      value: test,
      enumerable: true,
    });
  }
  const count = Object.keys(checked).length;
  if (count === 0 || count > maxAppTests) {
    return refuseSuite(
      `A suite has between 1 and ${maxAppTests} tests; this one has ${count}.`
    );
  }
  return Object.freeze({
    kind: "app",
    fixtures,
    tests: Object.freeze(checked),
  });
};

/**
 * Declares one of an App's test suites: the default export of a file in
 * its `tests/` folder named `*.test.ts`, such as `tests/notes.test.ts`.
 * Every suite runs when a version of the App is made current, which is
 * refused while any of its tests fails.
 *
 * ```ts
 * import { appTest } from "@grasp-os/sdk/testing";
 * import { api } from "#grasp";
 *
 * export default appTest({
 *   fixtures: "notes",
 *   tests: {
 *     "an owner reads back the note they create": async (t) => {
 *       const owner = await t.as("note-owner");
 *       const id = await owner.mutation(api.notes.create, { title: "First" });
 *       t.equal((await owner.query(api.notes.get, { id }))?.title, "First");
 *     },
 *   },
 * });
 * ```
 */
export const appTest = (definition: AppTestDefinition): AppTestSuite =>
  readSuite(definition);

/**
 * One test's session with core's test runner: a fresh fixture store, which
 * goes when the session closes. Core's side of it is an RPC target.
 */
export interface AppTestSession {
  /**
   * Why principal `name` can't be used, such as a fixture that doesn't
   * name them; nothing when it can. Answered, not thrown: what fails is
   * the test, never the session.
   */
  principal: (name: string) => Promise<string | undefined>;
  /**
   * Calls a function as principal `name`: `request` is the call's JSON
   * text (`{ reference, input }`), as a screen sends it, and the answer
   * the JSON text of what the call answered (an `OperationResult`).
   */
  call: (name: string, request: string) => Promise<string>;
  /**
   * Follows a query as principal `name`: `request` as `call` takes it.
   * Each push of core's (`{ revision, result }`, the result an
   * `OperationResult`) goes to `onSnapshot`, and `onLost` is called once
   * core lets go of the subscription. Answers what releases it, or why
   * core refused it: the JSON text of a failed `OperationResult`.
   */
  subscribe: (
    name: string,
    request: string,
    onSnapshot: (push: unknown) => void,
    onLost: () => void
  ) => Promise<{ subscription: AppTestSubscription } | { refusal: string }>;
  /**
   * Ends the session: releases the live queries its test left open, and
   * discards its fixture store.
   */
  close: () => Promise<void>;
}

/** A live query's subscription in core, as the session answers it. */
export interface AppTestSubscription {
  release: () => Promise<void>;
}

/** Core's test runner, as `runAppSuite` reaches it. */
export interface AppTestHost {
  /**
   * A session for the test named `name`, on fixture `fixtures`; throws
   * when the App has no such fixture, or it isn't one.
   */
  open: (fixtures: string, name: string) => Promise<AppTestSession>;
}

/** How one test went: no failures when it passed. */
export interface AppTestResult {
  name: string;
  failures: string[];
}

/** How a suite went, test by test, in order. */
export interface AppTestReport {
  fixtures: string;
  results: AppTestResult[];
}

/** A test's own assertion failing (`equal`, `rejectsCode`). */
class TestAssertionError extends Error {
  override name = "TestAssertionError";
}

/** A call the App or the host refused or failed. */
class TestCallError extends Error {
  override name = "TestCallError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The value an `OperationResult` holds; throws the failure it holds. */
const settled = (parsed: unknown): unknown => {
  if (isRecord(parsed) && parsed.ok === true) {
    return parsed.value;
  }
  const error = isRecord(parsed) ? parsed.error : undefined;
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    throw new TestCallError(error.code, error.message);
  }
  throw new Error("The test runner answered something else than a result.");
};

/** The value a call's answer (an `OperationResult`'s text) holds. */
const unwrapped = (answer: string): unknown => settled(JSON.parse(answer));

/** The request a principal sends for `reference`, of `kind`, with `args`. */
const requestFor = (
  reference: unknown,
  kind: ReferenceKind,
  args: unknown
): string => {
  if (!isRecord(reference) || reference.kind !== kind) {
    throw new TestAssertionError(
      `expected a reference to one of the App's ${kind === "query" ? "queries" : `${kind}s`}, from #grasp`
    );
  }
  const { resourceId, resourceVersion, contractId, fingerprint } = reference;
  return JSON.stringify({
    reference: { resourceId, resourceVersion, contractId, fingerprint, kind },
    input: args,
  });
};

// Values as they cross from the host (JSON), in canonical JSON, so equal
// values compare equal whatever order their keys are in.
const canonical = (value: unknown): string => {
  const text = JSON.stringify(value);
  if (text === undefined) {
    return "undefined";
  }
  // SAFETY: parsing JSON text always gives a JSON value.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return canonicalJson(JSON.parse(text) as Json);
};

/**
 * Releases `stub`, an RPC stub core returned (a session, a subscription),
 * when it is one:
 * the isolate holds it no longer than its test.
 */
const disposed = (stub: object): void => {
  const dispose: unknown = Reflect.get(stub, Symbol.dispose);
  if (typeof dispose === "function") {
    Reflect.apply(dispose, stub, []);
  }
};

/** One test as it runs: its session, and what its live queries wait on. */
interface TestRun {
  readonly session: AppTestSession;
  /** Ends each live query still open: the test is over. */
  readonly closers: Set<() => void>;
  /** What each `next` under way waits on, for a test that runs out of time. */
  readonly waiting: Set<{ readonly describe: () => string }>;
}

/** The most of a snapshot a failure shows. */
const maxShownSnapshot = 300;

/** `value` as a failure shows it, cut short. */
const shown = (value: unknown): string => {
  const text = canonical(value);
  return text.length > maxShownSnapshot
    ? `${text.slice(0, maxShownSnapshot)}…`
    : text;
};

/** The contract a reference names, for a failure's text. */
const contractOf = (reference: unknown): string =>
  isRecord(reference) && typeof reference.contractId === "string"
    ? reference.contractId
    : "a query";

/** A push of core's, as far as a live query reads it. */
const readPush = (
  push: unknown
): { revision: number; result: unknown } | undefined =>
  isRecord(push) &&
  typeof push.revision === "number" &&
  Number.isSafeInteger(push.revision)
    ? { revision: push.revision, result: push.result }
    : undefined;

/**
 * How often in a row core may let go of a live query, with no snapshot
 * in between, before the test fails. Core lets go of one it can't keep
 * fresh for now (a read that met a concurrent write, a store that
 * restarted), and a screen follows it again from a fresh read; so does a
 * test, but one core can't keep following at all fails it.
 */
export const maxLostInARow = 5;

/** How long a test waits to follow again after each loss in a row, in ms. */
const refollowMs = 50;

/** One subscription to a live query, and the newest revision it pushed. */
interface Attempt {
  revision: number;
  handle: AppTestSubscription | undefined;
}

/**
 * Follows `reference` with `args` as principal `name` (`subscribe`): the
 * snapshots core pushes are kept in order, each newer than the last of
 * its subscription (`readPush`'s revision), until `next` takes them.
 * Lost, it follows again, as a screen does, from a fresh read: a new
 * subscription, whose revisions start over, and whose predecessor's late
 * pushes are dropped.
 */
const followed = async (
  run: TestRun,
  name: string,
  reference: unknown,
  args: unknown
): Promise<LiveQuery<unknown>> => {
  const request = requestFor(reference, "query", args);
  const contract = contractOf(reference);
  const snapshots: unknown[] = [];
  let last: { value: unknown } | undefined;
  let failure: Error | undefined;
  let closed = false;
  let wake: (() => void) | undefined;
  let attempt: Attempt | undefined;
  let lostInARow = 0;
  const notify = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  const fail = (error: unknown): void => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    notify();
  };
  /** Whether `of` is what the test follows now, and still may. */
  const current = (of: Attempt): boolean =>
    !closed && failure === undefined && attempt === of;
  const pushed = (of: Attempt, push: unknown): void => {
    const read = readPush(push);
    // One older than a snapshot already had came late: a newer stands.
    if (!current(of) || read === undefined || read.revision <= of.revision) {
      return;
    }
    of.revision = read.revision;
    lostInARow = 0;
    let value: unknown;
    try {
      value = settled(read.result);
    } catch (error) {
      fail(error);
      return;
    }
    snapshots.push(value);
    last = { value };
    // Each snapshot is the whole result: one past the bound replaces
    // nothing the test could still need but the oldest.
    if (snapshots.length > maxBufferedSnapshots) {
      snapshots.shift();
    }
    notify();
  };
  const follow = async (): Promise<void> => {
    const of: Attempt = { revision: 0, handle: undefined };
    attempt = of;
    let handle: AppTestSubscription;
    try {
      const answer = await run.session.subscribe(
        name,
        request,
        (push) => {
          pushed(of, push);
        },
        () => {
          // oxlint-disable-next-line no-use-before-define -- each loss follows again, which may be lost
          lost(of);
        }
      );
      if ("refusal" in answer) {
        // Throws the refusal it holds, as a call's: `t.rejectsCode` reads it.
        settled(JSON.parse(answer.refusal));
        throw new Error(
          "The test runner refused a live query without saying why."
        );
      }
      handle = answer.subscription;
    } catch (error) {
      // Refused: nothing is followed, nor followed again.
      if (attempt === of) {
        attempt = undefined;
      }
      throw error;
    }
    if (current(of)) {
      of.handle = handle;
    } else {
      // Lost, closed or ended meanwhile.
      disposed(handle);
    }
  };
  const lost = (of: Attempt): void => {
    if (!current(of)) {
      return;
    }
    attempt = undefined;
    if (of.handle !== undefined) {
      disposed(of.handle);
    }
    lostInARow += 1;
    if (lostInARow > maxLostInARow) {
      fail(
        new TestAssertionError(
          `core stopped following the live query of ${contract} ${lostInARow} times in a row`
        )
      );
      return;
    }
    const again = async (): Promise<void> => {
      if (closed || failure !== undefined) {
        return;
      }
      try {
        await follow();
      } catch (error) {
        fail(error);
      }
    };
    setTimeout(() => {
      void again();
    }, refollowMs * lostInARow);
  };
  await follow();
  const end = (): Attempt | undefined => {
    closed = true;
    snapshots.length = 0;
    notify();
    const ended = attempt;
    attempt = undefined;
    return ended;
  };
  // As the test ends: nothing of it is held in the isolate past it.
  const drop = (): void => {
    const ended = end();
    if (ended?.handle !== undefined) {
      disposed(ended.handle);
    }
  };
  run.closers.add(drop);
  const waitOn = {
    describe: () =>
      `live.next on ${contract}, ${last === undefined ? "with no snapshot yet" : `whose last snapshot was ${shown(last.value)}`}`,
  };
  return {
    next: async (predicate) => {
      for (;;) {
        while (snapshots.length > 0) {
          const value = snapshots.shift();
          if (predicate === undefined || predicate(value)) {
            return value;
          }
        }
        if (failure !== undefined) {
          throw failure;
        }
        if (closed) {
          throw new TestAssertionError(
            `live.next on ${contract} after it was closed`
          );
        }
        if (wake !== undefined) {
          throw new TestAssertionError(
            `live.next on ${contract} waits for one snapshot at a time`
          );
        }
        const { promise, resolve } = Promise.withResolvers<null>();
        wake = (): void => {
          resolve(null);
        };
        run.waiting.add(waitOn);
        try {
          // One snapshot after another, in the order core pushed them.
          // oxlint-disable-next-line no-await-in-loop -- see above
          await promise;
        } finally {
          run.waiting.delete(waitOn);
        }
      }
    },
    close: async () => {
      if (closed) {
        return;
      }
      const ended = end();
      run.closers.delete(drop);
      if (ended?.handle !== undefined) {
        await ended.handle.release();
        disposed(ended.handle);
      }
    },
  };
};

const principalOf = (run: TestRun, name: string): TestPrincipal => {
  const { session } = run;
  const call =
    (kind: ReferenceKind) =>
    async (reference: unknown, args: unknown): Promise<never> =>
      // SAFETY: the host checked the value against the function's
      // contract (its `returns`), which `ReturnOf` types.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      unwrapped(
        await session.call(name, requestFor(reference, kind, args))
      ) as never;
  return Object.freeze({
    query: call("query"),
    mutation: call("mutation"),
    action: call("action"),
    // SAFETY: what core pushes was checked against the query's contract
    // (its `returns`), which `ReturnOf` types.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    subscribe: (async (reference: unknown, args: unknown) =>
      await followed(run, name, reference, args)) as TestPrincipal["subscribe"],
  });
};

const contextFor = (run: TestRun): AppTestContext => ({
  as: async (name) => {
    const refused = await run.session.principal(name);
    if (refused !== undefined) {
      throw new TestAssertionError(refused);
    }
    return principalOf(run, name);
  },
  equal: (actual, expected, message) => {
    if (canonical(actual) !== canonical(expected)) {
      throw new TestAssertionError(
        `${message === undefined ? "" : `${message}: `}expected ${canonical(expected)}, got ${canonical(actual)}`
      );
    }
  },
  rejectsCode: async (work, code) => {
    try {
      await (typeof work === "function" ? work() : work);
    } catch (error) {
      if (error instanceof TestCallError && error.code === code) {
        return;
      }
      throw new TestAssertionError(
        error instanceof TestCallError
          ? `expected ${code}, but the call failed with ${error.code}: ${error.message}`
          : `expected ${code}, but it threw ${messageOf(error)}`
      );
    }
    throw new TestAssertionError(`expected ${code}, but the call succeeded`);
  },
});

/** The most of one failure's text a report holds. */
const maxFailureLength = 2000;

/** Why a test failed, in one line. */
const failureOf = (error: unknown): string => {
  let failure = `threw ${messageOf(error)}`;
  if (error instanceof TestAssertionError) {
    failure = error.message;
  } else if (error instanceof TestCallError) {
    failure = `unexpected error ${error.code}: ${error.message}`;
  }
  return failure.slice(0, maxFailureLength);
};

/**
 * Runs `test` for at most `ms`: a test that never finishes fails, saying
 * what it still waited on (`waiting`), and the next one runs.
 */
const withinTime = async (
  test: Promise<void>,
  ms: number,
  waiting: TestRun["waiting"]
): Promise<void> => {
  const limit = deadline(ms);
  try {
    await Promise.race([test, whenAborted(limit.signal)]);
  } catch (error) {
    if (limit.stopped() === "timeout") {
      const waits = [...waiting].map(({ describe }) => describe());
      throw new TestAssertionError(
        `didn't finish within ${ms / 1000} seconds${waits.length === 0 ? "" : `, still waiting in ${waits.join("; ")}`}`
      );
    }
    throw error;
  } finally {
    limit.clear();
  }
};

/**
 * Runs `suite` (a test file's default export) over core's `host`, one
 * test after another, each in a session of its own that is closed after
 * it. Never throws for a test: each failure is in the report. Throws for
 * a file whose default export isn't an `appTest` suite. Each test may run
 * `testTimeoutMs`: `appTestTimeoutMs`, or less where core says so.
 */
export const runAppSuite = async (
  suite: unknown,
  host: AppTestHost,
  { testTimeoutMs = appTestTimeoutMs }: { testTimeoutMs?: number } = {}
): Promise<AppTestReport> => {
  const timeoutMs = Math.min(testTimeoutMs, appTestTimeoutMs);
  if (!isRecord(suite) || suite.kind !== "app") {
    return refuseSuite(
      "A test file (tests/*.test.ts) default-exports an appTest suite."
    );
  }
  const { fixtures, tests } = readSuite(suite);
  const results: AppTestResult[] = [];
  for (const [name, test] of Object.entries(tests)) {
    // One test after another: each may only rely on its own session.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const session = await host.open(fixtures, name);
    const run: TestRun = { session, closers: new Set(), waiting: new Set() };
    const failures: string[] = [];
    try {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await withinTime(test(contextFor(run)), timeoutMs, run.waiting);
    } catch (error) {
      failures.push(failureOf(error));
    } finally {
      // Its live queries end with it: core releases their subscriptions
      // as the session closes.
      for (const drop of run.closers) {
        drop();
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      await session.close();
      disposed(session);
    }
    results.push({ name, failures });
  }
  return { fixtures, results };
};
