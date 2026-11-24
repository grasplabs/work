/**
 * The pieces the seed's workflows are made of, as core publishes them:
 * independent grasp-workflow/2 documents, which each App binds under an
 * alias. A definition is written
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

/**
 * Step `id`, which fails the run with the workflow's own `error` when the
 * expression `condition` holds: an `if` around a `raise`.
 */
export const raiseWhen = (
  id: string,
  condition: string,
  error: { code: string; message: string }
): Step => ({
  id,
  type: "if",
  condition: { $expr: condition },
  // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
  then: [{ id: `${id}Raised`, type: "raise", error }],
});
