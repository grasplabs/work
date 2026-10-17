// The custom modules a JSON workflow's version carries beside its
// definition (platform specification 13.6): TypeScript files under
// `code/`, each a module of calculations (`compute` from
// `@grasp-os/sdk/compute`). Published with the definition, built and
// sealed with it; a binding names one export as
// `local:code/<file>.ts#<export>`.

/** A module's path: `code/<file>.ts`, in folders of plain names. */
export const workflowModulePattern =
  /^code\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/u;

/** What one version's modules may take. */
export const workflowModuleLimits = {
  /** The most modules a version carries. */
  files: 32,
  /** The most characters one module has. */
  fileChars: 256 * 1024,
  /** The most characters its modules have together. */
  totalChars: 1024 * 1024,
  /** The longest path. */
  pathChars: 256,
  /**
   * The most calculations a version's modules export, and the most
   * characters of each contract's input or output descriptor, as canonical
   * JSON: refused at publication past these, and read back within them,
   * so a version that published always loads.
   */
  contracts: 256,
  descriptorChars: 256 * 1024,
} as const;

/**
 * Why `modules` (by path) are more or other than a version carries, if
 * they are: undefined when they fit.
 */
export const workflowModulesError = (
  modules: Readonly<Record<string, string>>
): string | undefined => {
  const entries = Object.entries(modules);
  if (entries.length > workflowModuleLimits.files) {
    return `A version carries at most ${workflowModuleLimits.files} modules.`;
  }
  let total = 0;
  for (const [path, source] of entries) {
    if (
      path.length > workflowModuleLimits.pathChars ||
      !workflowModulePattern.test(path)
    ) {
      return `"${path.slice(0, 100)}" isn't a module path: write code/<file>.ts.`;
    }
    if (source.length > workflowModuleLimits.fileChars) {
      return `${path} has more than ${workflowModuleLimits.fileChars} characters.`;
    }
    total += source.length;
  }
  return total > workflowModuleLimits.totalChars
    ? `A version's modules have at most ${workflowModuleLimits.totalChars} characters together.`
    : undefined;
};
