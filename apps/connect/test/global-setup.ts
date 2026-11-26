import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { connectorBuilder } from "@grasp-os/compiler/build-connectors";
import {
  mcpConnectorEntry,
  mcpConnectorSource,
} from "@grasp-os/compiler/connector-source";
import { z } from "zod";

import { buildConnectors, connectorEntries } from "../build.ts";
import { urlConnectorPlaceholders } from "./url-connector-placeholders.ts";

/**
 * Connect's connectors as its tests load them: the release's, as build.ts
 * builds them, the sample connector the tests call through, one that
 * syncs (`sample-sync`), three apps
 * that sign in with their own records (OAuth 2.0, an API key, and OAuth
 * 2.0 pinned to a tenant as a suite's, `sample-tenant`), a built-in
 * serving its vendor's MCP server with a key (`sample-tracker`), one named
 * `composio`, whose contracts must never be served, and `sample-unreached`
 * (`withUnreachedTool`).
 */
export const testConnectorsFile = path.join(
  import.meta.dirname,
  "../dist/test/connectors.js"
);

/**
 * The classes of the fake Composio's tools, which connect's tests and the
 * connect core's tests bundle read in place of the release's
 * (`#composio-classes`).
 */
export const testComposioClassesFile = path.join(
  import.meta.dirname,
  "fixtures/composio-classes.ts"
);

const builtSchema = z.array(
  z.object({
    manifest: z.looseObject({
      name: z.string(),
      actions: z.record(z.string(), z.record(z.string(), z.unknown())),
    }),
    code: z.string(),
  })
);

/**
 * Adds a copy of the sample connector named `sample-unreached`, whose
 * `items.list` doesn't say whom it reaches: what a connector made before
 * tools had a reach would ship. The build refuses to make one, so it is
 * written in after it, for the tests to show connect refuses it too.
 */
const withUnreachedTool = (file: string): void => {
  const source = readFileSync(file, "utf-8");
  const built = builtSchema.parse(
    JSON.parse(source.slice("export default ".length, source.lastIndexOf(";")))
  );
  const sample = built.find(({ manifest }) => manifest.name === "sample");
  const listed = sample?.manifest.actions["items.list"];
  if (sample === undefined || listed === undefined) {
    throw new Error("The sample connector's items.list wasn't built");
  }
  const { reach: _reach, ...unreached } = listed;
  built.push({
    manifest: {
      ...sample.manifest,
      name: "sample-unreached",
      actions: { ...sample.manifest.actions, "items.list": unreached },
    },
    code: sample.code,
  });
  writeFileSync(file, `export default ${JSON.stringify(built)};\n`);
};

/**
 * A connector made from a URL as core builds it, its fields placeholders
 * (url-connector-placeholders.ts): what the tests add in core's place,
 * each field put in as the compiler puts in a string (`generatedConnector`
 * in mcp-connectors-harness.ts). Built once, with the `connector` target.
 */
export const testUrlConnectorFile = path.join(
  import.meta.dirname,
  "../dist/test/url-connector.js"
);

const writeUrlConnector = async (): Promise<void> => {
  const { name, title, url, registration } = urlConnectorPlaceholders;
  const source = mcpConnectorSource({
    name,
    title,
    mcp: { url, registration },
  });
  const built = await (
    await connectorBuilder()
  )({
    entry: mcpConnectorEntry,
    read: (file) => (file === mcpConnectorEntry ? source : undefined),
  });
  if (!built.ok) {
    throw new Error(built.refusals.join("\n"));
  }
  for (const placeholder of [name, title, url, registration]) {
    if (built.code.split(JSON.stringify(placeholder)).length !== 2) {
      throw new Error(
        `${placeholder} isn't in the built code once, as written`
      );
    }
  }
  writeFileSync(
    testUrlConnectorFile,
    `export default ${JSON.stringify(built.code)};\n`
  );
};

const setup = async (): Promise<void> => {
  await buildConnectors(
    [
      ...connectorEntries(),
      path.join(import.meta.dirname, "fixtures/sample-connector.ts"),
      path.join(import.meta.dirname, "fixtures/sample-sync-connector.ts"),
      path.join(import.meta.dirname, "fixtures/sample-oauth-connector.ts"),
      path.join(import.meta.dirname, "fixtures/sample-key-connector.ts"),
      path.join(import.meta.dirname, "fixtures/sample-erp-connector.ts"),
      path.join(import.meta.dirname, "fixtures/sample-tenant-connector.ts"),
      path.join(import.meta.dirname, "fixtures/sample-mcp-key-connector.ts"),
      path.join(import.meta.dirname, "fixtures/composio-named-connector.ts"),
    ],
    testConnectorsFile
  );
  withUnreachedTool(testConnectorsFile);
  await writeUrlConnector();
};

export default setup;
