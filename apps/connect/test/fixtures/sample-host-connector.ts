/**
 * An app each client runs on a host of its own, such as an ERP on the
 * company's server: one connector written on `@grasp-os/sdk/connector`
 * whose host is a template (`{host}`), given by the admin who connects it
 * with an API key, and filled by connect's egress alone. Its provider is
 * whatever host the test answers for.
 */
import { auth, defineConnector, tool, v } from "@grasp-os/sdk/connector";

/** Its host template: a whole host, set per connection. */
export const sampleHostTemplate = "{host}";

/** The header the app takes its key in. */
export const sampleHostHeader = "x-api-key";

const Item = v.object({ id: v.string(), title: v.string() });
const Items = v.object({ items: v.array(Item) });

export default defineConnector({
  name: "sample-host",
  title: "Sample host app",
  hosts: [sampleHostTemplate],
  auth: auth.apiKey({
    header: sampleHostHeader,
    account: {
      url: "https://{host}/v1/whoami",
      id: "/account/id",
      name: "/account/name",
    },
  }),
  tools: {
    "items.list": tool({
      description: "Lists the items on a board",
      readOnly: true,
      reach: "own",
      resource: "board",
      routes: ["GET /v1/boards/{board}/items"],
      args: { board: v.string().min(1) },
      returns: Items,
      handler: async ({ board }, api) =>
        await api.get("/v1/boards/{board}/items", {
          path: { board },
          returns: Items,
        }),
    }),
  },
});
