import { connectErrors } from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { prepareBuiltIn } from "../src/connector-providers.ts";
import { connections } from "../src/db/schema.ts";
import { connectorAction, currentTools } from "../src/mcp-connectors.ts";
import { disconnect, finishConnection } from "../src/oauth.ts";
import { retryRevocations } from "../src/revocations.ts";
import {
  auditEvents,
  callAs,
  clientOrigin,
  outcome,
  runMaintenance,
  someone,
} from "./connect.ts";
import type { Call } from "./connect.ts";
import { sampleTrackerOrigin } from "./fixtures/sample-mcp-key-connector.ts";
import {
  admin,
  generatedConnector,
  chatAgent,
  confirmHeld,
  connectLinear,
  linearItself,
  keyServer,
  mcpInternet,
  sent,
  servers,
  startLinear,
} from "./mcp-connectors-harness.ts";
import { racingDb, racingRead } from "./racing-db.ts";

// A built-in of the release that serves its vendor's MCP server
// (`defineConnector`'s `mcp`): Linear (packages/connectors/linear) at
// Linear's own server, connect's faithful fake. It is in the catalog by
// its name, connected by the same start as a connector made from a URL,
// its sign-in learned and Grasp registered there on its first connection,
// and its tools classed by the rules. The ways it can fail: two first
// connections at once each keeping a client of their own; an admin adding
// its server again by hand, or a connector made from a URL holding it
// already; a row kept for a server the release no longer names.

mcpInternet();
const audit = auditEvents();

/**
 * Makes the built-in Linear's row look made for another URL, as an
 * earlier release moves it: its URL and client, never its `server`.
 */
const madeForAnotherUrl = async (): Promise<void> => {
  await env.DB.prepare(
    "UPDATE connectors SET url = ?1, client_id = ?2 WHERE id = ?3"
  )
    .bind("https://mcp.linear-old.example/mcp", "old-client", "linear")
    .run();
};

/**
 * Parks the built-in Linear's connections the file's earlier tests made:
 * disconnected, with no tokens or owed revokes, so a test counts its own.
 */
const parkEarlierLinears = async (): Promise<void> => {
  const ofLinear =
    "SELECT id FROM connections WHERE server_kind = 'connector' AND server = 'linear'";
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM token_revocations WHERE connection_id IN (${ofLinear})`
    ),
    env.DB.prepare(
      `DELETE FROM connection_tokens WHERE connection_id IN (${ofLinear})`
    ),
    env.DB.prepare(
      `UPDATE connections SET status = 'disconnected' WHERE id IN (${ofLinear})`
    ),
  ]);
};

/** Where the catalog says people sign in to the built-in Linear. */
const linearSignInHost = async (): Promise<string | undefined> => {
  const { entries } = await exports.default.catalog();
  return entries.find(({ id }) => id === "linear")?.signInHost;
};

/** A table's columns, as `"name"` each. */
const columnsOf = async (table: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    `SELECT name FROM pragma_table_info('${table}')`
  ).all<{ name: string }>();
  return results.map(({ name }) => `"${name}"`);
};

/** `columns` to select, each as it is but those `given` a value. */
const values = (columns: string[], given: Record<string, string>): string =>
  columns.map((column) => given[column] ?? column).join(", ");

/**
 * Connection `id` again, with its tokens, as another person's: a
 * connection made through the same row just now. Its ID.
 */
const madeAgain = async (id: string): Promise<string> => {
  const copy = crypto.randomUUID();
  const owner = `user-${crypto.randomUUID()}`;
  const connectionColumns = await columnsOf("connections");
  const tokenColumns = await columnsOf("connection_tokens");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO connections (${connectionColumns.join(", ")}) SELECT ${values(connectionColumns, { '"id"': "?1", '"owner_user_id"': "?2", '"account_id"': "?2" })} FROM connections WHERE id = ?3`
    ).bind(copy, owner, id),
    env.DB.prepare(
      `INSERT INTO connection_tokens (${tokenColumns.join(", ")}) SELECT ${values(tokenColumns, { '"connection_id"': "?1" })} FROM connection_tokens WHERE connection_id = ?2`
    ).bind(copy, id),
  ]);
  return copy;
};

/** Connection `id`'s status, and how many token rows it has. */
const stateOf = async (id: string) =>
  await env.DB.prepare(
    "SELECT status, (SELECT count(*) FROM connection_tokens WHERE connection_id = ?1) AS tokens FROM connections WHERE id = ?1"
  )
    .bind(id)
    .first<{ status: string; tokens: number }>();

/** The rows connect keeps for connector `id`. */
const rowsOf = async (id: string) => {
  const { results } = await env.DB.prepare(
    "SELECT client_id, url FROM connectors WHERE id = ?"
  )
    .bind(id)
    .all<{
      client_id: string | null;
      url: string;
    }>();
  return results;
};

describe("a built-in connector serving its vendor's MCP server", () => {
  it("is in the catalog by its name, offered to connect with a sign-in at its server", async () => {
    const { entries } = await exports.default.catalog();
    expect(
      entries.filter(({ id }) => id === "linear" || id === "notion")
    ).toStrictEqual(
      ["Linear", "Notion"].map((name) => ({
        source: "connector",
        id: name.toLowerCase(),
        name,
        categories: [],
        toolCount: null,
        logo: null,
        description: null,
        group: "Other",
        auth: "managed",
      }))
    );
    await expect(
      exports.default.catalogTools({ source: "connector", id: "linear" })
    ).resolves.toStrictEqual([]);
    // No one connected Notion, so it has no row yet, and no tools.
    await expect(
      exports.default.connectorTools({ person: admin(), connector: "notion" })
    ).resolves.toStrictEqual([]);
  });

  it("registers at its server on its first connection, once, and its tools are classed by the rules", async () => {
    const anna = someone();
    const ben = someone();
    await expect(rowsOf("linear")).resolves.toStrictEqual([]);
    const annas = await connectLinear("linear", anna, "personal", linearItself);
    const bens = await connectLinear("linear", ben, "personal", linearItself);
    const read = await callAs(chatAgent(anna), {
      connectionId: annas,
      action: "list_issues",
      input: {},
    });
    const [owners] = await exports.default.connectionOwners([annas]);
    const [token] = [...linearItself.tokens.values()];
    const rows = await rowsOf("linear");
    expect({
      registrations: linearItself.registrations.length,
      redirect: linearItself.registrations[0]?.redirectUris,
      rows: rows.map(({ client_id, url }) => ({
        client: client_id === linearItself.registrations[0]?.clientId,
        url,
      })),
      connected: [annas, bens].every((id) => id !== ""),
      tokenResource: token?.resource,
      read: read.output.includes("ENG-1"),
      classes: {
        list_issues: owners?.toolClasses?.list_issues,
        save_issue: owners?.toolClasses?.save_issue,
      },
    }).toStrictEqual({
      registrations: 1,
      redirect: [`${clientOrigin}/api/connections/callback`],
      rows: [{ client: true, url: linearItself.url }],
      connected: true,
      tokenResource: linearItself.url,
      read: true,
      classes: { list_issues: "read-own", save_issue: "reach-others" },
    });
  });

  it("keeps one client when two first connections register at once", async () => {
    const register = linearItself.handle;
    let arrived = 0;
    const both = Promise.withResolvers<true>();
    // Each registration waits for the other: both are at the server
    // before either row is written.
    vi.spyOn(linearItself, "handle").mockImplementation(async (request) => {
      if (new URL(request.url).pathname === "/register") {
        arrived += 1;
        if (arrived === 2) {
          both.resolve(true);
        }
        await both.promise;
      }
      return await register(request);
    });
    const anna = someone();
    const ben = someone();
    const urls = await Promise.all([
      startLinear("linear", anna),
      startLinear("linear", ben),
    ]);
    const finished = await Promise.all(
      [anna, ben].map(async (person, index) => {
        const { code, state, iss } = linearItself.consent(urls[index] ?? "");
        const { connectionId } = await exports.default.finishConnection({
          person,
          state,
          code,
          iss,
        });
        return connectionId;
      })
    );
    const rows = await rowsOf("linear");
    expect({
      registrations: linearItself.registrations.length,
      rows: rows.length,
      clients: urls.map((url) => new URL(url).searchParams.get("client_id")),
      finished: finished.every((id) => id !== ""),
    }).toStrictEqual({
      registrations: 2,
      rows: 1,
      clients: [rows[0]?.client_id, rows[0]?.client_id],
      finished: true,
    });
  });

  it("is refused when an admin adds its server by hand, before anything is asked of the server", async () => {
    expect({
      added: await outcome(
        exports.default.addConnector(
          generatedConnector(admin(), {
            name: "Linear",
            url: linearItself.url,
            auth: { kind: "oauth" },
          })
        )
      ),
      asked: linearItself.metadataRequests.length,
      rows: await rowsOf("linear"),
    }).toStrictEqual({
      added: "connection.connector_built_in",
      asked: 0,
      rows: [],
    });
  });

  it("names the host its people sign in at only while its row is for its server", async () => {
    await connectLinear("linear", someone(), "personal", linearItself);
    const atItsServer = await linearSignInHost();
    await madeForAnotherUrl();
    expect({ atItsServer, moved: await linearSignInHost() }).toStrictEqual({
      atItsServer: new URL(linearItself.origin).host,
      moved: undefined,
    });
  });

  it("learns the sign-in again when its row was made for another URL, moves the row to the server it calls, and sends that server nothing of the connections made before", async () => {
    await parkEarlierLinears();
    const anna = someone();
    const annas = await connectLinear("linear", anna, "personal", linearItself);
    const [annasToken = ""] = linearItself.tokens.keys();
    // Her connection was made with the old server's sign-in: its access
    // token is due for refreshing, and a revoke of it is owed.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE connectors SET url = ?1, server = ?1, client_id = ?2 WHERE id = ?3"
      ).bind("https://mcp.linear-old.example/mcp", "old-client", "linear"),
      env.DB.prepare(
        "UPDATE connection_tokens SET access_expires_at = 0 WHERE connection_id = ?"
      ).bind(annas),
      env.DB.prepare(
        "INSERT INTO token_revocations (id, connection_id, sealed, reason, attempts, retry_at, created_at) SELECT ?, connection_id, sealed, 'needs_reauth', 0, 0, 0 FROM connection_tokens WHERE connection_id = ?"
      ).bind(crypto.randomUUID(), annas),
    ]);
    const before = sent.length;

    const url = await startLinear("linear", someone());
    const events = await audit.events();
    const listed = await exports.default.revocationsByHand({
      person: someone("admin"),
    });
    const givenUp = listed.filter(({ connectionId }) => connectionId === annas);
    const [row] = await rowsOf("linear");
    const status = await env.DB.prepare(
      "SELECT status FROM connections WHERE id = ?"
    )
      .bind(annas)
      .first<string>("status");
    const used = await outcome(
      callAs(chatAgent(anna), {
        connectionId: annas,
        action: "list_issues",
        input: {},
      })
    );
    await runMaintenance();
    await exports.default.disconnect({ person: anna, connectionId: annas });
    const kept = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM connection_tokens WHERE connection_id = ?1) + (SELECT count(*) FROM token_revocations WHERE connection_id = ?1) AS kept"
    )
      .bind(annas)
      .first<number>("kept");
    expect({
      registrations: linearItself.registrations.length,
      row: row?.url,
      client: row?.client_id,
      asked: new URL(url).searchParams.get("client_id"),
      status,
      used,
      kept,
      hers: sent
        .slice(before)
        .filter(
          ({ url: to, headers }) =>
            to === `${linearItself.origin}/token` ||
            Object.values(headers).some((value) => value.includes(annasToken))
        ),
    }).toStrictEqual({
      registrations: 2,
      row: linearItself.url,
      client: linearItself.registrations[1]?.clientId,
      asked: linearItself.registrations[1]?.clientId,
      status: "needs_reauth",
      used: "connect.connection_inactive",
      kept: 0,
      hers: [],
    });
    // One event for the move, and the grant it left live at the old
    // server listed for an admin to revoke there by hand.
    expect({
      moves: events
        .filter(({ action }) => action === "connector.moved")
        .map(({ actor, target, detail }) => ({ actor, target, detail })),
      givenUp: givenUp.map(({ state, owedFor, reason }) => ({
        state,
        owedFor,
        reason,
      })),
    }).toStrictEqual({
      moves: [
        {
          actor: { type: "system" },
          target: { type: "connector", id: "linear" },
          detail: {
            connector: "linear",
            from: "https://mcp.linear-old.example/mcp",
            url: linearItself.url,
            needsReauth: 1,
            tokensDropped: 1,
            revokesGivenUp: 1,
            heldDropped: 0,
          },
        },
      ],
      givenUp: [
        { state: "given_up", owedFor: "needs_reauth", reason: "moved" },
      ],
    });
  });

  it("counts in its one event a connection made as it moved", async () => {
    await parkEarlierLinears();
    const annas = await connectLinear(
      "linear",
      someone(),
      "personal",
      linearItself
    );
    await madeForAnotherUrl();
    // Another connection lands once the move read what it moves, just
    // before it writes.
    let made = "";
    await prepareBuiltIn(
      {
        ...env,
        DB: racingDb(async () => {
          made ||= await madeAgain(annas);
        }),
      },
      "linear",
      clientOrigin
    );
    const events = await audit.events();
    expect({
      counted: events
        .filter(({ action }) => action === "connector.moved")
        .map(({ detail }) => [detail.needsReauth, detail.tokensDropped]),
      made: await stateOf(made),
    }).toStrictEqual({
      counted: [[2, 2]],
      made: { status: "needs_reauth", tokens: 0 },
    });
  });

  it("goes by its release's title, whatever its row was made with, its sign-in and connections as they are", async () => {
    const anna = someone();
    const annas = await connectLinear("linear", anna, "personal", linearItself);
    await env.DB.prepare("UPDATE connectors SET name = ? WHERE id = ?")
      .bind("Linear, as it was called", "linear")
      .run();
    const registered = linearItself.registrations.length;
    await startLinear("linear", someone());
    const listed = await exports.default.listConnections(anna);
    const named = listed.find(({ id }) => id === annas)?.name;
    expect({
      named,
      registrations: linearItself.registrations.length - registered,
      annas: await stateOf(annas),
    }).toStrictEqual({
      named: "Linear",
      registrations: 0,
      annas: { status: "active", tokens: 1 },
    });
  });

  it("confirms no action held before its server moved, once its person signs in again, and counts it in the move's event", async () => {
    await parkEarlierLinears();
    const anna = someone();
    const annas = await connectLinear("linear", anna, "personal", linearItself);
    const agent = chatAgent(anna);
    const title = `Held before the move ${crypto.randomUUID()}`;
    await callAs(agent, {
      connectionId: annas,
      action: "save_issue",
      input: { title, team: "Engineering" },
    });
    const [listed] = await exports.default.listPendingActions(anna, "grasp");
    await madeForAnotherUrl();
    await startLinear("linear", someone());
    const again = await connectLinear("linear", anna, "personal", linearItself);

    const confirmed = await outcome(
      confirmHeld(
        anna,
        agent,
        { connectionId: annas, action: "save_issue" },
        listed
      )
    );
    const events = await audit.events();
    expect({
      listed: listed?.action,
      again: again === annas,
      held: await exports.default.listPendingActions(anna, "grasp"),
      confirmed,
      saved: linearItself.workspace.issues.filter(
        (issue) => issue.title === title
      ),
      heldDropped: events
        .filter(({ action }) => action === "connector.moved")
        .map(({ detail }) => detail.heldDropped),
    }).toStrictEqual({
      listed: "save_issue",
      again: true,
      held: [],
      confirmed: "connect.pending_not_found",
      saved: [],
      heldDropped: [1],
    });
  });

  it("finishes no sign-in started before its server moved, and sends its code nowhere", async () => {
    await connectLinear("linear", someone(), "personal", linearItself);
    const ben = someone();
    const url = await startLinear("linear", ben);
    await madeForAnotherUrl();
    await startLinear("linear", someone());
    const before = sent.length;

    const { code, state, iss } = linearItself.consent(url);
    const finished = await outcome(
      exports.default.finishConnection({ person: ben, state, code, iss })
    );
    expect({
      finished,
      exchanged: sent
        .slice(before)
        .filter(({ url: to }) => to === `${linearItself.origin}/token`),
    }).toStrictEqual({ finished: "connection.flow_invalid", exchanged: [] });
  });

  it("finishes no sign-in whose server moved once it was taken, and sends its code nowhere", async () => {
    await connectLinear("linear", someone(), "personal", linearItself);
    const ben = someone();
    const url = await startLinear("linear", ben);
    await madeForAnotherUrl();
    const before = sent.length;
    // The move lands as the finish reads its connector's sign-in, once it
    // took the flow.
    let moved = false;
    const movingDb = racingRead(/from "connectors"/iu, async () => {
      moved = true;
      await startLinear("linear", someone());
    });

    const { code, state, iss } = linearItself.consent(url);
    const finished = await outcome(
      finishConnection(
        { ...env, DB: movingDb },
        { person: ben, state, code, iss }
      )
    );
    expect({
      moved,
      finished,
      exchanged: sent
        .slice(before)
        .filter(({ url: to }) => to === `${linearItself.origin}/token`),
    }).toStrictEqual({
      moved: true,
      finished: "connection.flow_invalid",
      exchanged: [],
    });
  });

  it("sends no credential read as another release moved its row away", async () => {
    await parkEarlierLinears();
    const anna = someone();
    const annas = await connectLinear("linear", anna, "personal", linearItself);
    const connection = await drizzle(env.DB)
      .select()
      .from(connections)
      .where(eq(connections.id, annas))
      .get();
    if (connection === undefined) {
      throw new Error("Expected Anna's connection");
    }
    const before = sent.length;
    // Once the list's request read the row as this release's, another
    // release (a rollback) moves it to the server it serves, just before
    // her credential is read: what it reads is no longer this server's.
    let moved = false;
    const listed = await outcome(
      currentTools(
        {
          ...env,
          DB: racingRead(/from "connection_tokens"/iu, async () => {
            moved = true;
            await madeForAnotherUrl();
          }),
        },
        { ...connection, toolListFreshUntil: null }
      )
    );
    expect({
      moved,
      listed,
      sent: sent
        .slice(before)
        .filter(({ url }) => url.startsWith(linearItself.origin)),
    }).toStrictEqual({
      moved: true,
      listed: "connect.server_unavailable",
      sent: [],
    });
  });

  it.each([
    ["its connection's", 0],
    ["the refresh's", 1],
  ])(
    "sends no refresh token read as its server moved to the issuer it moved from, read after %s read of its tokens",
    async (_, skip) => {
      await parkEarlierLinears();
      const anna = someone();
      const annas = await connectLinear(
        "linear",
        anna,
        "personal",
        linearItself
      );
      await madeForAnotherUrl();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE connectors SET token_endpoint = ? WHERE id = ?"
        ).bind("https://mcp.linear-old.example/token", "linear"),
        env.DB.prepare(
          "UPDATE connection_tokens SET access_expires_at = 0 WHERE connection_id = ?"
        ).bind(annas),
      ]);
      const connection = await drizzle(env.DB)
        .select()
        .from(connections)
        .where(eq(connections.id, annas))
        .get();
      if (connection === undefined) {
        throw new Error("Expected Anna's connection");
      }
      const before = sent.length;
      // Once the old issuer was read for her credential, the release moves
      // the connector and Anna signs in again, and her new token is due a
      // refresh by the time it is read.
      let moved = false;
      const listed = await outcome(
        currentTools(
          {
            ...env,
            DB: racingRead(
              /from "connection_tokens"/iu,
              async () => {
                moved = true;
                await startLinear("linear", someone());
                await connectLinear("linear", anna, "personal", linearItself);
                await env.DB.prepare(
                  "UPDATE connection_tokens SET access_expires_at = 0 WHERE connection_id = ?"
                )
                  .bind(annas)
                  .run();
              },
              { skip }
            ),
          },
          { ...connection, toolListFreshUntil: null }
        )
      );
      expect({
        moved,
        listed,
        toOld: sent
          .slice(before)
          .filter(({ url }) =>
            url.startsWith("https://mcp.linear-old.example")
          ),
      }).toStrictEqual({
        moved: true,
        listed: "connect.server_unavailable",
        toOld: [],
      });
    }
  );

  it("sends no token read as its server moved to revoke at the issuer it moved from, and owes its revoke", async () => {
    await parkEarlierLinears();
    const anna = someone();
    const annas = await connectLinear("linear", anna, "personal", linearItself);
    await madeForAnotherUrl();
    await env.DB.prepare(
      "UPDATE connectors SET revocation_endpoint = ? WHERE id = ?"
    )
      .bind("https://mcp.linear-old.example/revoke", "linear")
      .run();
    const before = sent.length;
    // As Anna disconnects, once the old issuer was read to revoke at, the
    // release moves the connector and Anna signs in again.
    let moved = false;
    await disconnect(
      {
        ...env,
        DB: racingRead(/from "connection_tokens"/iu, async () => {
          moved = true;
          await startLinear("linear", someone());
          await connectLinear("linear", anna, "personal", linearItself);
        }),
      },
      { person: anna, connectionId: annas }
    );
    const owed = await env.DB.prepare(
      "SELECT COUNT(*) AS owed FROM token_revocations WHERE connection_id = ?"
    )
      .bind(annas)
      .first("owed");
    expect({
      moved,
      owed,
      toOld: sent
        .slice(before)
        .filter(({ url }) => url.startsWith("https://mcp.linear-old.example")),
    }).toStrictEqual({ moved: true, owed: 1, toOld: [] });
  });

  it("sends a call whose tool was read before its server moved to no server", async () => {
    await parkEarlierLinears();
    const anna = someone();
    const annas = await connectLinear("linear", anna, "personal", linearItself);
    const connectionOf = async () => {
      const row = await drizzle(env.DB)
        .select()
        .from(connections)
        .where(eq(connections.id, annas))
        .get();
      if (row === undefined) {
        throw new Error("Expected Anna's connection");
      }
      return row;
    };
    await currentTools(env, await connectionOf());
    await madeForAnotherUrl();
    // Its tool is read while its row names the server it moves from; the
    // release then moves it, and Anna signs in again, before it is sent.
    const { open } = await connectorAction(
      env,
      await connectionOf(),
      "list_issues",
      "read-own"
    );
    await startLinear("linear", someone());
    await connectLinear("linear", anna, "personal", linearItself);
    const before = sent.length;

    const call = async () => {
      const server = await open();
      return await server.call("list_issues", {});
    };

    expect({
      called: await outcome(call()),
      calls: sent
        .slice(before)
        .filter(({ headers }) => headers["mcp-method"] === "tools/call"),
    }).toStrictEqual({ called: "connect.server_unavailable", calls: [] });
  });

  it("keeps no tool list read at the server its connector moved from", async () => {
    await parkEarlierLinears();
    const anna = someone();
    const annas = await connectLinear("linear", anna, "personal", linearItself);
    const connectionOf = async () => {
      const row = await drizzle(env.DB)
        .select()
        .from(connections)
        .where(eq(connections.id, annas))
        .get();
      if (row === undefined) {
        throw new Error("Expected Anna's connection");
      }
      return row;
    };
    await currentTools(env, await connectionOf());
    await madeForAnotherUrl();
    // A call loads her connection, its list fresh, as the release moves
    // the connector; she signs in again before it is sent.
    const loaded = await connectionOf();
    await startLinear("linear", someone());
    const before = sent.length;
    const call = async () => {
      const { open } = await connectorAction(
        env,
        loaded,
        "list_issues",
        "read-own"
      );
      await connectLinear("linear", anna, "personal", linearItself);
      const server = await open();
      return await server.call("list_issues", {});
    };

    expect({
      called: await outcome(call()),
      calls: sent
        .slice(before)
        .filter(({ headers }) => headers["mcp-method"] === "tools/call"),
    }).toStrictEqual({ called: "connect.action_not_found", calls: [] });
  });

  it("sends no owed revoke to the server its connector moved to as it was tried", async () => {
    const annas = await connectLinear(
      "linear",
      someone(),
      "personal",
      linearItself
    );
    await madeForAnotherUrl();
    // Disconnected with the old server's sign-in, its revoke still owed.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO token_revocations (id, connection_id, sealed, reason, attempts, retry_at, created_at) SELECT ?, connection_id, sealed, 'disconnected', 0, 0, ? FROM connection_tokens WHERE connection_id = ?"
      ).bind(crypto.randomUUID(), Date.now(), annas),
      env.DB.prepare(
        "DELETE FROM connection_tokens WHERE connection_id = ?"
      ).bind(annas),
      env.DB.prepare(
        "UPDATE connections SET status = 'disconnected' WHERE id = ?"
      ).bind(annas),
    ]);
    const before = sent.length;
    // The move lands as the try reads the connector's sign-in.
    let moved = false;
    await retryRevocations({
      ...env,
      DB: racingRead(/from "connectors"/iu, async () => {
        moved = true;
        await startLinear("linear", someone());
      }),
    });
    expect({
      moved,
      revoked: sent
        .slice(before)
        .filter(({ url }) => url === `${linearItself.origin}/token`),
      owed: await env.DB.prepare(
        "SELECT count(*) AS owed FROM token_revocations WHERE connection_id = ?"
      )
        .bind(annas)
        .first<number>("owed"),
    }).toStrictEqual({ moved: true, revoked: [], owed: 0 });
  });

  it("keeps a connection made after one move when another, found stale at once, lands after it", async () => {
    await connectLinear("linear", someone(), "personal", linearItself);
    await madeForAnotherUrl();
    // The first start's registration waits until a second start moved the
    // row and someone connected through it. Each side waits on its own
    // timers, never on a promise the other resolves: workerd runs what such
    // a promise wakes as the request that resolved it.
    const register = linearItself.handle;
    const turns = { held: false, connected: false };
    vi.spyOn(linearItself, "handle").mockImplementation(async (request) => {
      if (new URL(request.url).pathname === "/register" && !turns.held) {
        turns.held = true;
        while (!turns.connected) {
          // oxlint-disable-next-line no-await-in-loop -- waits its turn
          await scheduler.wait(5);
        }
      }
      return await register(request);
    });
    const late = startLinear("linear", someone());
    while (!turns.held) {
      // oxlint-disable-next-line no-await-in-loop -- waits its turn
      await scheduler.wait(5);
    }
    const carols = await connectLinear(
      "linear",
      someone(),
      "personal",
      linearItself
    );
    turns.connected = true;
    await late;

    expect({
      registrations: linearItself.registrations.length,
      carols: await stateOf(carols),
    }).toStrictEqual({
      registrations: 3,
      carols: { status: "active", tokens: 1 },
    });
  });

  it("takes no key, and learns nothing of its server for one", async () => {
    expect({
      keyed: await outcome(
        exports.default.connectWithKey({
          person: someone(),
          provider: "linear",
          scope: "personal",
          key: "a-key",
        })
      ),
      asked: linearItself.metadataRequests.length,
      rows: await rowsOf("linear"),
    }).toStrictEqual({
      keyed: "connection.provider_unavailable",
      asked: 0,
      rows: [],
    });
  });

  it("can't be connected while a connector made from a URL holds its server, and says so", async () => {
    await env.DB.prepare(
      "INSERT INTO connectors (id, name, url, auth, header, created_by, created_at) VALUES (?, ?, ?, 'header', 'x-api-key', ?, ?)"
    )
      .bind(
        `mcp_${"0".repeat(32)}`,
        "Linear by hand",
        linearItself.url,
        "user-admin",
        Date.now()
      )
      .run();
    expect({
      started: await outcome(startLinear("linear", someone())),
      rows: await rowsOf("linear"),
    }).toStrictEqual({
      started: "connection.connector_exists",
      rows: [],
    });
  });
});

describe("a built-in serving its vendor's MCP server with a person's key", () => {
  it("is in the catalog to connect with a key, connected with the key its server takes, and never signed in to", async () => {
    keyServer(sampleTrackerOrigin, "tracker-key");
    const anna = someone();
    const { entries } = await exports.default.catalog();
    const connectWith = async (key: string) =>
      await exports.default.connectWithKey({
        person: anna,
        provider: "sample-tracker",
        scope: "personal",
        key,
      });
    const refused = await outcome(connectWith("another-key"));
    const { connectionId } = await connectWith("tracker-key");
    const classes = await exports.default.connectorToolClasses(connectionId);
    const started = await outcome(startLinear("sample-tracker", someone()));
    const { results } = await env.DB.prepare(
      "SELECT url, auth, header, client_id, created_by FROM connectors WHERE id = 'sample-tracker'"
    ).all();
    expect({
      auth: entries.find(({ id }) => id === "sample-tracker")?.auth,
      refused,
      classes,
      started,
      rows: results,
    }).toStrictEqual({
      auth: "key",
      refused: "connection.provider_refused",
      classes: { list_notes: "read-own" },
      started: "connection.provider_unavailable",
      rows: [
        {
          url: `${sampleTrackerOrigin}/mcp`,
          auth: "header",
          header: "x-api-key",
          client_id: null,
          created_by: "release",
        },
      ],
    });
  });

  it.each([
    ["its server", "url", "https://mcp.tracker-next.example/mcp"],
    ["the header its key goes in", "header", "x-tracker-key"],
  ])(
    "keeps no key checked before its connector moved, by %s, nor connects again one the move asked to",
    async (_, column, value) => {
      keyServer(sampleTrackerOrigin, "tracker-key");
      const anna = someone();
      const connectWith = async () =>
        await exports.default.connectWithKey({
          person: anna,
          provider: "sample-tracker",
          scope: "personal",
          key: "tracker-key",
        });
      const { connectionId } = await connectWith();
      // Another release moves the connector as its server checks the key:
      // its row to the server it names, and its connections asked to
      // connect again, their keys dropped.
      const serve = servers.get(sampleTrackerOrigin);
      let moved = false;
      servers.set(sampleTrackerOrigin, async (request) => {
        if (!moved) {
          moved = true;
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE connectors SET ${column} = ? WHERE id = ?`
            ).bind(value, "sample-tracker"),
            env.DB.prepare(
              "UPDATE connections SET status = 'needs_reauth' WHERE id = ?"
            ).bind(connectionId),
            env.DB.prepare(
              "DELETE FROM connection_tokens WHERE connection_id = ?"
            ).bind(connectionId),
          ]);
        }
        return await (serve?.(request) ?? new Response(null, { status: 404 }));
      });

      const kept = await outcome(connectWith());
      const after = await env.DB.prepare(
        "SELECT status, (SELECT COUNT(*) FROM connection_tokens WHERE connection_id = connections.id) AS keys FROM connections WHERE id = ?"
      )
        .bind(connectionId)
        .first();
      const { results: others } = await env.DB.prepare(
        "SELECT id FROM connections WHERE provider = 'sample-tracker' AND owner_user_id = ? AND id != ?"
      )
        .bind(anna.userId, connectionId)
        .all();
      await env.DB.prepare(
        "UPDATE connectors SET url = ?, header = 'x-api-key' WHERE id = ?"
      )
        .bind(`${sampleTrackerOrigin}/mcp`, "sample-tracker")
        .run();
      servers.set(sampleTrackerOrigin, serve ?? (() => new Response(null)));
      expect({ moved, kept, after, others }).toStrictEqual({
        moved: true,
        kept: "connection.flow_invalid",
        after: { status: "needs_reauth", keys: 0 },
        others: [],
      });
    }
  );
});

/** Anna's connection to the built-in Linear, and a call of list_issues through it. */
const listing = async () => {
  const anna = someone();
  const connectionId = await connectLinear(
    "linear",
    anna,
    "personal",
    linearItself
  );
  return async (input: Call["input"]) =>
    await callAs(chatAgent(anna), {
      connectionId,
      action: "list_issues",
      input,
    });
};

/** Adds `count` issues like the first, each described by `description`. */
const addIssues = (count: number, description: string): void => {
  const [first] = linearItself.workspace.issues;
  if (first === undefined) {
    throw new Error("Expected the fake's seeded issues");
  }
  for (let at = 0; at < count; at += 1) {
    linearItself.workspace.issues.push({
      ...first,
      uuid: crypto.randomUUID(),
      identifier: `ENG-${100 + at}`,
      title: `Issue ${at} with a title of a usual length`,
      description,
    });
  }
};

/** The code of a call that failed, and what its server said, if it did. */
const refusal = async (
  call: Promise<unknown>
): Promise<{ code: string | undefined; said: unknown } | "ok"> => {
  try {
    await call;
  } catch (error) {
    return {
      code: connectErrors.codeOf(error),
      said: isExpectedError(error) ? error.details?.output : undefined,
    };
  }
  return "ok";
};

/** The issues of a list_issues answer, by their IDs and teams. */
const issuesOf = ({ output }: { output: string }) =>
  z
    .object({
      issues: z.array(z.object({ id: z.string(), team: z.string() })),
      hasNextPage: z.boolean(),
    })
    .parse(JSON.parse(output));

describe("Linear's list_issues, called as a chat's model calls it", () => {
  it("answers with no filter, by a team its first answer named, and its largest page", async () => {
    const list = await listing();
    const [first] = linearItself.workspace.teams;
    if (first === undefined) {
      throw new Error("Expected the fake's seeded team");
    }
    linearItself.workspace.teams.push({
      id: crypto.randomUUID(),
      key: "OPS",
      name: "Operations",
    });
    addIssues(260, "Steps to reproduce, and what was expected.");
    const all = issuesOf(await list({}));
    const team = all.issues[0]?.team ?? "";
    const byTeam = issuesOf(await list({ team }));
    const others = issuesOf(await list({ team: "Operations" }));
    const largest = issuesOf(await list({ limit: 250 }));
    expect({
      firstPage: all.issues.length,
      team: team === first.name,
      byTeam: byTeam.issues.every((issue) => issue.team === team),
      others: others.issues.length,
      largest: largest.issues.length,
      more: largest.hasNextPage,
    }).toStrictEqual({
      firstPage: 50,
      team: true,
      byTeam: true,
      others: 0,
      largest: 250,
      more: true,
    });
  });

  it("hands back Linear's refusal of what it doesn't take, in Linear's words", async () => {
    const list = await listing();
    expect({
      unknownKey: await refusal(list({ first: 10 })),
      pastItsLargestPage: await refusal(list({ limit: 500 })),
    }).toStrictEqual({
      unknownKey: {
        code: "connect.action_failed",
        said: JSON.stringify('Invalid input: unrecognized key "first"'),
      },
      pastItsLargestPage: {
        code: "connect.action_failed",
        said: JSON.stringify(
          "Invalid input: limit must be an integer from 1 to 250"
        ),
      },
    });
  });

  it("names an answer too large to read, so a call asking for less goes through", async () => {
    const list = await listing();
    // Issues as long as real ones get: a page of them is over what connect reads.
    addIssues(
      260,
      "What happened, steps to reproduce, the logs and the links. ".repeat(80)
    );
    expect({
      whole: await refusal(list({ limit: 250 })),
      fewerFields: await refusal(
        list({ limit: 250, fields: ["id", "title", "status"] })
      ),
    }).toStrictEqual({
      whole: { code: "connect.answer_too_large", said: undefined },
      fewerFields: "ok",
    });
  });
});

describe("a vendor's tool error", () => {
  it("goes on structured as its server gave it, for its code to be read", async () => {
    const list = await listing();
    const { handle } = linearItself;
    const reason = "y".repeat(2000);
    vi.spyOn(linearItself, "handle").mockImplementation(async (request) => {
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => {});
      const call = z
        .object({ id: z.number(), method: z.literal("tools/call") })
        .safeParse(body);
      return call.success
        ? Response.json({
            jsonrpc: "2.0",
            id: call.data.id,
            result: {
              resultType: "complete",
              content: [{ type: "text", text: reason }],
              structuredContent: { error: { code: "invalid", reason } },
              isError: true,
            },
          })
        : await handle(request);
    });
    await expect(refusal(list({}))).resolves.toStrictEqual({
      code: "connect.action_failed",
      said: JSON.stringify({ error: { code: "invalid", reason } }),
    });
  });
});
