import { classByRules } from "@grasp-os/runtime/connector";
import type { RuledTool } from "@grasp-os/runtime/connector";
import type { ConnectionScope, ToolClass } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";
import { and, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  connections,
  connectionTools,
  connectorBlockedTools,
} from "./db/schema.ts";
import { isShallowJson } from "./served-schemas.ts";

// The class of a tool an MCP server lists comes from the rules
// (`classByRules`, the runtime's tool-rules.ts): the same for every
// server, with no model and no person deciding tool by tool, and computed
// from the tool as the server lists it now, never stored. A tool the
// server changes is classed again the next time its list is read.

/**
 * A schema connect kept as JSON text (`connection_tools`), after it
 * checked it when its list was read: as it was, or no properties at all
 * should the row have been changed at rest.
 */
export const storedSchema = (text: string): Json => {
  const value: unknown = JSON.parse(text);
  return isShallowJson(value) ? value : {};
};

/**
 * The class of each of `tools` by the rules, by name, for a connection of
 * `scope`; tools Grasp never runs are left out. Built as own properties
 * whatever a name is (`__proto__` too).
 */
export const classesOf = (
  tools: readonly RuledTool[],
  scope: ConnectionScope
): Record<string, Exclude<ToolClass, "never">> =>
  Object.fromEntries(
    tools.flatMap((tool) => {
      const toolClass = classByRules(tool, scope);
      return toolClass === "never" ? [] : [[tool.name, toolClass]];
    })
  );

/**
 * The class of each tool kept for each of `rows`, connections to
 * connectors, by the rules, as their lists were last read: nothing is
 * asked of a server here. Tools Grasp never runs, and tools an admin
 * blocked on the connector, are left out.
 */
export const keptToolClasses = async (
  db: D1Database,
  rows: readonly { id: string; scope: ConnectionScope }[]
): Promise<Map<string, Record<string, Exclude<ToolClass, "never">>>> => {
  if (rows.length === 0) {
    return new Map();
  }
  const kept = await drizzle(db)
    .select()
    .from(connectionTools)
    .where(
      and(
        inArray(
          connectionTools.connectionId,
          rows.map(({ id }) => id)
        ),
        sql`NOT EXISTS (SELECT 1 FROM ${connectorBlockedTools} JOIN ${connections} ON ${connections.server} = ${connectorBlockedTools.connectorId} WHERE ${connections.id} = ${connectionTools.connectionId} AND ${connectorBlockedTools.name} = ${connectionTools.name})`
      )
    );
  return new Map(
    rows.map(({ id, scope }) => [
      id,
      classesOf(
        kept
          .filter(({ connectionId }) => connectionId === id)
          .map((row) => ({
            name: row.name,
            inputSchema: storedSchema(row.inputSchema),
            annotations: row.annotations,
          })),
        scope
      ),
    ])
  );
};
