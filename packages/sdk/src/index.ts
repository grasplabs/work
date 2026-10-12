// The SDK's root module (`@grasp-os/sdk`): values and schemas (values.ts),
// and how an App registers itself, the resources it needs and the error
// it fails with on purpose. Server code and schemas import these; the
// server constructors come from the generated `#grasp/server` module.

export * from "./values.ts";
export { app } from "./app.ts";
export type {
  App,
  AppDefinition,
  OperationAccess,
  OperationTree,
  TableVerbs,
} from "./app.ts";
export { AppError } from "./app-error.ts";
export { resource } from "./resources.ts";
export type {
  AnyResource,
  ConnectorResource,
  KnowledgeHit,
  KnowledgeOperation,
  KnowledgeResource,
  ModelResource,
  ResourceKind,
  TemplateResource,
} from "./resources.ts";
