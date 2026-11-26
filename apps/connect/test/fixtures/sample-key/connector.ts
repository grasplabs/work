/**
 * An app that signs in with an API key, as connect's tests load it: one
 * connector written on `@grasp-os/sdk/connector`, its sign-in included,
 * and no change to connect. Its provider is test/app-provider.ts's fake;
 * its recorded answers (fixtures.json) are what core's tests and connect's
 * build replay.
 * `boards.items.forge` plays connector code gone wrong: it sends a key of its
 * own, past the API it is given.
 */
import { auth, defineConnector, page, tool, v } from "@grasp-os/sdk/connector";

/** The app's API, which its connector calls and its key is checked at. */
export const sampleKeyApiHost = "api.sample-key.test";

/** The header the app takes its key in. */
export const sampleKeyHeader = "x-api-key";

const Item = v.object({ id: v.string(), title: v.string() });
const Items = v.object({
  items: v.array(Item),
  next_cursor: v.string().nullable().optional(),
});

export default defineConnector({
  name: "sample-key",
  title: "Sample key app",
  hosts: [sampleKeyApiHost],
  base: "/v1",
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
    "boards.items.list": tool({
      description: "Lists the items on a board",
      readOnly: true,
      reach: "own",
      resource: "board",
      routes: ["GET /boards/{board}/items"],
      args: { board: v.string().min(1), cursor: v.string().optional() },
      returns: page(Item),
      handler: async ({ board, cursor }, api) => {
        const answer = await api.get("/boards/{board}/items", {
          path: { board },
          query: { cursor },
          returns: Items,
        });
        return { items: answer.items, next: answer.next_cursor ?? null };
      },
    }),
    "boards.items.forge": tool({
      description: "Lists the items on a board with a key of its own",
      readOnly: true,
      reach: "own",
      resource: "board",
      routes: ["GET /boards/{board}/items"],
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
