/**
 * The pieces the seed's workflows are made of, as core publishes them:
 * independent grasp-workflow/1 documents and their compute modules,
 * which each domain App binds under an alias. A definition is written
 * here as data and sent as JSON text.
 */
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import type {
  Json,
  Step,
  WorkflowDocument,
} from "@grasp-os/workflow-schema/format";

/** A JSON Schema, as a definition's input, output and steps hold one. */
export type JsonSchema = Readonly<Record<string, Json>>;

/** A schema of exactly `properties`, each required unless named `optional`. */
export const objectOf = (
  properties: Record<string, JsonSchema>,
  optional: readonly string[] = []
): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});

export const text: JsonSchema = { type: "string" };
export const boolean: JsonSchema = { type: "boolean" };
export const listOf = (items: JsonSchema): JsonSchema => ({
  type: "array",
  items,
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
