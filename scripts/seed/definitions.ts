/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
/**
 * The pieces the seed's workflows are made of, as core publishes them:
 * independent workflows in the grasp-open-workflow/1 profile (a JSON
 * definition and its compute modules), which each domain App binds under
 * an alias. A definition is written here as data and sent as JSON text.
 */
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";

/** A JSON Schema, as a definition's input, output and parameters hold one. */
export type JsonSchema = Record<string, unknown>;

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
export const number: JsonSchema = { type: "number" };
export const integer: JsonSchema = { type: "integer" };
export const boolean: JsonSchema = { type: "boolean" };
export const textOrNull: JsonSchema = {
  anyOf: [{ type: "string" }, { type: "null" }],
};
export const listOf = (items: JsonSchema): JsonSchema => ({
  type: "array",
  items,
});

/** A parameter of whom a decision asks: a person, a team or a role. */
export const personParam = (label: string) => ({
  schema: { type: "string", "x-grasp-value": { kind: "person" } },
  label,
  required: true,
  sensitive: false,
});

/** An amount in cents above which someone has to approve. */
export const limitParam = (label: string, cents: number) => ({
  schema: { type: "integer", minimum: 0 },
  label,
  default: cents,
  sensitive: false,
});

/** What a workflow is made of, before core names it. */
export interface DefinitionParts {
  input: JsonSchema;
  output: JsonSchema;
  params?: Record<string, unknown>;
  bindings: Record<string, { kind: string; contract: string }>;
  tasks: unknown[];
}

/** The definition of workflow `name`, as JSON text core publishes. */
export const definitionText = (
  name: string,
  title: string,
  { input, output, params = {}, bindings, tasks }: DefinitionParts
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params, bindings },
      },
    },
    input: { schema: { format: "json", document: input } },
    output: { schema: { format: "json", document: output } },
    do: tasks,
  });

/** A compute binding to export `name` of the workflow's module `file`. */
export const computeBinding = (file: string, name: string) => ({
  kind: "compute",
  contract: `local:code/${file}.ts#${name}`,
});

/**
 * Task `id` calling compute binding `binding` on `args`, its answer kept
 * in the context as `as`.
 */
export const computeTask = (
  id: string,
  binding: string,
  args: string,
  as?: string
) => ({
  [id]: {
    call: "grasp.compute",
    with: { binding, arguments: args },
    ...(as === undefined
      ? {}
      : { export: { as: `\${ $context + {${as}: .} }` } }),
  },
});

/**
 * Task `id` asking the person, team or role in parameter `param` to
 * decide through decision binding `binding`, about `input`, with
 * `prompt`; its outcome kept in the context as `decision`.
 */
export const decisionTask = (
  id: string,
  {
    binding,
    param,
    prompt,
    input,
    days,
  }: {
    binding: string;
    param: string;
    prompt: string;
    input: string;
    days: number;
  }
) => ({
  [id]: {
    call: "grasp.decision",
    with: {
      binding,
      recipients: `\${ [$params.${param}] }`,
      prompt,
      input,
    },
    timeout: { after: { days } },
    export: { as: "${ $context + {decision: .} }" },
  },
});

/**
 * Task `id` going on to `approved` when the decision in the context was
 * approved, to `otherwise` when it wasn't.
 */
export const approvedRoute = (
  id: string,
  approved: string,
  otherwise: string
) => ({
  [id]: {
    switch: [
      {
        yes: {
          when: "${ $context.decision.approved == true }",
          then: approved,
        },
      },
      { no: { then: otherwise } },
    ],
  },
});

/** Task `id` answering `value` as the workflow's output, then ending. */
export const answerTask = (id: string, value: string) => ({
  [id]: { set: value, then: "end" },
});
