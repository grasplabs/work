import { connectionErrors } from "@grasp-os/shared/connect";
import type {
  ConnectWithKey,
  OAuthProvider,
  StartConnection,
} from "@grasp-os/shared/connect";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import { signInConfig } from "../auth/config.ts";
import { onOrigin, personOf, tenantOf } from "../connections.ts";
import { classesOn } from "../tool-classes.ts";

// What the onboarding connects, from one of its steps: the admin starts a
// flow at connect, consents at the provider, and the browser comes back
// to the step it left, with the new connection's ID in its address
// (`?connection=`). Every such connection is the organization's (shared),
// connected by its admin, never by Grasp's staff: what it reads is the
// client's. The directory is the first (directory.ts), where the
// documents live the second (document-places.ts). The HR platform (hr.ts)
// signs in with API credentials the admin made there instead: no flow,
// the same rules (`connectOnboardingWithKey`).

/** The client's admin: the client's own accounts are the client's to connect. */
const requireClientAdmin = (identity: Identity): void => {
  requireAdmin(identity);
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
};

/**
 * Starts connecting `provider` for the onboarding: where to send the
 * browser. A suite's connection, or one of a suite's read-only admin
 * connections, is pinned to the organization's own tenant there, `suite`;
 * an app has none.
 */
export const startOnboardingConnection = async (
  env: Env,
  identity: Identity,
  {
    provider,
    suite,
    returnTo,
  }: {
    provider: StartConnection["provider"];
    suite: OAuthProvider | null;
    returnTo: unknown;
  }
): Promise<{ url: string }> => {
  requireClientAdmin(identity);
  const config = signInConfig(env);
  const tenant =
    config === undefined || suite === null
      ? undefined
      : tenantOf(config, suite);
  if (config === undefined || (suite !== null && tenant === undefined)) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  const back =
    typeof returnTo === "string"
      ? onOrigin(config.origin, returnTo)
      : undefined;
  if (back === undefined) {
    throw connectionErrors.create("connection.invalid");
  }
  return await env.CONNECT.startConnection({
    person: await personOf(env, identity),
    provider,
    scope: "shared",
    origin: config.origin,
    ...(tenant === undefined ? {} : { tenant }),
    returnTo: `${back.pathname}${back.search}`,
    classes: await classesOn(env),
  });
};

/**
 * Connects `provider` for the onboarding with an API key the admin made
 * there: the connection's ID, once the provider took the key. The key
 * goes to connect, and is never kept, logged or answered here.
 */
export const connectOnboardingWithKey = async (
  env: Env,
  identity: Identity,
  { provider, key }: Pick<ConnectWithKey, "provider" | "key">
): Promise<{ connectionId: string }> => {
  requireClientAdmin(identity);
  return await env.CONNECT.connectWithKey({
    person: await personOf(env, identity),
    provider,
    scope: "shared",
    key,
  });
};
