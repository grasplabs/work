/**
 * Where one client's core is, to ask it directly: through the router's
 * route with the router secret, signing with that client's auth secret
 * for one purpose (src/clients/kickoff.ts, src/clients/commands.ts).
 */
import { deploySecrets, ifStored } from "../deploy/context.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import type { CoreAddress } from "./core-address.ts";
import { clientGrid, routeOf } from "./grid.ts";

/** One client's core, and the secrets to reach and sign for it. */
export interface ClientCore {
  address: CoreAddress;
  routerSecret: string;
  authSecret: string;
}

/** Where client `clientId`'s core is, and the secret to sign for it with; null when it can't be asked. */
export const clientCore = async (
  env: Env,
  clientId: string
): Promise<ClientCore | null> => {
  const grid = await clientGrid(env);
  const row = grid.find(
    ({ id, status }) => id === clientId && status === "active"
  );
  const secrets = await ifStored(
    async (): Promise<DeploySecrets> => await deploySecrets(env)
  );
  if (row === undefined || secrets === null) {
    return null;
  }
  const route = await routeOf(
    env.ROUTER_HOSTS,
    secrets.routerKey,
    row.id,
    row.hostname,
    env.DISPATCHER
  );
  if (route === "no_route" || route === "unknown") {
    return null;
  }
  return {
    address: route.core,
    routerSecret: route.secret,
    authSecret: await clientAuthSecret(secrets, row.id, route.generation),
  };
};
