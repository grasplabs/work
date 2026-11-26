import {
  classByRules,
  isJsonArray,
  topNames,
} from "@grasp-os/runtime/connector";
import type { ToolHints } from "@grasp-os/runtime/connector";
import {
  addConnectorSchema,
  blockConnectorToolSchema,
  connectErrors,
  connectionErrors,
  connectionOwnersSchema,
  connectorToolNameSchema,
  connectorToolsRequestSchema,
} from "@grasp-os/shared/connect";
import type {
  ActionShape,
  ConnectorContract,
  ConnectorContractAction,
  ConnectorToolView,
  ToolClass,
} from "@grasp-os/shared/connect";
import { connectionIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson, isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEventIf, recordEvents, recordEventsIf } from "./audit.ts";
import { companyAddressOf, companyRoute, outbound } from "./company-network.ts";
import {
  auditRefusal,
  connectionEvent,
  refuseStaff,
} from "./connection-audit.ts";
import type { Connection } from "./connections.ts";
import {
  builtInAt,
  connectorRow,
  isDuplicate,
  maxListedTools,
  secretContext,
  signInRow,
} from "./connector-providers.ts";
import {
  connections,
  connectionTools,
  connectorBlockedTools,
  connectors,
} from "./db/schema.ts";
import { ownerErased } from "./erased-people.ts";
import { isPublicName } from "./mcp-discovery.ts";
import { McpError, mcpHeaderValue, modernMcpServer } from "./mcp.ts";
import type { ListedServerTool, McpServer, McpTool } from "./mcp.ts";
import { pauseAsked } from "./pause.ts";
import {
  actionNamePattern,
  isShallowJson,
  maxSchemaBytes,
  servedSchema,
  textAnswer,
} from "./served-schemas.ts";
import { connectorCredentialFor, pausedWait } from "./tokens.ts";
import { classesOf, keptToolClasses, storedSchema } from "./tool-rules.ts";
import { vaultFor } from "./vault.ts";

// Connectors served through a vendor's MCP server, and connections to
// them: the one connection kind, always to a connector. A built-in of the
// release declares its server in its manifest (`defineConnector`'s
// `mcp`), and connect learns how it signs in and registers there on its
// first connection (connector-providers.ts `prepareBuiltIn`). Any other
// is made from its URL (GRA-1375): an admin enters it, and connect checks
// where it leads, learns how it signs in and registers there
// (mcp-discovery.ts), and keeps it as the one-line
// `defineConnector({ name, mcp: { url } })` in `connectors`; moving that
// onto generated source is GRA-2325's second part. People then connect to
// either as to any app (oauth.ts, connector-providers.ts), and connect
// alone holds their tokens.
//
// Everything the server says is untrusted (threat model on GRA-1375):
// - its tool list is read when the last read's `ttlMs` (an hour at most)
//   ran out, checked tool by tool, and kept whole: a tool whose schemas
//   are too deep or too large, whose name a call couldn't carry, or that
//   asks for headers connect won't send, isn't kept, and a name listed
//   twice is kept for neither;
// - each change of a list is audited once, with counts of the tools
//   added, removed and changed (a new tool is callable at once when its
//   class is on: Nick's decision on GRA-2306), and a list is fresh for a
//   minute at least, so no server makes connect read it on every call;
// - each tool's class is computed from the list as kept now
//   (tool-rules.ts), never stored, so a changed tool is classed again and
//   a removed one serves no call, contract or binding;
// - a tool an admin blocked on the connector is offered to nobody and
//   refused at the call, before anything goes out;
// - a call goes only to the server's own URL, by POST, as `tools/call` of
//   the one tool it names, or as `tools/list` (`serverFor`), with the
//   connection's credential added there and nowhere else; no redirect is
//   followed, and every answer is capped and read as mcp.ts reads them;
// - what a server says of its own call (its provenance, that it did
//   nothing, what it changed) isn't taken: a remote write that failed is
//   of unknown outcome (policy.ts).

/** Longest description kept, in characters: the rest is cut off. */
const maxDescriptionLength = 4096;

/** Longest a tool list is fresh, whatever the server says. */
const maxListTtlMs = 60 * 60 * 1000;

/** Shortest a tool list is fresh, whatever the server says. */
const minListTtlMs = 60 * 1000;

/** How long a tool list is fresh when the server doesn't say. */
const defaultListTtlMs = 5 * 60 * 1000;

/**
 * Least time between two reads of one connection's tool list after an
 * answer (`refreshLater`): longer than a read may take, so asks at once
 * start one read, and a server that failed isn't asked again at every ask.
 * A list its server keeps fresh for less is read again after this, for
 * offers and search; calls and requests read it live once it is stale.
 */
const laterReadGapMs = 5 * 60 * 1000;

/**
 * Most tools one statement keeps: D1 binds at most 100 parameters a
 * statement, a kept tool takes six, and the condition it is kept on a few.
 */
const toolsPerInsert = 14;

/** An `x-mcp-header` name: an HTTP token (RFC 9110). */
const paramHeaderPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/u;

/** What may go in an `x-mcp-header` parameter. */
const paramHeaderTypes: ReadonlySet<unknown> = new Set([
  "string",
  "integer",
  "boolean",
]);

/** A tool of a connector's server, as connect keeps it. */
export interface ConnectorTool {
  name: string;
  description: string | null;
  inputSchema: Json;
  outputSchema: Json | undefined;
  annotations: ToolHints;
}

/**
 * Adds a connector by its server's URL, for an admin who isn't staff: the
 * URL checked and its name resolved to public addresses only, its sign-in
 * learned and connect registered there (or the client the admin entered
 * kept, its secret sealed), and the row written with its event. Its ID.
 */
export const addConnector = async (
  env: Env,
  request: unknown
): Promise<{ id: string }> => {
  const { person, name, url, companyNetwork, origin, auth } =
    connectionErrors.parse("connection.invalid", addConnectorSchema, request);
  // A URL of its origin and path alone (`addConnectorSchema`), https
  // but inside the company's network.
  const server = new URL(url);
  if (companyNetwork !== true && server.protocol !== "https:") {
    throw connectionErrors.create("connection.invalid");
  }
  // A server inside the company's own network is reached through the
  // company network at its URL's origin alone (company-network.ts).
  const address =
    companyNetwork === true ? companyAddressOf(server.origin) : undefined;
  const detail = {
    host: server.host,
    auth: auth.kind,
    ...(address !== undefined && { companyNetwork: address }),
  };
  await refuseStaff(env, person, detail);
  if (!isAdmin(person.role)) {
    await auditRefusal(env, person, "connector.added", {
      ...detail,
      outcome: "refused",
      reason: "role.forbidden",
    });
    throw roleErrors.create("role.forbidden");
  }
  // One catalog entry per server: a built-in's is connected as it is.
  const served = builtInAt(server.href);
  if (served !== undefined) {
    throw connectionErrors.create("connection.connector_built_in", {
      connector: served.name,
    });
  }
  if (companyNetwork === true) {
    // Its sign-in, discovered and registered at the server, would be read
    // from the public internet: a key in a header only, for now.
    if (address === undefined || auth.kind !== "header") {
      throw connectionErrors.create("connection.invalid");
    }
    if (companyRoute(env) === undefined) {
      throw connectionErrors.create("connection.company_network_unavailable");
    }
  } else if (!(await isPublicName(server))) {
    throw connectionErrors.create("connection.server_refused");
  }
  const vault = await vaultFor(env);
  if (vault === undefined) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  const id = `mcp_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date();
  const common = { id, name, createdBy: person.userId, createdAt: now };
  const row: typeof connectors.$inferInsert = {
    ...common,
    url: server.href,
    ...(auth.kind === "header"
      ? {
          auth: "header",
          header: auth.header,
          companyNetwork: address !== undefined,
        }
      : await signInRow(
          vault,
          id,
          server,
          new URL(origin).origin,
          auth.client
        )),
  };
  try {
    await recordEvents(
      env,
      [
        connectionEvent(person, "connector.added", undefined, {
          ...detail,
          connector: id,
          ...(row.registration === undefined || row.registration === null
            ? {}
            : { registration: row.registration }),
          outcome: "ok",
        }),
      ],
      [drizzle(env.DB).insert(connectors).values(row)]
    );
  } catch (error) {
    if (isDuplicate(error)) {
      throw connectionErrors.create("connection.connector_exists");
    }
    throw error;
  }
  return { id };
};

/** `value` as a JSON Schema connect keeps: an object, shallow and small. */
const schemaOf = (value: unknown): Json | undefined =>
  isShallowJson(value) &&
  isRecord(value) &&
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxSchemaBytes
    ? value
    : undefined;

/** How many objects in `value` have `key` of their own, at any depth. */
const keyCount = (value: Json, key: string): number => {
  let count = 0;
  const pending: Json[] = [value];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (isJsonArray(next)) {
      for (const each of next) {
        pending.push(each);
      }
    } else if (isRecord(next)) {
      count += Object.hasOwn(next, key) ? 1 : 0;
      for (const each of Object.values(next)) {
        if (each !== undefined) {
          pending.push(each);
        }
      }
    }
  }
  return count;
};

/**
 * The `x-mcp-header` parameters of an input schema, by property: only on
 * its own properties, each a primitive, named as a header may be, and
 * each name once whatever its case. Undefined when the schema asks for
 * one anywhere else or any other way: connect couldn't send that tool's
 * calls as the server expects them.
 */
const paramHeadersOf = (inputSchema: Json): Map<string, string> | undefined => {
  const headers = new Map<string, string>();
  const names = new Set<string>();
  const properties =
    isRecord(inputSchema) && isRecord(inputSchema.properties)
      ? inputSchema.properties
      : {};
  for (const [property, schema] of Object.entries(properties)) {
    if (!isRecord(schema) || !Object.hasOwn(schema, "x-mcp-header")) {
      continue;
    }
    const header = schema["x-mcp-header"];
    if (
      typeof header !== "string" ||
      !paramHeaderPattern.test(header) ||
      names.has(header.toLowerCase()) ||
      !paramHeaderTypes.has(schema.type)
    ) {
      return undefined;
    }
    names.add(header.toLowerCase());
    headers.set(property, header);
  }
  return keyCount(inputSchema, "x-mcp-header") === headers.size
    ? headers
    : undefined;
};

/** A listed tool as connect keeps it, or undefined if it isn't kept. */
const toolOf = (listed: ListedServerTool): ConnectorTool | undefined => {
  const inputSchema = schemaOf(listed.inputSchema);
  const outputSchema =
    listed.outputSchema === undefined
      ? undefined
      : schemaOf(listed.outputSchema);
  if (
    !connectorToolNameSchema.safeParse(listed.name).success ||
    inputSchema === undefined ||
    (listed.outputSchema !== undefined && outputSchema === undefined) ||
    paramHeadersOf(inputSchema) === undefined
  ) {
    return undefined;
  }
  const hints = isRecord(listed.annotations) ? listed.annotations : {};
  return {
    name: listed.name,
    description:
      typeof listed.description === "string"
        ? listed.description.slice(0, maxDescriptionLength)
        : null,
    inputSchema,
    outputSchema,
    annotations: {
      ...(typeof hints.readOnlyHint === "boolean"
        ? { readOnlyHint: hints.readOnlyHint }
        : {}),
      ...(typeof hints.destructiveHint === "boolean"
        ? { destructiveHint: hints.destructiveHint }
        : {}),
    },
  };
};

/**
 * A client for `connection`'s server that sends only what `allows` lets
 * through, to the connector's own URL, with the connection's credential.
 */
const serverFor = async (
  env: Env,
  connection: Connection,
  allows: (method: string, name: string | null) => boolean
) => {
  const row = await connectorRow(env.DB, connection.server);
  if (row === undefined) {
    throw connectErrors.create("connect.server_unavailable");
  }
  const { credential, companyNetwork } = await connectorCredentialFor(
    env,
    connection.id
  );
  // A release may have moved the connector while its credential was read,
  // and the credential read since be the new server's: it goes only to
  // the server the row still names.
  const still = await connectorRow(env.DB, connection.server);
  if (
    still?.url !== row.url ||
    still.auth !== row.auth ||
    still.companyNetwork !== row.companyNetwork
  ) {
    throw connectErrors.create("connect.server_unavailable");
  }
  // A server inside the network is never sent to over the internet.
  if (row.companyNetwork === true && companyNetwork === undefined) {
    throw connectErrors.create("connect.server_unavailable");
  }
  const send = outbound(env, companyNetwork);
  return modernMcpServer(row.url, async (request) => {
    if (
      request.method !== "POST" ||
      request.url !== row.url ||
      !allows(
        request.headers.get("mcp-method") ?? "",
        request.headers.get("mcp-name")
      )
    ) {
      throw new McpError("Connect doesn't send that request");
    }
    const headers = new Headers(request.headers);
    headers.set(credential.header, credential.value);
    const response = await send(
      new Request(request, { headers, redirect: "manual" })
    );
    // A server that asks every caller to wait pauses the connection, as a
    // native connector's provider does at the egress.
    await pauseAsked(env.DB, connection.id, response, {
      connector: connection.server,
    });
    return response;
  });
};

/** A tool as JSON whose keys a server may reorder without changing it. */
const toolJson = (tool: ConnectorTool): string =>
  canonicalJson({ ...tool, annotations: { ...tool.annotations } });

/** Orders tools by name, which a list holds each of once. */
const byName = (a: ConnectorTool, b: ConnectorTool): number =>
  a.name < b.name ? -1 : 1;

/** A kept row as the tool it is. */
const keptTool = (row: typeof connectionTools.$inferSelect): ConnectorTool => ({
  name: row.name,
  description: row.description,
  inputSchema: storedSchema(row.inputSchema),
  outputSchema:
    row.outputSchema === null ? undefined : storedSchema(row.outputSchema),
  annotations: row.annotations,
});

/** The tools kept for `connectionId` at its last read. */
const keptTools = async (
  db: D1Database,
  connectionId: string
): Promise<ConnectorTool[]> => {
  const rows = await drizzle(db)
    .select()
    .from(connectionTools)
    .where(eq(connectionTools.connectionId, connectionId));
  return rows.map(keptTool);
};

/**
 * How `after` differs from `before`, lists of one connection's tools:
 * how many tools it added and removed, how many it kept by name but
 * changed, and of those how many the rules class otherwise now.
 */
const listChanges = (
  before: readonly ConnectorTool[],
  after: readonly ConnectorTool[],
  scope: Connection["scope"]
): { added: number; removed: number; changed: number; reclassed: number } => {
  const old = new Map(before.map((tool) => [tool.name, tool]));
  const kept = after.flatMap((tool) => {
    const was = old.get(tool.name);
    return was === undefined ? [] : [{ was, now: tool }];
  });
  const changed = kept.filter(
    ({ was, now }) => toolJson(was) !== toolJson(now)
  );
  return {
    added: after.length - kept.length,
    removed: before.length - kept.length,
    changed: changed.length,
    reclassed: changed.filter(
      ({ was, now }) => classByRules(was, scope) !== classByRules(now, scope)
    ).length,
  };
};

/**
 * `connection`'s tools as its server lists them now: as kept while the
 * last read is fresh, read again and kept whole once it isn't. Throws
 * `connect.server_unavailable` when the list can't be read.
 */
export const currentTools = async (
  env: Env,
  connection: Connection
): Promise<ConnectorTool[]> => {
  const now = Date.now();
  if ((connection.toolListFreshUntil?.getTime() ?? 0) > now) {
    return await keptTools(env.DB, connection.id);
  }
  let listed: Awaited<ReturnType<ReturnType<typeof modernMcpServer>["list"]>>;
  try {
    const server = await serverFor(
      env,
      connection,
      (method) => method === "tools/list"
    );
    listed = await server.list(maxListedTools);
  } catch (error) {
    if (error instanceof McpError) {
      throw connectErrors.create("connect.server_unavailable");
    }
    // Its server asked every caller to wait (the connection paused): the
    // list can't be read until the wait is over.
    const paused = pausedWait(error);
    if (paused !== undefined) {
      throw connectErrors.create("connect.server_unavailable", {
        retryAfterSeconds: Math.ceil(paused.retryAfterMs / 1000),
      });
    }
    throw error;
  }
  const counts = new Map<string, number>();
  for (const { name } of listed.tools) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const tools = listed.tools.flatMap((each) => {
    const tool = counts.get(each.name) === 1 ? toolOf(each) : undefined;
    return tool === undefined ? [] : [tool];
  });
  const db = drizzle(env.DB);
  // Kept only for the connection as it was when the list was asked for:
  // still active, not changed since (signed in again, disconnected), its
  // person not being erased, and its list not kept since by another read,
  // so of reads at once one keeps its list and records the change.
  const asAsked = sql`EXISTS (SELECT 1 FROM ${connections} WHERE ${connections.id} = ${connection.id} AND ${connections.status} = 'active' AND ${connections.updatedAt} = ${connection.updatedAt.getTime()} AND ${connections.toolListReadAt} IS ${connection.toolListReadAt?.getTime() ?? null} AND NOT ${ownerErased(connection.id)})`;
  const read = db
    .update(connections)
    .set({
      toolListReadAt: new Date(now),
      toolListFreshUntil: new Date(
        now +
          Math.min(
            Math.max(listed.ttlMs ?? defaultListTtlMs, minListTtlMs),
            maxListTtlMs
          )
      ),
    })
    .where(and(eq(connections.id, connection.id), asAsked));
  // A list this read didn't keep: another read kept its own first, and
  // what is callable is what that one kept and recorded; or the connection
  // changed since (signed in again, disconnected), and the list serves
  // this call alone.
  const notKept = async (): Promise<ConnectorTool[]> => {
    const row = await db
      .select({ status: connections.status, updatedAt: connections.updatedAt })
      .from(connections)
      .where(eq(connections.id, connection.id))
      .get();
    return row?.status === "active" &&
      row.updatedAt.getTime() === connection.updatedAt.getTime()
      ? await keptTools(env.DB, connection.id)
      : tools;
  };
  // An unchanged list is kept as it is: only its freshness moves.
  const kept = await keptTools(env.DB, connection.id);
  if (
    kept.toSorted(byName).map(toolJson).join("\n") ===
    tools.toSorted(byName).map(toolJson).join("\n")
  ) {
    const moved = await read.returning({ id: connections.id });
    return moved.length > 0 ? tools : await notKept();
  }
  const rows = tools.map(
    (tool) =>
      sql`(${connection.id}, ${tool.name}, ${tool.description}, ${JSON.stringify(tool.inputSchema)}, ${tool.outputSchema === undefined ? null : JSON.stringify(tool.outputSchema)}, ${JSON.stringify(tool.annotations)})`
  );
  const inserts = [];
  for (let start = 0; start < rows.length; start += toolsPerInsert) {
    inserts.push(
      db
        .insert(connectionTools)
        .select(
          sql`SELECT * FROM (VALUES ${sql.join(rows.slice(start, start + toolsPerInsert), sql`, `)}) WHERE ${asAsked}`
        )
    );
  }
  const writes = [
    db
      .delete(connectionTools)
      .where(and(eq(connectionTools.connectionId, connection.id), asAsked)),
    ...inserts,
    read,
  ] as const;
  // Recorded once, exactly when the list it read is kept: a first read
  // too, as every tool it adds is callable from then on.
  const [recorded] = await recordEventsIf(env, [
    {
      entry: connectionEvent(null, "connector.tools.changed", connection.id, {
        connector: connection.server,
        first: connection.toolListReadAt === null,
        ...listChanges(kept, tools, connection.scope),
      }),
      from: connections,
      where: asAsked,
      writes,
    },
  ]);
  return recorded === true ? tools : await notKept();
};

/** The names of the tools an admin blocked on connector `connectorId`. */
const blockedToolsOf = async (
  db: D1Database,
  connectorId: string
): Promise<Set<string>> => {
  const rows = await drizzle(db)
    .select({ name: connectorBlockedTools.name })
    .from(connectorBlockedTools)
    .where(eq(connectorBlockedTools.connectorId, connectorId));
  return new Set(rows.map(({ name }) => name));
};

/**
 * `connection`'s tools as its server lists them now (`currentTools`),
 * but those an admin blocked on its connector: what it offers.
 */
export const offeredTools = async (
  env: Env,
  connection: Connection
): Promise<ConnectorTool[]> => {
  const [tools, blocked] = await Promise.all([
    currentTools(env, connection),
    blockedToolsOf(env.DB, connection.server),
  ]);
  return tools.filter(({ name }) => !blocked.has(name));
};

/**
 * Reads and keeps `connection`'s tool list as its server lists it now,
 * if it can: a failure is logged, and the list is read at the next need.
 */
const readToolList = async (
  env: Env,
  connection: Connection
): Promise<void> => {
  try {
    await currentTools(env, connection);
  } catch (error) {
    log.warn("connections.tool_list_unread", {
      connectionId: connection.id,
      ...errorFields(error),
    });
  }
};

/**
 * Reads `connection`'s tool list if no read after an answer started in
 * the last `laterReadGapMs`: the read it marks started is the only one,
 * however many asks see the list stale at once, and one that fails isn't
 * tried again until the gap has passed.
 */
const readOnceLater = async (
  env: Env,
  connection: Connection,
  now: number
): Promise<void> => {
  let started: { id: string }[];
  try {
    started = await drizzle(env.DB)
      .update(connections)
      .set({ toolListTriedAt: new Date(now) })
      .where(
        and(
          eq(connections.id, connection.id),
          eq(connections.status, "active"),
          eq(connections.updatedAt, connection.updatedAt),
          or(
            isNull(connections.toolListFreshUntil),
            lte(connections.toolListFreshUntil, new Date(now))
          ),
          or(
            isNull(connections.toolListTriedAt),
            lte(connections.toolListTriedAt, new Date(now - laterReadGapMs))
          )
        )
      )
      .returning({ id: connections.id });
  } catch (error) {
    log.warn("connections.tool_list_unread", {
      connectionId: connection.id,
      ...errorFields(error),
    });
    return;
  }
  if (started.length > 0) {
    await readToolList(env, connection);
  }
};

/**
 * Reads an active `connection`'s tool list again after an answer
 * (`later`), when it is stale or was never read, for the next ask to see:
 * one read at a time, and none for a while after one (`readOnceLater`).
 * Freshness stays as it was, so a list that can't be read is still read
 * live where a call or a request needs it, and says why it can't be.
 */
const refreshLater = (
  env: Env,
  connection: Connection,
  later: (work: Promise<unknown>) => void
): void => {
  const now = Date.now();
  if (
    connection.status === "active" &&
    (connection.toolListFreshUntil?.getTime() ?? 0) <= now &&
    (connection.toolListTriedAt?.getTime() ?? 0) <= now - laterReadGapMs
  ) {
    later(readOnceLater(env, connection, now));
  }
};

/**
 * `connection`'s tools as kept, answered at once, so no server holds up a
 * search, but those an admin blocked on its connector; a list stale or
 * never read is read again after (`later`).
 */
export const keptToolsNow = async (
  env: Env,
  connection: Connection,
  later: (work: Promise<unknown>) => void
): Promise<ConnectorTool[]> => {
  refreshLater(env, connection, later);
  const [tools, blocked] = await Promise.all([
    keptTools(env.DB, connection.id),
    blockedToolsOf(env.DB, connection.server),
  ]);
  return tools.filter(({ name }) => !blocked.has(name));
};

/**
 * The tools each connection to a connector in `request` offers to ask
 * for, by its ID: those of its list as kept that the rules class (tools
 * Grasp never runs are left out), answered at once, so no server holds
 * up what a chat is offered. A list gone stale, or never read (its read
 * at connecting failed), is read again after the answer (`later`), for
 * the next ask to see what its server lists now. Any other connection, an
 * inactive one or an unknown ID is left out.
 */
export const offeredConnectorTools = async (
  env: Env,
  request: unknown,
  later: (work: Promise<unknown>) => void
): Promise<Record<string, string[]>> => {
  const ids = connectErrors.parse(
    "connect.invalid",
    connectionOwnersSchema,
    request
  );
  if (ids.length === 0) {
    return {};
  }
  // By ID alone: D1 binds at most 100 to a statement, as many as `ids`.
  const found = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(inArray(connections.id, ids));
  const rows = found.filter(
    ({ serverKind, status }) =>
      serverKind === "connector" && status === "active"
  );
  const kept = await keptToolClasses(env.DB, rows);
  for (const row of rows) {
    refreshLater(env, row, later);
  }
  return Object.fromEntries(
    rows.map((row) => [row.id, Object.keys(kept.get(row.id) ?? {})])
  );
};

/**
 * Reads and keeps the tool list of `connectionId` as it is connected, or
 * connected again, when it is a connection to a connector: what it offers
 * to ask for is then known before anyone calls it. A list that can't be
 * read now is read again at the next ask. Awaited by the sign-in, so what
 * the person just connected is offered at once.
 */
export const keepToolList = async (
  env: Env,
  connectionId: string
): Promise<void> => {
  let connection: Connection | undefined;
  try {
    connection = await drizzle(env.DB)
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .get();
  } catch (error) {
    log.warn("connections.tool_list_unread", {
      connectionId,
      ...errorFields(error),
    });
    return;
  }
  if (
    connection?.serverKind === "connector" &&
    connection.status === "active"
  ) {
    await readToolList(env, connection);
  }
};

/**
 * The classes of connection `connectionId`'s tools by the rules, from its
 * server's list as it is now: none for a connection that isn't an active
 * one to a connector. Throws `connect.server_unavailable` when the list
 * can't be read.
 */
export const connectorToolClasses = async (
  env: Env,
  connectionId: unknown
): Promise<Record<string, Exclude<ToolClass, "never">>> => {
  const id = connectionIdSchema.safeParse(connectionId);
  const connection = id.success
    ? await drizzle(env.DB)
        .select()
        .from(connections)
        .where(eq(connections.id, id.data))
        .get()
    : undefined;
  if (
    connection?.serverKind !== "connector" ||
    connection.status !== "active"
  ) {
    return {};
  }
  return classesOf(await offeredTools(env, connection), connection.scope);
};

/** Whether `toolClass` only reads. */
const reads = (toolClass: ToolClass): boolean =>
  toolClass === "read-own" ||
  toolClass === "read-company" ||
  toolClass === "read-others";

/** The input properties a tool's schema names at its top. */
const topProperties = (inputSchema: Json): string[] => [
  ...new Set(topNames(inputSchema)),
];

/** `tools`' tool named exactly `name`, if any. */
const named = (
  tools: readonly ConnectorTool[],
  name: string
): ConnectorTool | undefined => tools.find((tool) => tool.name === name);

/**
 * The tool a call of `action` on `connection` names, as connect takes it
 * now, and how to reach it: a server that sends nothing but that tool's
 * call. Throws `connect.tool_blocked` for one an admin blocked on the
 * connector, `connect.never` for a tool Grasp never runs,
 * `connect.action_not_found` for one the server doesn't list now,
 * `connect.class_changed` when core let the call through as `checked`
 * (`CapabilityClaims.toolClass`) and the rules class it otherwise now, and
 * `connect.server_unavailable` when its list can't be read.
 */
export const connectorAction = async (
  env: Env,
  connection: Connection,
  action: string,
  checked: ToolClass | undefined
): Promise<{ tool: McpTool; open: () => Promise<Pick<McpServer, "call">> }> => {
  // Refused before its list is read: nothing goes out for it.
  const blocked = await blockedToolsOf(env.DB, connection.server);
  if (blocked.has(action)) {
    throw connectErrors.create("connect.tool_blocked");
  }
  const listed = named(await currentTools(env, connection), action);
  if (listed === undefined) {
    throw connectErrors.create("connect.action_not_found");
  }
  const toolClass = classByRules(listed, connection.scope);
  if (toolClass === "never") {
    throw connectErrors.create("connect.never");
  }
  if (checked !== undefined && checked !== toolClass) {
    throw connectErrors.create("connect.class_changed");
  }
  const headers =
    paramHeadersOf(listed.inputSchema) ?? new Map<string, string>();
  const callName = mcpHeaderValue(action);
  return {
    tool: {
      name: action,
      readOnly: reads(toolClass),
      resourceField: undefined,
      inputProperties: topProperties(listed.inputSchema),
    },
    open: async () => {
      const server = await serverFor(
        env,
        connection,
        (method, name) => method === "tools/call" && name === callName
      );
      return {
        call: async (name, input) => {
          // Checked again last, after its list and credential were read
          // and a write's key claimed: a tool blocked by then gets nothing
          // (call.ts frees the key).
          const blockedSince = await blockedToolsOf(env.DB, connection.server);
          if (blockedSince.has(action)) {
            throw connectErrors.create("connect.tool_blocked");
          }
          const sent: Record<string, string> = {};
          for (const [property, header] of headers) {
            const value = input[property];
            if (
              typeof value === "string" ||
              typeof value === "boolean" ||
              (typeof value === "number" && Number.isSafeInteger(value))
            ) {
              sent[`mcp-param-${header}`] = mcpHeaderValue(String(value));
            }
          }
          const result = await server.call(name, input, sent);
          // What a server says of its own call is not taken: no items it
          // claims to have read, no word that it did nothing.
          return {
            ...result,
            provenance: [],
            notPerformed: false,
            effectAbsent: false,
            change: undefined,
          };
        },
      };
    },
  };
};

/** The contract a connection to connector `id` serves. */
export const connectorContractId = (id: string): string => `connector.${id}@1`;

/**
 * `connection`'s contract, its tools as its server lists them now, each
 * with its class by the rules and its schemas as served
 * (served-schemas.ts). A tool Grasp never runs, or whose schemas can't be
 * served, isn't in it. Throws `connect.contract_not_found` when no tool
 * is, and `connect.server_unavailable` when the list can't be read.
 */
export const connectorContract = async (
  env: Env,
  connection: Connection
): Promise<ConnectorContract> => {
  const tools = await offeredTools(env, connection);
  const actions: Record<string, ConnectorContractAction> = Object.fromEntries(
    tools.flatMap((tool) => {
      const toolClass = classByRules(tool, connection.scope);
      const input = servedSchema(tool.inputSchema);
      const output =
        tool.outputSchema === undefined
          ? textAnswer
          : servedSchema(tool.outputSchema);
      return toolClass === "never" ||
        !actionNamePattern.test(tool.name) ||
        input === undefined ||
        output === undefined
        ? []
        : [
            [
              tool.name,
              {
                tool: tool.name,
                readOnly: reads(toolClass),
                class: toolClass,
                input,
                output,
              },
            ],
          ];
    })
  );
  if (Object.keys(actions).length === 0) {
    throw connectErrors.create("connect.contract_not_found");
  }
  return { contract: connectorContractId(connection.server), actions };
};

/**
 * What core needs of `action` before a chat's agent calls it: whether it
 * reads, by the rules, and its input's properties.
 */
export const connectorActionShape = async (
  env: Env,
  connection: Connection,
  action: string
): Promise<ActionShape> => {
  const listed = named(await offeredTools(env, connection), action);
  const toolClass =
    listed === undefined ? "never" : classByRules(listed, connection.scope);
  if (listed === undefined || toolClass === "never") {
    throw connectErrors.create("connect.action_not_found");
  }
  return {
    readOnly: reads(toolClass),
    inputs: topProperties(listed.inputSchema),
    provider: connection.provider,
  };
};

/** Connector `id`, or `connect.catalog_entry_not_found` when there's none. */
const requireConnector = async (env: Env, id: string): Promise<void> => {
  if ((await connectorRow(env.DB, id)) === undefined) {
    throw connectErrors.create("connect.catalog_entry_not_found");
  }
};

/**
 * A connector's tools for an admin (`ConnectApi.connectorTools`): each
 * tool its active connections' lists hold as last read, by name, as the
 * list read last holds it, with its class by the rules on a shared
 * connection; and each name an admin blocked, held or not.
 */
export const connectorTools = async (
  env: Env,
  request: unknown
): Promise<ConnectorToolView[]> => {
  const { person, connector } = connectionErrors.parse(
    "connection.invalid",
    connectorToolsRequestSchema,
    request
  );
  if (!isAdmin(person.role)) {
    throw roleErrors.create("role.forbidden");
  }
  await requireConnector(env, connector);
  const db = drizzle(env.DB);
  // One row a name, as the list read last holds it, however many people
  // connected: what is read grows with the connector's tools alone.
  const newest = db
    .select({
      name: connectionTools.name,
      description: connectionTools.description,
      inputSchema: connectionTools.inputSchema,
      annotations: connectionTools.annotations,
      rank: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${connectionTools.name} ORDER BY ${connections.toolListReadAt} DESC)`.as(
        "rank"
      ),
    })
    .from(connectionTools)
    .innerJoin(connections, eq(connections.id, connectionTools.connectionId))
    .where(
      and(
        eq(connections.server, connector),
        eq(connections.serverKind, "connector"),
        eq(connections.status, "active")
      )
    )
    .as("newest");
  const [rows, blocked] = await Promise.all([
    db.select().from(newest).where(eq(newest.rank, 1)),
    blockedToolsOf(env.DB, connector),
  ]);
  const listed = new Map(rows.map((row) => [row.name, row]));
  return [...new Set([...listed.keys(), ...blocked])].toSorted().map((name) => {
    const tool = listed.get(name);
    return {
      name,
      description: tool?.description ?? null,
      class:
        tool === undefined
          ? null
          : classByRules(
              {
                name,
                inputSchema: storedSchema(tool.inputSchema),
                annotations: tool.annotations,
              },
              "shared"
            ),
      blocked: blocked.has(name),
    };
  });
};

/**
 * Blocks one of a connector's tools by name, or lets it through again
 * (`ConnectApi.blockConnectorTool`), for an admin who isn't staff. Its
 * event is recorded exactly when it changes something: blocking a tool
 * already blocked records nothing.
 */
export const blockConnectorTool = async (
  env: Env,
  request: unknown
): Promise<void> => {
  const { person, connector, tool, blocked } = connectionErrors.parse(
    "connection.invalid",
    blockConnectorToolSchema,
    request
  );
  const action = blocked
    ? "connector.tool.blocked"
    : "connector.tool.unblocked";
  const detail = { connector, tool };
  await refuseStaff(env, person, detail, action);
  if (!isAdmin(person.role)) {
    await auditRefusal(env, person, action, {
      ...detail,
      outcome: "refused",
      reason: "role.forbidden",
    });
    throw roleErrors.create("role.forbidden");
  }
  await requireConnector(env, connector);
  const db = drizzle(env.DB);
  const isBlocked = sql`EXISTS (SELECT 1 FROM ${connectorBlockedTools} WHERE ${connectorBlockedTools.connectorId} = ${connector} AND ${connectorBlockedTools.name} = ${tool})`;
  await recordEventIf(
    env,
    connectionEvent(person, action, undefined, { ...detail, outcome: "ok" }),
    {
      from: connectors,
      where: sql`${connectors.id} = ${connector} AND ${blocked ? sql`NOT ${isBlocked}` : isBlocked}`,
    },
    [
      blocked
        ? db
            .insert(connectorBlockedTools)
            .values({
              connectorId: connector,
              name: tool,
              blockedBy: person.userId,
              blockedAt: new Date(),
            })
            .onConflictDoNothing()
        : db
            .delete(connectorBlockedTools)
            .where(
              and(
                eq(connectorBlockedTools.connectorId, connector),
                eq(connectorBlockedTools.name, tool)
              )
            ),
    ]
  );
};
