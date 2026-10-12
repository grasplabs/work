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
// manifest). Core binds an App's connector resource to one, checks every
// call's input and answer against it, and fingerprints it, so a release
// of the connector that changes any of it stops the binding until an
// admin approves it again. Read from the release's manifests alone:
// nothing is loaded, no token is read, and the connection must be a native
// one of that very connector, so no contract describes what a connection
// can't do.

/** The one major version contracts are generated at: shape changes drift. */
const generatedMajor = "1";

/** An action's name in a contract: what the SDK lets a declaration list. */
const actionNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

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
  const [qualified = "", major] = contract.split("@");
  const dot = qualified.indexOf(".");
  const name = qualified.slice(0, dot);
  const family = qualified.slice(dot + 1);
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
  if (
    major !== generatedMajor ||
    connection === undefined ||
    connection.status === "disconnected" ||
    connection.serverKind !== "native" ||
    connection.server !== name ||
    connector?.manifest.provider !== connection.provider
  ) {
    throw connectErrors.create("connect.contract_not_found");
  }
  const actions: Record<string, ConnectorContractAction> = {};
  for (const [tool, declared] of Object.entries(connector.manifest.actions)) {
    const action = tool.startsWith(`${family}.`)
      ? tool.slice(family.length + 1)
      : "";
    if (actionNamePattern.test(action)) {
      actions[action] = {
        tool,
        readOnly: declared.readOnly,
        input: JSON.stringify(declared.contract.input),
        output: JSON.stringify(declared.contract.output),
      };
    }
  }
  if (Object.keys(actions).length === 0) {
    throw connectErrors.create("connect.contract_not_found");
  }
  return { contract, actions };
};
