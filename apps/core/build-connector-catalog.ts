/**
 * Writes the SDK's connector catalog (packages/sdk/src/connector-catalog.gen.ts):
 * the type of every generated connector contract of this release, so an
 * App's `ctx.resources.<alias>.call(action, args)` infers the action's
 * arguments and answer from the contract its declaration names (spec 12).
 * Core's `typegen` runs it, and CI refuses the file when it is stale.
 *
 * It reads what the release serves, the way it serves it: the connectors
 * connect's build bundles (`connectorEntries`), grouped into contracts as
 * connect groups them (`generatedContracts`), and each action's JSON
 * Schemas read as core reads them for a binding (`readContractSchema`). An
 * action core can't read can't be bound, so it isn't in the catalog
 * either; nor is a contract left with no action.
 *
 * It also writes core's table of each native tool's class
 * (src/native-tool-classes.gen.ts), from the same manifests, which core
 * checks the chat's agent's calls against (src/tool-classes.ts).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { connectorCatalogSource } from "@grasp-os/sdk/host";
import type { CatalogAction } from "@grasp-os/sdk/host";
import { toolClassOf } from "@grasp-os/shared/connect";
import type { ToolClass } from "@grasp-os/shared/connect";
import { z } from "zod";

import {
  connectorManifestSchema,
  generatedContracts,
} from "../../packages/connector-kit/src/manifest.ts";
import { connectorEntries } from "../connect/build.ts";
import { readContractSchema } from "./src/connector-contracts.ts";

const catalogFile = path.join(
  import.meta.dirname,
  "../../packages/sdk/src/connector-catalog.gen.ts"
);

/**
 * Core's table of each native tool's class (src/native-tool-classes.gen.ts),
 * which the chat's agent's calls are checked against (tool-classes.ts).
 */
const classesFile = path.join(
  import.meta.dirname,
  "src/native-tool-classes.gen.ts"
);

/** A connector's module, as connect's build reads it. */
const moduleSchema = z.object({
  default: z.object({ manifest: z.unknown() }),
});

/** Every generated contract of the connectors at `entries`, by its actions. */
const catalogOf = async (
  entries: readonly string[]
): Promise<Map<string, Map<string, CatalogAction>>> => {
  const catalog = new Map<string, Map<string, CatalogAction>>();
  for (const entry of entries) {
    const loaded = moduleSchema.parse(
      // oxlint-disable-next-line no-await-in-loop -- one connector at a time
      await import(pathToFileURL(entry).href)
    );
    const manifest = connectorManifestSchema.parse(loaded.default.manifest);
    for (const [contract, served] of generatedContracts(manifest)) {
      const actions = new Map<string, CatalogAction>();
      for (const [action, { declared }] of served) {
        const input = readContractSchema(
          JSON.stringify(declared.contract.input)
        );
        const output = readContractSchema(
          JSON.stringify(declared.contract.output)
        );
        if (input !== undefined && output !== undefined) {
          actions.set(action, { input: input.schema, output: output.schema });
        }
      }
      if (actions.size > 0) {
        catalog.set(contract, actions);
      }
    }
  }
  return catalog;
};

/** The manifests of the connectors at `entries`, one at a time. */
const manifestsOf = async (entries: readonly string[]) => {
  const manifests = [];
  for (const entry of entries) {
    const loaded = moduleSchema.parse(
      // oxlint-disable-next-line no-await-in-loop -- one connector at a time
      await import(pathToFileURL(entry).href)
    );
    manifests.push(connectorManifestSchema.parse(loaded.default.manifest));
  }
  return manifests;
};

/**
 * Each native tool's class, by its connector's provider, then its name, as
 * its manifest declares it (`toolClassOf`). Two connectors of one provider
 * declaring the same tool would leave its class ambiguous: refused.
 */
export const toolClassesOf = (
  manifests: readonly z.infer<typeof connectorManifestSchema>[]
): Map<string, Map<string, ToolClass>> => {
  const classes = new Map<string, Map<string, ToolClass>>();
  for (const { name, provider, actions } of manifests) {
    const tools = classes.get(provider) ?? new Map<string, ToolClass>();
    for (const [tool, action] of Object.entries(actions)) {
      if (tools.has(tool)) {
        throw new Error(
          `${name} declares ${tool}, which another ${provider} connector declares too`
        );
      }
      tools.set(tool, toolClassOf(action));
    }
    classes.set(provider, tools);
  }
  return classes;
};

/** Orders keys by their code units, as the same on every machine. */
const byCodeUnits = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const byKey = <T>(map: ReadonlyMap<string, T>): [string, T][] =>
  [...map].toSorted(([a], [b]) => byCodeUnits(a, b));

/** The source of src/native-tool-classes.gen.ts for `classes`. */
const toolClassesSource = (
  classes: ReadonlyMap<string, ReadonlyMap<string, ToolClass>>
): string => {
  const providers = byKey(classes).map(([provider, tools]) => {
    const lines = byKey(tools).map(
      ([tool, toolClass]) =>
        `    ${JSON.stringify(tool)}: ${JSON.stringify(toolClass)},`
    );
    return `  ${JSON.stringify(provider)}: {\n${lines.join("\n")}\n  },`;
  });
  return `// Generated by Grasp from the native connectors of this release (apps/core/build-connector-catalog.ts).
// Don't edit it: \`vp run -r typegen\` makes it again, and CI refuses it stale.

/**
 * Each native connector tool's class (\`toolClassOf\`), by its connector's
 * provider, then the tool's name. Core reads and checks it in
 * tool-classes.ts.
 */
export const nativeToolClasses: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
${providers.join("\n")}
};
`;
};

if (import.meta.main) {
  const entries = connectorEntries();
  writeFileSync(catalogFile, connectorCatalogSource(await catalogOf(entries)));
  writeFileSync(
    classesFile,
    toolClassesSource(toolClassesOf(await manifestsOf(entries)))
  );
}
