/**
 * Microsoft Teams at the channel door: the Chat SDK's Teams adapter, and
 * what core checks of each request before the adapter takes it.
 *
 * The adapter runs Microsoft's own validator on every request
 * (`@microsoft/teams.apps`, `InboundActivityTokenValidator`): the Bot
 * Framework token's signature against Microsoft's keys, its expiry, this
 * bot's app id as its audience, its issuer, and its `serviceurl` claim
 * against the activity's `serviceUrl`. It is never handed a
 * `webhookVerifier`, which would set the Teams SDK's `skipAuth`, nor
 * `dangerouslyAllowUnauthenticatedRequests`: there is no unsigned way in,
 * not even locally, and the door's tests of forged, expired and
 * misaddressed tokens fail the moment there is.
 *
 * What that validator leaves to us (`teamsRefusal`), checked before it runs:
 *
 * - The tenant. Any Microsoft 365 tenant can install a bot; the activity's
 *   tenant (`channelData.tenant.id`, and `conversation.tenantId`, which the
 *   adapter reads first) must be the client's Entra tenant, the one its
 *   people sign in with (`SIGN_IN`).
 * - The channel. A Bot Framework bot is reachable from other channels
 *   (Web Chat, Direct Line, Slack...) with tokens Microsoft signs just the
 *   same; only `msteams` comes through here, and only with a token signed by
 *   a key Microsoft endorses for `msteams` (the key set's `endorsements`),
 *   which the validator doesn't look at.
 * - The issuer, strictly. The validator also takes Entra tokens from any
 *   tenant, for Agent 365's agentic identities; Grasp's bot isn't one, so
 *   only Bot Framework's own tokens get past.
 * - A `serviceUrl`. Without one the validator skips its `serviceurl` check.
 */
import { TeamsAdapter } from "@chat-adapter/teams";
import { fromBase64Url } from "@grasp-os/shared/encoding";
import type { Logger } from "chat";
import { z } from "zod";

import { jsonOf } from "../request-body.ts";
import { microsoftKey } from "./microsoft-keys.ts";
import type { ChannelFetch } from "./microsoft-keys.ts";

/** The Bot Framework channel Teams is. */
export const teamsChannelId = "msteams";

/** Who issues Bot Framework's tokens, in Microsoft's public cloud. */
export const botFrameworkIssuer = "https://api.botframework.com";

/**
 * Bot Framework's signing keys, where Microsoft's validator reads them (it
 * derives the address from the public cloud's OpenID metadata,
 * `https://login.botframework.com/v1/.well-known/openidconfiguration`,
 * without fetching it). The door checks endorsements in the same set.
 */
export const botFrameworkKeys =
  "https://login.botframework.com/v1/.well-known/keys";

/** The bot a deployment runs in Teams. */
export interface TeamsBot {
  /** Its Microsoft app id: the audience of every token Teams sends it. */
  appId: string;
  /**
   * The tokens its replies carry, by scope and tenant. Core holds none of
   * the bot's secrets: connect adds them (GRA-709, GRA-757).
   */
  token: (scope: string | string[], tenantId?: string) => Promise<string>;
}

/** Why the door turned a Teams request away. */
export type TeamsRefusal =
  | "activity"
  | "channel"
  | "tenant"
  | "token"
  | "issuer"
  | "key"
  | "endorsement";

/** An activity, as far as the door reads it before the adapter does. */
const activitySchema = z.object({
  channelId: z.string(),
  serviceUrl: z.url({ protocol: /^https$/u }),
  conversation: z.object({ tenantId: z.string().optional() }).optional(),
  channelData: z
    .object({ tenant: z.object({ id: z.string() }).optional() })
    .optional(),
});

/** A token's header and claims, read before anything vouches for them. */
const unverifiedTokenSchema = z.object({
  header: z.object({ kid: z.string() }),
  claims: z.object({ iss: z.string() }),
});

const sameTenant = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** A JWT segment as JSON, or undefined when it isn't one. */
const segmentOf = (segment: string | undefined): unknown => {
  if (segment === undefined) {
    return undefined;
  }
  try {
    return jsonOf(new TextDecoder().decode(fromBase64Url(segment)));
  } catch {
    return undefined;
  }
};

/** The bearer token of `authorization`, read but not yet verified. */
const unverifiedToken = (authorization: string | null) => {
  const [scheme, token, ...rest] = (authorization ?? "").split(" ");
  const bearer = scheme === "Bearer" && rest.length === 0 ? token : undefined;
  const [header, claims] = bearer?.split(".") ?? [];
  return unverifiedTokenSchema.safeParse({
    header: segmentOf(header),
    claims: segmentOf(claims),
  }).data;
};

/**
 * Why a Teams request with `body` and `authorization` doesn't come in, or
 * null when it may go on to the adapter, which verifies its token. `tenantId`
 * is the client's Entra tenant; `fetch` reaches Microsoft's keys.
 */
export const teamsRefusal = async (
  body: string,
  authorization: string | null,
  tenantId: string,
  fetch: ChannelFetch
): Promise<TeamsRefusal | null> => {
  const activity = activitySchema.safeParse(jsonOf(body)).data;
  if (activity === undefined) {
    return "activity";
  }
  if (activity.channelId !== teamsChannelId) {
    return "channel";
  }
  const tenants = [
    activity.channelData?.tenant?.id,
    activity.conversation?.tenantId,
  ];
  if (
    tenants[0] === undefined ||
    tenants.some(
      (tenant) => tenant !== undefined && !sameTenant(tenant, tenantId)
    )
  ) {
    return "tenant";
  }
  const token = unverifiedToken(authorization);
  if (token === undefined) {
    return "token";
  }
  if (token.claims.iss !== botFrameworkIssuer) {
    return "issuer";
  }
  const key = await microsoftKey(fetch, botFrameworkKeys, token.header.kid);
  if (key === undefined) {
    return "key";
  }
  if (!(key.endorsements ?? []).includes(teamsChannelId)) {
    return "endorsement";
  }
  return null;
};

const silent = (): void => undefined;

/**
 * The Chat SDK's logger, and its adapters': the door logs what it refuses
 * itself, without a message's text.
 */
export const quiet: Logger = {
  child: () => quiet,
  debug: silent,
  info: silent,
  warn: silent,
  error: silent,
};

/**
 * The Chat SDK's adapter for `bot`, in the client's Entra tenant
 * `tenantId`. Its app id, tenant and credentials are given here, so none
 * falls back to the `TEAMS_*` variables the adapter would otherwise read.
 */
export const teamsAdapter = (bot: TeamsBot, tenantId: string): TeamsAdapter =>
  new TeamsAdapter({
    appId: bot.appId,
    appType: "SingleTenant",
    appTenantId: tenantId,
    token: bot.token,
    userName: "Stephen",
    logger: quiet,
  });
