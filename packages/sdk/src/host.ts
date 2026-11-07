// What a host needs of the SDK and App code never does. A host holds
// descriptors as data (in a manifest, from a browser, from another version)
// and turns them back into schemas here, without running the code that
// declared them.

// What a host knows of schemas that App code needn't: the managed fields,
// the limits, and the error a declaration throws.
export {
  allowsNull,
  indexBase,
  managedFields,
  relationOf,
  SchemaDefinitionError,
  schemaLimits,
} from "./schema.ts";
export type {
  AccessMode,
  AccessModes,
  IndexBase,
  RowRole,
  RowRule,
  RowRules,
  SchemaDefinitionCode,
  TableAccess,
} from "./schema.ts";
// The descriptor format a manifest names, for a host that writes one.
export { descriptorVersion } from "./value-descriptor.ts";

// An App as the host runs it: its registration as data, and its handlers.
export { inspectApp, registerApp } from "./app.ts";
export type {
  AppInspection,
  AppManifest,
  AppParts,
  OperationManifest,
  ServerModules,
  UseManifest,
} from "./app.ts";
export { appErrorDetailsOf } from "./app-error.ts";
export { appMaxMigrations } from "./app.ts";
export { migrationPlatformMessages } from "./migration.ts";
export type { MigrationManifest } from "./migration.ts";

// A schema as a store's host reads, hashes and compares it.
export { diffSchemaManifests, schemaReferences } from "./schema-diff.ts";
export type {
  AccessChange,
  FieldChange,
  IndexChange,
  ReferenceStep,
  SchemaChange,
  SchemaDiff,
  SchemaReference,
  TableChange,
} from "./schema-diff.ts";
export {
  fieldWidens,
  holdsId,
  planSchemaChange,
  schemaCovered,
  withDefaultsFilled,
} from "./schema-plan.ts";
export type {
  AcceptedPlan,
  PlanOptions,
  PlannedChanges,
  PlannedCheck,
  PlannedField,
  PlannedIndex,
  PlannedRename,
  PlanRefusal,
  PlanRefusalReason,
  RefusedPlan,
  ReservedFields,
  SchemaAnswer,
  SchemaPlan,
} from "./schema-plan.ts";
export {
  manifestMaxBytes,
  manifestText,
  manifestVersion,
  readSchemaManifest,
  schemaHash,
  schemaManifest,
} from "./schema-manifest.ts";
export type {
  ManifestAccess,
  ManifestIndex,
  ManifestTable,
  ReadManifest,
  SchemaManifest,
} from "./schema-manifest.ts";

// Which currencies and time zones this SDK accepts: a host compares it with
// its own before it activates an App.
export { valueCatalogVersion } from "./value-catalog.ts";

// What a host reads a descriptor from its JSON text with: one reader,
// which a workflow's run uses too (`fittedValue`).
export { descriptorFromText, schemaFromDescriptor } from "./descriptor-text.ts";

// An App's manifest as the host reads it back from what inspection or a
// release answered, and the modules and references it generates from it.
export { appManifestMaxBytes } from "@grasp-os/shared/app-limits";
export { readAppManifest } from "./app-manifest.ts";
export {
  connectorCatalogSource,
  contractFingerprint,
  contractFingerprints,
  contractsFormatVersion,
  declaredWorkflows,
  decisionFingerprint,
  eventFingerprint,
  generatedPaths,
  generateModules,
  readSealedWorkflows,
  dataModelSource,
  serverModuleSource,
  symbolicModules,
  valueTypeOf,
  workflowFingerprint,
  workflowReferenceOf,
} from "./generate.ts";
export type {
  BoundWorkflow,
  BoundWorkflowDecision,
  BoundWorkflowEvent,
  WorkflowBindingExtras,
  WorkflowPin,
  CatalogAction,
  ReleaseIdentity,
} from "./generate.ts";
export { workflowReferenceLimits } from "./references.ts";
export { workflowQueries } from "./workflow-queries.ts";
export type { WorkflowQueryName } from "./workflow-queries.ts";
export {
  preferenceOperations,
  preferencePaths,
} from "./preference-operations.ts";
export type { PreferenceOperationName } from "./preference-operations.ts";

export { planPreferenceChange } from "./preference-plan.ts";
// Who calls an App, and the organization's people, which core answers
// itself (people.ts).
export {
  isPeopleOperationName,
  peopleLimits,
  peopleOperations,
  peopleReferences,
} from "./people.ts";
export type {
  PeopleOperationName,
  PeoplePage,
  Person,
  TeamRef,
  User,
} from "./people.ts";
export type {
  PreferencePlan,
  PreferenceRefusal,
  PreferencesContract,
} from "./preference-plan.ts";

// A descriptor as JSON Schema, for what reads only JSON Schema (a model
// told its answer's shape); values are still checked by the descriptor.
export { jsonSchemaOf } from "./json-schema.ts";
export type { JsonSchema, JsonSchemaOptions } from "./json-schema.ts";

// The session client as a host makes it (spec 10.7.1): over the host's own
// transport, one per App session, mounted for the pages it serves. App
// code never makes one; it gets the platform's from `useClient()`.
// `clientInternals` is what the page runtime and the React hooks reach
// of it: a component's reading of a query, as `useQuery` subscribes.
export { clientInternals, GraspClient } from "./client-core.ts";
export type { ClientTransport, StreamLink } from "./client-core.ts";
// The workflow channel the typed `useWorkflow` speaks over a client, for
// core's own tests of the side of it core serves (page-workflows.ts).
export { readWorkflowReference, workflowChannel } from "./client-workflow.ts";
export type {
  BindingSnapshot,
  ControlReceipt,
  RunSnapshot,
  WatchState,
} from "./client-workflow.ts";
export type { FileTransport, TransferProgress } from "./client-files.ts";
export type { LinkTransport } from "./client-links.ts";

// The page's side of core's file channel (spec 10.7.5): what moves a
// page's files' bytes, which never travel in a JSON call.
export { fileChannel } from "./file-channel.ts";
export { linkChannel } from "./link-channel.ts";
export type {
  LinkChannel,
  LinkChannelOptions,
  LinkDecision,
} from "./link-channel.ts";
export type {
  CoreFetch,
  FileChannel,
  FileChannelOptions,
} from "./file-channel.ts";
