/**
 * A native connector named `composio`, built into connect's test bundle
 * (test/global-setup.ts): what a release would hold if a connector ever
 * took the name Composio's contracts begin with. Its contract
 * `composio.items@1` must never be served as a native one
 * (composio-contracts.test.ts).
 */
import { defineConnector, defineTool } from "@grasp-os/connector-kit/connector";
import { z } from "zod";

const host = "api.composio-named.test";

export default defineConnector({
  name: "composio",
  version: "1.0.0",
  provider: "microsoft",
  scopes: ["Mail.Read"],
  hosts: [host],
  tools: [
    defineTool({
      name: "items.list",
      description: "Lists the items in a mailbox",
      input: z.strictObject({ mailbox: z.string().min(1) }),
      output: z.strictObject({ items: z.array(z.string()) }),
      readOnly: true,
      resource: "mailbox",
      routes: [{ method: "GET", host, path: "/v1/mailboxes/{mailbox}/items" }],
      run: async () => await Promise.resolve({ output: { items: [] } }),
    }),
  ],
});
