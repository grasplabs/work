import type { argsType, returnType } from "./function-references.ts";
import type { WorkflowDecisionWait } from "./workflow-runs.ts";

declare const outputType: unique symbol;

/**
 * A generated reference to one decision a workflow the App declares:
 * `workflows.<workflow>.decisions.<key>`. Its name, and nothing else at
 * run time; the types of the value a response carries (as a person
 * passes it, and as it normalizes) and of the context a person reviews
 * live in phantom members, from the App's own declaration
 * (`permission.workflow`). It answers, gets and grants nothing:
 * `useForm` takes it for an answer's form, its schema from the page's
 * build, and the host checks every response against the decision, the
 * run and the person.
 */
export interface WorkflowDecisionReference<
  Workflow extends string = string,
  Key extends string = string,
  ValueInput = unknown,
  ValueOutput = unknown,
  Context = unknown,
> {
  /** Its name: `workflows.<workflow>.decisions.<key>`. */
  readonly name: `${Workflow}.decisions.${Key}`;
  /** Types only: never set. */
  readonly [argsType]?: ValueInput;
  /** Types only: never set. */
  readonly [outputType]?: ValueOutput;
  /** Types only: never set. */
  readonly [returnType]?: Context;
}

/** Any decision reference, whatever its value and context. */
export type AnyWorkflowDecisionReference = WorkflowDecisionReference<
  string,
  string,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `DecisionValueOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `DecisionOutputOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `DecisionContextOf`
  any
>;

/** The value a response to `Reference` carries, as a person passes it. */
export type DecisionValueOf<Reference> =
  Reference extends WorkflowDecisionReference<string, string, infer Value>
    ? Value
    : Reference extends WorkflowDecisionWait<string, infer Value>
      ? Value
      : never;

/** What a response's value to `Reference` normalizes to. */
export type DecisionOutputOf<Reference> =
  Reference extends WorkflowDecisionReference<
    string,
    string,
    unknown,
    infer Output
  >
    ? Output
    : never;

/** The context a person reviews for `Reference`. */
export type DecisionContextOf<Reference> =
  Reference extends WorkflowDecisionReference<
    string,
    string,
    unknown,
    unknown,
    infer Context
  >
    ? Context
    : never;

const decisionNamePattern =
  /^workflows\.(?<workflow>[A-Za-z][A-Za-z0-9_]{0,63})\.decisions\.(?<key>[A-Za-z][A-Za-z0-9_]{0,63})$/u;

/**
 * The workflow alias and decision key `name` names
 * (`workflows.<workflow>.decisions.<key>`), or undefined for none.
 */
export const decisionName = (
  name: unknown
): { readonly workflow: string; readonly key: string } | undefined => {
  if (typeof name !== "string") {
    return undefined;
  }
  const groups = decisionNamePattern.exec(name)?.groups;
  return groups?.workflow === undefined || groups.key === undefined
    ? undefined
    : { workflow: groups.workflow, key: groups.key };
};
