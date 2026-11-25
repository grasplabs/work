import {
  addConnectorSchema,
  connectErrors,
  connectionErrors,
} from "@grasp-os/shared/connect";
import type {
  ActionShape,
  ConnectorContract,
  ConnectorContractAction,
  ToolClass,
} from "@grasp-os/shared/connect";
import { isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEvents } from "./audit.ts";
import {
  auditRefusal,
  connectionEvent,
  refuseStaff,
} from "./connection-audit.ts";
import type { Connection } from "./connections.ts";
import { secretContext } from "./connector-providers.ts";
import { connections, connectionTools, connectors } from "./db/schema.ts";
import { resolvedPublic } from "./http-connections.ts";
import { clientFor, discoverSignIn } from "./mcp-discovery.ts";
import { McpError, mcpHeaderValue, modernMcpServer } from "./mcp.ts";
import type { ListedServerTool, McpServer, McpTool } from "./mcp.ts";
import {
  isShallowJson,
  maxSchemaBytes,
  servedSchema,
  textAnswer,
} from "./served-schemas.ts";
import { credentialFor } from "./tokens.ts";
import { classByRules, isJsonArray, storedSchema } from "./tool-rules.ts";
import type { ToolHints } from "./tool-rules.ts";
import { vaultFor } from "./vault.ts";

// Connectors made from an MCP server's URL (GRA-1375), and connections to
// them: the one connection kind, always to a connector. An admin enters a
// server's URL; connect checks where it leads, learns how it signs in and
// registers there (mcp-discovery.ts), and keeps it as the one-line
// `defineConnector({ name, mcp: { url } })` in `connectors`. People then
// connect to it as to any app (oauth.ts, connector-providers.ts), and
// connect alone holds their tokens.
//
// Everything the server says is untrusted (threat model on GRA-1375):
// - its tool list is read when the last read's `ttlMs` (an hour at most)
//   ran out, checked tool by tool, and kept whole: a tool whose schemas
//   are too deep or too large, whose name a call couldn't carry, or that
//   asks for headers connect won't send, isn't kept, and a name listed
//   twice is kept for neither;
// - each tool's class is computed from the list as kept now
//   (tool-rules.ts), never stored, so a changed tool is classed again and
//   a removed one serves no call, contract or binding;
// - a call goes only to the server's own URL, by POST, as `tools/call` of
//   the one tool it names, or as `tools/list` (`serverFor`), with the
//   connection's credential added there and nowhere else; no redirect is
//   followed, and every answer is capped and read as mcp.ts reads them;
// - what a server says of its own call (its provenance, that it did
//   nothing, what it changed) isn't taken: a remote write that failed is
//   of unknown outcome (policy.ts).

/** Most tools a server may list for connect to read the list at all. */
const maxListedTools = 500;

/** Longest description kept, in characters: the rest is cut off. */
const maxDescriptionLength = 4096;

/** Longest a tool list is fresh, whatever the server says. */
const maxListTtlMs = 60 * 60 * 1000;

/**
 * A tool name connect sends: MCP's own rule for names (1 to 128 of
 * letters, digits, `_`, `-` and `.`).
 */
const toolNamePattern = /^[A-Za-z0-9_.-]{1,128}$/u;

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

/** The server's URL an admin entered, if connect would ever call it. */
const serverUrlOf = (url: string): URL => {
  const parsed = URL.parse(url);
  const { hostname } = parsed ?? { hostname: "" };
  if (
    parsed?.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.search !== "" ||
    // An address, not a name: the URL parser writes IPv4 in any spelling
    // as dotted decimal, and IPv6 in brackets.
    /^[\d.]+$/u.test(hostname) ||
    hostname.startsWith("[")
  ) {
    throw connectionErrors.create("connection.server_refused");
  }
  return parsed;
};

/** A unique index refused the row: another connector has that URL. */
const isDuplicate = (error: unknown): boolean =>
  error instanceof Error &&
  [error.message, error.cause instanceof Error ? error.cause.message : ""].some(
    (message) => message.includes("UNIQUE") && message.includes("connectors")
  );

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
  const { person, name, url, origin, auth } = connectionErrors.parse(
    "connection.invalid",
    addConnectorSchema,
    request
  );
  const server = serverUrlOf(url);
  const detail = { host: server.host, auth: auth.kind };
  await refuseStaff(env, person, detail);
  if (!isAdmin(person.role)) {
    await auditRefusal(env, person, "connector.added", {
      ...detail,
      outcome: "refused",
      reason: "role.forbidden",
    });
    throw roleErrors.create("role.forbidden");
  }
  if ((await resolvedPublic(server.hostname)) !== "public") {
    throw connectionErrors.create("connection.server_refused");
  }
  const vault = await vaultFor(env);
  if (vault === undefined) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  const id = `mcp_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date();
  const common = { id, name, createdBy: person.userId, createdAt: now };
  let row: typeof connectors.$inferInsert;
  if (auth.kind === "header") {
    row = { ...common, url: server.href, auth: "header", header: auth.header };
  } else {
    const signIn = await discoverSignIn(server);
    const client = await clientFor(signIn, new URL(origin).origin, auth.client);
    row = {
      ...common,
      url: signIn.resource,
      auth: "oauth",
      issuer: signIn.issuer,
      authorizationEndpoint: signIn.authorizationEndpoint,
      tokenEndpoint: signIn.tokenEndpoint,
      revocationEndpoint: signIn.revocationEndpoint ?? null,
      scopes: signIn.scopes,
      issParameter: signIn.issParameter,
      registration: client.registration,
      clientId: client.id,
      clientSecret:
        client.secret === undefined
          ? null
          : await vault.seal(client.secret, secretContext(id, signIn.issuer)),
      clientAuthentication: client.authentication,
    };
  }
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
    !toolNamePattern.test(listed.name) ||
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
  const row = await drizzle(env.DB)
    .select({ url: connectors.url })
    .from(connectors)
    .where(eq(connectors.id, connection.server))
    .get();
  if (row === undefined) {
    throw connectErrors.create("connect.server_unavailable");
  }
  const credential = await credentialFor(env, connection.id);
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
    return await fetch(new Request(request, { headers, redirect: "manual" }));
  });
};

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
  await db.batch([
    db
      .delete(connectionTools)
      .where(eq(connectionTools.connectionId, connection.id)),
    ...tools.map((tool) =>
      db.insert(connectionTools).values({
        connectionId: connection.id,
        name: tool.name,
        description: tool.description,
        inputSchema: JSON.stringify(tool.inputSchema),
        outputSchema:
          tool.outputSchema === undefined
            ? null
            : JSON.stringify(tool.outputSchema),
        annotations: tool.annotations,
      })
    ),
    db
      .update(connections)
      .set({
        toolListReadAt: new Date(now),
        toolListFreshUntil: new Date(
          now + Math.min(listed.ttlMs ?? 0, maxListTtlMs)
        ),
      })
      .where(eq(connections.id, connection.id)),
  ]);
  return tools;
};

/** Whether `toolClass` only reads. */
const reads = (toolClass: ToolClass): boolean =>
  toolClass === "read-own" ||
  toolClass === "read-company" ||
  toolClass === "read-others";

/** The input properties a tool's schema names at its top. */
const topProperties = (inputSchema: Json): string[] =>
  isRecord(inputSchema) && isRecord(inputSchema.properties)
    ? Object.keys(inputSchema.properties)
    : [];

/** `tools`' tool named exactly `name`, if any. */
const named = (
  tools: readonly ConnectorTool[],
  name: string
): ConnectorTool | undefined => tools.find((tool) => tool.name === name);

/**
 * The tool a call of `action` on `connection` names, as connect takes it
 * now, and how to reach it: a server that sends nothing but that tool's
 * call. Throws `connect.never` for a tool Grasp never runs,
 * `connect.action_not_found` for one the server doesn't list now, and
 * `connect.server_unavailable` when its list can't be read.
 */
export const connectorAction = async (
  env: Env,
  connection: Connection,
  action: string
): Promise<{ tool: McpTool; open: () => Promise<Pick<McpServer, "call">> }> => {
  const listed = named(await currentTools(env, connection), action);
  if (listed === undefined) {
    throw connectErrors.create("connect.action_not_found");
  }
  const toolClass = classByRules(listed, connection.scope);
  if (toolClass === "never") {
    throw connectErrors.create("connect.never");
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
  const actions: Record<string, ConnectorContractAction> = {};
  for (const tool of await currentTools(env, connection)) {
    const toolClass = classByRules(tool, connection.scope);
    const input = servedSchema(tool.inputSchema);
    const output =
      tool.outputSchema === undefined
        ? textAnswer
        : servedSchema(tool.outputSchema);
    if (toolClass !== "never" && input !== undefined && output !== undefined) {
      actions[tool.name] = {
        tool: tool.name,
        readOnly: reads(toolClass),
        class: toolClass,
        input,
        output,
      };
    }
  }
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
  const listed = named(await currentTools(env, connection), action);
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
