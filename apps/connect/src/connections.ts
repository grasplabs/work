import {
  composioToolName,
  composioToolsSchema,
  connectErrors,
  connectionOwnersSchema,
  toolClassOf,
} from "@grasp-os/shared/connect";
import type {
  ConnectionOwner,
  ToolClass,
  ToolReach,
} from "@grasp-os/shared/connect";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { composioClasses } from "#composio-classes";

import { composioKey } from "./composio.ts";
import { connections } from "./db/schema.ts";
import { mcpServer } from "./mcp.ts";
import type { McpServer } from "./mcp.ts";
import { isNeverTool } from "./never.ts";

// The connection registry: which connections exist, whose they are, and
// which MCP server carries out their actions.

export type Connection = typeof connections.$inferSelect;

/**
 * Where Composio serves the MCP servers it creates: `composio.mcp.generate`
 * returns `https://backend.composio.dev/v3/mcp/<server id>?user_id=...`.
 */
const composioMcpHost = "backend.composio.dev";
const composioMcpPath = "/v3/mcp/";

/**
 * A Composio server's URL, as stored: HTTPS on Composio's MCP host, and
 * never with credentials in it (connect's key is added per call, in a
 * header). Anything else is never called, whatever the registry says.
 */
const composioUrlSchema = z.url({ protocol: /^https$/u }).refine((url) => {
  const { host, pathname, username, password } = new URL(url);
  return (
    host === composioMcpHost &&
    pathname.startsWith(composioMcpPath) &&
    username === "" &&
    password === ""
  );
});

/**
 * The connection a call may use: it exists, it is someone's personal
 * connection only if the call acts for that person, and it is active. Never
 * more than the person (R5): a personal connection holds one person's own
 * account, so an App or agent acting for anyone else can't reach it, even
 * with a permission for it.
 */
export const usableConnection = async (
  db: D1Database,
  connectionId: string,
  onBehalfOf: string
): Promise<Connection> => {
  const connection = await drizzle(db)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (connection === undefined) {
    throw connectErrors.create("connect.connection_not_found");
  }
  // Before the status, so nobody else learns anything about it.
  if (
    connection.scope === "personal" &&
    connection.ownerUserId !== onBehalfOf
  ) {
    throw connectErrors.create("connect.not_owner");
  }
  if (connection.status !== "active") {
    throw connectErrors.create("connect.connection_inactive");
  }
  return connection;
};

/** Whether `url` is one connect would call as a Composio server. */
export const isComposioServerUrl = (url: string): boolean =>
  composioUrlSchema.safeParse(url).success;

/**
 * The tools the admin allowed on a Composio connection, as stored: none
 * when they aren't recorded or can't be read.
 */
const storedTools = ({ tools }: Pick<Connection, "tools">) => {
  if (tools === null) {
    return [];
  }
  let stored: unknown;
  try {
    stored = JSON.parse(tools);
  } catch {
    return [];
  }
  return composioToolsSchema.safeParse(stored).data ?? [];
};

/** The names of the tools the admin allowed on a Composio connection. */
export const allowedToolNames = (connection: Pick<Connection, "tools">) =>
  storedTools(connection).map(composioToolName);

/**
 * What connect takes a tool the admin allowed on a Composio connection to
 * be: whether it only reads, which input property names its resource
 * (`ComposioToolRule`), and its class: the one it is taken to be, and the
 * one Grasp gave it.
 */
export interface ToolRule {
  read: boolean;
  resource: string | undefined;
  /** What a call of it is: Grasp's class, a change unless both say read. */
  class: Exclude<ToolClass, "never">;
  /**
   * The class Grasp gave it (composio-classes.ts), as reviewed. It goes in
   * the contract, not `class`: a reclass the admin's rule hides (a read
   * turned change, for a tool the admin never marked as a read) is still
   * a changed contract an admin approves again.
   */
  reviewed: Exclude<ToolClass, "never">;
}

/** Whom each class a tool can be given reaches. */
const reachOf = {
  "read-own": "own",
  "read-company": "company",
  "change-own": "own",
  "change-company": "company",
  "reach-others": "others",
} as const satisfies Record<Exclude<ToolClass, "never">, ToolReach>;

/**
 * The class Grasp gave `tool` of `toolkit` (composio-classes.ts), if it
 * was given one other than `never`. Both names are Composio's and the
 * admin's, so only the table's own entries are read: a tool named
 * `constructor` or `__proto__` has no class.
 */
const reviewedClass = (
  toolkit: string,
  tool: string
): Exclude<ToolClass, "never"> | undefined => {
  const tools = Object.hasOwn(composioClasses, toolkit)
    ? composioClasses[toolkit]
    : undefined;
  const reviewed =
    tools !== undefined && Object.hasOwn(tools, tool) ? tools[tool] : undefined;
  return reviewed === "never" ? undefined : reviewed;
};

/**
 * The rule for `action` on a Composio connection, if the admin allowed it
 * and Grasp classed it: a tool nobody classed is never offered, served in
 * a contract or run, whatever the admin allowed. One whose tools aren't
 * recorded, or can't be read, allows none. A tool allowed by name alone
 * is a side effect with no resource.
 *
 * A tool Grasp never runs (never.ts) has no rule either.
 *
 * A call is a read only when both say so: the class Grasp gave the tool
 * and the admin's rule. Neither alone makes a change a read: a classed
 * read the admin didn't mark is held as a change of the same reach, and a
 * tool the admin marked as a read is held when its class changes
 * something. The class it is then taken to be follows (`toolClassOf`).
 */
export const allowedTool = (
  connection: Pick<Connection, "provider" | "tools">,
  action: string
): ToolRule | undefined => {
  const tool = storedTools(connection).find(
    (each) => composioToolName(each) === action
  );
  // Never offered, served or run, whatever its review or the admin say.
  const reviewed =
    tool === undefined || isNeverTool(action)
      ? undefined
      : reviewedClass(connection.provider, action);
  if (tool === undefined || reviewed === undefined) {
    return undefined;
  }
  const rule =
    typeof tool === "string"
      ? { read: false, resource: undefined }
      : { read: tool.read === true, resource: tool.resource };
  const read =
    rule.read && (reviewed === "read-own" || reviewed === "read-company");
  return {
    read,
    resource: rule.resource,
    class: toolClassOf({ readOnly: read, reach: reachOf[reviewed] }),
    reviewed,
  };
};

/**
 * The names of the tools a Composio connection offers: those the admin
 * allowed that Grasp classed (`allowedTool`).
 */
export const offeredToolNames = (
  connection: Pick<Connection, "provider" | "tools">
): string[] =>
  allowedToolNames(connection).filter(
    (name) => allowedTool(connection, name) !== undefined
  );

/**
 * The Composio MCP server behind the connection, if its URL is one, with
 * connect's Composio key on each request (Composio requires it), and
 * never while the key is unset.
 */
export const composioServer = (env: Env, connection: Connection): McpServer => {
  const url = composioUrlSchema.safeParse(connection.server);
  const key = composioKey(env);
  if (!url.success || key === undefined) {
    throw connectErrors.create("connect.server_unavailable");
  }
  return mcpServer(url.data, async (request) => {
    const headers = new Headers(request.headers);
    headers.set("x-api-key", key);
    return await fetch(new Request(request, { headers }));
  });
};

/**
 * The class each tool a Composio connection offers is taken to be
 * (`allowedTool`), by its name.
 */
const offeredToolClasses = (
  connection: Pick<Connection, "provider" | "tools">
): Record<string, Exclude<ToolClass, "never">> =>
  Object.fromEntries(
    offeredToolNames(connection).flatMap((name) => {
      const rule = allowedTool(connection, name);
      return rule === undefined ? [] : [[name, rule.class]];
    })
  );

/**
 * Whose each connection `request` names is (`ConnectApi.connectionOwners`),
 * disconnected ones too: what an App read through a connection before it
 * was disconnected is still its owner's alone. With what it is (its
 * source and provider) and its account: its ID, name, email address and
 * the other addresses it receives mail at, which core records with the
 * mail a workflow run sends through it, and, for a Composio one, the
 * class of each tool it offers. Unknown IDs are left out.
 */
export const connectionOwners = async (
  db: D1Database,
  request: unknown
): Promise<ConnectionOwner[]> => {
  const ids = connectErrors.parse(
    "connect.invalid",
    connectionOwnersSchema,
    request
  );
  if (ids.length === 0) {
    return [];
  }
  const rows = await drizzle(db)
    .select({
      id: connections.id,
      ownerUserId: connections.ownerUserId,
      status: connections.status,
      source: connections.serverKind,
      provider: connections.provider,
      accountId: connections.accountId,
      accountName: connections.accountName,
      accountEmail: connections.accountEmail,
      accountAddresses: connections.accountAddresses,
      accountSenders: connections.accountSenders,
      tools: connections.tools,
    })
    .from(connections)
    .where(inArray(connections.id, ids));
  return rows.map(({ accountAddresses, accountSenders, tools, ...row }) => ({
    ...row,
    accountAddresses: accountAddresses ?? [],
    accountSenders: accountSenders ?? [],
    ...(row.source === "composio" && {
      toolClasses: offeredToolClasses({ provider: row.provider, tools }),
    }),
  }));
};
