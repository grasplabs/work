// The SDK's root module (`@grasp-os/sdk`): values and schemas (values.ts),
// and how an App registers itself, the permissions it needs and the error
// it fails with on purpose. Server code and schemas import these; the
// server constructors come from the generated `server/_generated/server`
// module.

export * from "./values.ts";
export { app } from "./app.ts";
export type {
  App,
  AppDefinition,
  AppPermissions,
  OperationAccess,
  ScreenDefinition,
  TableVerbs,
} from "./app.ts";
export { AppError } from "./app-error.ts";
export { migration } from "./migration.ts";
export type {
  Migration,
  MigrationContext,
  MigrationDefinition,
} from "./migration.ts";
export {
  graspAlias,
  graspFunctions,
  httpContract,
  permission,
} from "./permissions.ts";
export type {
  AiClient,
  AiPermission,
  AnyPermission,
  AppClient,
  AppPermission,
  BrainClient,
  BrainHit,
  BrainOperation,
  BrainPermission,
  BrowserPermission,
  ComposioCall,
  ComposioContract,
  ConnectionClient,
  ConnectionPermission,
  ConnectorAction,
  ConnectorContract,
  FilesPermission,
  GraspFunctions,
  GuestsClient,
  GuestsOperation,
  GuestsPermission,
  HttpAnswer,
  HttpClient,
  HttpContract,
  HttpRequestInit,
  LinksPermission,
  PermissionKind,
  WorkflowConfig,
  WorkflowPermission,
} from "./permissions.ts";
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
  ScreenInputOf,
  ScreenSurfaceData,
  SurfaceInputOf,
  SurfaceNameOf,
  ScreenOutputOf,
  ScreenProps,
  ScreenReference,
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
