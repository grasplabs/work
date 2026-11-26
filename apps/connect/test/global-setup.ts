import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  connectorManifestSchema,
  fixturesSchema,
} from "@grasp-os/runtime/connector";
import type { Fixtures } from "@grasp-os/runtime/connector";
import type { TestProject } from "vite-plus/test/node";
import { z } from "zod";

import { buildConnectors, connectorEntries, fixturesFileOf } from "../build.ts";

/**
 * The connector a live recording run records (fixtures.live.test.ts):
 * its entry, from the repo root, as `RECORD_CONNECTOR` names it.
 */
const recording =
  process.env.RECORD_CONNECTOR === undefined ||
  process.env.RECORD_CONNECTOR === ""
    ? undefined
    : path.resolve(
        import.meta.dirname,
        "../../..",
        process.env.RECORD_CONNECTOR
      );

/** What a live recording run records, as the tests `inject` it. */
export interface Recording {
  /** The connector's name. */
  name: string;
  /** Its fixtures file, which the run writes. */
  file: string;
  /** The cases it records, and the fields it holds personal. */
  plan: Fixtures;
}

declare module "vite-plus/test" {
  interface ProvidedContext {
    recording: Recording | null;
  }
}

/**
 * Connect's connectors as its tests load them: the release's, as build.ts
 * builds them, the sample connector the tests call through, one that
 * syncs (`sample-sync`), three apps
 * that sign in with their own records (OAuth 2.0, an API key, and OAuth
 * 2.0 pinned to a tenant as a suite's, `sample-tenant`), a built-in
 * serving its vendor's MCP server with a key (`sample-tracker`), two on a
 * host of each client's own (`sample-host`, given with the key, and
 * `sample-company`, named by the token response), one named
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
 * The connector `recording` names, for a live run to record: its name, and
 * the cases its fixtures file lists, which must be written first.
 */
const recordingOf = async (entry: string): Promise<Recording> => {
  // The guard that matters most is one no code can check: the account
  // recorded from is Grasp's own and holds only made-up data.
  if (process.env.RECORD_MADE_UP_DATA !== "yes") {
    throw new Error(
      "Record only from an account Grasp owns that holds made-up data, and say so with RECORD_MADE_UP_DATA=yes"
    );
  }
  const file = fixturesFileOf(entry);
  if (!existsSync(file)) {
    throw new Error(`Write the cases to record in ${file} first`);
  }
  const loaded = z
    .object({ default: z.object({ manifest: z.unknown() }) })
    .parse(await import(pathToFileURL(entry).href));
  return {
    name: connectorManifestSchema.parse(loaded.default.manifest).name,
    file,
    plan: fixturesSchema.parse(JSON.parse(readFileSync(file, "utf-8"))),
  };
};

const setup = async (project: TestProject): Promise<void> => {
  project.provide(
    "recording",
    recording === undefined ? null : await recordingOf(recording)
  );
  const entries = [
    ...connectorEntries(),
    path.join(import.meta.dirname, "fixtures/sample-connector.ts"),
    path.join(import.meta.dirname, "fixtures/sample-sync-connector.ts"),
    path.join(import.meta.dirname, "fixtures/sample-oauth-connector.ts"),
    path.join(import.meta.dirname, "fixtures/sample-key/connector.ts"),
    path.join(import.meta.dirname, "fixtures/sample-erp-connector.ts"),
    path.join(import.meta.dirname, "fixtures/sample-tenant-connector.ts"),
    path.join(import.meta.dirname, "fixtures/sample-mcp-key-connector.ts"),
    path.join(import.meta.dirname, "fixtures/sample-host-connector.ts"),
    path.join(import.meta.dirname, "fixtures/sample-company-connector.ts"),
    path.join(import.meta.dirname, "fixtures/composio-named-connector.ts"),
  ];
  await buildConnectors(
    recording === undefined || entries.includes(recording)
      ? entries
      : [...entries, recording],
    testConnectorsFile,
    // Its cases are being recorded: they can't replay yet.
    recording
  );
  withUnreachedTool(testConnectorsFile);
};

export default setup;
