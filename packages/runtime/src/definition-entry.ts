// `@grasp-os/runtime/definition`: an App's definition (definition.ts), read,
// changed by its operations, and the config and schema generated from it.
// Only Grasp writes one: core's definition tools and builds, and the seed.
// Apart from `host`, as oxc parses it (oxc-parse.ts), which nothing a page
// or the sandbox loads needs.
export {
  canonicalDefinition,
  definitionManifest,
  definitionText,
  emptyDefinition,
  generatedFiles,
  isFunctionPath,
  readDefinition,
} from "./definition.ts";
export type {
  AppDefinition,
  DefinedField,
  DefinedFunction,
  DefinedRule,
  DefinedTable,
  DefinedWorkflowBinding,
} from "./definition.ts";
export type { FrozenJson, ValueDescriptor } from "./value-descriptor.ts";
export {
  applyOperation,
  tryOperation,
  tryReadDefinition,
  typeFrom,
  withExportedFunctions,
} from "./definition-operations.ts";
export type { DefinitionOperation } from "./definition-operations.ts";
export { definitionSources, validatorSource } from "./definition-source.ts";
export {
  declaredFunctionsOf,
  generatedServerSources,
  serverFunctionsOf,
} from "./server-syntax.ts";
