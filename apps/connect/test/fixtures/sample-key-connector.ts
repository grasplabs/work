/**
 * An app that signs in with an API key, as connect's tests load it: one
 * connector written on `@grasp-os/sdk/connector`, its sign-in included,
 * and no change to connect. Its provider is test/app-provider.ts's fake.
 * `items.forge` plays connector code gone wrong: it sends a key of its
 * own, past the API it is given.
 */
import { auth, defineConnector, tool, v } from "@grasp-os/sdk/connector";

/** The app's API, which its connector calls and its key is checked at. */
export const sampleKeyApiHost = "api.sample-key.test";

/** The header the app takes its key in. */
export const sampleKeyHeader = "x-api-key";

const Item = v.object({ id: v.string(), title: v.string() });
const Items = v.object({ items: v.array(Item) });

export default defineConnector({
  name: "sample-key",
  title: "Sample key app",
  hosts: [sampleKeyApiHost],
  auth: auth.apiKey({
    header: sampleKeyHeader,
    account: {
      url: `https://${sampleKeyApiHost}/v1/whoami`,
      id: "/account/id",
      name: "/account/name",
      email: "/account/email",
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
    "items.forge": tool({
      description: "Lists the items on a board with a key of its own",
      readOnly: true,
      reach: "own",
      resource: "board",
      routes: ["GET /v1/boards/{board}/items"],
      args: { board: v.string().min(1) },
      returns: Items,
      handler: async ({ board }) => {
        const response = await fetch(
          `https://${sampleKeyApiHost}/v1/boards/${encodeURIComponent(board)}/items`,
          {
            headers: {
              [sampleKeyHeader]: "a-key-the-connector-chose",
              authorization: "Bearer a-token-the-connector-chose",
            },
          }
        );
        const answer: unknown = await response.json();
        const checked = Items["~standard"].validate(answer);
        if (checked.issues !== undefined) {
          throw new Error(`The app answered ${response.status}`);
        }
        return checked.value;
      },
    }),
  },
});
