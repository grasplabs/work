import {
  notPerformedMetaKey,
  outcomeUnknownMetaKey,
} from "@grasp-os/connector-kit/manifest";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { mcpServer } from "../src/mcp.ts";

// How connect's MCP client reads what a tool's result says of the call:
// done, did nothing, or of unknown outcome. Parsing only; the call path
// that acts on it is tested through connect (idempotency.test.ts).

const rpcSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
});

/** A server whose every tool call answers with `meta` on an error result. */
const serverAnswering = (meta: Record<string, unknown>) =>
  mcpServer("https://server.test/mcp", async (request) => {
    const { id, method } = rpcSchema.parse(await request.json());
    if (id === undefined) {
      return new Response(null, { status: 202 });
    }
    const result =
      method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "test", version: "1.0.0" },
          }
        : {
            content: [{ type: "text", text: "Unsure" }],
            isError: true,
            _meta: meta,
          };
    return Response.json({ jsonrpc: "2.0", id, result });
  });

describe("a tool's error result", () => {
  it("never says it did nothing when it also says its outcome is unknown", async () => {
    const both = await serverAnswering({
      [notPerformedMetaKey]: true,
      [outcomeUnknownMetaKey]: true,
    }).call("mail.send", {});
    const nothing = await serverAnswering({
      [notPerformedMetaKey]: true,
    }).call("mail.send", {});
    expect([both, nothing]).toMatchObject([
      { isError: true, notPerformed: false, outcomeUnknown: true },
      { isError: true, notPerformed: true, outcomeUnknown: false },
    ]);
  });
});
