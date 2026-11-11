import { canonicalText } from "@grasp-os/shared/json";

import type { AppManifest } from "./app-types.ts";
import {
  declaredPermission,
  declaredPermissions,
} from "./manifest-permissions.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

/** One event a workflow declares: the type it admits and its data. */
export interface BoundWorkflowEvent {
  /** The CloudEvents type its binding admits. */
  readonly type: string;
  /** The descriptor of its data. */
  readonly data: ValueDescriptor;
}

/** One decision a workflow declares. */
export interface BoundWorkflowDecision {
  /** The descriptor of the value a response carries. */
  readonly value: ValueDescriptor;
  /** The descriptor of the context a person reviews. */
  readonly context: ValueDescriptor;
}

/**
 * A workflow the App declares, as its reference is generated and the host
 * resolves what a page or a mutation names of it: the App's alias for it
 * and the contract the App declares (`permission.workflow`): its args and
 * returns, its events by alias, its listen tasks, by path, with the
 * aliases of the events each listens for, and its decisions by alias.
 */
export interface BoundWorkflow {
  readonly alias: string;
  readonly args: ValueDescriptor;
  readonly returns: ValueDescriptor;
  readonly events: Readonly<Record<string, BoundWorkflowEvent>>;
  readonly listens: Readonly<Record<string, readonly string[]>>;
  readonly decisions: Readonly<Record<string, BoundWorkflowDecision>>;
  /**
   * The workflow version the host resolved the App's binding to, as a
   * seal records it. The host reads a run's history or decisions through
   * the reference only for a run of exactly this version, so a rebind
   * never reads one version's journal against another's contract. None
   * for an alias nothing was bound to. Never part of a generated
   * reference.
   */
  readonly pinned?: WorkflowPin;
}

/** A workflow resource's version, as the host resolved a binding to it. */
export interface WorkflowPin {
  readonly workflowId: string;
  readonly version: number;
}

/**
 * What the host resolved of a workflow the App declares, beside the
 * contract the declaration gives (`BoundWorkflow`): the version its
 * binding pins. Never from App code.
 */
export interface WorkflowBindingExtras {
  readonly alias: string;
  readonly pinned: WorkflowPin;
}

/** A workflow's events, listen tasks and decisions: what an App relies on. */
export type WorkflowEventContract = Pick<
  BoundWorkflow,
  "events" | "listens" | "decisions"
>;

/** `contract`, canonically: each listen task's events in name order. */
const canonicalContract = (contract: WorkflowEventContract): string =>
  canonicalText({
    events: contract.events,
    decisions: contract.decisions,
    listens: Object.fromEntries(
      Object.entries(contract.listens).map(([task, events]) => [
        task,
        events.toSorted(),
      ])
    ),
  });

/**
 * Whether `declared`, what the App declares of a workflow, and `bound`,
 * what a version of it has, are the same events (each's type and data),
 * listen tasks (each's events, in any order) and decisions (each's value
 * and context): what binding a version must keep.
 */
export const sameEventContract = (
  declared: WorkflowEventContract,
  bound: WorkflowEventContract
): boolean => canonicalContract(declared) === canonicalContract(bound);

/**
 * The workflows the App declares, in alias order, each with the contract
 * its declaration gives and the version the host resolved its binding to
 * in `bound`, if any. A resolution for a workflow the App doesn't declare
 * throws: a reference is made only for a declaration.
 */
export const declaredWorkflows = (
  manifest: Pick<AppManifest, "permissions">,
  bound: readonly WorkflowBindingExtras[]
): BoundWorkflow[] => {
  const pins = new Map<string, WorkflowPin>();
  for (const resolved of bound) {
    if (
      declaredPermission(manifest, resolved.alias, "workflows") === undefined
    ) {
      throw new TypeError(
        `${JSON.stringify(resolved.alias)} isn't a workflow the App declares.`
      );
    }
    if (pins.has(resolved.alias)) {
      throw new TypeError(
        `A bound workflow's alias is unique: ${JSON.stringify(resolved.alias)}`
      );
    }
    pins.set(resolved.alias, resolved.pinned);
  }
  return declaredPermissions(manifest, "workflows").map((declared) => {
    const workflow: BoundWorkflow = {
      alias: declared.alias,
      args: declared.args,
      returns: declared.returns,
      events: declared.events,
      listens: declared.listens,
      decisions: declared.decisions,
    };
    const pinned = pins.get(declared.alias);
    return pinned === undefined ? workflow : { ...workflow, pinned };
  });
};
