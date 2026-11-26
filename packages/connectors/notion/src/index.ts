// Notion, through Notion's own MCP server: every tool comes from its
// tools/list, classed by the rules, and Notion registers Grasp itself, so
// no Grasp OAuth app is needed.
import { defineConnector } from "@grasp-os/sdk/connector";

export default defineConnector({
  name: "notion",
  title: "Notion",
  mcp: { url: "https://mcp.notion.com/mcp", registration: "dcr" },
});
