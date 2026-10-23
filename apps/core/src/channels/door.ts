/**
 * The channel door: where a message from a chat app comes into core, on
 * Vercel's Chat SDK (D14), Teams first. Nothing reaches a handler until the
 * platform's adapter has verified the request as the platform signs it, and
 * core has checked what the adapter leaves to it (teams.ts).
 *
 * The route (`/api/channels/<platform>`), its rate limits and who a sender
 * is in Grasp come with GRA-757, which mounts `enterFromTeams`. Every call
 * the door makes outside the Worker, Microsoft's keys included, goes
 * through the fetch it is given, which GRA-757 points at connect (GRA-709).
 */
import type { TeamsAdapter } from "@chat-adapter/teams";
import { durableObjectState } from "@grasp-os/chat/state";
import { errorFields, log } from "@grasp-os/shared/log";
import { Chat } from "chat";

import { signInConfig } from "../auth/config.ts";
import { boundedText } from "../request-body.ts";
import { withMicrosoftKeys } from "./microsoft-keys.ts";
import type { ChannelFetch } from "./microsoft-keys.ts";
import { quiet, teamsAdapter, teamsRefusal } from "./teams.ts";
import type { TeamsBot, TeamsRefusal } from "./teams.ts";

/**
 * The most a chat app's request may hold. A Teams message is at most about
 * 28 KB; a card's submitted values and attachments' references stay well
 * within this.
 */
const maxBodyBytes = 256 * 1024;

/** The bots a deployment runs, one per chat app. */
export interface ChannelBots {
  teams: TeamsBot;
}

/** The Chat SDK with each chat app's adapter. */
export type ChannelChat = Chat<{ teams: TeamsAdapter }>;

/** What the door needs of the request it handles. */
export interface DoorOptions {
  /** Where the door's calls outside the Worker go: connect's fetch. */
  fetch: ChannelFetch;
  /** Keeps the Worker alive for what handlers do after the door answers. */
  waitUntil: (promise: Promise<unknown>) => void;
}

/** The client's Entra tenant, or undefined when its people don't sign in with Entra. */
const entraTenant = (env: Env): string | undefined =>
  signInConfig(env)?.entra?.tenantId;

/**
 * The Chat SDK for `bots`, its state in core's Durable Objects, or
 * undefined when the deployment has no Entra tenant for Teams to belong to.
 * Handlers are registered on it by whoever opens the door.
 */
export const channelChat = (
  env: Env,
  bots: ChannelBots
): ChannelChat | undefined => {
  const tenantId = entraTenant(env);
  if (tenantId === undefined) {
    return undefined;
  }
  const states =
    env.DURABLE_OBJECT_JURISDICTION === "none"
      ? env.CHAT_STATE
      : env.CHAT_STATE.jurisdiction("eu");
  return new Chat({
    userName: "Stephen",
    logger: quiet,
    state: durableObjectState(states),
    adapters: { teams: teamsAdapter(bots.teams, tenantId) },
  });
};

const refusalStatus: Record<TeamsRefusal, number> = {
  activity: 400,
  channel: 403,
  tenant: 403,
  token: 401,
  issuer: 401,
  key: 401,
  endorsement: 401,
};

const refused = (status: number): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

/**
 * Takes one request Teams posted into `chat`: core's checks first, then the
 * adapter's own verification, then the handlers. Anything not from the
 * client's tenant, through Teams, with a token Microsoft signed for this
 * bot, is refused before a handler sees it.
 */
export const enterFromTeams = async (
  chat: ChannelChat,
  request: Request,
  env: Env,
  { fetch, waitUntil }: DoorOptions
): Promise<Response> => {
  if (request.method !== "POST") {
    return refused(405);
  }
  const tenantId = entraTenant(env);
  if (tenantId === undefined) {
    return refused(404);
  }
  const body = await boundedText(request.body, maxBodyBytes);
  if (body === undefined) {
    return refused(413);
  }
  const authorization = request.headers.get("authorization");
  let refusal: TeamsRefusal | null = null;
  try {
    refusal = await teamsRefusal(body, authorization, tenantId, fetch);
  } catch (error) {
    // Microsoft's keys out of reach: nothing can be checked, so nothing
    // comes in, and Teams sends it again later.
    log.error("channels.keys_unreachable", {
      platform: "teams",
      ...errorFields(error),
    });
    return refused(503);
  }
  if (refusal !== null) {
    log.warn("channels.refused", { platform: "teams", refusal });
    return refused(refusalStatus[refusal]);
  }
  const verified = await withMicrosoftKeys(
    fetch,
    async () =>
      await chat.webhooks.teams(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body,
        }),
        { waitUntil }
      )
  );
  if (verified.status === 401) {
    log.warn("channels.refused", { platform: "teams", refusal: "signature" });
  }
  return verified;
};
