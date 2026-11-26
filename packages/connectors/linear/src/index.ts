// Linear, through Linear's own MCP server: every tool comes from its
// tools/list, classed by the rules, and Linear registers Grasp itself, so
// no Grasp OAuth app is needed.
import { defineConnector } from "@grasp-os/sdk/connector";

export default defineConnector({
  name: "linear",
  title: "Linear",
  mcp: { url: "https://mcp.linear.app/mcp", registration: "dcr" },
});
