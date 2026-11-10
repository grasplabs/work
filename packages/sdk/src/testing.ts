// `@grasp-os/sdk/testing`: an App's tests (`appTest`, `workflowTest`)
// and what they reach. Re-exported by name from @grasp-os/runtime, whose
// runner the platform runs them with.

export {
  appTest,
  TestDefinitionError,
  workflowTest,
} from "@grasp-os/runtime/testing";
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
} from "@grasp-os/runtime/testing";
