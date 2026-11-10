import { isEventType } from "@grasp-os/shared/sealed-builds";

import { namePattern, sha256Pattern } from "./declaration.ts";
import type { argsType } from "./function-references.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

/**
 * A generated reference to one event a workflow the App binds declares:
 * `workflows.<workflow>.events.<alias>`. It names the
 * workflow binding it belongs to (its App release, contract ID and
 * pinned fingerprint), the event binding's alias and the exact event type
 * it admits, with the descriptor of its data and that data's type in a
 * phantom member. It grants nothing: the host checks every send against
 * the run, the binding and the person, and validates the data again.
 */
export interface WorkflowEventReference<
  Workflow extends string = string,
  Alias extends string = string,
  Type extends string = string,
  Data = unknown,
> {
  readonly kind: "workflowEvent";
  readonly resourceId: string;
  readonly resourceVersion: number;
  /** The workflow binding's contract ID, e.g. `workflows.reviewInvoice`. */
  readonly workflow: Workflow;
  /** The fingerprint of the workflow contract it belongs to. */
  readonly workflowFingerprint: string;
  /** The event binding's alias in the workflow. */
  readonly alias: Alias;
  /** The CloudEvents type it admits. */
  readonly type: Type;
  /** The SHA-256 of its type and data contract, in hex. */
  readonly fingerprint: string;
  readonly data: ValueDescriptor;
  /** Types only: never set. */
  readonly [argsType]?: Data;
}

/** The data an event of `Reference` carries, as a sender passes it. */
export type EventDataOf<Reference> =
  Reference extends WorkflowEventReference<string, string, string, infer Data>
    ? Data
    : never;

/** An event reference as server code notifies with it, read as data. */
export interface EventReferenceData {
  /** The alias of the App's workflow it belongs to (`workflows.<alias>`). */
  readonly workflow: string;
  /** The event binding's alias in the workflow. */
  readonly alias: string;
  readonly type: string;
  readonly fingerprint: string;
}

const workflowContractPattern =
  /^workflows\.(?<alias>[A-Za-z][A-Za-z0-9_]{0,63})$/u;

/**
 * The event reference `value` is, read as data (`workflows.<workflow>.
 * events.<alias>`), or undefined when it isn't one. Nothing
 * about it is trusted: the host checks its workflow, alias, type and
 * fingerprint against the release it runs, and refuses one that doesn't
 * match.
 */
export const eventReferenceData = (
  value: unknown
): EventReferenceData | undefined => {
  if (!isPlainObject(value) || value.kind !== "workflowEvent") {
    return undefined;
  }
  const { workflow, alias, type, fingerprint } = value;
  const workflowAlias =
    typeof workflow === "string"
      ? workflowContractPattern.exec(workflow)?.groups?.alias
      : undefined;
  if (
    workflowAlias === undefined ||
    typeof alias !== "string" ||
    !namePattern.test(alias) ||
    typeof type !== "string" ||
    !isEventType(type) ||
    typeof fingerprint !== "string" ||
    !sha256Pattern.test(fingerprint)
  ) {
    return undefined;
  }
  return { workflow: workflowAlias, alias, type, fingerprint };
};
