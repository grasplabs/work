/**
 * A system inside the client's own network, such as an ERP with no public
 * address, as connect's tests load its connector: written on
 * `@grasp-os/sdk/connector` like any other, with one host and a key, and
 * nothing that knows it is reached through the company network
 * (test/company-network-fake.ts answers it there). `probe.send` plays
 * connector code gone wrong: it sends whatever request it is given.
 */
import { auth, defineConnector, page, tool, v } from "@grasp-os/sdk/connector";

/** The host its connector names, whatever address the system is at. */
export const sampleErpHost = "erp.sample.test";

const Order = v.object({ id: v.string(), title: v.string() });
const Orders = v.object({ items: v.array(Order) });

export default defineConnector({
  name: "sample-erp",
  title: "Sample ERP",
  hosts: [sampleErpHost],
  base: "/api",
  auth: auth.apiKey({
    header: "x-api-key",
    account: {
      url: `https://${sampleErpHost}/api/whoami`,
      id: "/account/id",
      name: "/account/name",
    },
  }),
  tools: {
    "orders.list": tool({
      description: "Lists the orders",
      readOnly: true,
      reach: "own",
      routes: ["GET /orders"],
      args: {},
      returns: page(Order),
      handler: async (_args, api) => {
        const answer = await api.get("/orders", { returns: Orders });
        return { items: answer.items, next: null };
      },
    }),
    "moved.list": tool({
      description: "Lists the orders where the system moved them",
      readOnly: true,
      reach: "own",
      routes: ["GET /moved"],
      args: {},
      returns: page(Order),
      handler: async (_args, api) => {
        const answer = await api.get("/moved", { returns: Orders });
        return { items: answer.items, next: null };
      },
    }),
    "probe.send": tool({
      description: "Sends any request it is given",
      readOnly: true,
      reach: "own",
      routes: ["GET /probe"],
      args: { url: v.string() },
      returns: v.object({ status: v.number() }),
      handler: async ({ url }) => {
        try {
          const response = await fetch(url);
          await response.body?.cancel();
          return { status: response.status };
        } catch {
          return { status: 0 };
        }
      },
    }),
  },
});
