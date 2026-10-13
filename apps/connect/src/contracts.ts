import { generatedContracts } from "@grasp-os/connector-kit/manifest";
import {
  connectErrors,
  connectorContractRequestSchema,
} from "@grasp-os/shared/connect";
import type {
  ConnectorContract,
  ConnectorContractAction,
} from "@grasp-os/shared/connect";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  composioContract,
  composioContractPrefix,
} from "./composio-contracts.ts";
import type { Connection } from "./connections.ts";
import { nativeConnector } from "./connectors.ts";
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
