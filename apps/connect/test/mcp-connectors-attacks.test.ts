import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  appFor,
  auditEvents,
  callAs,
  clientOrigin,
  connectWith,
  outcome,
  someone,
} from "./connect.ts";
import { linearMcpUrl } from "./linear-mcp-fake.ts";
import {
  addLinear,
  admin,
  chatAgent,
  confirmHeld,
  connectLinear,
  dns,
  linear,
  mcpInternet,
  rpcOf,
  sent,
  servers,
  startLinear,
} from "./mcp-connectors-harness.ts";

// A connector's server and the people around it, attacked (threat model
// on GRA-1375, items 4 to 10): answers that are too large, endless or
// malformed; redirects and sign-in metadata that would carry a token
// elsewhere; tokens crossing connections and people; writes of unknown
// outcome; a server down or slow; a URL inside the network; the audit.

mcpInternet();
const { events } = auditEvents();

/** Anna's connection to Linear, its list read once: its ID and agent. */
const connected = async () => {
  const anna = someone();
  const connector = await addLinear();
  const connectionId = await connectLinear(connector, anna);
  const agent = chatAgent(anna);
  await callAs(agent, { connectionId, action: "list_issues", input: {} });
  return { anna, connector, connectionId, agent };
};

/** Requests that reached Linear's token endpoint. */
const tokenRequests = (): number =>
  sent.filter(({ url }) => url === "https://mcp.linear.app/token").length;

/**
 * An MCP server at `origin` that signs in with OAuth, its metadata as
 * `changes` make it: what an admin may point connect at.
 */
const signInServer = (
  origin: string,
  changes: {
    resourceMetadataAt?: string;
    resource?: string;
    issuer?: string;
    challengeMethods?: string[];
  } = {}
) => {
  dns.set(new URL(origin).hostname, ["34.120.10.2"]);
  servers.set(origin, (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp") {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${changes.resourceMetadataAt ?? `${origin}/.well-known/oauth-protected-resource/mcp`}"`,
        },
      });
    }
    if (pathname === "/.well-known/oauth-protected-resource/mcp") {
      return Response.json({
        resource: changes.resource ?? `${origin}/mcp`,
        authorization_servers: [origin],
      });
    }
    if (pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: changes.issuer ?? origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        code_challenge_methods_supported: changes.challengeMethods ?? ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (pathname === "/register") {
      return Response.json(
        { client_id: `client-of-${origin}` },
        { status: 201 }
      );
    }
    return new Response("Not Found", { status: 404 });
  });
  return `${origin}/mcp`;
};

/** An MCP server that takes a fixed key in `x-api-key`, with one read. */
const keyServer = (origin: string, key: string): string => {
  dns.set(new URL(origin).hostname, ["34.120.10.3"]);
  servers.set(origin, async (request) => {
    if (request.headers.get("x-api-key") !== key) {
      return new Response(null, { status: 401 });
    }
    const { id, method } = await rpcOf(request);
    const result =
      method === "tools/list"
        ? {
            resultType: "complete",
            ttlMs: 300_000,
            tools: [
              {
                name: "list_notes",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }
        : {
            resultType: "complete",
            content: [{ type: "text", text: "[]" }],
          };
    return Response.json({ jsonrpc: "2.0", id, result });
  });
  return `${origin}/mcp`;
};

/** Adds the server at `url` as a connector signing in with OAuth. */
const addServer = async (url: string, person = admin()) =>
  await exports.default.addConnector({
    person,
    name: "A server",
    url,
    origin: clientOrigin,
    auth: { kind: "oauth" },
  });

describe("a connector's server", () => {
  it("is cut off for an answer too large, malformed, or of another request", async () => {
    const { connectionId, agent } = await connected();
    const read = async () =>
      await outcome(
        callAs(agent, { connectionId, action: "list_issues", input: {} })
      );
    linear.next = () =>
      new Response(
        `{"jsonrpc":"2.0","id":2,"result":"${"x".repeat(2 * 1024 * 1024)}"}`,
        {
          headers: { "content-type": "application/json" },
        }
      );
    const large = await read();
    linear.next = () =>
      new Response("{ not json", {
        headers: { "content-type": "application/json" },
      });
    const garbage = await read();
    linear.next = () =>
      new Response("<html><body>Bad gateway</body></html>", {
        headers: { "content-type": "text/html" },
      });
    const html = await read();
    linear.next = async (request) => {
      const { id } = await rpcOf(request);
      return Response.json({
        jsonrpc: "2.0",
        id: id + 1,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: "[]" }],
        },
      });
    };
    const otherId = await read();
    linear.next = async (request) => {
      const { id } = await rpcOf(request);
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: { resultType: "input_required", inputRequests: {} },
      });
    };
    const incomplete = await read();

    expect({ large, garbage, html, otherId, incomplete }).toStrictEqual({
      large: "connect.server_unavailable",
      garbage: "connect.server_unavailable",
      html: "connect.server_unavailable",
      otherId: "connect.server_unavailable",
      incomplete: "connect.server_unavailable",
    });
  });

  it("isn't read when it lists more tools than connect reads", async () => {
    linear.tools = Array.from({ length: 501 }, (_, index) => ({
      name: `list_things_${index}`,
      inputSchema: { type: "object", properties: {} },
    }));
    const anna = someone();
    const connectionId = await connectLinear(await addLinear(), anna);

    await expect(
      outcome(
        callAs(chatAgent(anna), {
          connectionId,
          action: "list_things_1",
          input: {},
        })
      )
    ).resolves.toBe("connect.server_unavailable");
  });

  it("ends an answer that never ends at the call's deadline", async () => {
    const { connectionId, agent } = await connected();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const before = sent.length;
    linear.next = (request) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode(": still here\n\n"));
            request.signal.addEventListener("abort", () => {
              controller.error(request.signal.reason);
            });
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    const call = outcome(
      callAs(
        agent,
        { connectionId, action: "list_issues", input: {} },
        {},
        // In this test's own context, where its fake timers run.
        connectWith({})
      )
    ).finally(() => {
      settled = true;
    });
    while (sent.length === before) {
      // oxlint-disable-next-line no-await-in-loop -- waiting on the request
      await scheduler.wait(5);
    }
    vi.advanceTimersByTime(30_000 - 1000);
    await scheduler.wait(50);
    const beforeDeadline = settled;
    vi.advanceTimersByTime(1000);

    await expect(call).resolves.toBe("connect.server_unavailable");
    expect(beforeDeadline).toBeFalsy();
  });

  it("fails a read at the deadline when it never answers, and on a 503, with nothing held or claimed", async () => {
    const { anna, connectionId, agent } = await connected();
    linear.next = () => new Response("Service Unavailable", { status: 503 });
    const unavailable = await outcome(
      callAs(agent, { connectionId, action: "list_issues", input: {} })
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    linear.down = true;
    const before = sent.length;
    const call = outcome(
      callAs(
        agent,
        { connectionId, action: "list_issues", input: {} },
        {},
        connectWith({})
      )
    );
    while (sent.length === before) {
      // oxlint-disable-next-line no-await-in-loop -- waiting on the request
      await scheduler.wait(5);
    }
    vi.advanceTimersByTime(30_000);

    expect({
      unavailable,
      down: await call,
      held: await exports.default.listPendingActions(anna, "grasp"),
    }).toStrictEqual({
      unavailable: "connect.server_unavailable",
      down: "connect.server_unavailable",
      held: [],
    });
  });

  it("takes a write that went out as of unknown outcome, whatever it says, and never sends it again", async () => {
    const { anna, connectionId } = await connected();
    const app = appFor(anna.userId);
    const write = (idempotencyKey: string) => ({
      connectionId,
      action: "save_issue",
      input: { title: `Fix ${idempotencyKey}`, team: "Engineering" },
      idempotencyKey,
    });
    await callAs(app, { connectionId, action: "list_issues", input: {} });
    // The server takes it, then the connection drops.
    linear.next = async (request) => {
      await linear.handle(request);
      throw new TypeError("Network connection lost.");
    };
    const dropped = await outcome(callAs(app, write("run-1:save")));
    const sentAfterDrop = linear.calls.filter(
      ({ name }) => name === "save_issue"
    ).length;
    const again = await outcome(callAs(app, write("run-1:save")));
    const sentAgain =
      linear.calls.filter(({ name }) => name === "save_issue").length -
      sentAfterDrop;
    linear.next = async (request) => {
      const { id } = await rpcOf(request);
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          isError: true,
          content: [{ type: "text", text: "Nothing was done." }],
          _meta: { "grasp.dev/notPerformed": true },
        },
      });
    };
    const claimsNothing = await outcome(callAs(app, write("run-2:save")));

    expect({
      dropped,
      again,
      sentAgain,
      claimsNothing,
    }).toStrictEqual({
      dropped: "connect.outcome_unknown",
      again: "connect.outcome_unknown",
      sentAgain: 0,
      claimsNothing: "connect.outcome_unknown",
    });
  });

  it("never follows a redirect, so the token goes nowhere else", async () => {
    const { anna, connectionId, agent } = await connected();
    linear.next = () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://collector.example/steal" },
      });
    const read = await outcome(
      callAs(agent, { connectionId, action: "list_issues", input: {} })
    );
    linear.next = () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://collector.example/steal" },
      });
    await callAs(agent, {
      connectionId,
      action: "save_issue",
      input: { title: "Fix the redirect", team: "Engineering" },
    });
    const confirmed = await outcome(
      confirmHeld(anna, agent, { connectionId, action: "save_issue" })
    );

    expect({
      read,
      confirmed,
      collector: sent.filter(({ url }) =>
        url.startsWith("https://collector.example")
      ),
    }).toStrictEqual({
      read: "connect.server_unavailable",
      confirmed: "connect.outcome_unknown",
      collector: [],
    });
  });

  it("refuses sign-in metadata that leads anywhere but the server and its own issuer", async () => {
    const elsewhere = signInServer("https://mcp.one.example", {
      resourceMetadataAt:
        "https://metadata.other.example/.well-known/oauth-protected-resource",
    });
    const otherResource = signInServer("https://mcp.two.example", {
      resource: "https://mcp.linear.app/mcp",
    });
    const otherIssuer = signInServer("https://mcp.three.example", {
      issuer: "https://login.other.example",
    });
    const plainPkce = signInServer("https://mcp.four.example", {
      challengeMethods: ["plain"],
    });
    const fine = signInServer("https://mcp.five.example");

    expect({
      elsewhere: await outcome(addServer(elsewhere)),
      otherResource: await outcome(addServer(otherResource)),
      otherIssuer: await outcome(addServer(otherIssuer)),
      plainPkce: await outcome(addServer(plainPkce)),
      fine: await outcome(addServer(fine)),
      fetchedElsewhere: sent.some(({ url }) => url.includes("other.example")),
    }).toStrictEqual({
      elsewhere: "connection.sign_in_unsupported",
      otherResource: "connection.sign_in_unsupported",
      otherIssuer: "connection.sign_in_unsupported",
      plainPkce: "connection.sign_in_unsupported",
      fine: "ok",
      fetchedElsewhere: false,
    });
  });

  it("redeems no code from another issuer, without the issuer it promised, or for another person", async () => {
    const connector = await addLinear();
    const anna = someone();
    const bob = someone();
    const finish = async (iss: string | null, person = anna) => {
      const consent = linear.consent(await startLinear(connector, anna), {
        iss,
      });
      return await outcome(
        exports.default.finishConnection({
          person,
          state: consent.state,
          code: consent.code,
          ...(consent.iss === undefined ? {} : { iss: consent.iss }),
        })
      );
    };

    expect({
      otherIssuer: await finish("https://login.other.example"),
      noIssuer: await finish(null),
      otherPerson: await finish("https://mcp.linear.app", bob),
      tokenRequests: tokenRequests(),
    }).toStrictEqual({
      otherIssuer: "connection.provider_refused",
      noIssuer: "connection.provider_refused",
      otherPerson: "connection.flow_invalid",
      tokenRequests: 0,
    });
  });

  it("sends an x-mcp-header value only in its own Mcp-Param header, and offers no tool whose header can't be sent", async () => {
    linear.tools = [
      ...linear.tools,
      {
        name: "get_project",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", "x-mcp-header": "Authorization" },
          },
        },
      },
      {
        name: "get_cycle",
        inputSchema: {
          type: "object",
          properties: {
            cycle: { type: "string", "x-mcp-header": "X-Cycle\r\nHost" },
          },
        },
      },
    ];
    const { connectionId, agent } = await connected();
    // The fake has no handler for it: its error answer doesn't matter here.
    await outcome(
      callAs(agent, {
        connectionId,
        action: "get_project",
        input: { project: "Bearer stolen" },
      })
    );
    const call = linear.calls.find(({ name }) => name === "get_project");
    const [owner] = await exports.default.connectionOwners([connectionId]);

    expect({
      param: call?.headers["mcp-param-authorization"],
      authorization:
        call?.authorization?.startsWith("Bearer ") === true &&
        call.authorization !== "Bearer stolen",
      get_cycle: owner?.toolClasses?.get_cycle,
      cycle: await outcome(
        callAs(agent, {
          connectionId,
          action: "get_cycle",
          input: { cycle: "1" },
        })
      ),
    }).toStrictEqual({
      param: "Bearer stolen",
      authorization: true,
      get_cycle: undefined,
      cycle: "connect.action_not_found",
    });
  });

  it("serves a personal connection to its owner alone, and each connector's credential to its own server alone", async () => {
    const { connectionId } = await connected();
    const bob = someone();
    const notes = keyServer("https://mcp.notes.example", "notes-key");
    const { id: notesConnector } = await exports.default.addConnector({
      person: admin(),
      name: "Notes",
      url: notes,
      origin: clientOrigin,
      auth: { kind: "header", header: "X-Api-Key" },
    });
    const { connectionId: notesConnection } =
      await exports.default.connectWithKey({
        person: bob,
        provider: notesConnector,
        scope: "personal",
        key: "notes-key",
      });
    const bobsRead = await callAs(chatAgent(bob), {
      connectionId: notesConnection,
      action: "list_notes",
      input: {},
    });
    const toLinear = sent.filter(({ url }) =>
      url.startsWith("https://mcp.linear.app/mcp")
    );
    const toNotes = sent.filter(({ url }) =>
      url.startsWith("https://mcp.notes.example")
    );

    expect({
      colleague: await outcome(
        callAs(chatAgent(bob), {
          connectionId,
          action: "list_issues",
          input: {},
        })
      ),
      bobsRead: bobsRead.output,
      keyAtLinear: toLinear.some(
        ({ headers }) => headers["x-api-key"] !== undefined
      ),
      tokenAtNotes: toNotes.some(
        ({ headers }) => headers.authorization !== undefined
      ),
      member: await outcome(addServer(linearMcpUrl, someone("user"))),
      staff: await outcome(
        addServer(linearMcpUrl, { ...admin(), staff: true })
      ),
    }).toStrictEqual({
      colleague: "connect.not_owner",
      bobsRead: JSON.stringify("[]"),
      keyAtLinear: false,
      tokenAtNotes: false,
      member: "role.forbidden",
      staff: "connection.staff_not_allowed",
    });
  });

  it("is added only at a public https name", async () => {
    dns.set("inside.example", ["10.0.0.7"]);
    const add = async (url: string) => await outcome(addServer(url));

    expect({
      http: await add("http://mcp.linear.app/mcp"),
      address: await add("https://34.120.10.1/mcp"),
      v6: await add("https://[2001:db8::1]/mcp"),
      userInfo: await add("https://user@mcp.linear.app/mcp"),
      inside: await add("https://inside.example/mcp"),
      unknown: await add("https://nowhere.example/mcp"),
      registered: linear.registrations.length,
    }).toStrictEqual({
      http: "connection.invalid",
      address: "connection.server_refused",
      v6: "connection.server_refused",
      userInfo: "connection.server_refused",
      inside: "connection.server_refused",
      unknown: "connection.server_refused",
      registered: 0,
    });
  });

  it("is added with one event saying who, where and how it registered", async () => {
    const person = admin();
    const connector = await addLinear(person);
    const refused = await outcome(addLinear(someone("user")));
    const recorded = await events();
    const added = recorded.filter(({ action }) => action === "connector.added");

    expect(refused).toBe("role.forbidden");
    expect(added).toMatchObject([
      {
        actor: { userId: person.userId },
        detail: {
          host: "mcp.linear.app",
          auth: "oauth",
          connector,
          registration: "dynamic",
          outcome: "ok",
        },
      },
      { detail: { outcome: "refused", reason: "role.forbidden" } },
    ]);
    expect(added).toHaveLength(2);
  });
});
