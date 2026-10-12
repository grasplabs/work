import { connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectorContract,
  ConnectorContractAction,
} from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";

import { allowedTool, composioServer } from "./connections.ts";
import type { Connection } from "./connections.ts";
import { McpError } from "./mcp.ts";
import type { McpListedTool } from "./mcp.ts";

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
// - only tools on the admin's allowlist are served, a read only if the
//   admin said so (`ToolRule.read`), never by Composio's hint;
// - a tool is served only by a name an App can declare, once: a name
//   listed twice is ambiguous, and left out;
// - a schema is served only up to `maxSchemaBytes` and `maxSchemaDepth`;
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

/** Largest schema served for one side of one action, in bytes of JSON. */
const maxSchemaBytes = 64 * 1024;

/** Deepest a served schema nests, as core reads them. */
const maxSchemaDepth = 32;

/** A name an App can declare as an action (the SDK's own rule). */
const actionNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/** What a tool without an output schema answers: its text. */
const textAnswer = JSON.stringify({ type: "string" });

const isRecord = (value: Json | undefined): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `schema` with each object that names its properties, and says nothing
 * of others, closed; at its subschemas only (`properties`, `items`,
 * `anyOf`, `additionalProperties`), never inside a value such as a
 * `const`. Undefined when it nests deeper than `maxSchemaDepth`.
 */
const closedSchema = (schema: Json, depth: number): Json | undefined => {
  if (depth > maxSchemaDepth) {
    return undefined;
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const deeper = (each: Json): Json | undefined =>
    closedSchema(each, depth + 1);
  const closed: Record<string, Json> = {};
  for (const [key, value] of Object.entries(schema)) {
    let served: Json | undefined = value;
    if (key === "properties" && isRecord(value)) {
      const properties: Record<string, Json> = {};
      for (const [name, property] of Object.entries(value)) {
        const read = deeper(property);
        if (read === undefined) {
          return undefined;
        }
        Object.defineProperty(properties, name, {
          value: read,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      served = properties;
    } else if (key === "anyOf" && Array.isArray(value)) {
      const members = value.map(deeper);
      served = members.every((member) => member !== undefined)
        ? members
        : undefined;
    } else if (key === "items" || key === "additionalProperties") {
      served = deeper(value);
    }
    if (served === undefined) {
      return undefined;
    }
    Object.defineProperty(closed, key, {
      value: served,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (
    isRecord(closed.properties) &&
    !Object.hasOwn(closed, "additionalProperties")
  ) {
    closed.additionalProperties = false;
  }
  return closed;
};

/** `schema` as served, as JSON text; undefined if it is too large or deep. */
const servedSchema = (schema: Json): string | undefined => {
  const closed = closedSchema(schema, 1);
  if (closed === undefined) {
    return undefined;
  }
  const text = JSON.stringify(closed);
  return new TextEncoder().encode(text).byteLength > maxSchemaBytes
    ? undefined
    : text;
};

/** The tools the server lists, each named once; a name listed twice is left out. */
const listedOnce = (tools: readonly McpListedTool[]): McpListedTool[] => {
  const counts = new Map<string, number>();
  for (const { name } of tools) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return tools.filter(({ name }) => counts.get(name) === 1);
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
  let listed: McpListedTool[];
  try {
    listed = await composioServer(env, connection).tools();
  } catch (error) {
    throw error instanceof McpError
      ? connectErrors.create("connect.server_unavailable")
      : error;
  }
  const actions: Record<string, ConnectorContractAction> = {};
  for (const { name, inputSchema, outputSchema } of listedOnce(listed)) {
    const rule = allowedTool(connection, name);
    const input = servedSchema(inputSchema);
    const output =
      outputSchema === undefined ? textAnswer : servedSchema(outputSchema);
    if (
      rule !== undefined &&
      actionNamePattern.test(name) &&
      input !== undefined &&
      output !== undefined
    ) {
      actions[name] = { tool: name, readOnly: rule.read, input, output };
    }
  }
  if (Object.keys(actions).length === 0) {
    throw connectErrors.create("connect.contract_not_found");
  }
  return { contract, actions };
};
