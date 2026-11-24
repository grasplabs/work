import type { StartConnection } from "@grasp-os/shared/connect";
import type { SignInConfig } from "@grasp-os/shared/deployment-config";
import { relayedClientOf, relayState } from "@grasp-os/shared/oauth-relay";
import type { RelayKind } from "@grasp-os/shared/oauth-relay";

/**
 * `authorizationUrl`, an IdP's URL a `kind` flow sends the browser to,
 * with its `state` put through the relay in relay mode
 * (@grasp-os/shared/oauth-relay): this deployment's label, when, and the
 * MAC from its router secret in front, and for a sign-in the provider,
 * whose callback the relay sends the browser back to. As it is without
 * relay mode. Throws when it can't be relayed: without the router secret
 * (which behind the router a core always has), or without a state. Such
 * a flow could never come back, so it never starts.
 */
export const relayedAuthorizationUrl = async (
  env: Pick<Env, "ROUTER_SECRET">,
  config: SignInConfig,
  authorizationUrl: string,
  flow: { kind: RelayKind; provider?: string }
): Promise<string> => {
  const { callbackOrigin } = config;
  if (callbackOrigin === undefined) {
    return authorizationUrl;
  }
  const client = relayedClientOf(config.origin, callbackOrigin);
  const url = new URL(authorizationUrl);
  const state = url.searchParams.get("state");
  const secret = env.ROUTER_SECRET;
  if (client === null || state === null || !secret) {
    throw new Error("This flow can't go through the OAuth relay");
  }
  url.searchParams.set(
    "state",
    await relayState(secret, { ...flow, label: client.label, state })
  );
  return url.href;
};

/**
 * Starts connecting an account through OAuth for the deployment `config`
 * describes: its provider returns to `config.origin`, or in relay mode to
 * the relay, with the state put through it. What every start of an OAuth
 * connection in core goes through, so none bypasses relay mode.
 */
export const startOAuthConnection = async (
  env: Pick<Env, "ROUTER_SECRET" | "CONNECT">,
  config: SignInConfig,
  request: Omit<StartConnection, "origin" | "callbackOrigin">
): Promise<{ url: string }> => {
  const { callbackOrigin } = config;
  const { url } = await env.CONNECT.startConnection({
    ...request,
    origin: config.origin,
    ...(callbackOrigin === undefined ? {} : { callbackOrigin }),
  });
  return {
    url: await relayedAuthorizationUrl(env, config, url, {
      kind: "connections",
    }),
  };
};
