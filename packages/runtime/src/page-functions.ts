import { canonicalText } from "@grasp-os/shared/json";
import { isEventType } from "@grasp-os/shared/sealed-builds";

import type { FunctionManifest } from "./app-types.ts";
import type {
  BoundWorkflow,
  BoundWorkflowDecision,
  BoundWorkflowEvent,
} from "./bound-workflows.ts";
import { namePattern } from "./declaration.ts";
import type { ReferenceKind } from "./function-references.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { workflowReferenceLimits } from "./workflow-references.ts";

// What a page knows of its App's public functions beyond their names:
// what `useForm` checks a submission with (a mutation's or an action's
// kind and arguments) and what `DataGrid` reads its columns from (a
// query's declared return). A reference is a name and nothing else, so
// this comes with the page's build instead (`.grasp/functions.ts`, which
// the host generates from the release's manifest and the compiler builds
// in beside the route tree), and the client looks a function up by the
// name its reference holds. Nothing a reference carries besides its name
// is ever read: an object that brings its own arguments or kind changes
// nothing, and a name the release has no public function at (an
// internal one, a key every object inherits) finds none. Core checks
// every call again with the function's own validator, in the release
// current when it's called.
//
// The same goes for the workflows the App declares: their references are
// names too, and what `useWorkflow` and a decision's form need of each
// (its events' types and data, its listen tasks, its decisions' value
// and context) comes with the build, by the workflow's alias. Core
// checks every send and answer again in the release that answers it.

/** One of the release's public functions, as a page reads it. */
export interface PageFunction {
  readonly kind: ReferenceKind;
  readonly args: ValueDescriptor;
  /** Its declared return; null where it declares none. */
  readonly returns: ValueDescriptor | null;
}

/** A release's public functions, by name. */
export type PageFunctions = ReadonlyMap<string, PageFunction>;

/** One workflow the release declares, as a page reads it. */
export interface PageWorkflow {
  /** Its events, by alias. */
  readonly events: ReadonlyMap<string, BoundWorkflowEvent>;
  /** Its listen tasks, by path: the aliases of the events each listens for. */
  readonly listens: ReadonlyMap<string, ReadonlySet<string>>;
  /** Its decisions, by alias. */
  readonly decisions: ReadonlyMap<string, BoundWorkflowDecision>;
}

/** What a page's build says of its release, beyond the names it calls. */
export interface PageBuild {
  readonly functions: PageFunctions;
  /** The workflows the release declares, by alias. */
  readonly workflows: ReadonlyMap<string, PageWorkflow>;
}

const kinds: ReadonlySet<unknown> = new Set(["query", "mutation", "action"]);

/** `value` as a descriptor, strictly; undefined for anything else. */
const descriptorIn = (value: unknown): ValueDescriptor | undefined => {
  try {
    return readDescriptor(value, 1, { nodes: 0 });
  } catch {
    return undefined;
  }
};

/** `value` as one function's entry, or undefined when it isn't one. */
const pageFunctionOf = (value: unknown): PageFunction | undefined => {
  if (!isPlainObject(value) || !kinds.has(value.kind)) {
    return undefined;
  }
  const args = descriptorIn(value.args);
  const returns = value.returns === null ? null : descriptorIn(value.returns);
  if (args === undefined || returns === undefined) {
    return undefined;
  }
  // SAFETY: one of `kinds`, checked above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return { kind: value.kind as ReferenceKind, args, returns };
};

/**
 * The own entries of `value`, a record of at most `max`; undefined for
 * anything else, which is no part of a workflow, never an empty one.
 */
const entriesOf = (
  value: unknown,
  max: number
): [string, unknown][] | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  return entries.length > max ? undefined : entries;
};

/** `value` as one event's entry, or undefined when it isn't one. */
const pageEventOf = (value: unknown): BoundWorkflowEvent | undefined => {
  if (
    !isPlainObject(value) ||
    typeof value.type !== "string" ||
    !isEventType(value.type)
  ) {
    return undefined;
  }
  const data = descriptorIn(value.data);
  return data === undefined ? undefined : { type: value.type, data };
};

/** `value` as one decision's entry, or undefined when it isn't one. */
const pageDecisionOf = (value: unknown): BoundWorkflowDecision | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const decided = descriptorIn(value.value);
  const context = descriptorIn(value.context);
  return decided === undefined || context === undefined
    ? undefined
    : { value: decided, context };
};

/**
 * `value` as one workflow's entry: its events, its listen tasks (each
 * listening for its own events, each once) and its decisions, each by a
 * plain alias; undefined when any of it doesn't read, so the page finds
 * no such workflow rather than part of one.
 */
const pageWorkflowOf = (value: unknown): PageWorkflow | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const eventEntries = entriesOf(value.events, workflowReferenceLimits.events);
  const listenEntries = entriesOf(
    value.listens,
    workflowReferenceLimits.listens
  );
  const decisionEntries = entriesOf(
    value.decisions,
    workflowReferenceLimits.decisions
  );
  if (
    eventEntries === undefined ||
    listenEntries === undefined ||
    decisionEntries === undefined
  ) {
    return undefined;
  }
  const events = new Map<string, BoundWorkflowEvent>();
  for (const [alias, entry] of eventEntries) {
    const event = pageEventOf(entry);
    if (!namePattern.test(alias) || event === undefined) {
      return undefined;
    }
    events.set(alias, event);
  }
  const listens = new Map<string, ReadonlySet<string>>();
  for (const [task, aliases] of listenEntries) {
    if (
      task.length === 0 ||
      task.length > workflowReferenceLimits.taskPathLength ||
      !Array.isArray(aliases) ||
      aliases.length === 0 ||
      aliases.some(
        (alias) => typeof alias !== "string" || !events.has(alias)
      ) ||
      new Set(aliases).size !== aliases.length
    ) {
      return undefined;
    }
    listens.set(task, new Set<string>(aliases));
  }
  const decisions = new Map<string, BoundWorkflowDecision>();
  for (const [alias, entry] of decisionEntries) {
    const decision = pageDecisionOf(entry);
    if (!namePattern.test(alias) || decision === undefined) {
      return undefined;
    }
    decisions.set(alias, decision);
  }
  return { events, listens, decisions };
};

/** Each workflow read, by the canonical text of the entry it was read from. */
const entryTexts = new WeakMap<PageWorkflow, string>();

/**
 * What `value`, `.grasp/functions.ts`'s `functions`, holds: the
 * release's functions and workflows, each as a map, by name and alias:
 * only its own entries that read as one, so no name finds what every
 * object inherits. None of either for anything else.
 */
export const readPageBuild = (
  value: unknown,
  /**
   * The build this one replaces (a preview's draft changed): each of its
   * workflows whose entry reads the same is kept, the very object, so a
   * page's hook on it keeps its runs and controls (react/workflow.ts).
   */
  previous?: PageBuild
): PageBuild => {
  const functions = new Map<string, PageFunction>();
  const workflows = new Map<string, PageWorkflow>();
  if (!isPlainObject(value)) {
    return { functions, workflows };
  }
  if (isPlainObject(value.functions)) {
    for (const [name, entry] of Object.entries(value.functions)) {
      const fn = pageFunctionOf(entry);
      if (fn !== undefined) {
        functions.set(name, fn);
      }
    }
  }
  if (isPlainObject(value.workflows)) {
    for (const [alias, entry] of Object.entries(value.workflows)) {
      const workflow = pageWorkflowOf(entry);
      if (namePattern.test(alias) && workflow !== undefined) {
        const text = canonicalText(entry);
        const kept = previous?.workflows.get(alias);
        const same = kept !== undefined && entryTexts.get(kept) === text;
        entryTexts.set(workflow, text);
        workflows.set(alias, same ? kept : workflow);
      }
    }
  }
  return { functions, workflows };
};

/**
 * The workflows of `.grasp/functions.ts`, by alias: what `useWorkflow`
 * reads of each beyond its names, as the App declares it.
 */
export const pageWorkflowsOf = (
  workflows: readonly BoundWorkflow[]
): Record<string, Pick<BoundWorkflow, "events" | "listens" | "decisions">> =>
  Object.fromEntries(
    workflows.map(({ alias, events, listens, decisions }) => [
      alias,
      { events, listens, decisions },
    ])
  );

/**
 * `.grasp/functions.ts`: the release's public functions by name, data
 * only, for the page's build. Generated from its manifest, in name order.
 */
export const pageFunctionsOf = (
  functions: Readonly<Record<string, FunctionManifest>>
): Record<string, PageFunction> =>
  Object.fromEntries(
    Object.values(functions)
      .filter((fn) => fn.visibility === "public")
      .toSorted((a, b) => (a.path < b.path ? -1 : 1))
      .map((fn) => [
        fn.path,
        {
          kind: fn.kind,
          args: fn.args,
          returns: fn.returns,
        },
      ])
  );
