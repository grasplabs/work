import { generatedContracts } from "@grasp-os/connector-kit/manifest";
import {
  actionShapeRequestSchema,
  connectErrors,
  connectorContractRequestSchema,
} from "@grasp-os/shared/connect";
import type {
  ActionShape,
  ConnectorContract,
  ConnectorContractAction,
} from "@grasp-os/shared/connect";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { nativeConnector } from "./bundled-connectors.ts";
import {
  composioContract,
  composioContractPrefix,
} from "./composio-contracts.ts";
import { allowedTool } from "./connections.ts";
import type { Connection } from "./connections.ts";
import { connections } from "./db/schema.ts";

// Generated connector contracts (spec 12). Which one a connection serves
// is decided by the connection's kind, never by the name alone, so a
// toolkit named like one of our connectors, or a connector named like
// Composio, never serves the other's contract:
//
// - a native connection serves its connector's actions of one family, such
//   as its `mail.*` tools, as `<connector>.<family>@1`, with the JSON
//   Schemas the connector's own schemas make of each action's input and
//   output (connector-kit's manifest, `generatedContracts`). Read from the
//   release's manifests alone: nothing is loaded and no token is read;
// - a Composio connection serves `composio.<toolkit>@1`, its own toolkit's
//   allowed tools, as its server lists them now (composio-contracts.ts).
//
// Core binds an App's connector resource to one, checks every call's input
// and answer against it, and fingerprints it, so a change to any of it (a
// connector release, Composio changing a tool) stops the binding until an
// admin approves it again. No contract describes what the connection
// can't do.

/** A native connection's contract `contract`, if its connector serves it. */
const nativeContract = (
  connection: Connection,
  contract: string
): ConnectorContract | undefined => {
  const name = contract.slice(0, contract.indexOf("."));
  const connector =
    name === composioContractPrefix ? undefined : nativeConnector(name);
  const served =
    connector === undefined
      ? undefined
      : generatedContracts(connector.manifest).get(contract);
  if (
    served === undefined ||
    connection.serverKind !== "native" ||
    connection.server !== name ||
    connector?.manifest.provider !== connection.provider
  ) {
    return undefined;
  }
  const actions: Record<string, ConnectorContractAction> = {};
  for (const [action, { tool, declared }] of served) {
    actions[action] = {
      tool,
      readOnly: declared.readOnly,
      input: JSON.stringify(declared.contract.input),
      output: JSON.stringify(declared.contract.output),
    };
  }
  return { contract, actions };
};

/**
 * The contract `request` names, as its connection serves it now; or
 * `connect.contract_not_found`, or `connect.server_unavailable` when a
 * Composio connection's server can't be reached to read it.
 */
export const connectorContract = async (
  env: Env,
  request: unknown
): Promise<ConnectorContract> => {
  const parsed = connectorContractRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { contract, connectionId } = parsed.data;
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (connection === undefined || connection.status === "disconnected") {
    throw connectErrors.create("connect.contract_not_found");
  }
  if (connection.serverKind === "composio") {
    if (contract !== `${composioContractPrefix}.${connection.provider}@1`) {
      throw connectErrors.create("connect.contract_not_found");
    }
    return await composioContract(env, connection, contract);
  }
  const served = nativeContract(connection, contract);
  if (served === undefined) {
    throw connectErrors.create("connect.contract_not_found");
  }
  return served;
};

/** The properties a served JSON Schema names, or `null` for none it can tell. */
const propertiesOf = (schema: string | undefined): string[] | null => {
  if (schema === undefined) {
    return null;
  }
  const parsed: unknown = JSON.parse(schema);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const properties: unknown = Reflect.get(parsed, "properties");
  return typeof properties === "object" && properties !== null
    ? Object.keys(properties)
    : [];
};

/**
 * What core needs of `request`'s action before a chat's agent calls it
 * (`ActionShape`), by the same rules a call goes by: a Composio tool is a
 * read only as its admin allowed it, with the input its server lists now;
 * a native one as its manifest says. `connect.action_not_found` for an
 * action the connection doesn't allow, `connect.server_unavailable` when
 * a Composio server can't be reached to list its tools.
 */
export const actionShape = async (
  env: Env,
  request: unknown
): Promise<ActionShape> => {
  const parsed = actionShapeRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { connectionId, action } = parsed.data;
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (connection === undefined || connection.status === "disconnected") {
    throw connectErrors.create("connect.connection_not_found");
  }
  const { provider } = connection;
  if (connection.serverKind === "composio") {
    const rule = allowedTool(connection, action);
    if (rule === undefined) {
      throw connectErrors.create("connect.action_not_found");
    }
    let inputs: string[] | null = null;
    try {
      const served = await composioContract(
        env,
        connection,
        `${composioContractPrefix}.${provider}@1`
      );
      inputs = propertiesOf(
        Object.hasOwn(served.actions, action)
          ? served.actions[action]?.input
          : undefined
      );
    } catch (error) {
      // No tool of it can be served as a contract: its input is unknown.
      if (connectErrors.codeOf(error) !== "connect.contract_not_found") {
        throw error;
      }
    }
    return { readOnly: rule.read, inputs, provider };
  }
  const manifest = nativeConnector(connection.server)?.manifest;
  const declared =
    manifest !== undefined &&
    manifest.provider === provider &&
    Object.hasOwn(manifest.actions, action)
      ? manifest.actions[action]
      : undefined;
  if (declared === undefined) {
    throw connectErrors.create("connect.action_not_found");
  }
  return { readOnly: declared.readOnly, inputs: [...declared.input], provider };
};
