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
/**
 * An in-memory engine for workflows, with the time-skipping and
 * step-mocking of Temporal's test environment: steps can be mocked by
 * name, or made to fail; decisions are answered up front, and a wait for
 * one without an answer times out right away, as sleeps end right away.
 * The workflow SDK's own tests run on it.
 */
export { createTestEngine } from "./test-engine.ts";
export type {
  StepCall,
  StepMock,
  StepRecord,
  TestEngineOptions,
} from "./test-engine.ts";
