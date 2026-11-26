/**
 * A system that signs in with a form and holds its session in a cookie,
 * as connect's tests load its connector (`auth.login`): one host, so it can
 * also be reached through the company network (test/company-network-fake.ts
 * answers it there), with nothing that knows it is.
 */
import { auth, defineConnector, page, tool, v } from "@grasp-os/sdk/connector";

/** The host its connector names, whatever address the system is at. */
export const sampleCookieHost = "erp.sample-cookie.test";

/** The cookie the system keeps its session in. */
export const sampleCookieName = "ERPSESSION";

const Order = v.object({ id: v.string(), title: v.string() });
const Orders = v.object({ items: v.array(Order) });

export default defineConnector({
  name: "sample-cookie",
  title: "Sample cookie ERP",
  hosts: [sampleCookieHost],
  base: "/session",
  auth: auth.login({
    fields: { user: v.string(), secret: v.string() },
    account: "user",
    request: {
      url: `https://${sampleCookieHost}/session/login`,
      form: { user: "{user}", secret: "{secret}", client: "grasp" },
    },
    token: { cookie: sampleCookieName },
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
  },
});
