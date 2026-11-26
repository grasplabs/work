/**
 * A built-in serving its vendor's MCP server that takes a person's key in
 * a header, as connect's tests load it: one `defineConnector` with `mcp`,
 * its server a test's own (mcp-connectors-harness.ts `keyServer`).
 */
import { defineConnector } from "@grasp-os/sdk/connector";

/** Where its server is. */
export const sampleTrackerOrigin = "https://mcp.sample-tracker.test";

export default defineConnector({
  name: "sample-tracker",
  title: "Sample tracker",
  mcp: {
    url: `${sampleTrackerOrigin}/mcp`,
    registration: { header: "X-Api-Key" },
  },
});
