/**
 * The API reference, from TypeScript's types and doc comments: TypeDoc
 * with its Markdown plugin, run as its own CLI runs it (convert, validate,
 * write), and refused as the CLI refuses it: on any error TypeDoc
 * reports, and on any warning its validation reports, such as a
 * `{@link}` to nothing. The API runs none of those checks by itself.
 */
import { Application } from "typedoc";
import type { TypeDocOptions } from "typedoc";
import type { PluginOptions } from "typedoc-plugin-markdown";

/** TypeDoc's options, and its Markdown plugin's. */
export type ReferenceOptions = Partial<TypeDocOptions & PluginOptions>;

/**
 * Writes the reference `options` describe, each module under the name
 * `moduleName` gives it. Throws, writing nothing, if TypeDoc reports an
 * error or its validation a warning.
 */
export const writeReference = async (
  options: ReferenceOptions,
  moduleName: (name: string) => string = (name) => name
): Promise<void> => {
  const app = await Application.bootstrapWithPlugins({
    ...options,
    plugin: ["typedoc-plugin-markdown"],
    // Links to nothing, and paths that name no file. Not the types a
    // public one names that aren't exported themselves (`notExported`):
    // the SDK keeps its helper types to itself, and the reference shows
    // them where they are used.
    validation: {
      invalidLink: true,
      invalidPath: true,
      notExported: false,
      notDocumented: false,
      rewrittenLink: true,
      unusedMergeModuleWith: true,
    },
    treatValidationWarningsAsErrors: true,
  });
  const project = await app.convert();
  if (project === undefined || app.logger.hasErrors()) {
    throw new Error("TypeDoc could not read the code (see its errors above).");
  }
  const warnings = app.logger.warningCount;
  app.validate(project);
  if (
    app.logger.hasErrors() ||
    app.logger.warningCount !== warnings ||
    app.logger.validationWarningCount !== 0
  ) {
    throw new Error(
      "TypeDoc's validation failed, such as a {@link} to nothing (see its warnings above)."
    );
  }
  for (const module of project.children ?? []) {
    module.name = moduleName(module.name);
  }
  await app.generateOutputs(project);
  if (app.logger.hasErrors()) {
    throw new Error(
      "TypeDoc could not write the reference (see its errors above)."
    );
  }
};
