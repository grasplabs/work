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
  attachmentsMetaKey,
  changeMetaKey,
  confirmedMetaKey,
  connectorIsolateRequests,
  connectorManifestSchema,
  connectorNameSchema,
  effectAbsentMetaKey,
  effectKeyMetaKey,
  effectKeyPattern,
  egressHeader,
  egressKind,
  egressTooLargeMessage,
  findMetaKey,
  forbiddenInValue,
  generatedContractMajor,
  generatedContracts,
  hostSchema,
  httpMethods,
  maxChangeBytes,
  maxProvenanceItems,
  maxRetryAfterSeconds,
  mcpProtocolVersion,
  notPerformedMetaKey,
  outcomeUnknownMetaKey,
  pathMatches,
  provenanceMetaKey,
  provenanceSchema,
  readAsSchema,
  recoveryModes,
  redirectHostMatches,
  resourceMetaKey,
  routeSchema,
  segmentValuePattern,
  stampHeader,
  stampMetaKey,
  stampPattern,
  syncManifestSchema,
  syncMethod,
  syncNameSchema,
  syncParamsSchema,
  syncPlacesMethod,
  syncPlacesParamsSchema,
} from "./manifest.ts";
export type {
  ActionDescribe,
  ActionManifest,
  ConnectorManifest,
  ContractAction,
  EgressKind,
  RecoveryMode,
  Route,
  SyncManifest,
  SyncParams,
} from "./manifest.ts";
export {
  accountLookupSchema,
  endpointHost,
  reservedAuthorizationParams,
  signInSchema,
  tenantKinds,
  withTenant,
} from "./sign-in.ts";
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
export { jsonBody, providerFetch, segment } from "./provider.ts";
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
