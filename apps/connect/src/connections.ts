import { isNeverTool } from "@grasp-os/runtime/connector";
import {
  composioToolName,
  composioToolsSchema,
  connectErrors,
  connectionOwnersSchema,
  toolClassOf,
} from "@grasp-os/shared/connect";
import type {
  ConnectionOwner,
  PersonalAccount,
  ToolClass,
} from "@grasp-os/shared/connect";
import { sourceReaderProviders } from "@grasp-os/shared/source-readers";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { composioTools } from "./catalog.ts";
import { composioKey } from "./composio.ts";
import { connections } from "./db/schema.ts";
import { mcpServer } from "./mcp.ts";
import type { McpServer } from "./mcp.ts";
import { keptToolClasses } from "./tool-rules.ts";

// The connection registry: which connections exist, whose they are, and
// which MCP server carries out their actions.

export type Connection = typeof connections.$inferSelect;

/**
 * Where Composio serves a session's MCP endpoint: on its API host, at the
 * session's own path (`POST /tool_router/session` answers
 * `https://backend.composio.dev/api/v3/tool_router/session/<id>/mcp`).
 */
const composioMcpHost = "backend.composio.dev";
const composioSessionPath =
  /^\/api\/v3(?:\.1)?\/tool_router\/session\/(?<id>[^/]+)\/mcp$/u;

/**
 * What is wrong with `url` as the MCP endpoint of Composio's session
 * `sessionId`, if anything: connect calls only HTTPS on Composio's API
 * host, without credentials in it (connect's key is added per call, in a
 * header), at exactly that session's path, and never one naming a user or
 * an account of its own.
 */
export const sessionUrlProblem = (
  url: string,
  sessionId: string
): "host" | "path" | "user" | undefined => {
  if (!URL.canParse(url)) {
    return "host";
  }
  const { protocol, host, pathname, username, password, searchParams } =
    new URL(url);
  if (
    protocol !== "https:" ||
    host !== composioMcpHost ||
    username !== "" ||
    password !== ""
  ) {
    return "host";
  }
  if (
    composioSessionPath.exec(pathname)?.groups?.id !==
    encodeURIComponent(sessionId)
  ) {
    return "path";
  }
  return searchParams.has("user_id") || searchParams.has("connected_account_id")
    ? "user"
    : undefined;
};

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

/** A tool the admin allowed, as stored: its name, or its rule. */
type StoredTool = z.output<typeof composioToolsSchema>[number];

/** Each connection's allowed tools as read, by the row they were read from. */
const readTools = new WeakMap<
  Pick<Connection, "tools">,
  readonly StoredTool[]
>();

/**
 * The tools the admin allowed on a Composio connection, as stored: none
 * when they aren't recorded or can't be read. Read once for each row:
 * a connection allows up to a thousand, and each of them is looked up
 * here (`allowedTool`).
 */
const storedTools = (
  connection: Pick<Connection, "tools">
): readonly StoredTool[] => {
  const known = readTools.get(connection);
  if (known !== undefined) {
    return known;
  }
  let stored: unknown = null;
  try {
    stored = connection.tools === null ? null : JSON.parse(connection.tools);
  } catch {
    // Unreadable: it allows none.
  }
  const read = composioToolsSchema.safeParse(stored).data ?? [];
  readTools.set(connection, read);
  return read;
};

/** The names of the tools the admin allowed on a Composio connection. */
export const allowedToolNames = (connection: Pick<Connection, "tools">) =>
  storedTools(connection).map(composioToolName);

/** Those of them the admin marked as only reading, which run unheld. */
export const readToolNames = (connection: Pick<Connection, "tools">) =>
  storedTools(connection).flatMap((tool) =>
    typeof tool !== "string" && tool.read === true ? [tool.name] : []
  );

/**
 * The input property naming the one resource each tool acts on, for the
 * tools the admin gave one (`ComposioToolRule.resource`), by tool name.
 */
export const toolResourcesOf = (
  connection: Pick<Connection, "tools">
): Record<string, string> =>
  Object.fromEntries(
    storedTools(connection).flatMap((tool) =>
      typeof tool !== "string" && tool.resource !== undefined
        ? [[tool.name, tool.resource]]
        : []
    )
  );

/**
 * What connect takes a tool the admin allowed on a Composio connection to
 * be: whether it only reads, which input property names its resource
 * (`ComposioToolRule`), and its class.
 */
export interface ToolRule {
  read: boolean;
  resource: string | undefined;
  /**
   * What a call of it is: a read of what the connection holds when the
   * admin allowed it as a read, a change of it otherwise (`toolClassOf`).
   */
  class: Exclude<ToolClass, "never">;
}

/**
 * The admin's entry for `action` on a Composio connection, if they allowed
 * it: whether they allowed it as a read, and the input property naming its
 * resource. One whose tools aren't recorded, or can't be read, allows
 * none; a tool allowed by name alone is a change with no resource. What
 * Grasp never runs (`isNeverTool`) is refused by name, as it is for every
 * connection.
 */
export const allowedEntry = (
  connection: Pick<Connection, "tools">,
  action: string
): { read: boolean; resource: string | undefined } | undefined => {
  const tool = storedTools(connection).find(
    (each) => composioToolName(each) === action
  );
  if (tool === undefined || isNeverTool(action)) {
    return undefined;
  }
  return typeof tool === "string"
    ? { read: false, resource: undefined }
    : { read: tool.read === true, resource: tool.resource };
};

/**
 * The rule for `action` on a Composio connection, if the admin allowed it
 * (`allowedEntry`): the admin's allowlist is the gate. Every tool Composio
 * serves for the toolkit may be allowed, and whatever is allowed is
 * offered and runs; no review by Grasp stands in between.
 *
 * It is a read only when the admin allowed it as one and Composio tags it
 * read-only now (`taggedRead`, `readOnlyNow`): an entry stored as a read
 * of a tool Composio doesn't call read-only (one it stopped calling so, or
 * one stored before the connect form refused it) is a change, held for
 * its person. Its class follows: a read or a change of what the
 * connection holds (its person's own, or the company's). The company's
 * classes and a held change's confirmation then apply to it as to any
 * connection's.
 */
export const allowedTool = (
  connection: Pick<Connection, "tools" | "scope">,
  action: string,
  taggedRead: ReadonlySet<string>
): ToolRule | undefined => {
  const entry = allowedEntry(connection, action);
  if (entry === undefined) {
    return undefined;
  }
  const read = entry.read && taggedRead.has(action);
  return {
    read,
    resource: entry.resource,
    class: toolClassOf({
      readOnly: read,
      reach: connection.scope === "personal" ? "own" : "company",
    }),
  };
};

/**
 * The names of the tools Composio tags read-only now in `toolkit`, as the
 * catalog lists them (`composioTools`): none while connect has no key or
 * the catalog can't be read, so that nothing is taken for a read then.
 */
export const readOnlyNow = async (
  env: Env,
  toolkit: string
): Promise<ReadonlySet<string>> => {
  const key = composioKey(env);
  if (key === undefined) {
    return new Set();
  }
  try {
    const tools = await composioTools(key, toolkit);
    return new Set(
      tools.flatMap(({ name, readOnly }) => (readOnly ? [name] : []))
    );
  } catch (error) {
    const code = connectErrors.codeOf(error);
    if (
      code === "connect.catalog_unavailable" ||
      code === "connect.catalog_entry_not_found"
    ) {
      return new Set();
    }
    throw error;
  }
};

/**
 * The rule for one `action` (`allowedTool`), reading which tools Composio
 * tags read-only (`readOnlyNow`) only for an entry stored as a read: no
 * other can be a read, so a change asks Composio's catalog nothing.
 */
export const allowedToolNow = async (
  env: Env,
  connection: Pick<Connection, "tools" | "scope" | "provider">,
  action: string
): Promise<ToolRule | undefined> =>
  allowedTool(
    connection,
    action,
    allowedEntry(connection, action)?.read === true
      ? await readOnlyNow(env, connection.provider)
      : new Set()
  );

/**
 * The names of the tools a Composio connection offers: those the admin
 * allowed, but for what Grasp never runs (`allowedTool`).
 */
export const offeredToolNames = (
  connection: Pick<Connection, "tools">
): string[] =>
  allowedToolNames(connection).filter(
    (name) => allowedEntry(connection, name) !== undefined
  );

/**
 * The MCP endpoint of the Composio session behind the connection, if its
 * URL is that session's (`sessionUrlProblem`), with connect's Composio key
 * on each request (Composio requires it), and never while the key is
 * unset.
 */
export const composioServer = (env: Env, connection: Connection): McpServer => {
  const { server: url, composioSessionId: sessionId } = connection;
  const key = composioKey(env);
  if (
    sessionId === null ||
    sessionUrlProblem(url, sessionId) !== undefined ||
    key === undefined
  ) {
    throw connectErrors.create("connect.server_unavailable");
  }
  return mcpServer(url, async (request) => {
    const headers = new Headers(request.headers);
    headers.set("x-api-key", key);
    return await fetch(new Request(request, { headers }));
  });
};

/**
 * The class each tool a Composio connection offers is taken to be
 * (`allowedTool`, with what Composio tags read-only now), by its name.
 */
const offeredToolClasses = (
  connection: Pick<Connection, "tools" | "scope">,
  taggedRead: ReadonlySet<string>
): Record<string, Exclude<ToolClass, "never">> =>
  Object.fromEntries(
    offeredToolNames(connection).flatMap((name) => {
      const rule = allowedTool(connection, name, taggedRead);
      return rule === undefined ? [] : [[name, rule.class]];
    })
  );

/**
 * Whose each connection `request` names is (`ConnectApi.connectionOwners`),
 * disconnected ones too: what an App read through a connection before it
 * was disconnected is still its owner's alone. With what it is (its
 * source and provider) and its account: its ID, name, email address and
 * the other addresses it receives mail at, which core records with the
 * mail a workflow run sends through it, and, for a Composio one or one to
 * a connector, the class of each tool it offers (a connector's by its list
 * as kept). Unknown IDs are left out.
 */
export const connectionOwners = async (
  env: Env,
  request: unknown
): Promise<ConnectionOwner[]> => {
  const db = env.DB;
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
      scope: connections.scope,
    })
    .from(connections)
    .where(inArray(connections.id, ids));
  const connectorClasses = await keptToolClasses(
    db,
    rows.filter(({ source }) => source === "connector")
  );
  // What Composio tags read-only now, read once for each toolkit.
  const toolkits = [
    ...new Set(
      rows.flatMap(({ source, provider }) =>
        source === "composio" ? [provider] : []
      )
    ),
  ];
  const tagged = new Map(
    await Promise.all(
      toolkits.map(
        async (toolkit) => [toolkit, await readOnlyNow(env, toolkit)] as const
      )
    )
  );
  return rows.map(
    ({ accountAddresses, accountSenders, tools, scope, ...row }) => ({
      ...row,
      accountAddresses: accountAddresses ?? [],
      accountSenders: accountSenders ?? [],
      ...(row.source === "composio" && {
        toolClasses: offeredToolClasses(
          { tools, scope },
          tagged.get(row.provider) ?? new Set()
        ),
      }),
      ...(row.source === "connector" && {
        toolClasses: connectorClasses.get(row.id) ?? {},
      }),
    })
  );
};

/** The person `personalAccounts` is asked about: core's user ID. */
const accountsOwnerSchema = z.string().min(1);

/**
 * The suite accounts the person `request` names connected as their own
 * (`ConnectApi.personalAccounts`), disconnected ones too, each saying
 * whether it still is: connections connect made itself (`native`), pinned
 * to the company's tenant, whose account it took from the provider's
 * verified ID token at connecting (oauth.ts). One a token renewal lost
 * (`needs_reauth`) is still connected. Its address only as the provider
 * last confirmed it, and when (`verifiedEmail`, providers.ts
 * `confirmAddress`): Google's; Entra's address is not verified, so none
 * for Microsoft. Its groups as the last whole read of them said, and when
 * (reader-groups.ts).
 */
export const personalAccounts = async (
  db: D1Database,
  request: unknown
): Promise<PersonalAccount[]> => {
  const userId = connectErrors.parse(
    "connect.invalid",
    accountsOwnerSchema,
    request
  );
  const rows = await drizzle(db)
    .select({
      provider: connections.provider,
      tenant: connections.tenant,
      accountId: connections.accountId,
      verifiedEmail: connections.verifiedEmail,
      verifiedEmailAt: connections.verifiedEmailAt,
      pastVerifiedEmails: connections.pastVerifiedEmails,
      readerGroups: connections.readerGroups,
      readerGroupsAt: connections.readerGroupsAt,
      status: connections.status,
    })
    .from(connections)
    .where(
      and(
        eq(connections.ownerUserId, userId),
        eq(connections.scope, "personal"),
        eq(connections.serverKind, "native"),
        inArray(connections.provider, [...sourceReaderProviders]),
        isNotNull(connections.tenant),
        isNotNull(connections.accountId)
      )
    );
  return rows.flatMap(
    ({
      provider,
      tenant,
      accountId,
      verifiedEmail,
      verifiedEmailAt,
      pastVerifiedEmails,
      readerGroups,
      readerGroupsAt,
      status,
    }) =>
      tenant === null || accountId === null
        ? []
        : [
            {
              provider,
              tenant,
              accountId,
              verifiedEmail,
              verifiedEmailAt: verifiedEmailAt?.getTime() ?? null,
              pastVerifiedEmails: pastVerifiedEmails ?? [],
              groups: readerGroups ?? [],
              groupsReadAt: readerGroupsAt?.getTime() ?? null,
              connected: status !== "disconnected",
            },
          ]
  );
};

/**
 * A connection's past addresses once its confirmed address becomes
 * `next`, as SQL for the update that sets it: the address it held is
 * kept (`past_verified_emails`) when `next` replaces or clears it, once
 * however often it comes back, so its person's erasure still finds it. Read in the same statement, before the
 * update changes it.
 */
export const pastAddressesAfter = (next: string | null): SQL =>
  sql`CASE WHEN ${connections.verifiedEmail} IS NOT NULL AND ${connections.verifiedEmail} IS NOT ${next}
      AND NOT EXISTS (
        SELECT 1 FROM json_each(coalesce(${connections.pastVerifiedEmails}, '[]'))
        WHERE value = ${connections.verifiedEmail}
      )
    THEN json_insert(coalesce(${connections.pastVerifiedEmails}, '[]'), '$[#]', ${connections.verifiedEmail})
    ELSE ${connections.pastVerifiedEmails} END`;
