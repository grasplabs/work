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
   * The workflow the App's version binds under the alias, as its seal
   * records it: its pages start and read runs of it, at whichever version
   * each run is of, while the App's binding still names it, so a rebind
   * to another workflow never reads one's journal against another's
   * contract. None for an alias the version binds nothing to. Never part
   * of a generated reference.
   */
  readonly workflowId?: string;
}

/**
 * What the host resolved of a workflow the App declares, beside the
 * contract the declaration gives (`BoundWorkflow`): the workflow its
 * version binds. Never from App code.
 */
export interface WorkflowBindingExtras {
  readonly alias: string;
  readonly workflowId: string;
}

/** A workflow's events, listen tasks and decisions: what an App relies on. */
export type WorkflowEventContract = Pick<
  BoundWorkflow,
  "events" | "listens" | "decisions"
>;

/**
 * What `declared`, what an App declares of a workflow, relies on that
 * `provided`, what a version of it has, doesn't give as declared, each
 * named for people: an event (its type and data), a decision (its value
 * and context) or a listen task (waiting on at least the events
 * declared). None when the version gives everything the App declares,
 * whatever else it has: so a workflow adds to its contract without
 * waiting for the Apps that bind it, and drops something only once no
 * App declares it.
 */
export const contractGaps = (
  declared: WorkflowEventContract,
  provided: WorkflowEventContract
): string[] => [
  ...Object.entries(declared.events).flatMap(([alias, event]) =>
    Object.hasOwn(provided.events, alias) &&
    canonicalText(provided.events[alias]) === canonicalText(event)
      ? []
      : [`event \`${alias}\``]
  ),
  ...Object.entries(declared.decisions).flatMap(([alias, decision]) =>
    Object.hasOwn(provided.decisions, alias) &&
    canonicalText(provided.decisions[alias]) === canonicalText(decision)
      ? []
      : [`decision \`${alias}\``]
  ),
  ...Object.entries(declared.listens).flatMap(([task, events]) => {
    const waits = Object.hasOwn(provided.listens, task)
      ? provided.listens[task]
      : undefined;
    return waits !== undefined && events.every((event) => waits.includes(event))
      ? []
      : [`listen task \`${task}\``];
  }),
];

/**
 * The workflows the App declares, in alias order, each with the contract
 * its declaration gives and the workflow the host resolved its binding to
 * in `bound`, if any. A resolution for a workflow the App doesn't declare
 * throws: a reference is made only for a declaration.
 */
export const declaredWorkflows = (
  manifest: Pick<AppManifest, "permissions">,
  bound: readonly WorkflowBindingExtras[]
): BoundWorkflow[] => {
  const bindings = new Map<string, string>();
  for (const resolved of bound) {
    if (
      declaredPermission(manifest, resolved.alias, "workflows") === undefined
    ) {
      throw new TypeError(
        `${JSON.stringify(resolved.alias)} isn't a workflow the App declares.`
      );
    }
    if (bindings.has(resolved.alias)) {
      throw new TypeError(
        `A bound workflow's alias is unique: ${JSON.stringify(resolved.alias)}`
      );
    }
    bindings.set(resolved.alias, resolved.workflowId);
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
    const workflowId = bindings.get(declared.alias);
    return workflowId === undefined ? workflow : { ...workflow, workflowId };
  });
};
