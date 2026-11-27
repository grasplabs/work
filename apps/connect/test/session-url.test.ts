import { describe, expect, it } from "vite-plus/test";

import { sessionUrlProblem, urlShape } from "../src/connections.ts";

// Which MCP URL of a Composio session connect stores and calls
// (`sessionUrlProblem`): HTTPS on Composio's API host, no credentials, at
// a path naming that session's own ID, no user or account in its query.
// Composio's docs never write the URL out; the shapes are those a live
// answer and Composio's own code show. A refused one is logged by its
// shape alone (`urlShape`).

const id = "trs_1a2b3c4d5e6f";

/** The session's URL with a username and password in it. */
const withCredentials = new URL(
  `https://backend.composio.dev/tool_router/${id}/mcp`
);
withCredentials.username = "someone";
withCredentials.password = "anything";

describe("a Composio session's MCP URL", () => {
  it("is taken in each shape Composio answers, for its own session", () => {
    expect(
      [
        `https://backend.composio.dev/tool_router/${id}/mcp`,
        `https://backend.composio.dev/api/v3/tool_router/session/${id}/mcp`,
        `https://backend.composio.dev/api/v3.1/tool_router/session/${id}/mcp`,
      ].map((url) => sessionUrlProblem(url, id))
    ).toStrictEqual([undefined, undefined, undefined]);
  });

  it("is refused off Composio's host, over plain HTTP, with credentials, for another session, off the session's path, or naming a user or account", () => {
    expect(
      Object.fromEntries(
        Object.entries({
          otherHost: `https://mcp.attacker.example/tool_router/${id}/mcp`,
          lookalike: `https://backend.composio.dev.attacker.example/tool_router/${id}/mcp`,
          plainHttp: `http://backend.composio.dev/tool_router/${id}/mcp`,
          credentials: withCredentials.href,
          otherSession:
            "https://backend.composio.dev/tool_router/trs_other/mcp",
          otherPath: `https://backend.composio.dev/api/v3/connected_accounts/${id}/mcp`,
          nested: `https://backend.composio.dev/tool_router/${id}/mcp/extra`,
          legacy: `https://backend.composio.dev/v3/mcp/${id}?user_id=grasp`,
          user: `https://backend.composio.dev/tool_router/${id}/mcp?user_id=someone`,
          account: `https://backend.composio.dev/tool_router/${id}/mcp?connected_account_id=ca_1`,
          unparsable: "not a url",
        }).map(([name, url]) => [name, sessionUrlProblem(url, id)])
      )
    ).toStrictEqual({
      otherHost: "host",
      lookalike: "host",
      plainHttp: "host",
      credentials: "host",
      otherSession: "path",
      otherPath: "path",
      nested: "path",
      legacy: "path",
      user: "user",
      account: "user",
      unparsable: "host",
    });
  });

  it("is logged by its shape alone: its host, its path's IDs written as such, and its query's names", () => {
    expect(
      urlShape(
        `https://backend.composio.dev/tool_router/${id}/mcp?user_id=someone&key=s3cret`
      )
    ).toStrictEqual({
      host: "https://backend.composio.dev",
      path: "/tool_router/:id/mcp",
      query: "user_id,key",
    });
  });
});
