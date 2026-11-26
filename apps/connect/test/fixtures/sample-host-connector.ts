/**
 * An app each client runs on a host of its own, such as an ERP on the
 * company's server: one connector written on `@grasp-os/sdk/connector`
 * whose host is a template (`{host}`), given by the admin who connects it
 * with an API key, and filled by connect's egress alone. Its provider is
 * whatever host the test answers for. `items.direct` and `items.elsewhere`
 * play connector code that reaches past the template: one names the host
 * an admin gave outright, the other the stand-in of a template it doesn't
 * declare.
 */
import { auth, defineConnector, page, tool, v } from "@grasp-os/sdk/connector";

/** Its host template: a whole host, set per connection. */
export const sampleHostTemplate = "{host}";

/** A host an admin gives the app, which its code names outright in `items.direct`. */
export const sampleHostFilled = "erp.acme.test";

/** The header the app takes its key in. */
export const sampleHostHeader = "x-api-key";

const Item = v.object({ id: v.string(), title: v.string() });
const Items = v.object({ items: v.array(Item) });
const Reached = v.object({ status: v.number() });

/** The status a board's items at `origin` answer connector code with. */
const reach = async (origin: string, board: string) => {
  const response = await fetch(
    `${origin}/v1/boards/${encodeURIComponent(board)}/items`
  );
  await response.body?.cancel();
  return { status: response.status };
};

export default defineConnector({
  name: "sample-host",
  title: "Sample host app",
  hosts: [sampleHostTemplate],
  base: "/v1",
  auth: auth.apiKey({
    header: sampleHostHeader,
    account: {
      url: "https://{host}/v1/whoami",
      id: "/account/id",
      name: "/account/name",
    },
  }),
  tools: {
    "boards.items.list": tool({
      description: "Lists the items on a board",
      readOnly: true,
      reach: "own",
      resource: "board",
      routes: ["GET /boards/{board}/items"],
      args: { board: v.string().min(1) },
      returns: page(Item),
      handler: async ({ board }, api) => {
        const answer = await api.get("/boards/{board}/items", {
          path: { board },
          returns: Items,
        });
        return { items: answer.items, next: null };
      },
    }),
    "boards.items.direct": tool({
      description: "Lists the items on a board at the host it was given",
      readOnly: true,
      reach: "own",
      resource: "board",
      routes: ["GET /boards/{board}/items"],
      args: { board: v.string().min(1) },
      returns: Reached,
      handler: async ({ board }) =>
        await reach(`https://${sampleHostFilled}`, board),
    }),
    "boards.items.elsewhere": tool({
      description: "Lists the items on a board at a template it doesn't have",
      readOnly: true,
      reach: "own",
      resource: "board",
      routes: ["GET /boards/{board}/items"],
      args: { board: v.string().min(1) },
      returns: Reached,
      handler: async ({ board }) => await reach("https://other.invalid", board),
    }),
  },
});
