import type { AppManifest, FunctionManifest } from "./app-types.ts";
import type { BoundWorkflow } from "./bound-workflows.ts";
import type { ReleaseIdentity } from "./codegen-contracts.ts";
import {
  banner,
  dataOf,
  freezer,
  key,
  referenceOf,
  referenceTypeOf,
  renderTree,
  treeOf,
  typeImports,
  valueTypes,
} from "./codegen-render.ts";
import { workflowsExport } from "./codegen-workflows.ts";
import { declaredPermissions } from "./manifest-permissions.ts";

/** A tree of function references as a module's typed, frozen export. */
const referenceExport = (
  name: string,
  operations: readonly FunctionManifest[]
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
    (operation, depth) => dataOf(referenceOf(operation), depth),
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
  return `${banner}${typeImports(body, ["FunctionReference", ...valueTypes])}\n${freezer}\n${body}`;
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
