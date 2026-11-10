import { canonicalText } from "@grasp-os/shared/json";

import type { AppManifest, FunctionManifest } from "./app-types.ts";
import type { BoundWorkflow } from "./bound-workflows.ts";
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
import { pageFunctionsOf, pageWorkflowsOf } from "./page-functions.ts";
import type { Declared } from "./server-modules.ts";
import { workflowFunctions } from "./workflow-functions.ts";

/**
 * An App's server functions as its modules' syntax declares them: each
 * one's visibility by its path (`tasks.list` for `server/tasks.ts`'s
 * `export const list = query(…)`), read without running the code
 * (server-modules.ts). What the generated `api` and `internal` trees
 * hold, so they depend only on the server files' paths and what they
 * export, never on a release.
 */
export type ServerFunctions = Readonly<Record<string, Declared>>;

/** A tree of function references as a module's typed, frozen export. */
const referenceExport = (name: string, paths: readonly string[]): string => {
  const tree = treeOf(paths.map((path) => [path, path]));
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

/** The paths of `functions` of `visibility`, in order. */
const pathsOf = (
  functions: ServerFunctions,
  visibility: "public" | "internal"
): string[] =>
  Object.keys(functions)
    .filter((path) => functions[path]?.visibility === visibility)
    .toSorted();

/** `@server/_generated/internal`: the internal tree. */
export const serverReferencesText = (functions: ServerFunctions): string => {
  const body = referenceExport("internal", pathsOf(functions, "internal"));
  return `${banner}${typeImports(body, ["FunctionReferenceFromExport"])}\n${freezer}\n${body}`;
};

/**
 * `.grasp/functions.ts`: the release's public functions by name, as data
 * (page-functions.ts), built into its pages beside their route tree: the
 * App's own, and the queries and mutations of each workflow it declares
 * (workflow-functions.ts), which forms and grids take as any other; and
 * each workflow's events, listen tasks and decisions, by alias, which
 * `useWorkflow` and a decision's form read.
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
  const data = JSON.stringify(
    canonicalText({
      functions: pageFunctionsOf(operations),
      workflows: pageWorkflowsOf(workflows),
    })
  );
  return `${banner}export const functions: unknown = JSON.parse(${data});\n`;
};
/** `@server/_generated/api`: the public api and everything else a browser may hold. */
export const referencesText = (
  functions: ServerFunctions,
  app: Pick<AppManifest, "permissions">,
  workflows: readonly BoundWorkflow[]
): string => {
  const parts: string[] = [
    referenceExport("api", pathsOf(functions, "public")),
    workflowsExport(workflows),
  ];

  const resources = [
    ...declaredPermissions(app, "files"),
    ...declaredPermissions(app, "links"),
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
