// An App's tests (`appTest`), which core's test runner runs against the
// real host: app-test-suite.ts and app-test-runner.ts. They assert with
// vitest's `expect`, imported from `vitest` (vitest.ts).
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
} from "./app-test-suite.ts";
export type {
  AppTestContext,
  AppTestFunction,
  AppTestSuite,
  LiveQuery,
  PublicReference,
  TestClock,
  TestDecisionAnswer,
  TestEffects,
  TestIdentity,
  TestIdentityFields,
  TestRun,
  TestRunContext,
  TestRunOutcome,
  TestRuns,
  TestStartOptions,
  WorkflowTestRun,
} from "./app-test-types.ts";
export { GraspError } from "./client-error.ts";
