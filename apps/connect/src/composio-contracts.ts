import { composioToolsMax, connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectorContract,
  ConnectorContractAction,
} from "@grasp-os/shared/connect";

import { allowedTool, composioServer } from "./connections.ts";
import type { Connection } from "./connections.ts";
import { McpError } from "./mcp.ts";
import type { McpListedTool } from "./mcp.ts";
import { servedSchema, textAnswer } from "./served-schemas.ts";

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
// - only tools on the admin's allowlist that Grasp classed are served
//   (composio-classes.ts), each with its class, a read only if both the
//   class and the admin say so (`ToolRule`), never by Composio's hint;
//   nothing of any other tool is even read. The class is fingerprinted
//   with the rest, so a release that reclasses a tool stops the binding
//   until an admin approves it again;
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

/** A name an App can declare as an action (the SDK's own rule). */
const actionNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

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
    listed = await composioServer(env, connection).tools(maxListedTools);
  } catch (error) {
    throw error instanceof McpError
      ? connectErrors.create("connect.server_unavailable")
      : error;
  }
  const actions: Record<string, ConnectorContractAction> = {};
  for (const { name, inputSchema, outputSchema } of listedOnce(listed)) {
    // The admin's word and the name first: nothing else of a tool that
    // can't be served is read.
    const rule = actionNamePattern.test(name)
      ? allowedTool(connection, name)
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
        class: rule.reviewed,
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
