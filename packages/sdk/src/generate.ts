import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import type { AppManifest, OperationManifest } from "./app.ts";
import type { ValueDescriptor, ValueSchema } from "./value-descriptor.ts";
import { descriptorOf } from "./value-schema.ts";

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
export const contractsFormatVersion = 1;

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

/**
 * A workflow the App binds (spec 3, 10.4.1, 10.4.6), as the host resolved
 * its binding against the approved records: the App's alias for it, the
 * pinned version's input and output, the events it declares by their
 * binding's alias, and its listen tasks, by path, with the aliases of the
 * events each listens for. Never from App code: what a reference pins is
 * the host's word.
 */
export interface BoundWorkflow {
  readonly alias: string;
  readonly input: ValueDescriptor;
  readonly output: ValueDescriptor;
  readonly events: Readonly<Record<string, BoundWorkflowEvent>>;
  readonly listens: Readonly<Record<string, readonly string[]>>;
}

/**
 * The fingerprint of an event's exact contract: the SHA-256, in hex, of
 * its type and data descriptor, canonically.
 */
export const eventFingerprint = async (
  event: BoundWorkflowEvent
): Promise<string> =>
  await sha256Hex(canonicalText({ type: event.type, data: event.data }));

/**
 * The fingerprint of a bound workflow's exact public contract: the
 * SHA-256, in hex, of its input, output, events and listen tasks,
 * canonically. Any change to any of them changes it, so a reference pins
 * all of them; the host refuses a run that pins another.
 */
export const workflowFingerprint = async (
  workflow: BoundWorkflow
): Promise<string> =>
  await sha256Hex(
    canonicalText({
      input: workflow.input,
      output: workflow.output,
      events: workflow.events,
      listens: workflow.listens,
    })
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
    for (const alias of Object.keys(workflow.events)) {
      if (!aliasPattern.test(alias)) {
        throw new TypeError(
          `An event's alias is plain: ${JSON.stringify(alias)}`
        );
      }
    }
    for (const [task, listened] of Object.entries(workflow.listens)) {
      if (
        listened.length === 0 ||
        listened.some((alias) => !Object.hasOwn(workflow.events, alias))
      ) {
        throw new TypeError(
          `Listen task ${JSON.stringify(task)} of ${workflow.alias} listens for events the workflow declares.`
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

/** `names` in order: the same contract makes the same text. */
const sortedKeys = (record: Readonly<Record<string, unknown>>): string[] =>
  Object.keys(record).toSorted();

/**
 * The type of the waits a run of `workflow` can be held at: the engine's
 * own, and one event wait per listen task, keyed by its path, holding the
 * references of the events it listens for.
 */
const waitTypeOf = (workflow: BoundWorkflow, depth: number): string => {
  const members = sortedKeys(workflow.listens).map((task) => {
    const events = [...new Set(workflow.listens[task])]
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
  return ["WorkflowEngineWait", ...members]
    .map((member) => `| ${member}`)
    .join(`\n${indent(depth)}`);
};

/** The type of the reference to `workflow`. */
const workflowTypeOf = (workflow: BoundWorkflow): string => {
  const events = sortedKeys(workflow.events).map((alias) => {
    const event = workflow.events[alias];
    const type =
      event === undefined ? "never" : eventTypeOf(workflow, alias, event);
    return `${indent(3)}readonly ${key(alias)}: ${type};`;
  });
  const eventsType =
    events.length === 0
      ? "Readonly<Record<never, never>>"
      : `{\n${events.join("\n")}\n${indent(2)}}`;
  const parts = [
    JSON.stringify(workflow.alias),
    valueTypeOf(workflow.input, "input"),
    valueTypeOf(workflow.output, "output"),
    waitTypeOf(workflow, 2),
    eventsType,
  ];
  return `WorkflowReference<\n${parts.map((part) => `${indent(2)}${part},`).join("\n")}\n${indent(1)}>`;
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
  };
};

/**
 * `workflows`: one reference per workflow the App binds, each with its
 * events and nothing else; no `.start`, `.get` or `.cancel` (spec 10.4).
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
  return `export const workflows: {\n${types.join("\n")}\n} = frozen({\n${values.join("\n")}\n});\n`;
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
    "WorkflowEngineWait",
    "WorkflowEventReference",
    "WorkflowEventWait",
    "WorkflowReference",
    ...valueTypes,
  ])}\n${freezer}\n${body}`;
};

/**
 * Every module the host generates for an App, by path (`generatedPaths`),
 * for the release `identity`, from its `manifest` as the host read it
 * (`readAppManifest`) and the `workflows` it binds, as the host resolved
 * them (`BoundWorkflow`).
 */
export const generateModules = async (
  manifest: AppManifest,
  identity: ReleaseIdentity,
  workflows: readonly BoundWorkflow[] = []
): Promise<Record<string, string>> => {
  checkBoundWorkflows(workflows);
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
