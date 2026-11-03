import { v } from "@grasp-os/sdk";
import type { ValueSchema } from "@grasp-os/sdk";
import type { CatalogContractDefinition } from "@grasp-os/shared/workflow-resources";

// The general catalog contracts every release ships (GRA-1469), installed
// with the built-ins (builtins.ts) as a built-in blueprint's are
// (`ensureReleaseContract`): published once, under a key nobody has taken,
// and never changed; a new shape is a new key. Without them a fresh
// deployment's catalog holds no model or decision contract a JSON
// workflow can bind, so the only steps a builder or the chat could write
// are a workflow's own `local:` code. Each is general, never a topic's or
// a client's: what a call does is the workflow's to say (a model step's
// instructions and output schema, an approval's prompt and input).
//
// A contract grants nothing. What serves a binding to one is still an
// admin's approval of that workflow's version: the model it reads with,
// through the model gateway and the workspace's own provider key, or who
// answers its decision.

/** The most levels of arrays and objects an approval's input nests. */
const approvalInputDepth = 5;

/** Any JSON value nesting at most `depth` levels of arrays and objects. */
const jsonUpTo = (depth: number): ValueSchema<unknown, unknown> => {
  const scalars = [v.string(), v.number(), v.boolean(), v.null()] as const;
  if (depth === 0) {
    return v.union(...scalars);
  }
  const inner = jsonUpTo(depth - 1);
  return v.union(...scalars, v.array(inner), v.record(inner));
};

/**
 * A model step: the task gives its instructions, its input and the JSON
 * Schema its output must match (`grasp.model`), and the admin's approval
 * names the model.
 */
export const modelStepContract = "grasp/model-step";

/**
 * A person's check or approval (`grasp.decision`): they see the task's
 * prompt and input, an object of any JSON, and answer whether they approve
 * (`approved`), with a comment of their own or none.
 */
export const approvalContract = "grasp/approval";

/** The contracts this release ships, by key. */
export const releaseContracts: readonly CatalogContractDefinition[] = [
  { key: modelStepContract, kind: "model" },
  {
    key: approvalContract,
    kind: "decision",
    input: JSON.stringify(v.record(jsonUpTo(approvalInputDepth)).descriptor),
    // What the decision page answers with: nothing, or the person's
    // comment (`takesPageAnswers`).
    response: JSON.stringify(
      v.union(v.null(), v.object({ comment: v.string() })).descriptor
    ),
  },
];
