import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { auditEvents, callAs, outcome, someone } from "./connect.ts";
import { linearMcpUrl } from "./linear-mcp-fake.ts";
import {
  addLinear,
  chatAgent,
  confirmHeld,
  connectLinear,
  linear,
  mcpInternet,
} from "./mcp-connectors-harness.ts";

// A connector made from an MCP server's URL (GRA-1375), end to end in
// workerd against a faithful fake of Linear's server: an admin adds it by
// its URL, connect registers there, a person signs in, a read the rules
// allow runs, and a write is held until its person confirms it.

mcpInternet();
const { events } = auditEvents();

describe("a connector made from Linear's MCP server URL", () => {
  it("registers, signs in, reads, and holds a write until its person confirms", async () => {
    const connector = await addLinear();
    const anna = someone();
    const connectionId = await connectLinear(connector, anna);
    const agent = chatAgent(anna);

    const read = await callAs(agent, {
      connectionId,
      action: "list_issues",
      input: {},
    });
    const held = await callAs(agent, {
      connectionId,
      action: "save_issue",
      input: { title: "Fix the sign-in", team: "Engineering" },
    });
    const callsBefore = linear.calls.filter(
      ({ method }) => method === "tools/call"
    ).length;
    const confirmed = await confirmHeld(anna, agent, {
      connectionId,
      action: "save_issue",
    });
    const [owners] = await exports.default.connectionOwners([connectionId]);
    const toolCalls = linear.calls.filter(
      ({ method }) => method === "tools/call"
    );
    const [registration] = linear.registrations;
    const [token] = [...linear.tokens.values()];
    const recorded = await events();
    const added = recorded.filter(({ action }) => action === "connector.added");

    expect({
      registrations: linear.registrations.length,
      authMethod: registration?.tokenEndpointAuthMethod,
      tokenResource: token?.resource,
      read: read.output.includes("ENG-1"),
      held: held.pending === undefined ? "ran" : "held",
      sentBeforeConfirming: callsBefore,
      confirmed: confirmed.output.includes("Fix the sign-in"),
      sent: toolCalls.map(({ name }) => name),
      created: linear.workspace.issues.some(
        ({ title }) => title === "Fix the sign-in"
      ),
      classes: {
        list_issues: owners?.toolClasses?.list_issues,
        save_issue: owners?.toolClasses?.save_issue,
      },
    }).toStrictEqual({
      registrations: 1,
      authMethod: "none",
      tokenResource: linearMcpUrl,
      read: true,
      held: "held",
      sentBeforeConfirming: 1,
      confirmed: true,
      sent: ["list_issues", "save_issue"],
      created: true,
      classes: { list_issues: "read-own", save_issue: "change-own" },
    });
    expect(added).toMatchObject([
      {
        detail: {
          host: "mcp.linear.app",
          auth: "oauth",
          connector,
          registration: "dynamic",
          outcome: "ok",
        },
      },
    ]);
  });

  it("connects again in place once it needs signing in again, and keeps no tool list once disconnected", async () => {
    const connector = await addLinear();
    const anna = someone();
    const agent = chatAgent(anna);
    const connectionId = await connectLinear(connector, anna);
    await callAs(agent, { connectionId, action: "list_issues", input: {} });
    const twice = await outcome(connectLinear(connector, anna));
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE connections SET status = 'needs_reauth' WHERE id = ?"
      ).bind(connectionId),
      env.DB.prepare(
        "DELETE FROM connection_tokens WHERE connection_id = ?"
      ).bind(connectionId),
    ]);

    const again = await connectLinear(connector, anna);
    const read = await callAs(agent, {
      connectionId,
      action: "list_issues",
      input: {},
    });
    await exports.default.disconnect({ person: anna, connectionId });
    const tools = await env.DB.prepare(
      "SELECT count(*) AS kept FROM connection_tools WHERE connection_id = ?"
    )
      .bind(connectionId)
      .first<{ kept: number }>();

    expect({
      twice,
      sameConnection: again === connectionId,
      read: read.output.includes("ENG-1"),
      toolsAfterDisconnect: tools?.kept,
    }).toStrictEqual({
      twice: "connection.already_connected",
      sameConnection: true,
      read: true,
      toolsAfterDisconnect: 0,
    });
  });

  it("keeps none of an erased person's tool lists, once their grant is revoked", async () => {
    const connector = await addLinear();
    const anna = someone();
    const connectionId = await connectLinear(connector, anna);
    await callAs(chatAgent(anna), {
      connectionId,
      action: "list_issues",
      input: {},
    });
    const kept = async () =>
      await env.DB.prepare(
        "SELECT count(*) AS tools FROM connection_tools WHERE connection_id = ?"
      )
        .bind(connectionId)
        .first<{ tools: number }>();
    const before = await kept();

    const erased = await outcome(
      exports.default.erasePersonal({ ownerUserId: anna.userId })
    );

    expect({
      before: (before?.tools ?? 0) > 0,
      erased,
      after: await kept(),
      revoked: [...linear.tokens.values()].every(({ revoked }) => revoked),
    }).toStrictEqual({
      before: true,
      erased: "ok",
      after: { tools: 0 },
      revoked: true,
    });
  });
});
