// The SDK's root module (`@grasp-os/sdk`): values and schemas (values.ts),
// and how an App registers itself, the permissions it needs and the error
// it fails with on purpose. Server code and schemas import these; the
// server constructors come from the generated `server/_generated/server`
// module.

export * from "./values.ts";
export type * from "./value-types.ts";
export { defineApp } from "./app.ts";
export type { App, AppConfig, AppPermissions } from "./app-types.ts";

export { AppError } from "./app-error.ts";
export { migration } from "./migration.ts";
export type {
  Migration,
  MigrationContext,
  MigrationDefinition,
} from "./migration.ts";
export { httpContract } from "./connector-contracts.ts";
export { graspFunctions } from "./grasp-functions.ts";
export { permission } from "./permission.ts";
export type {
  ComposioCall,
  ComposioContract,
  ConnectorAction,
  ConnectorContract,
  HttpAnswer,
  HttpContract,
  HttpRequestInit,
} from "./connector-contracts.ts";
export type { GraspFunctions } from "./grasp-functions.ts";
export type {
  AiClient,
  BrainClient,
  BrainHit,
  ConnectionClient,
  GuestsClient,
  HttpClient,
} from "./permission-clients.ts";
export type {
  AiPermission,
  AnyPermission,
  AppPermission,
  BrainOperation,
  BrainPermission,
  BrowserPermission,
  ConnectionPermission,
  FilesPermission,
  GraspPermission,
  GuestsOperation,
  GuestsPermission,
  LinksPermission,
  PermissionKind,
  WorkflowConfig,
  WorkflowPermission,
} from "./permission-types.ts";
// References (spec 8, 32.1): what the generated `@server/_generated/api` modules hold.
export type {
  AnyOperationReference,
  AnyWorkflowReference,
  AppErrorCategory,
  AppErrorPayload,
  ArgsOf,
  DecisionContextOf,
  DecisionValueOf,
  DescriptorInputOf,
  DescriptorOutputOf,
  DescriptorSchema,
  EventDataOf,
  FilesOperation,
  FilesReference,
  LinksReference,
  OperationReference,
  ProgressOf,
  ReferenceKind,
  ReferenceVisibility,
  ReturnOf,
  RunHandle,
  WorkflowDecisionDetail,
  WorkflowDecisionInboxItem,
  WorkflowDecisionReference,
  WorkflowDecisionsOf,
  WorkflowDecisionWait,
  WorkflowEngineWait,
  WorkflowEventReference,
  WorkflowEventsOf,
  WorkflowEventWait,
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowQueryPage,
  WorkflowReference,
  WorkflowWait,
  WorkflowWaitOf,
} from "./references.ts";
// Who calls an App, and the organization's people (people.ts): what a
// server function reads as `ctx.auth.getUser()` and `ctx.people`.
export type {
  PageOptions,
  PeopleDirectory,
  PeoplePage,
  Person,
  TeamRef,
  User,
} from "./people.ts";
