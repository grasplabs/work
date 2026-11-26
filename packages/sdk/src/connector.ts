// `@grasp-os/sdk/connector`: how a connector is written. Re-exported by
// name from @grasp-os/runtime, which implements it. A connector's files
// import this and nothing else.

export {
  attachedFiles,
  attachments,
  auth,
  contentAs,
  defineConnector,
  event,
  page,
  stampHeader,
  sync,
  tool,
  ToolError,
  v,
} from "@grasp-os/runtime/connector";
export type {
  AccountDeclaration,
  Api,
  ApiRequest,
  AttachedFile,
  Checkpoint,
  ConnectorAuth,
  ConnectorDeclaration,
  ConnectorReader,
  ConnectorTool,
  EventDeclaration,
  IdTokenDeclaration,
  Infer,
  InferInput,
  McpDeclaration,
  OAuth2Declaration,
  QueryValue,
  RightsDeclaration,
  RouteText,
  SyncDeclaration,
  ToolArgs,
  ToolCall,
  ToolDeclaration,
} from "@grasp-os/runtime/connector";
