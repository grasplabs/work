import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { messageOf } from "@grasp-os/shared/errors";
import { isRecord } from "@grasp-os/shared/json";

import { followed } from "./app-test-follow.ts";
import {
  TestAssertionError,
  TestCallError,
  canonical,
  disposed,
  requestFor,
  unwrapped,
} from "./app-test-session.ts";
import type {
  AppTestHost,
  AppTestReport,
  AppTestResult,
  RunningTest,
} from "./app-test-session.ts";
import { readSuite, refuseSuite } from "./app-test-suite.ts";
import type {
  TestDecisionAnswer,
  TestPrincipal,
  TestRunOutcome,
  TestRuns,
  WorkflowTestContext,
  WorkflowTestFunction,
  WorkflowTestRun,
} from "./app-test-types.ts";
import type { ReferenceKind } from "./function-references.ts";

/**
 * How long one test may run before it fails, in milliseconds, its calls
 * included: they are real calls of the App's functions.
 */
export const appTestTimeoutMs = 30_000;

/**
 * Each run a principal started: the test that started it, and its number
 * in that test's session, which names another run in any other test's.
 */
const runNumbers = new WeakMap<
  object,
  { readonly test: RunningTest; readonly number: number }
>();

/**
 * The number of `run` in `test`'s session, a handle one of `test`'s own
 * principals started; fails the test for any other, one kept from another
 * test included.
 */
const numberOf = (test: RunningTest, run: unknown): number => {
  const started =
    typeof run === "object" && run !== null ? runNumbers.get(run) : undefined;
  if (started === undefined) {
    throw new TestAssertionError(
      "expected a run a test principal started, from start"
    );
  }
  if (started.test !== test) {
    throw new TestAssertionError(
      "expected a run this test started, not one another test started"
    );
  }
  return started.number;
};

/**
 * The start request for `reference` with `input`, as a page's
 * `useWorkflow` sends it: a call of the reference's `start` mutation.
 */
const startRequestFor = (reference: unknown, input: unknown): string => {
  const start =
    isRecord(reference) &&
    reference.kind === "workflow" &&
    isRecord(reference.mutations)
      ? reference.mutations.start
      : undefined;
  if (!isRecord(start)) {
    throw new TestAssertionError(
      "expected a reference to one of the App's workflows, from @server/_generated/api"
    );
  }
  return requestFor(start, "mutation", { input });
};

/** What a start answers: the run's number in the session. */
const startedNumber = (value: unknown): number => {
  if (
    isRecord(value) &&
    typeof value.run === "number" &&
    Number.isSafeInteger(value.run)
  ) {
    return value.run;
  }
  throw new Error("The test runner answered a start without its run.");
};

const principalOf = (run: RunningTest, name: string): TestPrincipal => {
  const { session } = run;
  const call =
    (kind: ReferenceKind) =>
    async (reference: unknown, args: unknown): Promise<never> =>
      // SAFETY: the host checked the value against the function's
      // contract (its `returns`), which `FunctionReturn` types.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      unwrapped(
        await session.call(name, requestFor(reference, kind, args))
      ) as never;
  return Object.freeze({
    query: call("query"),
    mutation: call("mutation"),
    action: call("action"),
    // SAFETY: what core pushes was checked against the query's contract
    // (its `returns`), which `FunctionReturn` types.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    subscribe: (async (reference: unknown, args: unknown) =>
      await followed(run, name, reference, args)) as TestPrincipal["subscribe"],
    // SAFETY: a start answers the run's handle, whose output only types it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    start: (async (reference: unknown, input: unknown) => {
      const answer = await session.start(
        name,
        startRequestFor(reference, input)
      );
      const handle: WorkflowTestRun = Object.freeze({
        workflow:
          isRecord(reference) && typeof reference.contractId === "string"
            ? reference.contractId
            : "a workflow",
      });
      runNumbers.set(handle, {
        test: run,
        number: startedNumber(unwrapped(answer)),
      });
      return handle;
    }) as TestPrincipal["start"],
    respond: async (
      handle: WorkflowTestRun,
      task: string,
      { approved, value, run: asked }: TestDecisionAnswer
    ): Promise<void> => {
      unwrapped(
        await session.respond(
          name,
          numberOf(run, handle),
          JSON.stringify({
            task,
            approved,
            ...(value === undefined ? {} : { value }),
            ...(asked === undefined ? {} : { run: asked }),
          })
        )
      );
    },
  });
};

/** The outcome `text` (`runOutcome`'s answer) holds; fails the test for none. */
const outcomeOf = (text: string, run: WorkflowTestRun): TestRunOutcome => {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null) {
    throw new TestAssertionError(
      `the run of ${run.workflow} didn't end before the test's deadline`
    );
  }
  if (
    isRecord(parsed) &&
    (parsed.status === "completed" ||
      parsed.status === "failed" ||
      parsed.status === "cancelled")
  ) {
    // SAFETY: core answers a `FixtureRunOutcome`, which this is the shape of.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return parsed as TestRunOutcome;
  }
  throw new Error("The test runner answered something else than an outcome.");
};

const contextFor = (run: RunningTest): WorkflowTestContext => ({
  runs: {
    // SAFETY: the run's output was checked against its version's output
    // schema as it ended, which `Output` types.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    untilTerminal: (async (handle: WorkflowTestRun) =>
      outcomeOf(
        await run.session.runOutcome(numberOf(run, handle)),
        handle
      )) as TestRuns["untilTerminal"],
  },
  effects: {
    completedCount: async (handle, task) =>
      await run.session.completedCount(numberOf(run, handle), task),
  },
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
  waiting: RunningTest["waiting"]
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
 * a file whose default export isn't an `appTest` or `workflowTest` suite. Each test may run
 * `testTimeoutMs`: `appTestTimeoutMs`, or less where core says so.
 */
export const runAppSuite = async (
  suite: unknown,
  host: AppTestHost,
  { testTimeoutMs = appTestTimeoutMs }: { testTimeoutMs?: number } = {}
): Promise<AppTestReport> => {
  const timeoutMs = Math.min(testTimeoutMs, appTestTimeoutMs);
  if (!isRecord(suite) || (suite.kind !== "app" && suite.kind !== "workflow")) {
    return refuseSuite(
      "A test file (tests/*.test.ts) default-exports an appTest or workflowTest suite."
    );
  }
  const { fixtures, tests } = readSuite<WorkflowTestFunction>(
    suite,
    suite.kind
  );
  const results: AppTestResult[] = [];
  for (const [name, test] of Object.entries(tests)) {
    // One test after another: each may only rely on its own session.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const session = await host.open(fixtures, name);
    const run: RunningTest = {
      session,
      closers: new Set(),
      waiting: new Set(),
      faults: new Set(),
    };
    const failures: string[] = [];
    try {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await withinTime(test(contextFor(run)), timeoutMs, run.waiting);
      const [fault] = run.faults;
      if (fault !== undefined) {
        throw fault;
      }
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
