import { canonicalText } from "@grasp-os/shared/json";

import type { AppManifest, FunctionManifest } from "./app-types.ts";
import type { BoundWorkflow } from "./bound-workflows.ts";
import type { ReleaseIdentity } from "./codegen-contracts.ts";
import {
  banner,
  dataOf,
  freezer,
  key,
  referenceTypeOf,
  renderTree,
  treeOf,
  typeImports,
  valueTypes,
} from "./codegen-render.ts";
import { workflowsExport } from "./codegen-workflows.ts";
import { declaredPermissions } from "./manifest-permissions.ts";
import { pageFunctionsOf } from "./page-functions.ts";
import { workflowFunctions } from "./workflow-functions.ts";

/** A tree of function references as a module's typed, frozen export. */
const referenceExport = (
  name: string,
  operations: readonly FunctionManifest[]
): string => {
  const tree = treeOf(
    operations.map((operation) => [operation.path, operation.path])
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
    (path) => `{ name: ${JSON.stringify(path)} }`,
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
): FunctionManifest[] =>
  Object.values(manifest.operations)
    .filter((operation) => operation.visibility === visibility)
    .toSorted((a, b) => (a.path < b.path ? -1 : 1));

/** `@server/_generated/internal`: the internal tree. */
export const serverReferencesText = (manifest: AppManifest): string => {
  const body = referenceExport("internal", operationsOf(manifest, "internal"));
  return `${banner}${typeImports(body, ["FunctionReferenceFromExport"])}\n${freezer}\n${body}`;
};

/**
 * `.grasp/functions.ts`: the release's public functions by name, as data
 * (page-functions.ts), built into its pages beside their route tree: the
 * App's own, and the queries and mutations of each workflow it binds
 * (workflow-functions.ts), which forms and grids take as any other.
 */
export const pageFunctionsText = (
  manifest: AppManifest,
  workflows: readonly BoundWorkflow[]
): string => {
  const operations: Record<string, FunctionManifest> = {
    ...manifest.operations,
  };
  for (const workflow of workflows) {
    const { queries, mutations } = workflowFunctions(workflow);
    for (const fn of [...Object.values(queries), ...Object.values(mutations)]) {
      if (fn !== undefined) {
        operations[fn.path] = fn;
      }
    }
  }
  // Parsed from JSON text, not written as an object literal: a field a
  // descriptor names `__proto__` stays a field, never the prototype.
  const data = JSON.stringify(canonicalText(pageFunctionsOf(operations)));
  return `${banner}export const functions: unknown = JSON.parse(${data});\n`;
};
/** `@server/_generated/api`: the public api and everything else a browser may hold. */
export const referencesText = async (
  manifest: AppManifest,
  identity: ReleaseIdentity,
  workflows: readonly BoundWorkflow[]
): Promise<string> => {
  const parts: string[] = [
    referenceExport("api", operationsOf(manifest, "public")),
    await workflowsExport(identity, workflows),
  ];

  const resources = [
    ...declaredPermissions(manifest, "files"),
    ...declaredPermissions(manifest, "links"),
  ].toSorted((a, b) => (a.alias < b.alias ? -1 : 1));
  const resourceTypes = resources.map((declared) => {
    const literals = (
      declared["~permission"] === "files"
        ? declared.operations
        : declared.origins
    )
      .map((item) => JSON.stringify(item))
      .join(", ");
    const type =
      declared["~permission"] === "files"
        ? `FilesReference<${JSON.stringify(declared.alias)}, readonly [${literals}]>`
        : `LinksReference<${JSON.stringify(declared.alias)}, readonly [${literals}]>`;
    return `  readonly ${key(declared.alias)}: ${type};`;
  });
  const resourceValues = resources.map((declared) => {
    const data =
      declared["~permission"] === "files"
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
      ? "export const permissions: Readonly<Record<never, never>> = frozen({});\n"
      : `export const permissions: {\n${resourceTypes.join("\n")}\n} = frozen({\n${resourceValues.join("\n")}\n});\n`
  );

  const body = parts.join("\n");
  return `${banner}${typeImports(body, [
    "FilesReference",
    "LinksReference",
    "FunctionReference",
    "FunctionReferenceFromExport",
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
