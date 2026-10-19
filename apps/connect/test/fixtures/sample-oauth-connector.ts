/**
 * An app that signs in with OAuth 2.0, as connect's tests load it: one
 * connector, its provider record (`signIn`) included, and no change to
 * connect. Its provider is test/app-provider.ts's fake.
 */
import {
  defineConnector,
  defineTool,
  ToolError,
} from "@grasp-os/connector-kit/connector";
import { z } from "zod";

/** Where the app signs people in and issues tokens. */
export const sampleOAuthAuthHost = "auth.sample-oauth.test";

/** The app's API, which its connector calls. */
export const sampleOAuthApiHost = "api.sample-oauth.test";

const api = `https://${sampleOAuthApiHost}`;

const itemSchema = z.object({ id: z.string(), title: z.string() });

export default defineConnector({
  name: "sample-oauth",
  version: "1.0.0",
  provider: "sample-oauth",
  signIn: {
    kind: "oauth2",
    name: "Sample OAuth app",
    authorizationEndpoint: `https://${sampleOAuthAuthHost}/oauth/authorize`,
    tokenEndpoint: `https://${sampleOAuthAuthHost}/oauth/token`,
    revocationEndpoint: `https://${sampleOAuthAuthHost}/oauth/revoke`,
    scopes: ["items:read", "items:write", "offline"],
    // As some apps have it: a comma, and the client in HTTP Basic.
    scopeSeparator: ",",
    clientAuthentication: "client_secret_basic",
    authorizationParams: { access_type: "offline" },
    account: {
      url: `${api}/v1/me`,
      id: "/data/id",
      name: "/data/name",
      email: "/data/email",
    },
  },
  scopes: ["items:read", "items:write"],
  hosts: [sampleOAuthApiHost],
  tools: [
    defineTool({
      name: "items.list",
      description: "Lists the items on a board",
      input: z.strictObject({ board: z.string().min(1) }),
      output: z.strictObject({ items: z.array(itemSchema) }),
      readOnly: true,
      resource: "board",
      routes: [
        {
          method: "GET",
          host: sampleOAuthApiHost,
          path: "/v1/boards/{board}/items",
        },
      ],
      run: async ({ board }) => {
        const response = await fetch(
          `${api}/v1/boards/${encodeURIComponent(board)}/items`
        );
        if (!response.ok) {
          throw new ToolError(`The app answered ${response.status}`, {
            notPerformed: response.status >= 500,
          });
        }
        const { items } = z
          .object({ items: z.array(itemSchema) })
          .parse(await response.json());
        return { output: { items }, provenance: items.map(({ id }) => id) };
      },
    }),
  ],
});
