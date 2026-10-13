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
    // SAFETY: a function, checked just above; what it does with `t` is
    // the test's own, and a failure is reported as the test's.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    checked[name] = test as AppTestFunction;
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
  /** Ends the session, discarding its fixture store. */
  close: () => Promise<void>;
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

/** The value a call's answer (an `OperationResult`'s text) holds. */
const unwrapped = (answer: string): unknown => {
  const parsed: unknown = JSON.parse(answer);
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

const principalOf = (session: AppTestSession, name: string): TestPrincipal => {
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

const contextFor = (session: AppTestSession): AppTestContext => ({
  as: async (name) => {
    const refused = await session.principal(name);
    if (refused !== undefined) {
      throw new TestAssertionError(refused);
    }
    return principalOf(session, name);
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
 * Runs `test` for at most `ms`: a test that never finishes fails, and the
 * next one runs.
 */
const withinTime = async (run: Promise<void>, ms: number): Promise<void> => {
  const limit = deadline(ms);
  try {
    await Promise.race([run, whenAborted(limit.signal)]);
  } catch (error) {
    if (limit.stopped() === "timeout") {
      throw new TestAssertionError(`didn't finish within ${ms / 1000} seconds`);
    }
    throw error;
  } finally {
    limit.clear();
  }
};

/**
 * Releases `stub`, an RPC stub core returned (a session), when it is one:
 * the isolate holds it no longer than its test.
 */
const disposed = (stub: object): void => {
  const dispose: unknown = Reflect.get(stub, Symbol.dispose);
  if (typeof dispose === "function") {
    Reflect.apply(dispose, stub, []);
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
    const failures: string[] = [];
    try {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await withinTime(test(contextFor(session)), timeoutMs);
    } catch (error) {
      failures.push(failureOf(error));
    } finally {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await session.close();
      disposed(session);
    }
    results.push({ name, failures });
  }
  return { fixtures, results };
};
