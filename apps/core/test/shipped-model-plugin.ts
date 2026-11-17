import path from "node:path";

import type { EmbedModel } from "@grasp-os/embed/model-files";
import type { UserWorkspaceConfig } from "vite-plus";

// For a test project only: core runs `model` as the one it ships. Every
// import of the embed package's model module gets the same module with
// `shippedModel` set to `model`, so core embeds with it (its question
// embedder, its bulk embedders and the Brain's queue) as a deployment
// that ships it would. Nothing outside the project changes: the code
// ships the model it names. Every core project runs the embed package's
// int8 test model by default (`coreProject` in vite.config.ts); the
// evaluation runs a model from a local path (vite.brain-eval.config.ts).

type Plugins = NonNullable<UserWorkspaceConfig["plugins"]>;

/** The embed package's model module, which `shippedModel` comes from. */
const modelFilesModule = path.join(
  import.meta.dirname,
  "../../../packages/embed/src/model-files.ts"
);

/** What every import of the model module gets instead. */
const shippedModelModule = "\0shipped-model";

/** A Vite plugin that makes `model` core's shipped one (above). */
export const shippedModelPlugin = (model: EmbedModel): Plugins[number] => ({
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
