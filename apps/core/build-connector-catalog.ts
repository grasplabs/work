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
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { connectorCatalogSource } from "@grasp-os/sdk/host";
import type { CatalogAction } from "@grasp-os/sdk/host";
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

if (import.meta.main) {
  writeFileSync(
    catalogFile,
    connectorCatalogSource(await catalogOf(connectorEntries()))
  );
}
