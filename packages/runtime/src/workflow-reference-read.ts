import type {
  BoundWorkflowDecision,
  BoundWorkflowEvent,
} from "./bound-workflows.ts";
import { clientError } from "./client-error.ts";
import type { ClientInternals } from "./client-internals.ts";
import { namePattern } from "./declaration.ts";
import type { FunctionReference } from "./function-references.ts";
import type { PageWorkflow } from "./page-functions.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { WorkflowEventReference } from "./workflow-events.ts";
import type { RunHandle } from "./workflow-runs.ts";
import type { RunSnapshot } from "./workflow-view.ts";

// A workflow reference, as a page's hook reads it: its name alone
// (`workflows.<alias>`), resolved in the page's build. Nothing else the
// object carries is read, so a forged one that brings its own events,
// decisions or function names changes nothing: its functions are named
// under the workflow's own name, its events and decisions are the ones
// the release declares under that alias (page-functions.ts), and an
// alias the release doesn't declare, or a key every object inherits,
// finds no workflow. Core checks every call, send and answer again in
// the release that answers it.

/** A workflow mutation, as the client calls it. */
type WorkflowMutation<Args, Return> = FunctionReference<
  "mutation",
  "public",
  Args,
  Return
>;

/** A control's mutation, as the client calls it: its receipt answered. */
type ControlMutation = WorkflowMutation<
  { readonly runId: string },
  {
    readonly kind: "pause" | "resume" | "cancel";
    readonly state: "admitted" | "applied" | "superseded";
  }
>;

/** One event of a workflow, as a page reads it: its reference and contract. */
export interface ReadEvent extends BoundWorkflowEvent {
  /** Its reference, `{ name }`, frozen: what a wait's event resolves to. */
  readonly reference: WorkflowEventReference;
}

/** A workflow reference, read by its name in the page's build. */
export interface ReadWorkflow {
  /** Its alias in the App. */
  readonly alias: string;
  /** Its name, e.g. `workflows.summarizeNote`. */
  readonly name: string;
  /**
   * The ordinary functions `useWorkflow` is built on, each named under
   * this very workflow's name: never another function of the App's.
   * Typed as their descriptors (workflow-functions.ts) declare them.
   */
  readonly functions: {
    readonly run: FunctionReference<
      "query",
      "public",
      { readonly runId: string },
      RunSnapshot | null
    >;
    readonly canStart: FunctionReference<
      "query",
      "public",
      Record<never, never>,
      boolean
    >;
    readonly start: WorkflowMutation<{ readonly args: unknown }, RunHandle>;
    readonly pause: ControlMutation;
    readonly resume: ControlMutation;
    readonly cancel: ControlMutation;
    /** None for a workflow that declares no events. */
    readonly send:
      | WorkflowMutation<
          {
            readonly runId: string;
            readonly event: string;
            readonly data: unknown;
          },
          unknown
        >
      | undefined;
  };
  /** Its events, by alias. */
  readonly events: ReadonlyMap<string, ReadEvent>;
  /** Its listen tasks, by path: the aliases of the events each listens for. */
  readonly listens: ReadonlyMap<string, ReadonlySet<string>>;
  /** Its decisions, by alias. */
  readonly decisions: ReadonlyMap<string, BoundWorkflowDecision>;
}

/**
 * Each build's workflow, read: the same object for as long as the page's
 * build is the same, so a hook keeps its calls; a new build (a preview's
 * draft changed) reads it afresh.
 */
const readWorkflows = new WeakMap<PageWorkflow, ReadWorkflow>();

const workflowNamePattern =
  /^workflows\.(?<alias>[A-Za-z][A-Za-z0-9_]{0,63})$/u;

/** `name`'s workflow alias (`workflows.<alias>`), or undefined for none. */
const workflowAliasOf = (name: unknown): string | undefined => {
  if (typeof name !== "string") {
    return undefined;
  }
  const alias = workflowNamePattern.exec(name)?.groups?.alias;
  return alias !== undefined && namePattern.test(alias) ? alias : undefined;
};

/** `workflow`, the build's under `alias`, read for its hook. */
const readOf = (alias: string, workflow: PageWorkflow): ReadWorkflow => {
  const name = `workflows.${alias}`;
  const query = (fn: string) => ({ name: `${name}.queries.${fn}` });
  const mutation = <Args, Return>(
    fn: string
  ): WorkflowMutation<Args, Return> => ({
    name: `${name}.mutations.${fn}`,
  });
  const events = new Map<string, ReadEvent>();
  for (const [event, contract] of workflow.events) {
    events.set(event, {
      ...contract,
      reference: Object.freeze({ name: `${name}.events.${event}` }),
    });
  }
  return {
    alias,
    name,
    functions: {
      run: query("run"),
      canStart: query("canStart"),
      start: mutation("start"),
      pause: mutation("pause"),
      resume: mutation("resume"),
      cancel: mutation("cancel"),
      send: events.size === 0 ? undefined : mutation("send"),
    },
    events,
    listens: workflow.listens,
    decisions: workflow.decisions,
  };
};

/**
 * `value` as a public workflow reference, read by its own `name` alone
 * in the page's build (`internals`); `contract.invalid_request` for
 * anything else (an operation's reference, a string, a name the release
 * declares no workflow under).
 */
export const readWorkflowReference = (
  internals: Pick<ClientInternals, "workflowOf">,
  value: unknown
): ReadWorkflow => {
  const alias =
    isPlainObject(value) && Object.hasOwn(value, "name")
      ? workflowAliasOf(value.name)
      : undefined;
  const workflow =
    alias === undefined ? undefined : internals.workflowOf(alias);
  if (alias === undefined || workflow === undefined) {
    throw clientError("contract.invalid_request");
  }
  const known = readWorkflows.get(workflow);
  if (known !== undefined) {
    return known;
  }
  const read = readOf(alias, workflow);
  readWorkflows.set(workflow, read);
  return read;
};
