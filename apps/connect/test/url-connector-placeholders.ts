/**
 * The fields a connector made from a URL is built with for the tests
 * (global-setup.ts `writeUrlConnector`), each replaced in its code by
 * what a test adds (mcp-connectors-harness.ts `generatedConnector`).
 */
export const urlConnectorPlaceholders = {
  name: `mcp_${"f".repeat(32)}`,
  title: "url-connector-title",
  url: "https://url-connector.invalid/mcp",
  registration: "dcr",
} as const;
