import type { argsType, returnType } from "./function-references.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import type { WorkflowDecisionWait } from "./workflow-runs.ts";

declare const outputType: unique symbol;

/**
 * A value schema as a generated module holds it: a browser
 * descriptor and nothing callable, with the types of what a person
 * answers and what it normalizes to in phantom members. `v.object` takes
 * it as a field, so a form's schema is built from it.
 */
export interface DescriptorSchema<Input = unknown, Output = unknown> {
  readonly kind: "descriptor";
  readonly descriptor: ValueDescriptor;
  /** Types only: never set. */
  readonly [argsType]?: Input;
  /** Types only: never set. */
  readonly [outputType]?: Output;
}

/** What a person passes for `Schema`. */
export type DescriptorInputOf<Schema> =
  Schema extends DescriptorSchema<infer Input> ? Input : never;

/** What `Schema`'s values normalize to. */
export type DescriptorOutputOf<Schema> =
  Schema extends DescriptorSchema<unknown, infer Output> ? Output : never;

/**
 * A generated reference to one decision a workflow the App binds declares:
 * `workflows.<workflow>.decisions.<key>`, read-only
 * schema metadata. It names the workflow binding and pinned contract it
 * belongs to and the decision binding's `key`, and holds the schema of
 * the value a response carries (`valueSchema`) and the descriptor of the
 * context a person reviews. It answers, gets and grants nothing: the host
 * checks every response against the decision, the run and the person.
 */
export interface WorkflowDecisionReference<
  Workflow extends string = string,
  Key extends string = string,
  ValueInput = unknown,
  ValueOutput = unknown,
  Context = unknown,
> {
  readonly kind: "workflowDecision";
  readonly resourceId: string;
  readonly resourceVersion: number;
  /** The workflow binding's contract ID, e.g. `workflows.reviewInvoice`. */
  readonly workflow: Workflow;
  /** The fingerprint of the workflow contract it belongs to. */
  readonly workflowFingerprint: string;
  /** The decision binding's alias in the workflow. */
  readonly key: Key;
  /** The SHA-256 of its value and context contract, in hex. */
  readonly fingerprint: string;
  /** What a response's `value` is checked by: data, never a function. */
  readonly valueSchema: DescriptorSchema<ValueInput, ValueOutput>;
  /** The descriptor of the context a person reviews before answering. */
  readonly context: ValueDescriptor;
  /** Types only: never set. */
  readonly [returnType]?: Context;
}

/** The value a response to `Reference` carries, as a person passes it. */
export type DecisionValueOf<Reference> =
  Reference extends WorkflowDecisionReference<string, string, infer Value>
    ? Value
    : Reference extends WorkflowDecisionWait<string, infer Value>
      ? Value
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
