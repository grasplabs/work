import { isEventType, sealedBuildLimits } from "@grasp-os/shared/sealed-builds";

import type { AppManifest } from "./app-types.ts";
import { namePattern } from "./declaration.ts";
import {
  declaredPermission,
  declaredPermissions,
} from "./manifest-permissions.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { workflowReferenceLimits } from "./workflow-references.ts";

/** One event a bound workflow declares, as the host resolved it. */
export interface BoundWorkflowEvent {
  /** The CloudEvents type its binding admits. */
  readonly type: string;
  /** The descriptor of its data. */
  readonly data: ValueDescriptor;
}

/** One decision a bound workflow declares, as the host resolved it. */
export interface BoundWorkflowDecision {
  /** The descriptor of the value a response carries. */
  readonly value: ValueDescriptor;
  /** The descriptor of the context a person reviews. */
  readonly context: ValueDescriptor;
}

/**
 * A workflow the App declares (spec 3, 10.4.1, 10.4.5, 10.4.6), as its
 * reference is generated: the App's alias for it and the input and output
 * the App declared (`permission.workflow`), the contract its reference pins;
 * and, as the host resolved the App's binding against the approved
 * records, the events it declares by their binding's alias, its listen
 * tasks, by path, with the aliases of the events each listens for, and its
 * decisions by their binding's alias.
 */
export interface BoundWorkflow {
  readonly alias: string;
  readonly input: ValueDescriptor;
  readonly output: ValueDescriptor;
  readonly events: Readonly<Record<string, BoundWorkflowEvent>>;
  readonly listens: Readonly<Record<string, readonly string[]>>;
  readonly decisions: Readonly<Record<string, BoundWorkflowDecision>>;
  /**
   * The workflow version the host resolved all of the above from: the
   * binding's, as a seal records it. The host reads a run's history or
   * decisions through the reference only for a run of exactly this version,
   * so a rebind never reads one version's journal against another's
   * contract. None for an alias nothing was resolved for. Never part of a
   * generated reference.
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
 * contract the declaration gives (`BoundWorkflow`): never from App code.
 */
export type WorkflowBindingExtras = Omit<BoundWorkflow, "input" | "output">;
/**
 * The workflows the App declares, in alias order, each with the contract
 * its declaration gives and what the host resolved of it in `bound`; an
 * alias without a resolution has none of its own (no events, listen
 * tasks or decisions). A resolution for a workflow the App doesn't
 * declare throws: a reference is made only for a declaration.
 */
export const declaredWorkflows = (
  manifest: AppManifest,
  bound: readonly WorkflowBindingExtras[]
): BoundWorkflow[] => {
  const extras = new Map<string, WorkflowBindingExtras>();
  for (const resolved of bound) {
    if (
      declaredPermission(manifest, resolved.alias, "workflows") === undefined
    ) {
      throw new TypeError(
        `${JSON.stringify(resolved.alias)} isn't a workflow the App declares.`
      );
    }
    if (extras.has(resolved.alias)) {
      throw new TypeError(
        `A bound workflow's alias is unique and plain: ${JSON.stringify(resolved.alias)}`
      );
    }
    extras.set(resolved.alias, resolved);
  }
  return declaredPermissions(manifest, "workflows").map((declared) => ({
    events: {},
    listens: {},
    decisions: {},
    ...extras.get(declared.alias),
    alias: declared.alias,
    input: declared.input,
    output: declared.output,
  }));
};
/**
 * `listens` with each task's events in name order: which events a task
 * listens for is a set, so the order the host listed them in changes no
 * fingerprint and no byte.
 */
export const sortedListens = (
  listens: Readonly<Record<string, readonly string[]>>
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(listens).map(([task, events]) => [task, events.toSorted()])
  );
/**
 * `workflows`, checked: unique aliases, and listen tasks that listen only
 * for events the workflow declares. The host resolved them, so a failure
 * is the host's own error, never the App's.
 */
export const checkBoundWorkflows = (
  workflows: readonly BoundWorkflow[]
): void => {
  const aliases = new Set<string>();
  for (const workflow of workflows) {
    if (!namePattern.test(workflow.alias) || aliases.has(workflow.alias)) {
      throw new TypeError(
        `A bound workflow's alias is unique and plain: ${JSON.stringify(workflow.alias)}`
      );
    }
    aliases.add(workflow.alias);
    if (
      Object.keys(workflow.events).length > workflowReferenceLimits.events ||
      Object.keys(workflow.listens).length > workflowReferenceLimits.listens ||
      Object.keys(workflow.decisions).length > workflowReferenceLimits.decisions
    ) {
      throw new TypeError(
        `${workflow.alias} declares more events, listen tasks or decisions than a reference holds.`
      );
    }
    for (const alias of [
      ...Object.keys(workflow.events),
      ...Object.keys(workflow.decisions),
    ]) {
      if (!namePattern.test(alias)) {
        throw new TypeError(
          `An event's or a decision's alias is plain: ${JSON.stringify(alias)}`
        );
      }
    }
    for (const event of Object.values(workflow.events)) {
      if (!isEventType(event.type)) {
        throw new TypeError(
          `An event's type is 1 to ${sealedBuildLimits.eventTypeLength} characters on one line, with no control character and no space at either end: ${JSON.stringify(event.type.slice(0, 64))}`
        );
      }
    }
    for (const [task, listened] of Object.entries(workflow.listens)) {
      if (
        task.length === 0 ||
        task.length > workflowReferenceLimits.taskPathLength ||
        listened.length === 0 ||
        new Set(listened).size !== listened.length ||
        listened.some((alias) => !Object.hasOwn(workflow.events, alias))
      ) {
        throw new TypeError(
          `Listen task ${JSON.stringify(task)} of ${workflow.alias} listens for events the workflow declares, each once.`
        );
      }
    }
  }
};
