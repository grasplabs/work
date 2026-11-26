/**
 * An app that signs in with an API key, as connect's tests load it: one
 * connector written on `@grasp-os/sdk/connector`, its sign-in included,
 * and no change to connect. Its provider is test/app-provider.ts's fake.
 * `boards.items.forge` plays connector code gone wrong: it sends a key of its
 * own, past the API it is given. Its files are on a second host, which
 * the key doesn't go to; `boards.items.headers` reads what an answer's
 * headers hold, as connector code that looks for a session or an echoed key.
 */
import { auth, defineConnector, page, tool, v } from "@grasp-os/sdk/connector";

/** The app's API, which its connector calls and its key is checked at. */
export const sampleKeyApiHost = "api.sample-key.test";

/** The app's file storage: a host of its connector's that takes no key. */
export const sampleKeyFilesHost = "files.sample-key.test";

/** The header the app takes its key in. */
export const sampleKeyHeader = "x-api-key";

const Item = v.object({ id: v.string(), title: v.string() });
const Items = v.object({ items: v.array(Item) });

export default defineConnector({
  name: "sample-key",
  title: "Sample key app",
  hosts: [sampleKeyApiHost, sampleKeyFilesHost],
  base: "/v1",
  auth: auth.apiKey({
    hosts: [sampleKeyApiHost],
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
      routes: [`GET ${sampleKeyApiHost}/boards/{board}/items`],
      args: { board: v.string().min(1) },
      returns: page(Item),
      handler: async ({ board }, api) => {
        const answer = await api.get(
          `${sampleKeyApiHost}/boards/{board}/items`,
          {
            path: { board },
            returns: Items,
          }
        );
        return { items: answer.items, next: null };
      },
    }),
    "boards.files.list": tool({
      description: "Lists the files on a board, from the app's storage",
      readOnly: true,
      reach: "own",
      resource: "board",
      routes: [`GET ${sampleKeyFilesHost}/boards/{board}/files`],
      args: { board: v.string().min(1) },
      returns: page(Item),
      handler: async ({ board }, api) => {
        const answer = await api.get(
          `${sampleKeyFilesHost}/boards/{board}/files`,
          {
            path: { board },
            returns: Items,
          }
        );
        return { items: answer.items, next: null };
      },
    }),
    "boards.items.headers": tool({
      description: "Reads the headers of the answer to a board's items",
      readOnly: true,
      reach: "own",
      resource: "board",
      routes: [`GET ${sampleKeyApiHost}/boards/{board}/items`],
      args: { board: v.string().min(1) },
      returns: v.object({ headers: v.string() }),
      handler: async ({ board }) => {
        const response = await fetch(
          `https://${sampleKeyApiHost}/v1/boards/${encodeURIComponent(board)}/items`
        );
        await response.body?.cancel();
        return { headers: JSON.stringify([...response.headers]) };
      },
    }),
    "boards.items.forge": tool({
      description: "Lists the items on a board with a key of its own",
      readOnly: true,
      reach: "own",
      resource: "board",
      routes: [`GET ${sampleKeyApiHost}/boards/{board}/items`],
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
