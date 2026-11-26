// `@grasp-os/runtime/connector`: what a connector is written with (the
// surface `@grasp-os/sdk/connector` re-exports), the MCP server it becomes
// in its isolate, and the manifest, contracts and sign-in records connect
// decides by. The one entry of the runtime connect imports: it reaches no
// React, TanStack or App code (scripts/check-runtime-boundary.ts).

export { v } from "../common/values.ts";
export type { Infer, InferInput } from "../common/value-types.ts";
export { auth, defineConnector, event, page, sync, tool } from "./define.ts";
export type {
  AccountDeclaration,
  Checkpoint,
  ConnectorAuth,
  ConnectorDeclaration,
  ConnectorReader,
  ConnectorTool,
  DefinedConnector,
  EventDeclaration,
  IdTokenDeclaration,
  OAuth2Declaration,
  RightsDeclaration,
  SyncDeclaration,
  ToolArgs,
  ToolCall,
  ToolDeclaration,
} from "./define.ts";
export type {
  Api,
  ApiAnswer,
  ApiRequest,
  QueryValue,
  RouteMethod,
  RouteText,
} from "./api.ts";
export {
  ToolError,
  callMetaOf,
  checkOneWrite,
  contractSchemaOf,
  failure,
  invalidCode,
  isClosed,
  lookUp,
  recoveryOf,
  runFailure,
  serveConnector,
} from "./server.ts";
export type {
  CallMeta,
  CallResult,
  Connector,
  ConnectorBase,
  FailureKind,
  JsonObject,
  Tool,
  ToolChange,
  ToolErrorCode,
  ToolErrorDetails,
  ToolResult,
} from "./server.ts";
export {
  connectorIsolateRequests,
  connectorManifestSchema,
  connectorNameSchema,
  generatedContractMajor,
  generatedContracts,
  hostSchema,
  maxProvenanceItems,
  provenanceSchema,
  readAsSchema,
  recoveryModes,
  redirectHostMatches,
  routeSchema,
  syncManifestSchema,
  syncNameSchema,
  syncParamsSchema,
  syncPlacesParamsSchema,
} from "./manifest.ts";
export type {
  ActionDescribe,
  ActionManifest,
  ConnectorManifest,
  ContractAction,
  RecoveryMode,
  Route,
  SyncManifest,
  SyncParams,
} from "./manifest.ts";
export {
  attachmentsMetaKey,
  changeMetaKey,
  confirmedMetaKey,
  effectAbsentMetaKey,
  effectKeyMetaKey,
  effectKeyPattern,
  egressHeader,
  egressKind,
  egressTooLargeMessage,
  findMetaKey,
  forbiddenInValue,
  httpMethods,
  maxChangeBytes,
  maxRetryAfterSeconds,
  mcpProtocolVersion,
  notPerformedMetaKey,
  outcomeUnknownMetaKey,
  pathMatches,
  provenanceMetaKey,
  resourceMetaKey,
  segmentValuePattern,
  stampHeader,
  stampMetaKey,
  stampPattern,
  syncMethod,
  syncPlacesMethod,
} from "./protocol.ts";
export type { EgressKind } from "./protocol.ts";
export {
  accountLookupSchema,
  endpointHost,
  keyHeaderSchema,
  plainEndpointSchema,
  reservedAuthorizationParams,
  scopeToken,
  signInSchema,
  signInScopesSchema,
  tenantKinds,
  withTenant,
} from "./sign-in.ts";
export {
  filledHost,
  fitsTemplate,
  hostOf,
  hostTemplateOf,
  requestHost,
} from "./hosts.ts";
export { addressesOf } from "./mail-addresses.ts";
export type { Address } from "./mail-addresses.ts";
export type {
  AccountLookup,
  DeclaredRights,
  IdTokenCheck,
  SignIn,
  SignInInput,
  TenantKind,
} from "./sign-in.ts";
export { jsonSchemaOf } from "../common/json-schema.ts";
export { jsonBody, providerFetch, retryAfterOf, segment } from "./provider.ts";
export {
  classByRules,
  isJsonArray,
  isNeverPath,
  isNeverTool,
  ruledDeclaration,
  topNames,
} from "./tool-rules.ts";
export type { RuledTool, ToolHints } from "./tool-rules.ts";
export type { Provider, ProviderDefinition } from "./provider.ts";
export {
  checkReadable,
  contentAs,
  fromBase64,
  maxContentBytes,
  maxReadBytes,
  toBase64,
} from "./content.ts";
export {
  RestartSyncError,
  contentSize,
  cursorPart,
  defineSync,
  fetchBefore,
  fetchInRoom,
  fillPage,
  fitItem,
  fromCursorPart,
  fromInPagePart,
  inPagePart,
  isTooLarge,
  mayRequest,
  startOfPage,
  syncFailureSchema,
  syncPageLimits,
  syncPlacesResultSchema,
  syncResultSchema,
  syncRoom,
  takeContent,
} from "./sync.ts";
export type {
  EntryItems,
  InPage,
  PageFill,
  Sync,
  SyncDefinition,
  SyncFailure,
  SyncPlacesResult,
  SyncResult,
  SyncRoom,
} from "./sync.ts";
