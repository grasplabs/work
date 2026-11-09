/**
 * The pieces the seed's workflows are made of, as core publishes them:
 * independent grasp-workflow/1 documents and their compute modules,
 * which each App binds under an alias. A definition is written
 * here as data and sent as JSON text.
 */
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import type {
  Descriptor,
  Step,
  WorkflowDocument,
} from "@grasp-os/workflow-schema/format";

/** An object of exactly `fields`, each required unless named `optional`. */
export const objectOf = (
  fields: Record<string, Descriptor>,
  optional: readonly string[] = []
): Descriptor => ({
  kind: "object",
  fields: Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      optional.includes(name) ? { ...field, optional: true } : field,
    ])
  ),
});

export const text: Descriptor = { kind: "string" };
export const boolean: Descriptor = { kind: "boolean" };
export const listOf = (item: Descriptor): Descriptor => ({
  kind: "array",
  item,
});

/** What a workflow is made of: its document, but for `$schema`. */
export type DefinitionParts = Omit<WorkflowDocument, "$schema">;

/** The definition `parts` make, as JSON text core publishes. */
export const definitionText = (parts: DefinitionParts): string =>
  JSON.stringify({ $schema: workflowSchemaUrl, ...parts });

/** A compute binding to export `name` of the workflow's module `file`. */
export const computeBinding = (file: string, name: string) =>
  ({ kind: "compute", contract: `local:code/${file}.ts#${name}` }) as const;

/**
 * Step `id` calling compute binding `binding` on the expression `args`,
 * its answer read later as `steps.<id>.output`.
 */
export const computeStep = (
  id: string,
  binding: string,
  args: string
): Step => ({
  id,
  type: "do",
  binding,
  arguments: { $expr: args },
});
