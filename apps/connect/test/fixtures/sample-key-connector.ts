/**
 * An app that signs in with an API key, as connect's tests load it: one
 * connector, its provider record (`signIn`) included, and no change to
 * connect. Its provider is test/app-provider.ts's fake. `items.forge`
 * plays connector code gone wrong: it sends a key of its own.
 */
import {
  defineConnector,
  defineTool,
  ToolError,
} from "@grasp-os/connector-kit/connector";
import { z } from "zod";

/** The app's API, which its connector calls and its key is checked at. */
export const sampleKeyApiHost = "api.sample-key.test";

/** The header the app takes its key in. */
export const sampleKeyHeader = "x-api-key";

const api = `https://${sampleKeyApiHost}`;

const itemSchema = z.object({ id: z.string(), title: z.string() });

const list = async (
  board: string,
  headers: Record<string, string> = {}
): Promise<{ output: { items: z.infer<typeof itemSchema>[] } }> => {
  const response = await fetch(
    `${api}/v1/boards/${encodeURIComponent(board)}/items`,
    { headers }
  );
  if (!response.ok) {
    throw new ToolError(`The app answered ${response.status}`);
  }
  const { items } = z
    .object({ items: z.array(itemSchema) })
    .parse(await response.json());
  return { output: { items } };
};

const boardInput = z.strictObject({ board: z.string().min(1) });
const itemsOutput = z.strictObject({ items: z.array(itemSchema) });
const listRoute = {
  method: "GET",
  host: sampleKeyApiHost,
  path: "/v1/boards/{board}/items",
} as const;

export default defineConnector({
  name: "sample-key",
  version: "1.0.0",
  provider: "sample-key",
  signIn: {
    kind: "api_key",
    name: "Sample key app",
    header: sampleKeyHeader,
    account: {
      url: `${api}/v1/whoami`,
      id: "/account/id",
      name: "/account/name",
      email: "/account/email",
    },
  },
  scopes: [],
  hosts: [sampleKeyApiHost],
  tools: [
    defineTool({
      name: "items.list",
      description: "Lists the items on a board",
      input: boardInput,
      output: itemsOutput,
      readOnly: true,
      resource: "board",
      routes: [listRoute],
      run: async ({ board }) => await list(board),
    }),
    defineTool({
      name: "items.forge",
      description: "Lists the items on a board with a key of its own",
      input: boardInput,
      output: itemsOutput,
      readOnly: true,
      resource: "board",
      routes: [listRoute],
      run: async ({ board }) =>
        await list(board, {
          [sampleKeyHeader]: "a-key-the-connector-chose",
          authorization: "Bearer a-token-the-connector-chose",
        }),
    }),
  ],
});
