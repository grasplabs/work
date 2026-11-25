// `@grasp-os/sdk/connector`: how a connector is written. Re-exported by
// name from @grasp-os/runtime, which implements it. A connector's files
// import this and nothing else.

export {
  auth,
  defineConnector,
  event,
  page,
  sync,
  tool,
  v,
} from "@grasp-os/runtime/connector";
export type {
  AccountDeclaration,
  Api,
  ApiRequest,
  Checkpoint,
  ConnectorAuth,
  ConnectorDeclaration,
  ConnectorTool,
  EventDeclaration,
  Infer,
  InferInput,
  QueryValue,
  RouteText,
  SyncDeclaration,
  ToolArgs,
  ToolCall,
  ToolDeclaration,
} from "@grasp-os/runtime/connector";
