// `@grasp-os/runtime/host`: what a host needs of the runtime and App code
// never does. A host holds
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

// `ctx.db` over a host's own read and write executors.
export { databaseReader } from "./database-reader.ts";
export { databaseWriter } from "./database-writer.ts";

// An App as the host runs it: its registration as data, and its handlers.
export { inspectApp, registerApp } from "./app.ts";
export type {
  AppManifest,
  FunctionManifest,
  ServerModules,
} from "./app-types.ts";
export {
  actionPermission,
  actionPermissions,
  declaredPermission,
  declaredPermissions,
  isActionPermission,
} from "./manifest-permissions.ts";
export { appErrorDetailsOf, appErrorProblemOf } from "./app-error.ts";
export type { AppErrorProblem } from "./app-error.ts";
// Whether a function still serves what a workflow bound it as.
export { functionBreak } from "./function-change.ts";
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
  schemaHash,
  schemaManifest,
} from "./schema-manifest.ts";
export type { ManifestTable, SchemaManifest } from "./schema-manifest.ts";
export { readSchemaManifest } from "./schema-manifest-read.ts";
export type { ReadManifest } from "./schema-manifest-read.ts";

// What a host reads a descriptor from its JSON text with: one reader.
export { descriptorFromText, schemaFromDescriptor } from "./descriptor-text.ts";
// A descriptor's compact form, as a workflow's JSON and an App's definition
// hold it: its one reader and writer, and its JSON Schema for editors.
export {
  compactDescriptor,
  CompactDescriptorError,
  compactDescriptorSchema,
  descriptorFromCompact,
} from "./value-compact.ts";
export type { CompactDescriptor } from "./value-compact.ts";

// An App's manifest as the host reads it back from what inspection or a
// release answered, and the modules and references it generates from it.
export { appManifestMaxBytes } from "@grasp-os/shared/app-limits";
export { readAppManifest } from "./app-manifest.ts";
export { declaredWorkflows, sameEventContract } from "./bound-workflows.ts";
export type {
  BoundWorkflow,
  BoundWorkflowDecision,
  BoundWorkflowEvent,
  WorkflowBindingExtras,
  WorkflowEventContract,
  WorkflowPin,
} from "./bound-workflows.ts";
export { connectorCatalogSource } from "./codegen-connector-catalog.ts";
export type { CatalogAction } from "./codegen-connector-catalog.ts";
export {
  contractFingerprint,
  contractFingerprints,
  contractsFormatVersion,
  generatedPaths,
  workflowFingerprint,
} from "./codegen-contracts.ts";
export { valueTypeOf } from "./codegen-render.ts";
export { readSealedWorkflows } from "./codegen-sealed.ts";
export { dataModelSource, serverModuleSource } from "./codegen-server.ts";
export { symbolicModules } from "./codegen-stand-ins.ts";
export { workflowReferenceOf } from "./codegen-workflows.ts";
export { generateModules } from "./generate.ts";
export { workflowFunctions } from "./workflow-functions.ts";
export type {
  WorkflowFunctions,
  WorkflowMutationName,
  WorkflowQueryName,
} from "./workflow-functions.ts";
// Who calls an App, and the organization's people, which core answers
// itself (people.ts).
export {
  isPeopleFunctionName,
  peopleLimits,
  peopleFunctions,
  peopleReferences,
} from "./people.ts";
export type {
  PeopleFunctionName,
  PeoplePage,
  Person,
  TeamRef,
  User,
} from "./people.ts";

// A descriptor as JSON Schema, for what reads only JSON Schema (a model
// told its answer's shape); values are still checked by the descriptor.
export { jsonSchemaOf } from "./json-schema.ts";
export type { JsonSchema } from "./json-schema.ts";

// The session client as a host makes it: over the host's own
// transport, one per App session, mounted for the pages it serves. App
// code never makes one; it gets the platform's from `useClient()`.
// `clientInternals` is what the page runtime and the React hooks reach
// of it: a component's reading of a query, as `useQuery` subscribes.
export { clientInternals, GraspClient } from "./client-core.ts";
export type { ClientTransport, StreamLink } from "./client-transport.ts";
export type { FileTransport, TransferProgress } from "./file-transport.ts";

// The page's side of core's file channel: what moves a
// page's files' bytes, which never travel in a JSON call.
export { fileChannel } from "./file-channel.ts";
export { linkChannel } from "./link-channel.ts";
export type { LinkChannel, LinkDecision } from "./link-channel.ts";
export type { FileChannel } from "./file-channel.ts";

// How a declared name becomes a member of a client (`ctx.connections.<alias>.<action>`).
export { memberName } from "./member-names.ts";

// The runner an App's isolates run its functions, migrations and
// inspection with (runner.ts), and the channel a function's host answers
// it over.
export {
  installMutationRuntime,
  manifestOfApp,
  runFunction,
  runMigration,
} from "./runner.ts";
export type { FunctionChannel, MigrationRow, MutationStart } from "./runner.ts";

// The Brain's client over the binding a host hands a run (brain.ts).
export { brain, brainErrors } from "./brain.ts";
export type * from "./brain.ts";
