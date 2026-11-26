import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

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
import { retryable } from "./tool-calls.ts";

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
      classes: { list_issues: "read-own", save_issue: "reach-others" },
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

  it("pauses its connection for every caller when its server rate limits it, until the server's time passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const connector = await addLinear();
    const anna = someone();
    const connectionId = await connectLinear(connector, anna);
    const agent = chatAgent(anna);
    const read = async () =>
      await retryable(
        callAs(agent, { connectionId, action: "list_issues", input: {} })
      );
    await read();
    linear.next = () =>
      new Response("Too many requests", {
        status: 429,
        headers: { "retry-after": "30" },
      });
    const limited = await read();
    const callsBefore = linear.calls.length;
    const paused = await read();
    // Its tool list, gone stale meanwhile, can't be read again until then.
    await env.DB.prepare(
      "UPDATE connections SET tool_list_fresh_until = 0 WHERE id = ?"
    )
      .bind(connectionId)
      .run();
    const contract = await retryable(
      exports.default.connectorContract({
        contract: `connector.${connector}@1`,
        connectionId,
      })
    );
    const sentWhilePaused = linear.calls.length - callsBefore;
    vi.setSystemTime(Date.now() + 30_000);
    expect({
      limited,
      paused,
      contract,
      sentWhilePaused,
      after: await read(),
    }).toStrictEqual({
      limited: { code: "connect.server_unavailable" },
      paused: { code: "connect.rate_limited", retryAfterSeconds: 30 },
      contract: { code: "connect.server_unavailable", retryAfterSeconds: 30 },
      sentWhilePaused: 0,
      after: { code: "ok" },
    });
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
    // What the account signed in to now lists, while the old list is fresh.
    linear.tools = linear.tools.filter(({ name }) => name !== "list_teams");

    const again = await connectLinear(connector, anna);
    const classes = await exports.default.connectorToolClasses(connectionId);
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
      listedNow: Object.hasOwn(classes, "list_teams"),
      read: read.output.includes("ENG-1"),
      toolsAfterDisconnect: tools?.kept,
    }).toStrictEqual({
      twice: "connection.already_connected",
      sameConnection: true,
      listedNow: false,
      read: true,
      toolsAfterDisconnect: 0,
    });
  });

  it("keeps no tool list that comes back after its connection was disconnected", async () => {
    const connector = await addLinear();
    const anna = someone();
    const connectionId = await connectLinear(connector, anna);
    // The list kept as Anna connected has gone stale.
    await env.DB.prepare(
      "UPDATE connections SET tool_list_fresh_until = NULL WHERE id = ?"
    )
      .bind(connectionId)
      .run();
    // The server answers at once; its answer reaches connect only after
    // the person disconnected.
    linear.next = async (request) => {
      const answered = await linear.handle(request);
      await exports.default.disconnect({ person: anna, connectionId });
      return answered;
    };

    const classes = await exports.default.connectorToolClasses(connectionId);
    const kept = await env.DB.prepare(
      "SELECT count(*) AS kept FROM connection_tools WHERE connection_id = ?"
    )
      .bind(connectionId)
      .first<{ kept: number }>();

    expect({
      readForTheCall: Object.keys(classes).length > 0,
      kept: kept?.kept,
    }).toStrictEqual({ readForTheCall: true, kept: 0 });
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
