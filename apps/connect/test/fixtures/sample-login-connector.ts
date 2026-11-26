/**
 * An app that signs in with a call (`auth.login`), as connect's tests load
 * it: a user name and a password, posted as JSON, for a token in the
 * answer that its calls carry as a bearer token, written on
 * `@grasp-os/sdk/connector` with no change to connect. Its files are on a
 * second host, which the session doesn't go to. `orders.headers` reads what
 * an answer's headers hold, and `orders.probe` posts to the login itself,
 * as connector code that looks for a session would; `orders.create` is a
 * write, which a refused session never sends again.
 */
import { auth, defineConnector, page, tool, v } from "@grasp-os/sdk/connector";

/** The app's API, where it signs in and its session goes. */
export const sampleLoginApiHost = "api.sample-login.test";

/** The app's file storage: a host of its connector's the session doesn't go to. */
export const sampleLoginFilesHost = "files.sample-login.test";

/** Where the app signs in. */
export const sampleLoginPath = "/api/auth/login";

const Order = v.object({ id: v.string(), title: v.string() });
const Orders = v.object({ items: v.array(Order) });

export default defineConnector({
  name: "sample-login",
  title: "Sample login app",
  hosts: [sampleLoginApiHost, sampleLoginFilesHost],
  base: "/api",
  auth: auth.login({
    hosts: [sampleLoginApiHost],
    fields: { userName: v.string(), password: v.string() },
    account: "userName",
    request: {
      url: `https://${sampleLoginApiHost}${sampleLoginPath}`,
      json: { userName: "{userName}", password: "{password}", remember: false },
    },
    token: { from: "/token", header: "authorization", prefix: "Bearer " },
    expiresIn: "/expires_in",
  }),
  tools: {
    "orders.list": tool({
      description: "Lists the orders",
      readOnly: true,
      reach: "own",
      routes: [`GET ${sampleLoginApiHost}/orders`],
      args: {},
      returns: page(Order),
      handler: async (_args, api) => {
        const answer = await api.get(`${sampleLoginApiHost}/orders`, {
          returns: Orders,
        });
        return { items: answer.items, next: null };
      },
    }),
    "orders.create": tool({
      description: "Creates an order",
      readOnly: false,
      reach: "own",
      routes: [`POST ${sampleLoginApiHost}/orders`],
      args: { title: v.string() },
      returns: Order,
      handler: async ({ title }, api) =>
        await api.post(`${sampleLoginApiHost}/orders`, {
          body: { title },
          returns: Order,
        }),
    }),
    "files.list": tool({
      description: "Lists the files, from the app's storage",
      readOnly: true,
      reach: "own",
      routes: [`GET ${sampleLoginFilesHost}/files`],
      args: {},
      returns: page(Order),
      handler: async (_args, api) => {
        const answer = await api.get(`${sampleLoginFilesHost}/files`, {
          returns: Orders,
        });
        return { items: answer.items, next: null };
      },
    }),
    "orders.headers": tool({
      description: "Reads the headers of the answer to the orders",
      readOnly: true,
      reach: "own",
      routes: [`GET ${sampleLoginApiHost}/orders`],
      args: {},
      returns: v.object({ headers: v.string() }),
      handler: async () => {
        const response = await fetch(
          `https://${sampleLoginApiHost}/api/orders`
        );
        await response.body?.cancel();
        return { headers: JSON.stringify([...response.headers]) };
      },
    }),
    "orders.probe": tool({
      description: "Signs in itself, as connector code gone wrong",
      readOnly: true,
      reach: "own",
      routes: [`GET ${sampleLoginApiHost}/orders`],
      args: { password: v.string() },
      returns: v.object({ status: v.number() }),
      handler: async ({ password }) => {
        const response = await fetch(
          `https://${sampleLoginApiHost}${sampleLoginPath}`,
          {
            method: "POST",
            body: JSON.stringify({ userName: "erp-user", password }),
          }
        );
        await response.body?.cancel();
        return { status: response.status };
      },
    }),
  },
});
