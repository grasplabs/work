/**
 * Microsoft Teams as a door into core: the Chat SDK's Teams adapter, with
 * every request it is handed checked here, before anything of it reaches
 * a handler, as really sent by Microsoft for this client's bot, from this
 * client's tenant.
 *
 * Threat model, and how each is closed:
 *
 * - Anyone on the internet posting here. Every request must carry a Bot
 *   Framework token: a JWT signed RS256 by a key Microsoft publishes, which
 *   connect fetches (`channelSigningKeys`; core never fetches it itself). A
 *   request without one, with one that doesn't parse, without a key id, or
 *   signed by a key Microsoft doesn't publish is refused.
 * - Algorithm confusion. Only RS256 is accepted: `none`, HS256 with the
 *   public key as its secret, and every other algorithm are refused.
 * - A key Microsoft publishes for another channel. Each key names the
 *   channels it may sign for (its endorsements); only one endorsed for
 *   `msteams` is accepted, and the activity must say it is from `msteams`.
 * - A token for something else. The issuer must be the Bot Framework's
 *   (`https://api.botframework.com`), never Entra's, and the audience this
 *   client's bot (`TEAMS_BOT_ID`, or its `api://` forms): a token for
 *   another bot, or one Entra issued to anyone, is refused.
 * - An old token. `exp` is required; a token past it, or before its `nbf`,
 *   by more than five minutes of clock skew is refused.
 * - A token moved onto another activity. The token's `serviceurl` claim
 *   must equal the activity's `serviceUrl`, so a token can't send replies
 *   somewhere else. A whole delivery sent again within its lifetime, to
 *   the same service URL, is caught only by the Chat SDK's dedupe of the
 *   activity's id.
 * - Another company's Teams. The activity's tenant must be this client's
 *   Entra tenant (`SIGN_IN`), in its channel data and its conversation
 *   wherever either names one; an activity naming none is refused.
 * - Misconfiguration. Without `TEAMS_BOT_ID` or the client's Entra tenant,
 *   every request is refused: nothing falls back to accepting.
 * - The adapter's own check, or the SDK's environment switch, letting a
 *   request through unsigned. The adapter is always given this verifier,
 *   so it never takes a request the verifier didn't accept, whatever
 *   `DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS` says.
 * - Key rotation used to force fetches. Keys are kept per isolate for an
 *   hour; a key id not among them refreshes them at most once a minute.
 */
import type { ChannelSigningKey } from "@grasp-os/shared/channel-keys";
import { channelCredentialPlaceholder } from "@grasp-os/shared/connect";
import { log } from "@grasp-os/shared/log";
import type { Logger } from "chat";
import { importJWK, jwtVerify } from "jose";
import type { JWTHeaderParameters } from "jose";
import { z } from "zod";

import { signInConfig } from "../auth/config.ts";
import { ConnectedTeamsAdapter } from "./teams-adapter.ts";

/** Who issues the tokens the Bot Framework sends its requests with. */
const botFrameworkIssuer = "https://api.botframework.com";

/** The channel id Teams activities carry, and their keys are endorsed for. */
const teamsChannel = "msteams";

/** How far a token's times may be from core's clock. */
const clockToleranceSeconds = 5 * 60;

/** How long fetched keys are used before they are fetched again. */
const keysMaxAgeMs = 60 * 60 * 1000;

/** How often a key id not among the keys may have them fetched again. */
const refreshIntervalMs = 60 * 1000;

/** An activity, as far as its check reads it. */
const activitySchema = z.object({
  channelId: z.string(),
  serviceUrl: z.string(),
  conversation: z.object({ tenantId: z.string().optional() }).optional(),
  channelData: z
    .object({
      tenant: z.object({ id: z.string().optional() }).optional(),
    })
    .optional(),
});

const bearerPattern = /^Bearer (?<token>[\w-]+\.[\w-]+\.[\w-]+)$/u;

interface KeySet {
  keys: Map<string, ChannelSigningKey>;
  at: number;
}

/**
 * The keys an isolate last fetched, when it last started fetching them,
 * and the fetch under way, if one is.
 */
export interface TeamsKeys {
  set?: KeySet;
  lastFetch: number;
  fetching?: Promise<KeySet>;
}

/** Keys not yet fetched. */
export const teamsKeys = (): TeamsKeys => ({
  lastFetch: Number.NEGATIVE_INFINITY,
});

/** This isolate's keys, which every request it serves checks against. */
const isolateKeys = teamsKeys();

const fetchKeys = async (env: Env, keys: TeamsKeys): Promise<KeySet> => {
  keys.fetching ??= (async () => {
    keys.lastFetch = Date.now();
    try {
      const fetched = await env.CONNECT.channelSigningKeys("teams");
      keys.set = {
        keys: new Map(fetched.keys.map((key) => [key.kid, key])),
        at: Date.now(),
      };
      return keys.set;
    } finally {
      keys.fetching = undefined;
    }
  })();
  return await keys.fetching;
};

/**
 * The published key `kid` names. The keys are fetched when they are older
 * than an hour, or when `kid` isn't among them; fetches start at least a
 * minute apart whatever the keys' state, a failed one included, so an
 * outage or made-up key ids can't have every request ask connect again. A
 * request arriving while a fetch is under way waits for that fetch.
 */
const keyFor = async (
  env: Env,
  keys: TeamsKeys,
  kid: string
): Promise<ChannelSigningKey | undefined> => {
  const now = Date.now();
  const { set } = keys;
  const fresh = set !== undefined && now - set.at < keysMaxAgeMs;
  const known = fresh ? set.keys.get(kid) : undefined;
  if (known !== undefined) {
    return known;
  }
  if (keys.fetching === undefined && now - keys.lastFetch < refreshIntervalMs) {
    return undefined;
  }
  const fetched = await fetchKeys(env, keys);
  return fetched.keys.get(kid);
};

/** Why a request was refused, for the log: never anything of its own. */
class RefusalError extends Error {
  override name = "RefusalError";
}

/** The key a token's header names, if Microsoft endorses it for Teams. */
const verificationKey =
  (env: Env, keys: TeamsKeys) =>
  async (header: JWTHeaderParameters): Promise<CryptoKey> => {
    if (header.alg !== "RS256") {
      throw new RefusalError("algorithm");
    }
    if (typeof header.kid !== "string" || header.kid === "") {
      throw new RefusalError("no_kid");
    }
    const key = await keyFor(env, keys, header.kid);
    if (key === undefined) {
      throw new RefusalError("unknown_kid");
    }
    if (!key.endorsements.includes(teamsChannel)) {
      throw new RefusalError("not_endorsed");
    }
    const imported = await importJWK(
      { kty: key.kty, n: key.n, e: key.e },
      "RS256"
    );
    if (!(imported instanceof CryptoKey)) {
      throw new RefusalError("key");
    }
    return imported;
  };

/** This client's Entra tenant, as sign-in has it, if set. */
const clientTenant = (env: Env): string | undefined =>
  signInConfig(env)?.entra?.tenantId;

/** The tenants an activity names, in its channel data and conversation. */
const tenantsOf = (activity: z.infer<typeof activitySchema>): string[] =>
  [activity.channelData?.tenant?.id, activity.conversation?.tenantId].filter(
    (tenant) => tenant !== undefined
  );

/**
 * Whether `request`, whose body is `body`, really comes from Microsoft for
 * this client's bot and tenant. Throws `RefusalError` saying why not.
 */
const checkTeamsRequest = async (
  env: Env,
  keys: TeamsKeys,
  request: Request,
  body: string
): Promise<void> => {
  const botId = env.TEAMS_BOT_ID;
  const tenant = clientTenant(env);
  if (botId === undefined || botId === "" || tenant === undefined) {
    throw new RefusalError("unconfigured");
  }
  const token = bearerPattern.exec(request.headers.get("authorization") ?? "")
    ?.groups?.token;
  if (token === undefined) {
    throw new RefusalError("no_token");
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = undefined;
  }
  const activity = activitySchema.safeParse(parsedBody);
  if (!activity.success) {
    throw new RefusalError("body");
  }
  if (activity.data.channelId !== teamsChannel) {
    throw new RefusalError("channel");
  }
  const tenants = tenantsOf(activity.data);
  if (tenants.length === 0 || tenants.some((each) => each !== tenant)) {
    throw new RefusalError("tenant");
  }
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, verificationKey(env, keys), {
      algorithms: ["RS256"],
      issuer: botFrameworkIssuer,
      audience: [botId, `api://botid-${botId}`, `api://${botId}`],
      clockTolerance: clockToleranceSeconds,
      requiredClaims: ["exp"],
    }));
  } catch (error) {
    if (error instanceof RefusalError) {
      throw error;
    }
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "token";
    throw new RefusalError(code);
  }
  if (payload.serviceurl !== activity.data.serviceUrl) {
    throw new RefusalError("service_url");
  }
};

/** Whether `request` really comes from Teams; refusals are logged. */
export const verifiedTeamsRequest = async (
  env: Env,
  request: Request,
  body: string,
  keys: TeamsKeys = isolateKeys
): Promise<boolean> => {
  try {
    await checkTeamsRequest(env, keys, request, body);
    return true;
  } catch (error) {
    const reason = error instanceof RefusalError ? error.message : "keys";
    log.info("channel.refused", { platform: "teams", reason });
    return false;
  }
};

/**
 * Chat SDK's logs stay out of core's but for what fails: the adapter and
 * Microsoft's SDK log what they handle at info and debug, which can carry
 * what people wrote. Only the message of a warning or an error is kept.
 */
const silent = (): void => undefined;
const teamsLogger: Logger = {
  child: () => teamsLogger,
  debug: silent,
  info: silent,
  warn: (message) => {
    log.warn("channel.teams", { message });
  },
  error: (message) => {
    log.error("channel.teams", { message });
  },
};

/**
 * Teams' adapter for this client's bot, every request it is handed checked
 * by {@link verifiedTeamsRequest} against `keys`, this isolate's unless a
 * test gives keys of its own. Everything it sends goes out through
 * connect, which holds the bot's credential: core builds the adapter with
 * the placeholder connect swaps for it (`channelCredentialPlaceholder`),
 * given as the token itself, so Microsoft's SDK never asks Entra for one.
 */
export const teamsAdapter = (
  env: Env,
  keys: TeamsKeys = isolateKeys
): ConnectedTeamsAdapter =>
  new ConnectedTeamsAdapter(env, {
    appId: env.TEAMS_BOT_ID ?? "",
    appType: "SingleTenant",
    appTenantId: clientTenant(env),
    webhookVerifier: async (request, body) =>
      await verifiedTeamsRequest(env, request, body, keys),
    token: () => channelCredentialPlaceholder,
    logger: teamsLogger,
  });
