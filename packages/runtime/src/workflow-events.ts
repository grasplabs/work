import { isPlainObject } from "@grasp-os/shared/json";

import { namePattern } from "./declaration.ts";
import type { argsType } from "./function-references.ts";

/**
 * A generated reference to one event a workflow the App declares:
 * `workflows.<workflow>.events.<alias>`. Its name, and nothing else at
 * run time; the type of its data lives in a phantom member, from the
 * App's own declaration (`permission.workflow`). It grants nothing: the
 * host resolves the alias in the App's release, checks the data with
 * that event's own descriptor, and checks every send against the run,
 * the binding and the person.
 */
export interface WorkflowEventReference<
  Workflow extends string = string,
  Alias extends string = string,
  Data = unknown,
> {
  /** Its name: `workflows.<workflow>.events.<alias>`. */
  readonly name: `${Workflow}.events.${Alias}`;
  /** Types only: never set. */
  readonly [argsType]?: Data;
}

/** The data an event of `Reference` carries, as a sender passes it. */
export type EventDataOf<Reference> =
  Reference extends WorkflowEventReference<string, string, infer Data>
    ? Data
    : never;

/** An event reference as code names it: its workflow's alias and its own. */
export interface EventName {
  /** The alias of the App's workflow it belongs to (`workflows.<alias>`). */
  readonly workflow: string;
  /** The event's alias in the workflow. */
  readonly alias: string;
}

const eventNamePattern =
  /^workflows\.(?<workflow>[A-Za-z][A-Za-z0-9_]{0,63})\.events\.(?<alias>[A-Za-z][A-Za-z0-9_]{0,63})$/u;

/**
 * The event `name` names (`workflows.<workflow>.events.<alias>`), or
 * undefined when it names none. Nothing about it is trusted: the host
 * resolves both aliases in the release it runs, and refuses a name it
 * doesn't declare.
 */
const eventName = (name: unknown): EventName | undefined => {
  if (typeof name !== "string") {
    return undefined;
  }
  const groups = eventNamePattern.exec(name)?.groups;
  const workflow = groups?.workflow;
  const alias = groups?.alias;
  return workflow === undefined ||
    alias === undefined ||
    !namePattern.test(workflow) ||
    !namePattern.test(alias)
    ? undefined
    : { workflow, alias };
};

/**
 * The event reference `value` names, read once from its own `name`, or
 * undefined when it isn't one.
 */
export const eventReferenceName = (value: unknown): EventName | undefined =>
  isPlainObject(value) && Object.hasOwn(value, "name")
    ? eventName(value.name)
    : undefined;
