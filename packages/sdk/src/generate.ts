import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import type { AppManifest, OperationManifest } from "./app.ts";
import { workflowReferenceLimits } from "./references.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor, ValueSchema } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { descriptorOf } from "./value-schema.ts";
import { workflowQueries } from "./workflow-queries.ts";
import type { WorkflowQueryName } from "./workflow-queries.ts";

// The modules the host generates for an App (spec 7.3, 8), from its
// manifest as the host read it (app-manifest.ts), never from its code:
//
// - `.grasp/server.ts` (`#grasp/server`): the server constructors and
//   `doc`, specialized to the App's schema. Its code is the same for every
//   App (`serverModule(schema)`); the specialization is in its types,
//   which come from `schema.ts` itself.
// - `.grasp/server-references.ts` (`#grasp/server-references`): the
//   `internal` tree, for the App's own server code only.
// - `.grasp/references.ts` (`#grasp`): the public `api`, `workflows`, the
//   resources its screens use, its `screens`, and `preferences` when it
//   declares them. What a browser gets: data and types, extracted from
//   descriptors, with no handler, schema or server code in it.
// - `.grasp/contracts.json`: the App's manifest, each function's
//   fingerprint and the workflows it binds with theirs, canonical: what
//   the release's contract hash covers.
//
// Generation is deterministic: the same manifest and identity always
// make the same bytes, so a release's artifacts can be compared and
// reused by their hashes.

/** The release a reference belongs to. */
export interface ReleaseIdentity {
  readonly resourceId: string;
  readonly resourceVersion: number;
}

/** Where each generated module is, among the App's files. */
export const generatedPaths = {
  server: ".grasp/server.ts",
  serverReferences: ".grasp/server-references.ts",
  references: ".grasp/references.ts",
  contracts: ".grasp/contracts.json",
} as const;

/** The format of `contracts.json`. */
export const contractsFormatVersion = 2;

/**
 * The fingerprint of `operation`'s exact contract: the SHA-256, in hex, of
 * its kind, visibility, arguments, return and progress, canonically. Any
 * change to any of them changes it.
 */
export const contractFingerprint = async (
  operation: OperationManifest
): Promise<string> =>
  await sha256Hex(
    canonicalText({
      kind: operation.kind,
      visibility: operation.visibility,
      args: operation.args,
      returns: operation.returns,
      stream: operation.stream,
    })
  );

/** Each function's fingerprint, by path. */
export const contractFingerprints = async (
  manifest: AppManifest
): Promise<Record<string, string>> => {
  const fingerprints: Record<string, string> = {};
  for (const [path, operation] of Object.entries(manifest.operations)) {
    // One after the other: a digest is quick, and the order is the map's.
    // oxlint-disable-next-line no-await-in-loop -- see above
    fingerprints[path] = await contractFingerprint(operation);
  }
  return fingerprints;
};

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
 * the App declared (`resource.workflow`), the contract its reference pins;
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
}

/**
 * The fingerprint of a decision's exact contract: the SHA-256, in hex, of
 * its value and context descriptors, canonically.
 */
export const decisionFingerprint = async (
  decision: BoundWorkflowDecision
): Promise<string> =>
  await sha256Hex(
    canonicalText({ value: decision.value, context: decision.context })
  );

/**
 * What the host resolved of a workflow the App declares, beside the
 * contract the declaration gives (`BoundWorkflow`): never from App code.
 */
export type WorkflowBindingExtras = Omit<BoundWorkflow, "input" | "output">;

/** What a sealed release's contracts can't be: anything but what was sealed. */
const unsealed = (what: string): never => {
  throw new TypeError(`The release's sealed workflows hold ${what}.`);
};

/** `value` as a plain record, or a refusal naming `what` it should be. */
const sealedRecord = (
  value: unknown,
  what: string
): Readonly<Record<string, unknown>> =>
  isPlainObject(value) ? value : unsealed(`${what} that isn't a record`);

/** A descriptor sealed as data, read back as strictly as when it was made. */
const sealedDescriptor = (value: unknown): ValueDescriptor =>
  readDescriptor(value, 1, { nodes: 0 });

/** What a release's contracts seal of one workflow it declares, read back. */
const sealedWorkflow = (value: unknown): WorkflowBindingExtras => {
  const sealed = sealedRecord(value, "a workflow");
  const { alias } = sealed;
  if (typeof alias !== "string") {
    return unsealed("a workflow with no alias");
  }
  const events: Record<string, BoundWorkflowEvent> = {};
  for (const [name, event] of Object.entries(
    sealedRecord(sealed.events, "events")
  )) {
    const { type, data } = sealedRecord(event, "an event");
    if (typeof type !== "string") {
      return unsealed("an event with no type");
    }
    events[name] = { type, data: sealedDescriptor(data) };
  }
  const listens: Record<string, readonly string[]> = {};
  for (const [task, listened] of Object.entries(
    sealedRecord(sealed.listens, "listen tasks")
  )) {
    if (
      !Array.isArray(listened) ||
      !listened.every((name) => typeof name === "string")
    ) {
      return unsealed("a listen task that isn't a list of events");
    }
    listens[task] = listened;
  }
  const decisions: Record<string, BoundWorkflowDecision> = {};
  for (const [name, decision] of Object.entries(
    sealedRecord(sealed.decisions, "decisions")
  )) {
    const { value: decided, context } = sealedRecord(decision, "a decision");
    decisions[name] = {
      value: sealedDescriptor(decided),
      context: sealedDescriptor(context),
    };
  }
  return { alias, events, listens, decisions };
};

/**
 * What the host resolved of each workflow a release declares, read back
 * from its sealed contracts (`contracts.json`'s `workflows`): so the
 * references a sealed version's screens get are generated from what its
 * seal resolved, whatever its bindings say now. Throws on anything else.
 */
export const readSealedWorkflows = (
  workflows: unknown
): WorkflowBindingExtras[] =>
  Object.values(sealedRecord(workflows, "workflows")).map((sealed) =>
    sealedWorkflow(sealed)
  );

/**
 * The workflows the App declares, in alias order, each with the contract
 * its declaration gives and what the host resolved of it in `bound`; an
 * alias without a resolution has none of its own (no events, listen
 * tasks or decisions). A resolution for a workflow the App doesn't
 * declare throws: a reference is made only for a declaration.
 */
const declaredWorkflows = (
  manifest: AppManifest,
  bound: readonly WorkflowBindingExtras[]
): BoundWorkflow[] => {
  const extras = new Map<string, WorkflowBindingExtras>();
  for (const resolved of bound) {
    if (!Object.hasOwn(manifest.workflows, resolved.alias)) {
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
  return Object.values(manifest.workflows)
    .toSorted((a, b) => (a.alias < b.alias ? -1 : 1))
    .map((declared) => ({
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
 * The fingerprint of an event's exact contract: the SHA-256, in hex, of
 * its type and data descriptor, canonically.
 */
export const eventFingerprint = async (
  event: BoundWorkflowEvent
): Promise<string> =>
  await sha256Hex(canonicalText({ type: event.type, data: event.data }));

/**
 * `listens` with each task's events in name order: which events a task
 * listens for is a set, so the order the host listed them in changes no
 * fingerprint and no byte.
 */
const sortedListens = (
  listens: Readonly<Record<string, readonly string[]>>
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(listens).map(([task, events]) => [task, events.toSorted()])
  );

/**
 * The fingerprint of a bound workflow's contract: the SHA-256, in hex, of
 * its input and output descriptors, canonically. What a run pins and the
 * host checks at start and watch; its events carry their own fingerprints,
 * and the release's contracts cover all of it.
 */
export const workflowFingerprint = async (
  workflow: Pick<BoundWorkflow, "input" | "output">
): Promise<string> =>
  await sha256Hex(
    canonicalText({ input: workflow.input, output: workflow.output })
  );

/** What the App calls a workflow and its events: plain identifiers. */
const aliasPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/**
 * `workflows`, checked: unique aliases, and listen tasks that listen only
 * for events the workflow declares. The host resolved them, so a failure
 * is the host's own error, never the App's.
 */
const checkBoundWorkflows = (workflows: readonly BoundWorkflow[]): void => {
  const aliases = new Set<string>();
  for (const workflow of workflows) {
    if (!aliasPattern.test(workflow.alias) || aliases.has(workflow.alias)) {
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
      if (!aliasPattern.test(alias)) {
        throw new TypeError(
          `An event's or a decision's alias is plain: ${JSON.stringify(alias)}`
        );
      }
    }
    for (const event of Object.values(workflow.events)) {
      if (
        event.type.length === 0 ||
        event.type.length > workflowReferenceLimits.eventTypeLength
      ) {
        throw new TypeError(
          `An event's type is 1 to ${workflowReferenceLimits.eventTypeLength} characters: ${JSON.stringify(event.type.slice(0, 64))}`
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

const identifier = /^[A-Za-z_$][\w$]*$/u;

/** A property name as TypeScript and JavaScript take it. */
const key = (name: string): string =>
  identifier.test(name) ? name : JSON.stringify(name);

/** What a caller passes (`input`), or what the value is once normalized. */
type Mode = "input" | "output";

/** Whether a value may be left out where `mode` reads it. */
const omittable = (descriptor: ValueDescriptor, mode: Mode): boolean =>
  descriptor.presence === "optional" ||
  (descriptor.presence === "default" && mode === "input");

/** The TypeScript of a kind's type, the kinds that hold others aside. */
const scalarTypeOf = (descriptor: ValueDescriptor): string => {
  switch (descriptor.kind) {
    case "string":
    case "person":
    case "model":
    case "template": {
      return "string";
    }
    case "number":
    case "timestamp":
    case "duration": {
      return "number";
    }
    case "boolean": {
      return "boolean";
    }
    case "null": {
      return "null";
    }
    case "literal": {
      return JSON.stringify(descriptor.value);
    }
    case "enum": {
      return descriptor.values
        .map((value) => JSON.stringify(value))
        .join(" | ");
    }
    case "id": {
      return `Id<${JSON.stringify(descriptor.tableName)}>`;
    }
    case "file": {
      return "FileValue";
    }
    case "money": {
      return "MoneyValue";
    }
    case "schedule": {
      return "ScheduleValue";
    }
    case "object":
    case "array":
    case "union":
    case "record": {
      return "never";
    }
    default: {
      return "never";
    }
  }
};

/**
 * The TypeScript type of the values `descriptor` accepts, as a caller
 * passes them (`input`: a field with a default may be left out) or as
 * they normalize (`output`): the same types `InferInput` and `Infer` give
 * the schema the descriptor came from. With `whole`, `undefined` too when
 * the value itself may be left out; an object field's presence is its
 * `?` instead.
 */
const typeOf = (
  descriptor: ValueDescriptor,
  mode: Mode,
  whole = false
): string => {
  let type: string;
  if (descriptor.kind === "object") {
    // In name order: a descriptor's own order means nothing, and the same
    // contract must make the same text.
    const fields = Object.entries(descriptor.fields)
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([name, field]) =>
          `${key(name)}${omittable(field, mode) ? "?" : ""}: ${typeOf(field, mode)}`
      );
    type =
      fields.length === 0 ? "Record<never, never>" : `{ ${fields.join("; ")} }`;
  } else if (descriptor.kind === "array") {
    type = `Array<${typeOf(descriptor.item, mode)}>`;
  } else if (descriptor.kind === "union") {
    type = descriptor.members
      .map((member) => `(${typeOf(member, mode, true)})`)
      .join(" | ");
  } else if (descriptor.kind === "record") {
    type = `Record<string, ${typeOf(descriptor.value, mode)}>`;
  } else {
    type = scalarTypeOf(descriptor);
  }
  const nullable = descriptor.nullable ? `${type} | null` : type;
  return whole && omittable(descriptor, mode)
    ? `${nullable} | undefined`
    : nullable;
};

/** The type of a whole value: `typeOf`, with its own presence. */
const valueTypeOf = (descriptor: ValueDescriptor, mode: Mode): string =>
  typeOf(descriptor, mode, true);

/** A tree of entries, by the segments of their dotted paths. */
type Tree<Leaf> = Map<string, { leaf: Leaf } | { tree: Tree<Leaf> }>;

/** The entries of `paths` as a tree of `leaf`s, by their segments. */
const treeOf = <Leaf>(
  entries: readonly (readonly [string, Leaf])[]
): Tree<Leaf> => {
  const root: Tree<Leaf> = new Map();
  for (const [path, leaf] of entries) {
    const segments = path.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = node.get(segment);
      if (existing !== undefined && "tree" in existing) {
        node = existing.tree;
      } else {
        const child: Tree<Leaf> = new Map();
        node.set(segment, { tree: child });
        node = child;
      }
    }
    node.set(segments.at(-1) ?? path, { leaf });
  }
  return root;
};

const indent = (depth: number): string => "  ".repeat(depth);

/**
 * `tree` as TypeScript text, each leaf as `render` writes it, keys in
 * order: types (`readonly` members) or values.
 */
const renderTree = <Leaf>(
  tree: Tree<Leaf>,
  render: (leaf: Leaf, depth: number) => string,
  member: (name: string) => string,
  separator: string,
  depth: number,
  empty = "{}"
): string => {
  const names = [...tree.keys()].toSorted();
  if (names.length === 0) {
    return empty;
  }
  const lines = names.map((name) => {
    const node = tree.get(name);
    let text = "";
    if (node !== undefined) {
      text =
        "leaf" in node
          ? render(node.leaf, depth + 1)
          : renderTree(node.tree, render, member, separator, depth + 1);
    }
    return `${indent(depth + 1)}${member(name)}: ${text}${separator}`;
  });
  return `{\n${lines.join("\n")}\n${indent(depth)}}`;
};

/** JSON data as a value in generated code: canonical, then indented. */
const dataOf = (value: unknown, depth: number): string => {
  // SAFETY: canonical JSON text parses to JSON, keys in canonical order.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const canonical = JSON.parse(canonicalText(value)) as Json;
  return JSON.stringify(canonical, null, 2).replaceAll(
    "\n",
    `\n${indent(depth)}`
  );
};

/** A function reference, as the data a generated module holds. */
const referenceOf = (
  identity: ReleaseIdentity,
  operation: OperationManifest,
  fingerprint: string
) => ({
  resourceId: identity.resourceId,
  resourceVersion: identity.resourceVersion,
  contractId: operation.path,
  fingerprint,
  kind: operation.kind,
  mode: operation.stream === null ? "single" : "stream",
  ...(operation.stream === null ? {} : { stream: operation.stream }),
  visibility: operation.visibility,
  args: operation.args,
  returns: operation.returns,
});

/** A function reference's type. */
const referenceTypeOf = (operation: OperationManifest): string => {
  const parts = [
    valueTypeOf(operation.args, "input"),
    valueTypeOf(operation.returns, "output"),
    JSON.stringify(operation.kind),
    JSON.stringify(operation.visibility),
  ];
  if (operation.stream !== null) {
    parts.push(valueTypeOf(operation.stream, "output"));
  }
  return `OperationReference<${parts.join(", ")}>`;
};

const banner =
  "// Generated by Grasp from the App's manifest. Don't edit it: it is made\n// again for every release, and edits are refused.\n";

/** Freezes generated data all the way down, inlined in each module. */
const freezer = `const frozen = <Value>(value: Value): Value => {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const entry of Object.values(value)) {
      frozen(entry);
    }
  }
  return value;
};
`;

/** The value types a generated module may name, imported from the SDK. */
const valueTypes = ["FileValue", "Id", "MoneyValue", "ScheduleValue"] as const;

/** The SDK types `text` names, imported as types. */
const typeImports = (text: string, names: readonly string[]): string => {
  const used = names.filter((name) =>
    new RegExp(`\\b${name}\\b`, "u").test(text)
  );
  return used.length === 0
    ? ""
    : `import type { ${used.toSorted().join(", ")} } from "@grasp-os/sdk";\n`;
};

/**
 * `#grasp/server`: the constructors, specialized to `schema.ts` by type.
 * The same for every App, so inspection can load it before anything is
 * generated from the App's manifest.
 */
export const serverModuleSource = `${banner}import type { Id as SdkId } from "@grasp-os/sdk";
import type { Doc as SdkDoc } from "@grasp-os/sdk/database";
import { serverModule } from "@grasp-os/sdk/server";
import type {
  ActionCtx as SdkActionCtx,
  MutationCtx as SdkMutationCtx,
  QueryCtx as SdkQueryCtx,
  Use,
} from "@grasp-os/sdk/server";

import schema from "../schema.ts";

type Tables = (typeof schema)["tables"];

const server = serverModule(schema);

export const query = server.query;
export const internalQuery = server.internalQuery;
export const mutation = server.mutation;
export const internalMutation = server.internalMutation;
export const action = server.action;
export const internalAction = server.internalAction;
export const doc = server.doc;

/** The names of the App's tables. */
export type TableName = keyof Tables & string;
/** The ID of a record of table \`Table\`. */
export type Id<Table extends TableName> = SdkId<Table>;
/** A record of table \`Table\`, as a read returns it. */
export type Doc<Table extends TableName> = SdkDoc<Tables[Table], Table>;
export type QueryCtx = SdkQueryCtx<Tables>;
export type MutationCtx<Uses extends readonly Use[] = readonly []> =
  SdkMutationCtx<Tables, Uses>;
export type ActionCtx<Uses extends readonly Use[] = readonly []> =
  SdkActionCtx<Uses>;
`;

/** A tree of function references as a module's typed, frozen export. */
const referenceExport = (
  name: string,
  operations: readonly OperationManifest[],
  identity: ReleaseIdentity,
  fingerprints: Readonly<Record<string, string>>
): string => {
  const tree = treeOf(
    operations.map((operation) => [operation.path, operation])
  );
  const type = renderTree(
    tree,
    referenceTypeOf,
    (member) => `readonly ${key(member)}`,
    ";",
    0,
    "Readonly<Record<never, never>>"
  );
  const value = renderTree(
    tree,
    (operation, depth) =>
      dataOf(
        referenceOf(identity, operation, fingerprints[operation.path] ?? ""),
        depth
      ),
    key,
    ",",
    0
  );
  return `export const ${name}: ${type} = frozen(${value});\n`;
};

/** The App's functions of `visibility`, by path. */
const operationsOf = (
  manifest: AppManifest,
  visibility: "public" | "internal"
): OperationManifest[] =>
  Object.values(manifest.operations)
    .filter((operation) => operation.visibility === visibility)
    .toSorted((a, b) => (a.path < b.path ? -1 : 1));

/** `#grasp/server-references`: the internal tree. */
const serverReferencesText = (
  manifest: AppManifest,
  identity: ReleaseIdentity,
  fingerprints: Readonly<Record<string, string>>
): string => {
  const body = referenceExport(
    "internal",
    operationsOf(manifest, "internal"),
    identity,
    fingerprints
  );
  return `${banner}${typeImports(body, ["OperationReference", ...valueTypes])}\n${freezer}\n${body}`;
};

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

/**
 * The types of `workflow`'s query references, by name: `runs` and
 * `history` from their descriptors, as any function's; `decisions` and
 * `decision` naming each decision's own wait type, so an item or detail
 * narrowed by its key answers `respond` with that decision's value.
 */
const queryTypesOf = (workflow: BoundWorkflow): [string, string][] => {
  const operations = workflowQueries(workflow);
  const keys = sortedKeys(workflow.decisions);
  const valueOf = (name: string): string => {
    const decision = workflow.decisions[name];
    return decision === undefined
      ? "never"
      : valueTypeOf(decision.value, "input");
  };
  const typed: Record<
    WorkflowQueryName,
    (operation: OperationManifest) => string
  > = {
    runs: referenceTypeOf,
    history: referenceTypeOf,
    decisions: (operation) => {
      const items = keys
        .map(
          (name) =>
            `WorkflowDecisionInboxItem<${JSON.stringify(name)}, ${valueOf(name)}>`
        )
        .join(" | ");
      return `OperationReference<${valueTypeOf(operation.args, "input")}, WorkflowQueryPage<${items}>, "query">`;
    },
    decision: (operation) => {
      const details = keys.map((name) => {
        const context = workflow.decisions[name]?.context;
        return `WorkflowDecisionDetail<${JSON.stringify(name)}, ${valueOf(name)}, ${context === undefined ? "never" : valueTypeOf(context, "output")}>`;
      });
      return `OperationReference<${valueTypeOf(operation.args, "input")}, ${[...details, "null"].join(" | ")}, "query">`;
    },
  };
  return Object.entries(operations)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([name, operation]) => {
      // SAFETY: the keys of `workflowQueries`' answer are query names.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const render = typed[name as WorkflowQueryName];
      return operation === undefined ? [] : [[name, render(operation)]];
    });
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
  const queries = queryTypesOf(workflow).map(
    ([name, type]) => `${indent(3)}readonly ${name}: ${type};`
  );
  const recordType = (members: readonly string[]): string =>
    members.length === 0
      ? "Readonly<Record<never, never>>"
      : `{\n${members.join("\n")}\n${indent(2)}}`;
  const parts = [
    JSON.stringify(workflow.alias),
    valueTypeOf(workflow.input, "input"),
    valueTypeOf(workflow.output, "output"),
    waitTypeOf(workflow, 2),
    recordType(events),
    recordType(decisions),
    recordType(queries),
  ];
  // No trailing comma: TypeScript 6, which checks App code, refuses one
  // in a type-argument list.
  return `WorkflowReference<\n${parts.map((part) => `${indent(2)}${part}`).join(",\n")}\n${indent(1)}>`;
};

/** The reference to `workflow`, as the data a generated module holds. */
const workflowReferenceOf = async (
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
  const queries: Record<string, unknown> = {};
  for (const [name, operation] of Object.entries(workflowQueries(workflow))) {
    if (operation !== undefined) {
      queries[name] = referenceOf(
        identity,
        operation,
        // oxlint-disable-next-line no-await-in-loop -- one digest at a time, as above
        await contractFingerprint(operation)
      );
    }
  }
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
    queries,
  };
};

/**
 * `workflows`: one reference per workflow the App binds, each with its
 * events, decisions and ordinary queries and nothing else; no `.start`,
 * `.get` or `.cancel` (spec 10.4).
 */
const workflowsExport = async (
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

/** `#grasp`: the public api and everything else a browser may hold. */
const referencesText = async (
  manifest: AppManifest,
  identity: ReleaseIdentity,
  fingerprints: Readonly<Record<string, string>>,
  workflows: readonly BoundWorkflow[]
): Promise<string> => {
  const parts: string[] = [
    referenceExport(
      "api",
      operationsOf(manifest, "public"),
      identity,
      fingerprints
    ),
    await workflowsExport(identity, workflows),
  ];

  const resources = Object.values(manifest.browserResources).toSorted((a, b) =>
    a.alias < b.alias ? -1 : 1
  );
  const resourceTypes = resources.map((declared) => {
    const literals = (
      declared["~resource"] === "files" ? declared.operations : declared.origins
    )
      .map((item) => JSON.stringify(item))
      .join(", ");
    const type =
      declared["~resource"] === "files"
        ? `FilesReference<${JSON.stringify(declared.alias)}, readonly [${literals}]>`
        : `LinksReference<${JSON.stringify(declared.alias)}, readonly [${literals}]>`;
    return `  readonly ${key(declared.alias)}: ${type};`;
  });
  const resourceValues = resources.map((declared) => {
    const data =
      declared["~resource"] === "files"
        ? {
            kind: "files",
            alias: declared.alias,
            operations: declared.operations,
          }
        : { kind: "links", alias: declared.alias, origins: declared.origins };
    return `  ${key(declared.alias)}: ${dataOf(data, 1)},`;
  });
  parts.push(
    resources.length === 0
      ? "export const resources: Readonly<Record<never, never>> = frozen({});\n"
      : `export const resources: {\n${resourceTypes.join("\n")}\n} = frozen({\n${resourceValues.join("\n")}\n});\n`
  );

  const screens = Object.values(manifest.screens).toSorted((a, b) =>
    a.name < b.name ? -1 : 1
  );
  const screenTypes = screens.map(
    (screen) =>
      `  readonly ${key(screen.name)}: ScreenReference<${JSON.stringify(screen.name)}, ${valueTypeOf(screen.input, "input")}>;`
  );
  const screenValues = screens.map(
    (screen) =>
      `  ${key(screen.name)}: ${dataOf({ name: screen.name, path: screen.path, input: screen.input }, 1)},`
  );
  parts.push(
    screens.length === 0
      ? "export const screens: Readonly<Record<never, never>> = frozen({});\n"
      : `export const screens: {\n${screenTypes.join("\n")}\n} = frozen({\n${screenValues.join("\n")}\n});\n`
  );

  // Only when declared: an App without preferences has no export to import.
  if (manifest.preferences !== null) {
    parts.push(
      `export const preferences: PreferencesReference<${valueTypeOf(manifest.preferences, "input")}, ${valueTypeOf(manifest.preferences, "output")}> = frozen(${dataOf({ resourceId: identity.resourceId, descriptor: manifest.preferences }, 0)});\n`
    );
  }

  const body = parts.join("\n");
  return `${banner}${typeImports(body, [
    "FilesReference",
    "LinksReference",
    "OperationReference",
    "PreferencesReference",
    "ScreenReference",
    "WorkflowDecisionDetail",
    "WorkflowDecisionInboxItem",
    "WorkflowDecisionReference",
    "WorkflowDecisionWait",
    "WorkflowEngineWait",
    "WorkflowEventReference",
    "WorkflowEventWait",
    "WorkflowQueryPage",
    "WorkflowReference",
    ...valueTypes,
  ])}\n${freezer}\n${body}`;
};

/**
 * Every module the host generates for an App, by path (`generatedPaths`),
 * for the release `identity`, from its `manifest` as the host read it
 * (`readAppManifest`) and what the host resolved of the workflows it
 * declares, `bound` (`WorkflowBindingExtras`).
 */
export const generateModules = async (
  manifest: AppManifest,
  identity: ReleaseIdentity,
  bound: readonly WorkflowBindingExtras[] = []
): Promise<Record<string, string>> => {
  const declared = declaredWorkflows(manifest, bound);
  checkBoundWorkflows(declared);
  const workflows = declared.map((workflow) => ({
    ...workflow,
    listens: sortedListens(workflow.listens),
  }));
  const fingerprints = await contractFingerprints(manifest);
  const workflowFingerprints: Record<string, string> = {};
  for (const workflow of workflows) {
    // oxlint-disable-next-line no-await-in-loop -- one digest at a time, as above
    workflowFingerprints[workflow.alias] = await workflowFingerprint(workflow);
  }
  const contracts = canonicalText({
    formatVersion: contractsFormatVersion,
    resourceId: identity.resourceId,
    resourceVersion: identity.resourceVersion,
    manifest,
    fingerprints,
    workflows: Object.fromEntries(
      workflows.map((workflow) => [workflow.alias, workflow])
    ),
    workflowFingerprints,
  });
  return {
    [generatedPaths.server]: serverModuleSource,
    [generatedPaths.serverReferences]: serverReferencesText(
      manifest,
      identity,
      fingerprints
    ),
    [generatedPaths.references]: await referencesText(
      manifest,
      identity,
      fingerprints,
      workflows
    ),
    [generatedPaths.contracts]: `${contracts}\n`,
  };
};

/** One action of a generated connector contract, as the schemas core checks it by. */
export interface CatalogAction {
  readonly input: ValueSchema<unknown, unknown>;
  readonly output: ValueSchema<unknown, unknown>;
}

/** `map`'s entries in name order: the same catalog makes the same text. */
const byName = <Value>(map: ReadonlyMap<string, Value>): [string, Value][] =>
  [...map].toSorted(([a], [b]) => (a < b ? -1 : 1));

/**
 * The SDK's connector catalog (`connector-catalog.gen.ts`): the type of
 * each generated connector contract of a Grasp release (spec 12), each
 * action's arguments as a caller passes them and its answer as it comes
 * back, from the descriptors core checks calls against. Types only: what
 * a binding serves is still decided, and checked both ways, at run time.
 */
export const connectorCatalogSource = (
  catalog: ReadonlyMap<string, ReadonlyMap<string, CatalogAction>>
): string => {
  const contracts = byName(catalog).map(([contract, actions]) => {
    const members = byName(actions).map(
      ([action, { input, output }]) =>
        `${indent(2)}readonly ${key(action)}: {\n${indent(3)}readonly input: ${valueTypeOf(descriptorOf(input), "input")};\n${indent(3)}readonly output: ${valueTypeOf(descriptorOf(output), "output")};\n${indent(2)}};`
    );
    return `${indent(1)}readonly ${key(contract)}: {\n${members.join("\n")}\n${indent(1)}};`;
  });
  return `// Generated by Grasp from the native connectors of this release (apps/core/build-connector-catalog.ts).
// Don't edit it: \`vp run -r typegen\` makes it again, and CI refuses it stale.

/**
 * Each generated connector contract (\`<connector>.<family>@1\`), by its
 * actions: the arguments a call passes and the answer it gets back.
 */
export interface ConnectorCatalog {
${contracts.join("\n")}
}
`;
};

/**
 * A tree of symbolic references, for inspection only: any path read of it
 * is a reference of `visibility` to that path, which the registration
 * resolves (its kind is what is registered there) or refuses.
 */
const symbolicTree = (visibility: "public" | "internal"): string =>
  `symbolic(${JSON.stringify(visibility)})`;

/**
 * The modules inspection loads in place of `#grasp` and
 * `#grasp/server-references` before the App's references exist (spec
 * 8): the registration is what says which paths there are, so its code
 * gets symbolic references, which grant nothing and resolve only against
 * that registration. Sealing then generates the real modules and inspects
 * again with them; nothing symbolic survives into a release.
 */
export const symbolicModules = (): Record<string, string> => {
  const prelude = `${banner}const symbolic = (visibility: string) => {
  const nodes = new Map<string, object>();
  const node = (path: string): object => {
    const known = nodes.get(path);
    if (known !== undefined) {
      return known;
    }
    const target = Object.freeze({ contractId: path, visibility });
    const made: object = new Proxy(target, {
      get: (_target, name) => {
        if (typeof name !== "string" || name === "then") {
          return undefined;
        }
        if (name === "contractId" || name === "visibility") {
          return target[name];
        }
        if (name === "kind") {
          return undefined;
        }
        return node(path === "" ? name : \`\${path}.\${name}\`);
      },
    });
    nodes.set(path, made);
    return made;
  };
  return node("");
};
`;
  return {
    [generatedPaths.serverReferences]: `${prelude}\nexport const internal = ${symbolicTree("internal")};\n`,
    [generatedPaths.references]: `${prelude}\nexport const api = ${symbolicTree("public")};\nexport const workflows = Object.freeze({});\nexport const resources = Object.freeze({});\nexport const screens = Object.freeze({});\nexport const preferences = Object.freeze({ resourceId: "", descriptor: null });\n`,
  };
};
