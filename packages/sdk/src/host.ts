// What a host needs of the SDK and App code never does. A host holds
// descriptors as data (in a manifest, from a browser, from another version)
// and turns them back into schemas here, without running the code that
// declared them.

// What a host knows of schemas that App code needn't: the managed fields,
// the limits, and the error a declaration throws.
export { SchemaDefinitionError } from "./schema-error.ts";
export { allowsNull, indexBase, relationOf } from "./schema-fields.ts";
export type { IndexBase } from "./schema-fields.ts";
export { managedFields, schemaLimits } from "./schema-limits.ts";
export type {
  AccessMode,
  RowRule,
  RowRules,
  TableAccess,
} from "./table-access.ts";
// The descriptor format a manifest names, for a host that writes one.
export { descriptorVersion } from "./value-descriptor.ts";

// An App as the host runs it: its registration as data, and its handlers.
export { inspectApp, registerApp } from "./app.ts";
export type {
  AppManifest,
  OperationManifest,
  ServerModules,
} from "./app-types.ts";
export {
  actionPermission,
  actionPermissions,
  declaredPermission,
  declaredPermissions,
  isActionPermission,
} from "./manifest-permissions.ts";
export { appErrorDetailsOf } from "./app-error.ts";
export { migrationPlatformMessages } from "./migration.ts";
export type { MigrationManifest } from "./migration.ts";

// A schema as a store's host reads, hashes and compares it.
export { referencesRenamed } from "./descriptor-references.ts";
export { fieldWidens, holdsReference } from "./field-change.ts";
export type { SchemaAnswer } from "./schema-answer.ts";
export {
  manifestMaxBytes,
  manifestText,
  manifestVersion,
  readSchemaManifest,
  schemaHash,
  schemaManifest,
} from "./schema-manifest.ts";
export type {
  ManifestTable,
  ReadManifest,
  SchemaManifest,
} from "./schema-manifest.ts";

// What a host reads a descriptor from its JSON text with: one reader,
// which a workflow's run uses too (`fittedValue`).
export { descriptorFromText, schemaFromDescriptor } from "./descriptor-text.ts";

// An App's manifest as the host reads it back from what inspection or a
// release answered, and the modules and references it generates from it.
export { appManifestMaxBytes } from "@grasp-os/shared/app-limits";
export { readAppManifest } from "./app-manifest.ts";
export { declaredWorkflows } from "./bound-workflows.ts";
export type {
  BoundWorkflow,
  BoundWorkflowDecision,
  BoundWorkflowEvent,
  WorkflowBindingExtras,
  WorkflowPin,
} from "./bound-workflows.ts";
export { connectorCatalogSource } from "./codegen-connector-catalog.ts";
export type { CatalogAction } from "./codegen-connector-catalog.ts";
export {
  contractFingerprint,
  contractFingerprints,
  contractsFormatVersion,
  eventFingerprint,
  generatedPaths,
  workflowFingerprint,
} from "./codegen-contracts.ts";
export { valueTypeOf } from "./codegen-render.ts";
export { readSealedWorkflows } from "./codegen-sealed.ts";
export { dataModelSource, serverModuleSource } from "./codegen-server.ts";
export { symbolicModules } from "./codegen-stand-ins.ts";
export { workflowReferenceOf } from "./codegen-workflows.ts";
export { generateModules } from "./generate.ts";
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
export type { PreferencePlan, PreferencesContract } from "./preference-plan.ts";

// A descriptor as JSON Schema, for what reads only JSON Schema (a model
// told its answer's shape); values are still checked by the descriptor.
export { jsonSchemaOf } from "./json-schema.ts";
export type { JsonSchema } from "./json-schema.ts";

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
export type { FileTransport, TransferProgress } from "./client-files.ts";

// The page's side of core's file channel (spec 10.7.5): what moves a
// page's files' bytes, which never travel in a JSON call.
export { fileChannel } from "./file-channel.ts";
export { linkChannel } from "./link-channel.ts";
export type { LinkChannel, LinkDecision } from "./link-channel.ts";
export type { FileChannel } from "./file-channel.ts";
