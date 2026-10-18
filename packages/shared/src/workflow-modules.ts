import { z } from "zod";

// The custom modules a JSON workflow's version carries beside its
// definition (platform specification 13.6): TypeScript files under
// `code/`, each a module of calculations (`compute` from
// `@grasp-os/sdk/compute`). Published with the definition, built and
// sealed with it; a binding names one export as
// `local:code/<file>.ts#<export>`.

/** A module's path: `code/<file>.ts`, in folders of plain names. */
export const workflowModulePattern =
  /^code\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/u;

/** The kinds of the workflow's own bindings an action may use. */
export const actionUseKinds = ["connector", "operation", "model"] as const;
export type ActionUseKind = (typeof actionUseKinds)[number];

/** An alias an action uses: a binding alias, as the profile names them. */
export const actionUseAliasPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

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
  /** The most of the workflow's bindings one action uses. */
  actionUses: 32,
  /** The most operations an action declares it calls of one connector. */
  actionUseOperations: 64,
  /** The longest operation name, as connect names a connector's. */
  operationChars: 256,
} as const;

/**
 * A binding an action declares it uses, as its sealed contract holds it
 * (GRA-704): a connector's with the exact operations it calls, each once;
 * an operation binding's (an App export, one operation) with nothing more;
 * a model binding's with the shape its calls answer. The host refuses a
 * call of any other operation.
 */
export const actionUseSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    alias: z.string().regex(actionUseAliasPattern),
    kind: z.literal("connector"),
    operations: z
      .array(z.string().min(1).max(workflowModuleLimits.operationChars))
      .min(1)
      .max(workflowModuleLimits.actionUseOperations)
      .refine((operations) => new Set(operations).size === operations.length),
  }),
  z.strictObject({
    alias: z.string().regex(actionUseAliasPattern),
    kind: z.literal("operation"),
  }),
  // A model binding's: the descriptor of what each of its calls answers,
  // as canonical JSON, sealed with the action's contract (GRA-700): the
  // host sends it, and checks every answer against it, never a shape the
  // action makes up as it runs.
  z.strictObject({
    alias: z.string().regex(actionUseAliasPattern),
    kind: z.literal("model"),
    output: z.string().min(1).max(workflowModuleLimits.descriptorChars),
  }),
]);

/** A use as `actionUseSchema` reads it. */
export type ActionUse = z.infer<typeof actionUseSchema>;

/** A use as the host holds it once sealed: frozen, its operations too. */
export type SealedUse =
  | {
      readonly alias: string;
      readonly kind: "connector";
      readonly operations: readonly string[];
    }
  | { readonly alias: string; readonly kind: "operation" }
  | { readonly alias: string; readonly kind: "model"; readonly output: string };

/** An action's uses: each alias once, at most `actionUses` of them. */
export const actionUsesSchema = z
  .array(actionUseSchema)
  .max(workflowModuleLimits.actionUses)
  .refine(
    (uses) => new Set(uses.map(({ alias }) => alias)).size === uses.length
  );

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
