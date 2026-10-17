import path from "node:path";

import { buildConnectors, connectorEntries } from "../build.ts";

/**
 * Connect's connectors as its tests load them: the release's, as build.ts
 * builds them, the sample connector the tests call through, two apps
 * that sign in with their own records (OAuth 2.0, an API key), and one named
 * `composio`, whose contracts must never be served.
 */
export const testConnectorsFile = path.join(
  import.meta.dirname,
  "../dist/test/connectors.js"
);

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
};

export default setup;
