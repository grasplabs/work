import path from "node:path";

import type { UserWorkspaceConfig } from "vite-plus";

// For a test project only: core runs `model` as if it shipped. Every
// import of the embed package's model module gets the same module with
// `shippedModel` set to `model` instead of null, so core embeds with it
// (its question embedder, its bulk embedders and the Brain's queue) as a
// deployment that ships it would. Nothing outside the project changes:
// `shippedModel` stays null in the code. Used by the evaluation with a
// model from a local path (vite.brain-eval.config.ts) and by core's test
// of recall by meaning (vite.brain-meaning.config.ts).

/** A model as the embed package names it: its name and its three files. */
export interface ShippedModel {
  name: string;
  tokenizer: { sha256: string; size: number };
  encoder: { sha256: string; size: number };
  tokens: { sha256: string; size: number };
}

type Plugins = NonNullable<UserWorkspaceConfig["plugins"]>;

/** The embed package's model module, which `shippedModel` comes from. */
const modelFilesModule = path.join(
  import.meta.dirname,
  "../../../packages/embed/src/model-files.ts"
);

/** What every import of the model module gets instead. */
const shippedModelModule = "\0shipped-model";

/** A Vite plugin that makes `model` core's shipped one (above). */
export const shippedModelPlugin = (model: ShippedModel): Plugins[number] => ({
  name: "shipped-model",
  enforce: "pre",
  async resolveId(source, importer) {
    if (importer === shippedModelModule) {
      return null;
    }
    const resolved = await this.resolve(source, importer, { skipSelf: true });
    return resolved?.id === modelFilesModule ? shippedModelModule : null;
  },
  load(id) {
    return id === shippedModelModule
      ? `export * from ${JSON.stringify(modelFilesModule)};
export const shippedModel = ${JSON.stringify(model)};`
      : null;
  },
});
