/**
 * The source of a connector made from an MCP server's URL: one
 * `defineConnector` with its name, title and server, and nothing else.
 * Core generates it from what an admin entered, once each field is
 * checked, and builds it with the `connector` target (connector.ts).
 * Connect keeps a version only when its source is exactly this, generated
 * from the fields of the manifest its code makes: until a person approves
 * a connector's code (GRA-1378), none written by a person or an agent is
 * ever stored or run.
 *
 * Each value goes in as a JSON string literal, which is a JavaScript one
 * (ECMAScript's JSON superset), so no text an admin typed is ever code;
 * the URL as the URL parser writes it.
 */

/** The fields a connector made from a URL is generated from. */
export interface McpConnectorFields {
  name: string;
  title: string;
  mcp: {
    url: string;
    registration: "dcr" | "client" | { header: string };
    network?: "company";
  };
}

/** The module path a generated connector's source is built at. */
export const mcpConnectorEntry = "connector.ts";

const literal = (value: string): string => JSON.stringify(value);

/** The source of the connector `fields` describe. */
export const mcpConnectorSource = ({
  name,
  title,
  mcp,
}: McpConnectorFields): string => {
  const registration =
    typeof mcp.registration === "string"
      ? literal(mcp.registration)
      : `{ header: ${literal(mcp.registration.header)} }`;
  // Its own words, never the value it was given: only this one is taken.
  const network = mcp.network === "company" ? ', network: "company"' : "";
  return `import { defineConnector } from "@grasp-os/sdk/connector";

export default defineConnector({
  name: ${literal(name)},
  title: ${literal(title)},
  mcp: { url: ${literal(new URL(mcp.url).href)}, registration: ${registration}${network} },
});
`;
};
