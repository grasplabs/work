import { composioToolsMax, connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectorContract,
  ConnectorContractAction,
} from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { composioTools } from "./catalog.ts";
import { composioKey } from "./composio.ts";
import {
  allowedTool,
  composioServer,
  offeredToolNames,
  readOnlyNow,
} from "./connections.ts";
import type { Connection } from "./connections.ts";
import { connections, connectionTools } from "./db/schema.ts";
import { McpError } from "./mcp.ts";
import type { McpListedTool } from "./mcp.ts";
import {
  actionNamePattern,
  isShallowJson,
  servedSchema,
  textAnswer,
} from "./served-schemas.ts";

// A Composio connection's generated contract, `composio.<toolkit>@1`: the
// tools its admin allowed, each an action named by its tool, with the
// schemas the connection's own MCP server lists for it now. Composio can
// change a toolkit without a release of ours, so nothing is snapshotted:
// core asks for the contract as an admin approves a binding and again
// before every request, and fingerprints it, so a schema Composio changed
// (or a rule our admin changed) stops the binding until an admin approves
// it again, as a native connector's release does. `@1` is how the contract
// is made, not Composio's version of the toolkit.
//
// Everything the server lists is untrusted (threat model on GRA-504):
// - only tools on the admin's allowlist are served, each with its class,
//   a read only if the admin allowed it as one (`ToolRule`), never by
//   Composio's hint; nothing of any other tool is even read. The class is
//   fingerprinted with the rest, so an admin's change of it stops the
//   binding until an admin approves it again;
// - a tool is served only by a name an App can declare, once: a name
//   listed twice is ambiguous, and left out;
// - the list is read up to `maxListedTools`, and each schema is checked for
//   depth without recursion before anything else reads it, so a crafted
//   one can't overflow the stack; it is served only up to `maxSchemaDepth`
//   and `maxSchemaBytes`;
// - a schema with a `pattern` anywhere is left out: core would compile and
//   run Composio's regular expression on App arguments and answers, and
//   one that backtracks (`^(a+)+$`) would burn core's CPU. Native
//   connectors' patterns are ours, reviewed; Composio's tool stays usable
//   through chat;
// - an object that names its properties and says nothing of others is
//   served closed (`additionalProperties: false`): a call carries, and an
//   answer holds, only the fields the tool names. That only narrows what
//   passes, and is fingerprinted with the rest. What core still can't read
//   (an open object, a keyword it doesn't enforce) leaves the action
//   unbindable: no App gets an answer core can't check;
// - a tool that declares no output schema answers text, as MCP has it, so
//   its answer is a string (`textAnswer`) App code parses as data.
//
// The contract holds tool names and schemas only: never the server's URL,
// the connected account or connect's key.

/** The first part of every Composio contract's ID. */
export const composioContractPrefix = "composio";

/**
 * Most tools a server may list for its contract to be read: twice as many
 * as an admin may allow, so a list that big isn't one Composio makes.
 */
const maxListedTools = 2 * composioToolsMax;

/**
 * The tools the server lists, each named once; a name listed twice is left
 * out, whatever either entry holds (one without a schema too), as a call
 * of it is refused (`McpServer.tool`).
 */
const listedOnce = (tools: readonly McpListedTool[]): McpListedTool[] => {
  const counts = new Map<string, number>();
  for (const { name } of tools) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return tools.filter(({ name }) => counts.get(name) === 1);
};

/**
 * The tools `connection`'s session lists now, each named once
 * (`listedOnce`): `connect.server_unavailable` when its list can't be read.
 */
const listedNow = async (
  env: Env,
  connection: Connection
): Promise<McpListedTool[]> => {
  try {
    return listedOnce(
      await composioServer(env, connection).tools(maxListedTools)
    );
  } catch (error) {
    throw error instanceof McpError
      ? connectErrors.create("connect.server_unavailable")
      : error;
  }
};

/**
 * Each tool's description in Composio's catalog of `toolkit`, by name:
 * none while the catalog can't be read, as a tool is still described by
 * its schema then.
 */
const catalogDescriptions = async (
  env: Env,
  toolkit: string
): Promise<ReadonlyMap<string, string>> => {
  const key = composioKey(env);
  if (key === undefined) {
    return new Map();
  }
  try {
    const tools = await composioTools(key, toolkit);
    return new Map(
      tools.flatMap(({ name, description }) =>
        description === null ? [] : [[name, description] as const]
      )
    );
  } catch {
    return new Map();
  }
};

/** A Composio tool as the chat's search and `describe` hand it over. */
interface DescribedTool {
  name: string;
  description: string;
  input: unknown;
  output: unknown;
}

/**
 * How long a session's kept list stands before a search reads it again
 * after answering, and how long after one such read the next may start.
 */
const keptListTtlMs = 10 * 60 * 1000;
const laterReadGapMs = 5 * 60 * 1000;

/** Tools kept in one insert: six values each, under D1's hundred. */
const toolsPerInsert = 16;

/**
 * The tools a chat's agent may call through `connection`, as its session
 * lists them now: those connect offers (`offeredToolNames`: what the admin
 * allowed, but for what Grasp never runs), each with the input and output
 * schemas its session lists, which is what a call is checked against
 * there, and Composio's description of it from the catalog. A schema
 * nesting deeper than any served one (`isShallowJson`, walked without
 * recursion) is never read further: such a tool is left out, and such an
 * output said nothing of. Throws `connect.server_unavailable` when the
 * session's list can't be read. Logged by counts and names alone, so one
 * attempt shows a session that lists its tools by other names, or without
 * schemas.
 */
const describedNow = async (
  env: Env,
  connection: Connection
): Promise<DescribedTool[]> => {
  const offered = new Set(offeredToolNames(connection));
  const [listed, descriptions] = await Promise.all([
    listedNow(env, connection),
    catalogDescriptions(env, connection.provider),
  ]);
  const described = listed.flatMap(({ name, inputSchema, outputSchema }) =>
    offered.has(name) && isShallowJson(inputSchema)
      ? [
          {
            name,
            description: descriptions.get(name) ?? "",
            input: inputSchema,
            output: isShallowJson(outputSchema) ? outputSchema : undefined,
          },
        ]
      : []
  );
  log.info("composio.tools_described", {
    toolkit: connection.provider,
    listed: listed.length,
    offered: offered.size,
    described: described.length,
    withInput: described.filter(
      ({ input }) =>
        typeof input === "object" &&
        input !== null &&
        Object.keys(input).length > 0
    ).length,
    // Names alone, a few: tool names are Composio's, never anyone's data.
    listedSample: listed
      .slice(0, 5)
      .map(({ name }) => name.slice(0, 80))
      .join(","),
  });
  return described;
};

/**
 * Keeps `described`, read of `connection`'s session at `now`, as its tool
 * list (`connection_tools`) and marks it fresh: only while the connection
 * is active and allows what it did when read, so a list read before a
 * change of its tools, or a disconnect, is never kept after it.
 */
const keepDescribed = async (
  env: Env,
  connection: Connection,
  described: readonly DescribedTool[],
  now: number
): Promise<void> => {
  const db = drizzle(env.DB);
  const asRead = sql`EXISTS (SELECT 1 FROM ${connections} WHERE ${connections.id} = ${connection.id} AND ${connections.status} = 'active' AND ${connections.tools} IS ${connection.tools})`;
  const rows = described.map(
    (tool) =>
      sql`(${connection.id}, ${tool.name}, ${tool.description}, ${JSON.stringify(tool.input ?? {})}, ${tool.output === undefined ? null : JSON.stringify(tool.output)}, ${"{}"})`
  );
  const inserts = [];
  for (let start = 0; start < rows.length; start += toolsPerInsert) {
    inserts.push(
      db
        .insert(connectionTools)
        .select(
          sql`SELECT * FROM (VALUES ${sql.join(rows.slice(start, start + toolsPerInsert), sql`, `)}) WHERE ${asRead}`
        )
    );
  }
  await db.batch([
    db
      .delete(connectionTools)
      .where(and(eq(connectionTools.connectionId, connection.id), asRead)),
    ...inserts,
    db
      .update(connections)
      .set({
        toolListReadAt: new Date(now),
        toolListFreshUntil: new Date(now + keptListTtlMs),
      })
      .where(and(eq(connections.id, connection.id), asRead)),
  ]);
};

/**
 * The tools a chat's agent may call through `connection`, as `describe`
 * hands them to the model (contracts.ts `connectionTools`): read of its
 * session now (`describedNow`), which `describe` may wait for, as for a
 * connector, and kept for searches (`keepDescribed`). Throws
 * `connect.server_unavailable` when the session's list can't be read.
 */
export const composioDescribedTools = async (
  env: Env,
  connection: Connection
): Promise<DescribedTool[]> => {
  const now = Date.now();
  const described = await describedNow(env, connection);
  await keepDescribed(env, connection, described, now);
  return described;
};

/**
 * Reads and keeps `connection`'s tools of its session, if it can, as it
 * is connected or its kept list goes stale: a failure is logged, and the
 * list is read at the next need.
 */
export const keepComposioTools = async (
  env: Env,
  connection: Connection
): Promise<void> => {
  try {
    await composioDescribedTools(env, connection);
  } catch (error) {
    log.warn("composio.tool_list_unread", {
      connectionId: connection.id,
      ...errorFields(error),
    });
  }
};

/**
 * Reads and keeps `connection`'s tools after an answer (`keepComposioTools`),
 * unless another read started within `laterReadGapMs`: marked as tried
 * first, so one read runs at a time.
 */
const readOnceLater = async (
  env: Env,
  connection: Connection,
  now: number
): Promise<void> => {
  try {
    const started = await drizzle(env.DB)
      .update(connections)
      .set({ toolListTriedAt: new Date(now) })
      .where(
        and(
          eq(connections.id, connection.id),
          or(
            isNull(connections.toolListTriedAt),
            lte(connections.toolListTriedAt, new Date(now - laterReadGapMs))
          )
        )
      )
      .returning({ id: connections.id });
    if (started.length > 0) {
      await keepComposioTools(env, connection);
    }
  } catch (error) {
    log.warn("composio.tool_list_unread", {
      connectionId: connection.id,
      ...errorFields(error),
    });
  }
};

/** A kept schema, or undefined for one that can't be read. */
const keptSchema = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
};

/**
 * `connection`'s tools as kept (`keepDescribed`), of those it offers now,
 * answered at once, so no session holds up a search: none until a first
 * read, and a search shows names alone then. A list stale or never read is
 * read again after the answer (`later`): one read at a time, and none for
 * a while after one.
 */
export const composioKeptTools = async (
  env: Env,
  connection: Connection,
  later: (work: Promise<unknown>) => void
): Promise<DescribedTool[]> => {
  const now = Date.now();
  if (
    connection.status === "active" &&
    (connection.toolListFreshUntil?.getTime() ?? 0) <= now &&
    (connection.toolListTriedAt?.getTime() ?? 0) <= now - laterReadGapMs
  ) {
    later(readOnceLater(env, connection, now));
  }
  const offered = new Set(offeredToolNames(connection));
  const rows = await drizzle(env.DB)
    .select()
    .from(connectionTools)
    .where(eq(connectionTools.connectionId, connection.id));
  return rows.flatMap((row) => {
    const input = keptSchema(row.inputSchema);
    return offered.has(row.name) && input !== undefined
      ? [
          {
            name: row.name,
            description: row.description ?? "",
            input,
            output:
              row.outputSchema === null
                ? undefined
                : keptSchema(row.outputSchema),
          },
        ]
      : [];
  });
};

/**
 * The contract `contract` (`composio.<toolkit>@1`, the connection's own
 * toolkit) as `connection`'s server serves it now. Throws
 * `connect.contract_not_found` when none of its allowed tools can be
 * served, and `connect.server_unavailable` when the server can't be
 * reached or its list read.
 */
export const composioContract = async (
  env: Env,
  connection: Connection,
  contract: string
): Promise<ConnectorContract> => {
  const listed = await listedNow(env, connection);
  const actions: Record<string, ConnectorContractAction> = {};
  const taggedRead = await readOnlyNow(env, connection.provider);
  for (const { name, inputSchema, outputSchema } of listed) {
    // The admin's word and the name first: nothing else of a tool that
    // can't be served is read.
    const rule = actionNamePattern.test(name)
      ? allowedTool(connection, name, taggedRead)
      : undefined;
    const input =
      rule === undefined || inputSchema === undefined
        ? undefined
        : servedSchema(inputSchema);
    const output =
      input === undefined || outputSchema === undefined
        ? textAnswer
        : servedSchema(outputSchema);
    if (rule !== undefined && input !== undefined && output !== undefined) {
      actions[name] = {
        tool: name,
        readOnly: rule.read,
        class: rule.class,
        input,
        output,
      };
    }
  }
  if (Object.keys(actions).length === 0) {
    throw connectErrors.create("connect.contract_not_found");
  }
  return { contract, actions };
};
