// `@grasp-os/sdk/definition`: an App's definition (definition.ts), read,
// changed by its operations, and the config and schema generated from it.
// Only Grasp writes one: core's definition tools and builds, and the seed.
// Apart from `host`, as oxc parses it (oxc-parse.ts), which nothing a page
// or the sandbox loads needs.
export {
  definitionManifest,
  definitionPath,
  definitionText,
  emptyDefinition,
  generatedFiles,
  readDefinition,
} from "./definition.ts";
export type {
  AppDefinition,
  DefinedField,
  DefinedRule,
  DefinedTable,
} from "./definition.ts";
export type { FrozenJson, ValueDescriptor } from "./value-descriptor.ts";
export {
  applyOperation,
  tryOperation,
  tryReadDefinition,
  typeFrom,
} from "./definition-operations.ts";
export type { DefinitionOperation } from "./definition-operations.ts";
export { definitionSources, validatorSource } from "./definition-source.ts";
