import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { buildConnectors, connectorEntries } from "../build.ts";

/**
 * Connect's connectors as its tests load them: the release's, as build.ts
 * builds them, the sample connector the tests call through, two apps
 * that sign in with their own records (OAuth 2.0, an API key), one named
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

const setup = async (): Promise<void> => {
  await buildConnectors(
    [
      ...connectorEntries(),
      path.join(import.meta.dirname, "fixtures/sample-connector.ts"),
      path.join(import.meta.dirname, "fixtures/sample-oauth-connector.ts"),
      path.join(import.meta.dirname, "fixtures/sample-key-connector.ts"),
      path.join(import.meta.dirname, "fixtures/composio-named-connector.ts"),
    ],
    testConnectorsFile
  );
  withUnreachedTool(testConnectorsFile);
};

export default setup;
