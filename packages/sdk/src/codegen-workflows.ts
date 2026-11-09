import type { FunctionManifest } from "./app-types.ts";
import { sortedListens } from "./bound-workflows.ts";
import type {
  BoundWorkflow,
  BoundWorkflowDecision,
  BoundWorkflowEvent,
} from "./bound-workflows.ts";
import {
  decisionFingerprint,
  eventFingerprint,
  workflowFingerprint,
} from "./codegen-contracts.ts";
import type { ReleaseIdentity } from "./codegen-contracts.ts";
import {
  dataOf,
  indent,
  key,
  referenceOf,
  referenceTypeOf,
  valueTypeOf,
} from "./codegen-render.ts";
import { workflowFunctions } from "./workflow-functions.ts";
import type {
  WorkflowMutationName,
  WorkflowQueryName,
} from "./workflow-functions.ts";

/** A workflow's contract ID: its registered path. */
const workflowContractId = (alias: string): string => `workflows.${alias}`;

/** The type of the reference to `event`, declared as `alias` by `workflow`. */
const eventTypeOf = (
  workflow: BoundWorkflow,
  alias: string,
  event: BoundWorkflowEvent
): string =>
  `WorkflowEventReference<${JSON.stringify(workflowContractId(workflow.alias))}, ${JSON.stringify(alias)}, ${JSON.stringify(event.type)}, ${valueTypeOf(event.data, "input")}>`;

/** The type of the reference to `decision`, declared as `name` by `workflow`. */
const decisionTypeOf = (
  workflow: BoundWorkflow,
  name: string,
  decision: BoundWorkflowDecision
): string =>
  `WorkflowDecisionReference<${JSON.stringify(workflowContractId(workflow.alias))}, ${JSON.stringify(name)}, ${valueTypeOf(decision.value, "input")}, ${valueTypeOf(decision.value, "output")}, ${valueTypeOf(decision.context, "output")}>`;

/** `names` in order: the same contract makes the same text. */
const sortedKeys = (record: Readonly<Record<string, unknown>>): string[] =>
  Object.keys(record).toSorted();

/**
 * The type of the waits a run of `workflow` can be held at: the engine's
 * own, one event wait per listen task, keyed by its path, holding the
 * references of the events it listens for, and one decision wait per
 * decision, keyed by its alias, with the type of its response's value.
 */
const waitTypeOf = (workflow: BoundWorkflow, depth: number): string => {
  const members = sortedKeys(workflow.listens).map((task) => {
    const events = (workflow.listens[task] ?? [])
      .toSorted()
      .map((alias) => {
        const event = workflow.events[alias];
        return event === undefined
          ? "never"
          : eventTypeOf(workflow, alias, event);
      })
      .join(" | ");
    return `WorkflowEventWait<${JSON.stringify(task)}, ${events}>`;
  });
  const decisions = sortedKeys(workflow.decisions).map((name) => {
    const decision = workflow.decisions[name];
    const value =
      decision === undefined ? "never" : valueTypeOf(decision.value, "input");
    return `WorkflowDecisionWait<${JSON.stringify(name)}, ${value}>`;
  });
  return ["WorkflowEngineWait", ...members, ...decisions]
    .map((member) => `| ${member}`)
    .join(`\n${indent(depth)}`);
};

/** `functions` as sorted `[name, type]` pairs, each typed by `typed`. */
const typesOf = <Name extends string>(
  functions: Partial<Record<Name, FunctionManifest>>,
  typed: Record<Name, (fn: FunctionManifest) => string>
): [string, string][] =>
  Object.entries<FunctionManifest | undefined>(functions)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([name, fn]) => {
      // SAFETY: the keys of `functions` are `Name`s.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const render = typed[name as Name];
      return fn === undefined ? [] : [[name, render(fn)]];
    });

/**
 * The types of `workflow`'s query references, by name: each from its
 * descriptors, as any function's, but `decisions` and `decision`, which
 * name each decision's own wait type, so an item or detail narrowed by
 * its key answers `respond` with that decision's value.
 */
const queryTypesOf = (workflow: BoundWorkflow): [string, string][] => {
  const operations = workflowFunctions(workflow).queries;
  const keys = sortedKeys(workflow.decisions);
  const valueOf = (name: string): string => {
    const decision = workflow.decisions[name];
    return decision === undefined
      ? "never"
      : valueTypeOf(decision.value, "input");
  };
  return typesOf<WorkflowQueryName>(operations, {
    run: referenceTypeOf,
    canStart: referenceTypeOf,
    runs: referenceTypeOf,
    history: referenceTypeOf,
    decisions: (fn) => {
      const items = keys
        .map(
          (name) =>
            `WorkflowDecisionInboxItem<${JSON.stringify(name)}, ${valueOf(name)}>`
        )
        .join(" | ");
      return `FunctionReference<"query", "public", ${valueTypeOf(fn.args, "input")}, WorkflowQueryPage<${items}>>`;
    },
    decision: (fn) => {
      const details = keys.map((name) => {
        const context = workflow.decisions[name]?.context;
        return `WorkflowDecisionDetail<${JSON.stringify(name)}, ${valueOf(name)}, ${context === undefined ? "never" : valueTypeOf(context, "output")}>`;
      });
      return `FunctionReference<"query", "public", ${valueTypeOf(fn.args, "input")}, ${[...details, "null"].join(" | ")}>`;
    },
  });
};

/** The types of `workflow`'s mutation references, from their descriptors. */
const mutationTypesOf = (workflow: BoundWorkflow): [string, string][] =>
  typesOf<WorkflowMutationName>(workflowFunctions(workflow).mutations, {
    start: referenceTypeOf,
    pause: referenceTypeOf,
    resume: referenceTypeOf,
    cancel: referenceTypeOf,
    send: referenceTypeOf,
  });

const recordType = (members: readonly string[]): string =>
  members.length === 0
    ? "Readonly<Record<never, never>>"
    : `{\n${members.join("\n")}\n${indent(2)}}`;

/** `[name, type]` pairs as a reference type's members. */
const members = (types: readonly [string, string][]): string[] =>
  types.map(([name, type]) => `${indent(3)}readonly ${name}: ${type};`);

/** `manifests` as the references a generated module holds, by name. */
const referencesOf = (
  manifests: Readonly<Record<string, FunctionManifest | undefined>>
): Record<string, unknown> => {
  const references: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(manifests)) {
    if (fn !== undefined) {
      references[name] = referenceOf(fn);
    }
  }
  return references;
};

/** The type of the reference to `workflow`. */
const workflowTypeOf = (workflow: BoundWorkflow): string => {
  const events = sortedKeys(workflow.events).map((alias) => {
    const event = workflow.events[alias];
    const type =
      event === undefined ? "never" : eventTypeOf(workflow, alias, event);
    return `${indent(3)}readonly ${key(alias)}: ${type};`;
  });
  const decisions = sortedKeys(workflow.decisions).map((name) => {
    const decision = workflow.decisions[name];
    const type =
      decision === undefined
        ? "never"
        : decisionTypeOf(workflow, name, decision);
    return `${indent(3)}readonly ${key(name)}: ${type};`;
  });
  const parts = [
    JSON.stringify(workflow.alias),
    valueTypeOf(workflow.input, "input"),
    valueTypeOf(workflow.output, "output"),
    waitTypeOf(workflow, 2),
    recordType(events),
    recordType(decisions),
    recordType(members(queryTypesOf(workflow))),
    recordType(members(mutationTypesOf(workflow))),
  ];
  // No trailing comma: TypeScript refuses one in a type-argument list.
  return `WorkflowReference<\n${parts.map((part) => `${indent(2)}${part}`).join(",\n")}\n${indent(1)}>`;
};

/**
 * The reference to `workflow`, as the data a generated module holds: what
 * a page's `@server/_generated/api` imports under `workflows.<alias>`.
 */
export const workflowReferenceOf = async (
  identity: ReleaseIdentity,
  workflow: BoundWorkflow
) => {
  const contractId = workflowContractId(workflow.alias);
  const fingerprint = await workflowFingerprint(workflow);
  const events: Record<string, unknown> = {};
  for (const alias of sortedKeys(workflow.events)) {
    const event = workflow.events[alias];
    if (event !== undefined) {
      events[alias] = {
        kind: "workflowEvent",
        resourceId: identity.resourceId,
        resourceVersion: identity.resourceVersion,
        workflow: contractId,
        workflowFingerprint: fingerprint,
        alias,
        type: event.type,
        // One after the other: a digest is quick, and the order is the map's.
        // oxlint-disable-next-line no-await-in-loop -- see above
        fingerprint: await eventFingerprint(event),
        data: event.data,
      };
    }
  }
  const decisions: Record<string, unknown> = {};
  for (const name of sortedKeys(workflow.decisions)) {
    const decision = workflow.decisions[name];
    if (decision !== undefined) {
      decisions[name] = {
        kind: "workflowDecision",
        resourceId: identity.resourceId,
        resourceVersion: identity.resourceVersion,
        workflow: contractId,
        workflowFingerprint: fingerprint,
        key: name,
        // oxlint-disable-next-line no-await-in-loop -- one digest at a time, as above
        fingerprint: await decisionFingerprint(decision),
        valueSchema: { kind: "descriptor", descriptor: decision.value },
        context: decision.context,
      };
    }
  }
  const functions = workflowFunctions(workflow);
  return {
    kind: "workflow",
    visibility: "public",
    resourceId: identity.resourceId,
    resourceVersion: identity.resourceVersion,
    alias: workflow.alias,
    contractId,
    fingerprint,
    input: workflow.input,
    output: workflow.output,
    events,
    listens: sortedListens(workflow.listens),
    decisions,
    queries: referencesOf(functions.queries),
    mutations: referencesOf(functions.mutations),
  };
};

/**
 * `workflows`: one reference per workflow the App binds, each with its
 * events, decisions and ordinary queries and mutations.
 */
export const workflowsExport = async (
  identity: ReleaseIdentity,
  workflows: readonly BoundWorkflow[]
): Promise<string> => {
  const sorted = workflows.toSorted((a, b) => (a.alias < b.alias ? -1 : 1));
  if (sorted.length === 0) {
    return "export const workflows: Readonly<Record<never, never>> = frozen({});\n";
  }
  const types = sorted.map(
    (workflow) =>
      `  readonly ${key(workflow.alias)}: ${workflowTypeOf(workflow)};`
  );
  const values = await Promise.all(
    sorted.map(
      async (workflow) =>
        `  ${key(workflow.alias)}: ${dataOf(await workflowReferenceOf(identity, workflow), 1)},`
    )
  );
  // `as const`: the data is inferred as the literal it is, never widened
  // into an object union whose missing keys become `?: undefined` and no
  // longer fit a descriptor.
  return `export const workflows: {\n${types.join("\n")}\n} = frozen({\n${values.join("\n")}\n} as const);\n`;
};
