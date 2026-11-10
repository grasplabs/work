import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { messageOf } from "@grasp-os/shared/errors";
import { isRecord } from "@grasp-os/shared/json";
import type { ReadRequest, WriteRequest } from "@grasp-os/shared/store-reads";

import { followed } from "./app-test-follow.ts";
import {
  TestAssertionError,
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
  AppTestContext,
  TestDecisionAnswer,
  TestIdentity,
  TestIdentityFields,
  TestRun,
  TestRunOutcome,
  TestRuns,
  TestStartOptions,
  WorkflowTestRun,
} from "./app-test-types.ts";
import { GraspError } from "./client-error.ts";
import { databaseWriter } from "./database-writer.ts";
import type { ReferenceKind } from "./function-references.ts";
import type { SchemaDefinition } from "./schema-types.ts";
import type { AnyTables } from "./server-function.ts";

/** What `t.run` waits for before it begins: nobody to register. */
const nobodyToWaitFor = async (): Promise<void> => {
  await Promise.resolve();
};

/**
 * How long one test may run before it fails, in milliseconds, its calls
 * included: they are real calls of the App's functions.
 */
export const appTestTimeoutMs = 30_000;

/**
 * Each run an identity started: the test that started it, and its number
 * in that test's session, which names another run in any other test's.
 */
const runNumbers = new WeakMap<
  object,
  { readonly test: RunningTest; readonly number: number }
>();

/** Each identity a test made: the test, and the name core knows it by. */
const identityNames = new WeakMap<
  object,
  { readonly test: RunningTest; readonly name: string }
>();

/**
 * The number of `run` in `test`'s session, a handle one of `test`'s own
 * identities started; fails the test for any other, one kept from another
 * test included.
 */
const numberOf = (test: RunningTest, run: unknown): number => {
  const started =
    typeof run === "object" && run !== null ? runNumbers.get(run) : undefined;
  if (started === undefined) {
    throw new TestAssertionError(
      "expected a run a test identity started, from start"
    );
  }
  if (started.test !== test) {
    throw new TestAssertionError(
      "expected a run this test started, not one another test started"
    );
  }
  return started.number;
};

/** The name of `identity`, one of `test`'s own; fails the test for any other. */
const nameOf = (test: RunningTest, identity: unknown): string => {
  const made =
    typeof identity === "object" && identity !== null
      ? identityNames.get(identity)
      : undefined;
  if (made?.test !== test) {
    throw new TestAssertionError(
      "expected an identity this test made, from t.withIdentity"
    );
  }
  return made.name;
};

/** A workflow reference's name: `workflows.<alias>`. */
const workflowNamePattern = /^workflows\.[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** The name of the workflow `reference` names, or undefined for none. */
const workflowNameOf = (reference: unknown): string | undefined =>
  isRecord(reference) &&
  typeof reference.name === "string" &&
  workflowNamePattern.test(reference.name)
    ? reference.name
    : undefined;

/**
 * The start request for `reference` with `args`, as a page's
 * `useWorkflow` sends it: a call of the `start` mutation under the
 * workflow's own name, never one the reference carries.
 */
const startRequestFor = (reference: unknown, args: unknown): string => {
  const name = workflowNameOf(reference);
  if (name === undefined) {
    throw new TestAssertionError(
      "expected a reference to one of the App's workflows, from @server/_generated/api"
    );
  }
  return requestFor({ name: `${name}.mutations.start` }, "mutation", { args });
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

/** `options` as the session takes them: deciders by name. */
const startOptionsOf = (
  test: RunningTest,
  options: TestStartOptions = {}
): string => {
  const { deciders, ...rest } = options;
  return JSON.stringify({
    ...rest,
    ...(deciders === undefined
      ? {}
      : {
          deciders: Object.fromEntries(
            Object.entries(deciders).map(([alias, identities]) => [
              alias,
              identities.map((identity) => nameOf(test, identity)),
            ])
          ),
        }),
  });
};

/** What a transaction's `begin` answers: its number. */
const transactionOf = (value: unknown): number => {
  if (
    isRecord(value) &&
    typeof value.transaction === "number" &&
    Number.isSafeInteger(value.transaction)
  ) {
    return value.transaction;
  }
  throw new Error("The test runner answered a transaction without its number.");
};

/**
 * `t.run` as `name` (the test itself for `null`): `fn` with a `ctx.db`
 * over `schema` whose reads and writes are the transaction's, which
 * commits once `fn` returns and is dropped if it throws.
 */
const runAs =
  (
    test: RunningTest,
    schema: SchemaDefinition,
    name: string | null,
    ready: () => Promise<void>
  ) =>
  async (fn: unknown): Promise<unknown> => {
    if (typeof fn !== "function") {
      throw new TestAssertionError("expected a function to run, (ctx) => ...");
    }
    await ready();
    const { session } = test;
    const transaction = transactionOf(unwrapped(await session.begin(name)));
    const db = databaseWriter(
      schema,
      async (request: ReadRequest) =>
        unwrapped(await session.read(transaction, JSON.stringify(request))),
      async (request: WriteRequest) =>
        unwrapped(await session.write(transaction, JSON.stringify(request)))
    );
    let value: unknown;
    try {
      value = await Reflect.apply(fn, undefined, [Object.freeze({ db })]);
    } catch (error) {
      // Its own error is what the test hears, whatever dropping it said.
      await session.end(transaction, false).catch(() => null);
      throw error;
    }
    unwrapped(await session.end(transaction, true));
    return value;
  };

/**
 * Identity `name` of `test`, each of whose calls waits for `ready`: core
 * knows them once it settles (`identify`).
 */
const identityOf = (
  test: RunningTest,
  schema: SchemaDefinition,
  name: string,
  ready: () => Promise<void>
): TestIdentity => {
  const { session } = test;
  const call =
    (kind: ReferenceKind) =>
    async (reference: unknown, args: unknown): Promise<never> => {
      const request = requestFor(reference, kind, args);
      await ready();
      // SAFETY: the host checked the value against the function's
      // contract (its `returns`), which `FunctionReturn` types.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return unwrapped(await session.call(name, request)) as never;
    };
  const identity: TestIdentity = Object.freeze({
    query: call("query"),
    mutation: call("mutation"),
    action: call("action"),
    // SAFETY: what core pushes was checked against the query's contract
    // (its `returns`), which `FunctionReturn` types.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    subscribe: (async (reference: unknown, args: unknown) => {
      await ready();
      return await followed(test, name, reference, args);
    }) as TestIdentity["subscribe"],
    // SAFETY: a start answers the run's handle, whose result only types it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    start: (async (
      reference: unknown,
      args: unknown,
      options?: TestStartOptions
    ) => {
      const request = startRequestFor(reference, args);
      const given = startOptionsOf(test, options);
      await ready();
      const answer = await session.start(name, request, given);
      const handle: WorkflowTestRun = Object.freeze({
        workflow: workflowNameOf(reference) ?? "a workflow",
      });
      runNumbers.set(handle, {
        test,
        number: startedNumber(unwrapped(answer)),
      });
      return handle;
    }) as TestIdentity["start"],
    respond: async (
      handle: WorkflowTestRun,
      task: string,
      { approved, value, run: asked }: TestDecisionAnswer
    ): Promise<void> => {
      await ready();
      unwrapped(
        await session.respond(
          name,
          numberOf(test, handle),
          JSON.stringify({
            task,
            approved,
            ...(value === undefined ? {} : { value }),
            ...(asked === undefined ? {} : { run: asked }),
          })
        )
      );
    },
    // SAFETY: what `fn` returns is what it answers.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    run: runAs(test, schema, name, ready) as TestRun<AnyTables>,
  });
  identityNames.set(identity, { test, name });
  return identity;
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

/** Who `fields` names, as the session registers them (`identify`). */
const identityRequest = (fields: unknown): { name: string; text: string } => {
  if (!isRecord(fields) || typeof fields.name !== "string") {
    throw new TestAssertionError(
      'expected who to act as, such as t.withIdentity({ name: "Ada" })'
    );
  }
  const { name, role = "user", teams = [] } = fields;
  return { name, text: JSON.stringify({ name, role, teams }) };
};

const contextFor = (
  test: RunningTest,
  schema: SchemaDefinition
): AppTestContext => {
  const { session } = test;
  return {
    withIdentity: (fields: TestIdentityFields) => {
      const { name, text } = identityRequest(fields);
      // Answered at once, as convex-test's is; core registers them
      // before any call of theirs, which waits for it. A refusal fails
      // each of their calls, and the test even if none follows.
      const registered = session.identify(text);
      test.pending.add(registered);
      return identityOf(test, schema, name, async () => {
        const refused = await registered;
        if (refused !== undefined) {
          throw new TestAssertionError(refused);
        }
      });
    },
    // SAFETY: what `fn` returns is what it answers.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    run: runAs(test, schema, null, nobodyToWaitFor) as TestRun<AnyTables>,
    runs: {
      // SAFETY: the run's result was checked against its version's
      // `returns` schema as it ended, which `Returns` types.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      untilTerminal: (async (handle: WorkflowTestRun) =>
        outcomeOf(
          await session.runOutcome(numberOf(test, handle)),
          handle
        )) as TestRuns["untilTerminal"],
      untilWaiting: async (handle) => {
        if (!(await session.runWaits(numberOf(test, handle)))) {
          throw new TestAssertionError(
            `the run of ${handle.workflow} neither waited nor ended before the test's deadline`
          );
        }
      },
    },
    effects: {
      completedCount: async (handle, task) =>
        await session.completedCount(numberOf(test, handle), task),
      modelRequestCount: async (handle, task) =>
        await session.modelRequestCount(numberOf(test, handle), task),
    },
    clock: {
      advance: async (ms) => {
        if (!Number.isSafeInteger(ms) || ms < 0) {
          throw new TestAssertionError(
            "expected the milliseconds to move the clock on by, a whole number of them"
          );
        }
        unwrapped(await session.advanceClock(ms));
      },
    },
  };
};

/** The most of one failure's text a report holds. */
const maxFailureLength = 2000;

/** Why a test failed, in one line. */
const failureOf = (error: unknown): string => {
  let failure = `threw ${messageOf(error)}`;
  if (error instanceof GraspError) {
    failure = `unexpected error ${error.code}: ${error.message}`;
  } else if (error instanceof Error && error.name === "AssertionError") {
    // vitest's `expect` failing: its message says what it expected.
    failure = error.message;
  } else if (error instanceof TestAssertionError) {
    failure = error.message;
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
  const { schema, tests } = readSuite(suite.schema, suite.tests);
  const results: AppTestResult[] = [];
  for (const [name, test] of Object.entries(tests)) {
    // One test after another: each may only rely on its own session.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const session = await host.open(name);
    const run: RunningTest = {
      session,
      closers: new Set(),
      waiting: new Set(),
      faults: new Set(),
      pending: new Set(),
    };
    const failures: string[] = [];
    try {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await withinTime(test(contextFor(run, schema)), timeoutMs, run.waiting);
      // Who it named, registered before it is judged.
      // oxlint-disable-next-line no-await-in-loop -- see above
      for (const refused of await Promise.all(run.pending)) {
        if (refused !== undefined) {
          run.faults.add(new TestAssertionError(refused));
        }
      }
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
  return { results };
};
