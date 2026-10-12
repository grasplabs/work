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

import { nativeConnector } from "./connectors.ts";
import { connections } from "./db/schema.ts";

// Generated connector contracts (spec 12): a native connector's actions of
// one family, such as its `mail.*` tools, as the contract
// `<connector>.<family>@1`, with the JSON Schemas the connector's own
// schemas make of each action's input and output (connector-kit's
// manifest, `generatedContracts`). Core binds an App's connector resource
// to one, checks every call's input and answer against it, and
// fingerprints it, so a release of the connector that changes any of it
// stops the binding until an admin approves it again. Read from the
// release's manifests alone: nothing is loaded, no token is read, and the
// connection must be a native one of that very connector, so no contract
// describes what a connection can't do.

/**
 * The contract `request` names, as its connection serves it now; or
 * `connect.contract_not_found`.
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
  const name = contract.slice(0, contract.indexOf("."));
  const connection = await drizzle(env.DB)
    .select({
      provider: connections.provider,
      serverKind: connections.serverKind,
      server: connections.server,
      status: connections.status,
    })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  const connector = nativeConnector(name);
  const served =
    connector === undefined
      ? undefined
      : generatedContracts(connector.manifest).get(contract);
  if (
    served === undefined ||
    connection === undefined ||
    connection.status === "disconnected" ||
    connection.serverKind !== "native" ||
    connection.server !== name ||
    connector?.manifest.provider !== connection.provider
  ) {
    throw connectErrors.create("connect.contract_not_found");
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
