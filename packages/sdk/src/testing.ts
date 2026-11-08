import { createTestEngine } from "./test-engine.ts";
import type {
  SideEffect,
  StepRecord,
  TestEngineOptions,
} from "./test-engine.ts";
import type { WorkflowDefinition } from "./workflow.ts";

// An App's tests (`appTest`), which core's test runner runs against the
// real host: app-test-suite.ts and app-test-runner.ts.
export { appTestTimeoutMs, runAppSuite } from "./app-test-runner.ts";
export type {
  AppTestHost,
  AppTestReport,
  AppTestResult,
  AppTestSession,
  AppTestSubscription,
} from "./app-test-session.ts";
export {
  appTest,
  maxAppTestName,
  maxAppTests,
  TestDefinitionError,
  testNamePattern,
  workflowTest,
} from "./app-test-suite.ts";
export type {
  AppTestContext,
  AppTestDefinition,
  AppTestFunction,
  AppTestSuite,
  LiveQuery,
  PublicReference,
  TestDecisionAnswer,
  TestEffects,
  TestPrincipal,
  TestRunOutcome,
  TestRuns,
  WorkflowTestContext,
  WorkflowTestDefinition,
  WorkflowTestFunction,
  WorkflowTestRun,
  WorkflowTestSuite,
} from "./app-test-types.ts";
export { createTestEngine } from "./test-engine.ts";
export type {
  SideEffect,
  StepCall,
  StepMock,
  StepRecord,
  TestEngineOptions,
} from "./test-engine.ts";

/**
 * Test harness for workflows. Runs a workflow in memory, with
 * the time-skipping and step-mocking of Temporal's test environment:
 *
 * - steps can be mocked by name, or made to fail;
 * - side-effect steps don't run: they're recorded with their input, so a
 *   test asserts what the workflow would change;
 * - decisions are answered up front, and a wait for one without an answer
 *   times out right away, as sleeps end right away.
 *
 * The workflow SDK's own tests run on it.
 */

/** What a test run or dry run needs besides the workflow. */
export interface TestRunOptions extends Omit<
  TestEngineOptions,
  "sideEffects" | "skipTime"
> {
  /** The run's input, e.g. the invoice that started it. */
  input?: unknown;
}

/** How a test run or dry run went. */
export type TestRun<Output = unknown> = (
  | { status: "completed"; output: Output }
  | { status: "failed"; error: Error }
) & {
  /** What each step did, in order. */
  steps: StepRecord[];
  /** The side effects the run would have had, and their input. */
  sideEffects: SideEffect[];
};

/**
 * Runs a workflow once in memory. Side-effect steps are recorded, never run,
 * whatever the options say. Every other step runs unless it's
 * mocked. Never throws for the workflow: a run that fails comes back with
 * its error.
 */
export const testRun = async <Output>(
  definition: WorkflowDefinition<Output>,
  { input, ...options }: TestRunOptions = {}
): Promise<TestRun<Output>> => {
  const { engine, steps } = createTestEngine({
    ...options,
    // Last, so no option sets it: `TestRunOptions` has no `sideEffects`,
    // but untyped options (a test file's, sent to core) may.
    sideEffects: "record",
  });
  let outcome:
    | { status: "completed"; output: Output }
    | { status: "failed"; error: Error };
  try {
    outcome = {
      status: "completed",
      output: await definition.run(engine, input),
    };
  } catch (error) {
    outcome = {
      status: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  return {
    ...outcome,
    steps,
    sideEffects: steps.flatMap((record) =>
      record.type === "step" && record.sideEffect && record.status !== "failed"
        ? [
            {
              name: record.name,
              ...(record.input === undefined ? {} : { input: record.input }),
            },
          ]
        : []
    ),
  };
};
