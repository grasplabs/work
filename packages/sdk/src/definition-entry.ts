// `@grasp-os/sdk/definition`: an App's definition (definition.ts), read,
// changed by its operations, and the config and schema generated from it.
// Only Grasp writes one: core's definition tools and builds, and the seed.
// Apart from `host`, as Babel parses and prints it, which nothing a page
// or the sandbox loads needs.
export {
  definitionManifest,
  definitionPath,
  definitionText,
  emptyDefinition,
  generatedFiles,
  readDefinition,
} from "./definition.ts";
export type { AppDefinition } from "./definition.ts";
export type { FrozenJson } from "./value-descriptor.ts";
export {
  applyOperation,
  tryOperation,
  tryReadDefinition,
  typeFrom,
} from "./definition-operations.ts";
export type { DefinitionOperation } from "./definition-operations.ts";
export { definitionSources } from "./definition-source.ts";
