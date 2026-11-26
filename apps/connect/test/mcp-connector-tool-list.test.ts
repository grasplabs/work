import { isRecord } from "@grasp-os/shared/json";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { connections } from "../src/db/schema.ts";
import { currentTools } from "../src/mcp-connectors.ts";
import { appFor, auditEvents, callAs, outcome, someone } from "./connect.ts";
import { linearOrigin } from "./linear-mcp-fake.ts";
import type { LinearTool } from "./linear-mcp-fake.ts";
import {
  addLinear,
  admin,
  chatAgent,
  connectLinear,
  linear,
  mcpInternet,
  rpcOf,
  sent,
} from "./mcp-connectors-harness.ts";

// A connector's server changing its tool list, attacked (threat model on
// GRA-2306, MC2 and MC5; GRA-2347): a new or changed tool is callable at
// once when its class is on, so every change of a list is audited, an
// admin can see a connector's tools and block one, and a server can't make
// connect read its list on every call. Where people sign in is shown.

mcpInternet();
const { events } = auditEvents();

/** A tool the server lists, with no input unless `changes` give one. */
const tool = (name: string, changes: Partial<LinearTool> = {}): LinearTool => ({
  name,
  description: `The ${name} tool.`,
  inputSchema: { type: "object", properties: {} },
  ...changes,
});

/** Anna's connection to Linear, its list read once. */
const connected = async () => {
  const anna = someone();
  const connector = await addLinear();
  const connectionId = await connectLinear(connector, anna);
  const agent = chatAgent(anna);
  await callAs(agent, { connectionId, action: "list_issues", input: {} });
  return { anna, connector, connectionId, agent };
};

/** Ends the kept list's freshness, as its `ttlMs` running out would. */
const listExpires = async (connectionId: string): Promise<void> => {
  await env.DB.prepare(
    "UPDATE connections SET tool_list_fresh_until = 0 WHERE id = ?"
  )
    .bind(connectionId)
    .run();
};

/** The events recorded of `action`, as who, what and the detail. */
const recorded = async (action: string) => {
  const all = await events();
  return all
    .filter((event) => event.action === action)
    .map(({ actor, target, detail }) => ({ actor, target, detail }));
};

/** The names of the tools a race's reads added, as in `list`. */
const added = (list: readonly { name: string }[]): string[] =>
  list.flatMap(({ name }) => (name.startsWith("get_status_") ? [name] : []));

/** How many times Linear's server was asked for its list. */
const listReads = (): number =>
  linear.calls.filter(({ method }) => method === "tools/list").length;

/**
 * Reads `connectionId`'s list twice at once, in one request (workerd lets
 * only one request hold another up): both ask before either is answered,
 * and each is answered with a list of its own, adding `get_status_1` or
 * `get_status_2`. What each read returned, and what is kept after.
 */
const twoReadsAtOnce = async (connectionId: string) => {
  const before = linear.tools;
  const serve = vi.mocked(globalThis.fetch).getMockImplementation();
  const bothAsked = Promise.withResolvers<boolean>();
  const firstAnswered = Promise.withResolvers<boolean>();
  let asked = 0;
  let answered = 0;
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { origin } = new URL(request.url);
    const rpc =
      origin === linearOrigin && request.method === "POST"
        ? await rpcOf(request)
        : undefined;
    if (serve === undefined) {
      throw new Error("Expected the internet to be stood up");
    }
    if (rpc?.method !== "tools/list" || asked >= 2) {
      return await serve(request);
    }
    asked += 1;
    if (asked === 2) {
      bothAsked.resolve(true);
    }
    await bothAsked.promise;
    answered += 1;
    const answer = answered;
    if (answer === 2) {
      await firstAnswered.promise;
    }
    linear.tools = [...before, tool(`get_status_${String(answer)}`)];
    const response = await serve(request);
    firstAnswered.resolve(true);
    return response;
  });
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (connection === undefined) {
    throw new Error("Expected the connection");
  }
  const lists = await Promise.all([
    currentTools(env, connection),
    currentTools(env, connection),
  ]);
  const { results: kept } = await env.DB.prepare(
    "SELECT name FROM connection_tools WHERE connection_id = ?"
  )
    .bind(connectionId)
    .all<{ name: string }>();
  return { asked, calledBy: lists.map(added), kept: added(kept) };
};

describe("a connector's tool list", () => {
  it("is audited once for each list kept that differs from the last, its first included, with counts, and not when unchanged but reordered", async () => {
    const { connector, connectionId, agent } = await connected();
    const { results: first } = await env.DB.prepare(
      "SELECT name FROM connection_tools WHERE connection_id = ?"
    )
      .bind(connectionId)
      .all<{ name: string }>();
    linear.tools = [
      ...linear.tools.filter(
        ({ name }) => name !== "get_issue" && name !== "list_comments"
      ),
      tool("get_status"),
      tool("get_cycle"),
      tool("list_comments", {
        inputSchema: { type: "object", properties: { to: { type: "string" } } },
      }),
    ];
    await listExpires(connectionId);
    await callAs(agent, { connectionId, action: "list_issues", input: {} });
    linear.tools = linear.tools.toReversed().map((listed) => ({
      ...Object.fromEntries(Object.entries(listed).toReversed()),
      name: listed.name,
      inputSchema: isRecord(listed.inputSchema)
        ? Object.fromEntries(Object.entries(listed.inputSchema).toReversed())
        : listed.inputSchema,
    }));
    await listExpires(connectionId);
    await callAs(agent, { connectionId, action: "list_issues", input: {} });
    const event = (counts: Record<string, boolean | number>) => ({
      actor: { type: "system" },
      target: { type: "connection", id: connectionId },
      detail: { connector, ...counts },
    });

    await expect(recorded("connector.tools.changed")).resolves.toStrictEqual([
      event({
        first: true,
        added: first.length,
        removed: 0,
        changed: 0,
        reclassed: 0,
      }),
      event({ first: false, added: 2, removed: 1, changed: 1, reclassed: 1 }),
    ]);
  });

  it("is kept, and its change recorded, by one of two reads at once, and both call by the list kept", async () => {
    const { connectionId } = await connected();
    const before = await recorded("connector.tools.changed");
    await listExpires(connectionId);
    const { asked, calledBy, kept } = await twoReadsAtOnce(connectionId);
    const changes = await recorded("connector.tools.changed");

    expect({
      asked,
      calledBy,
      changes: changes.slice(before.length).map(({ detail }) => detail),
    }).toStrictEqual({
      asked: 2,
      calledBy: [kept, kept],
      changes: [expect.objectContaining({ added: 1, removed: 0 })],
    });
  });

  it("is kept and recorded by one of two first reads at once, and both call by the list kept", async () => {
    const { connectionId } = await connected();
    // As connecting again leaves it: no list read yet.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE connections SET tool_list_read_at = NULL, tool_list_fresh_until = NULL WHERE id = ?"
      ).bind(connectionId),
      env.DB.prepare(
        "DELETE FROM connection_tools WHERE connection_id = ?"
      ).bind(connectionId),
    ]);
    const before = await recorded("connector.tools.changed");
    const { asked, calledBy, kept } = await twoReadsAtOnce(connectionId);
    const changes = await recorded("connector.tools.changed");

    expect({
      asked,
      calledBy,
      kept: kept.length,
      changes: changes.length - before.length,
    }).toStrictEqual({
      asked: 2,
      calledBy: [kept, kept],
      kept: 1,
      changes: 1,
    });
  });

  it("refuses a call of a tool blocked while its list was read, and sends it nothing", async () => {
    const { connector, connectionId, agent } = await connected();
    await listExpires(connectionId);
    const serve = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const { origin } = new URL(request.url);
      const rpc =
        origin === linearOrigin && request.method === "POST"
          ? await rpcOf(request)
          : undefined;
      // The admin blocks it while connect waits for the list.
      if (rpc?.method === "tools/list") {
        await exports.default.blockConnectorTool({
          person: admin(),
          connector,
          tool: "list_issues",
          blocked: true,
        });
      }
      if (serve === undefined) {
        throw new Error("Expected the internet to be stood up");
      }
      return await serve(request);
    });
    const callsBefore = linear.calls.filter(
      ({ method }) => method === "tools/call"
    ).length;
    const refused = await outcome(
      callAs(agent, { connectionId, action: "list_issues", input: {} })
    );

    expect({
      refused,
      listRead: listReads() > 0,
      sent:
        linear.calls.filter(({ method }) => method === "tools/call").length -
        callsBefore,
    }).toStrictEqual({
      refused: "connect.tool_blocked",
      listRead: true,
      sent: 0,
    });
  });

  it("refuses a write blocked while its list was read, sends it nothing, and leaves its key free", async () => {
    const { anna, connector, connectionId } = await connected();
    const app = appFor(anna.userId);
    const save = {
      connectionId,
      action: "save_issue",
      input: { title: "Fix it", team: "Engineering" },
      idempotencyKey: "run-1:save",
    };
    await listExpires(connectionId);
    const serve = vi.mocked(globalThis.fetch).getMockImplementation();
    if (serve === undefined) {
      throw new Error("Expected the internet to be stood up");
    }
    let blocking = true;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const { origin } = new URL(request.url);
      const rpc =
        origin === linearOrigin && request.method === "POST"
          ? await rpcOf(request)
          : undefined;
      // The admin blocks it after connect checked it first, while its
      // list is read.
      if (blocking && rpc?.method === "tools/list") {
        blocking = false;
        await exports.default.blockConnectorTool({
          person: admin(),
          connector,
          tool: "save_issue",
          blocked: true,
        });
      }
      return await serve(request);
    });
    const refused = await outcome(callAs(app, save));
    await exports.default.blockConnectorTool({
      person: admin(),
      connector,
      tool: "save_issue",
      blocked: false,
    });
    const again = await outcome(callAs(app, save));

    expect({
      refused,
      again,
      sent: linear.calls.filter(({ name }) => name === "save_issue").length,
    }).toStrictEqual({ refused: "connect.tool_blocked", again: "ok", sent: 1 });
  });

  it("is read again no sooner than a minute later, whatever the server says", async () => {
    linear.ttlMs = 0;
    const { connectionId, agent } = await connected();
    const reads = listReads();
    await callAs(agent, { connectionId, action: "list_issues", input: {} });
    const row = await env.DB.prepare(
      "SELECT tool_list_fresh_until - tool_list_read_at AS fresh FROM connections WHERE id = ?"
    )
      .bind(connectionId)
      .first<{ fresh: number }>();

    expect({
      fresh: row?.fresh,
      readsSince: listReads() - reads,
    }).toStrictEqual({ fresh: 60 * 1000, readsSince: 0 });
  });
});

describe("a tool an admin blocked", () => {
  it("is refused before anything goes out, offered to nobody, and runs again once let through", async () => {
    const { connector, connectionId, agent } = await connected();
    const ada = admin();
    const block = async (blocked: boolean) => {
      await exports.default.blockConnectorTool({
        person: ada,
        connector,
        tool: "list_issues",
        blocked,
      });
    };
    await block(true);
    await block(true);
    const sentBefore = sent.length;
    const refused = await outcome(
      callAs(agent, { connectionId, action: "list_issues", input: {} })
    );
    await listExpires(connectionId);
    const refusedStale = await outcome(
      callAs(agent, { connectionId, action: "list_issues", input: {} })
    );
    const sentWhileBlocked = sent.length - sentBefore;
    const classesNow = await exports.default.connectorToolClasses(connectionId);
    const [owner] = await exports.default.connectionOwners([connectionId]);
    const { actions } = await exports.default.connectorContract({
      contract: `connector.${connector}@1`,
      connectionId,
    });
    const shape = await outcome(
      exports.default.actionShape({ connectionId, action: "list_issues" })
    );
    const searched = await exports.default.connectionTools({ connectionId });
    const described = await exports.default.connectionTools({
      connectionId,
      actions: ["list_issues"],
    });
    const seen = await exports.default.connectorTools({
      person: admin(),
      connector,
    });
    const listIssues = seen.find(({ name }) => name === "list_issues");
    const blockedEvents = await recorded("connector.tool.blocked");
    await block(false);
    const after = await callAs(agent, {
      connectionId,
      action: "list_issues",
      input: {},
    });

    expect({
      refused,
      refusedStale,
      sentWhileBlocked,
      classesNow: classesNow.list_issues,
      owner: owner?.toolClasses?.list_issues,
      inContract: Object.hasOwn(actions, "list_issues"),
      searched: searched.some(({ name }) => name === "list_issues"),
      described: described.length,
      shape,
      seen: {
        class: listIssues?.class,
        blocked: listIssues?.blocked,
        described: typeof listIssues?.description === "string",
      },
      after: after.output.includes("ENG-1"),
      blocked: blockedEvents.length,
      unblocked: await recorded("connector.tool.unblocked"),
    }).toStrictEqual({
      refused: "connect.tool_blocked",
      refusedStale: "connect.tool_blocked",
      sentWhileBlocked: 0,
      classesNow: undefined,
      owner: undefined,
      inContract: false,
      searched: false,
      described: 0,
      shape: "connect.action_not_found",
      seen: { class: "read-company", blocked: true, described: true },
      after: true,
      blocked: 1,
      unblocked: [
        {
          actor: { type: "person", userId: ada.userId },
          target: undefined,
          detail: { connector, tool: "list_issues", outcome: "ok" },
        },
      ],
    });
  });

  it("can be blocked before its server lists it, and is then never offered", async () => {
    const { connector, connectionId, agent } = await connected();
    await exports.default.blockConnectorTool({
      person: admin(),
      connector,
      tool: "get_status",
      blocked: true,
    });
    const before = await exports.default.connectorTools({
      person: admin(),
      connector,
    });
    linear.tools = [...linear.tools, tool("get_status")];
    await listExpires(connectionId);
    const refused = await outcome(
      callAs(agent, { connectionId, action: "get_status", input: {} })
    );
    const classes = await exports.default.connectorToolClasses(connectionId);

    expect({
      before: before.find(({ name }) => name === "get_status"),
      refused,
      offered: Object.hasOwn(classes, "get_status"),
      called: linear.calls.some(({ name }) => name === "get_status"),
    }).toStrictEqual({
      before: {
        name: "get_status",
        description: null,
        class: null,
        blocked: true,
      },
      refused: "connect.tool_blocked",
      offered: false,
      called: false,
    });
  });

  it("is blocked only by an admin who isn't Grasp staff, and the tools are read only by an admin", async () => {
    const { connector } = await connected();
    const request = { connector, tool: "list_issues", blocked: true };
    const block = async (changes: object) =>
      await outcome(
        exports.default.blockConnectorTool({
          ...request,
          person: admin(),
          ...changes,
        })
      );
    const member = await block({ person: someone() });
    const staff = await block({ person: { ...admin(), staff: true } });
    const unknown = await block({ connector: `mcp_${"0".repeat(32)}` });
    const bad = await block({ tool: "list issues" });
    const memberReads = await outcome(
      exports.default.connectorTools({ person: someone(), connector })
    );
    const attempts = await recorded("connector.tool.blocked");

    expect({
      member,
      staff,
      unknown,
      bad,
      memberReads,
      done: attempts.filter(({ detail }) => detail?.outcome === "ok").length,
    }).toStrictEqual({
      member: "role.forbidden",
      staff: "connection.staff_not_allowed",
      unknown: "connect.catalog_entry_not_found",
      bad: "connection.invalid",
      memberReads: "role.forbidden",
      done: 0,
    });
  });
});

describe("a connector's catalog entry", () => {
  it("names the host its people sign in at", async () => {
    const connector = await addLinear();
    const { entries } = await exports.default.catalog();

    expect(entries.find(({ id }) => id === connector)?.signInHost).toBe(
      "mcp.linear.app"
    );
  });
});
