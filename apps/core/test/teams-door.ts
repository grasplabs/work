import { decodeThreadId } from "@chat-adapter/teams";
import { routerSecretHeader } from "@grasp-os/shared/router";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair, importJWK } from "jose";
import type { CryptoKey as JoseKey } from "jose";
import { beforeAll, beforeEach, vi } from "vite-plus/test";
import { z } from "zod";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import worker from "../src/index.ts";
import { pointAtGateway } from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import {
  botConnectorMembersUrl,
  botConnectorPostedUrl,
  botFrameworkSharedKeyUrl,
  teamsBot,
} from "./connect-providers.ts";
import type { Idp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// Teams posting to core's door (src/channels/door.ts) in the tests: a
// signing key Microsoft publishes, messages as Teams sends them, signed,
// posted through the Worker, and what reached the fake Bot Connector
// behind the real connect (test/bot-connector-fake.ts). Each file that
// posts calls `watched()` once, after `mockIdp()`.

const serviceUrl = "https://smba.trafficmanager.net/emea/";

/** Every request core itself sent to Microsoft while a test ran. */
export const toMicrosoft: string[] = [];

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

export const providers = (): Fetcher => {
  const binding = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(binding)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return binding;
};

let signingKey: { kid: string; privateKey: JoseKey };

const sharedKeySchema = z.object({
  key: z.looseObject({ kid: z.string() }),
});

/**
 * The signing key the test files share (`botFrameworkSharedKeyUrl`),
 * published once, and a watch on core's own fetch for each test, over the
 * mock IdP's.
 */
export const watched = () => {
  beforeAll(async () => {
    const { privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const offered = {
      ...(await exportJWK(privateKey)),
      kid: `door-key-${unique()}`,
    };
    const response = await providers().fetch(botFrameworkSharedKeyUrl, {
      method: "POST",
      body: JSON.stringify({ key: offered }),
    });
    const { key } = sharedKeySchema.parse(await response.json());
    const imported = await importJWK(key, "RS256");
    if (!(imported instanceof CryptoKey)) {
      throw new TypeError("Expected the shared signing key as a CryptoKey");
    }
    signingKey = { kid: key.kid, privateKey: imported };
  });
  beforeEach(() => {
    toMicrosoft.length = 0;
    const signIn = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const { hostname } = new URL(new Request(input, init).url);
      if (
        hostname.endsWith("botframework.com") ||
        hostname.endsWith("trafficmanager.net")
      ) {
        toMicrosoft.push(hostname);
      }
      if (signIn === undefined) {
        throw new Error("Expected the mock IdP to stand in for fetch");
      }
      return await signIn(input, init);
    });
  });
};

/** A token Microsoft signed for the client's bot. */
export const signed = async (): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    iss: "https://api.botframework.com",
    aud: teamsBot.id,
    serviceurl: serviceUrl,
    nbf: now - 60,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: "RS256", kid: signingKey.kid })
    .sign(signingKey.privateKey);
};

/** Someone writing on Teams: their object id, and their private chat. */
export const teamsPerson = (aadObjectId: string = crypto.randomUUID()) => ({
  aadObjectId,
  userId: `29:${unique()}`,
  conversation: `a:${unique()}`,
});
export type TeamsPerson = ReturnType<typeof teamsPerson>;

/** A message `person` sent the bot, as Teams posts one. */
export const messageFrom = (
  person: TeamsPerson,
  changes: Record<string, unknown> = {}
) => ({
  type: "message",
  id: `1729${unique()}`,
  timestamp: new Date().toISOString(),
  channelId: "msteams",
  serviceUrl,
  locale: "en-US",
  from: { id: person.userId, aadObjectId: person.aadObjectId },
  recipient: { id: `28:${teamsBot.id}`, name: "Stephen" },
  conversation: {
    id: person.conversation,
    conversationType: "personal",
    tenantId: acmeTenant,
  },
  channelData: { tenant: { id: acmeTenant } },
  text: "What's on my calendar today?",
  ...changes,
});

/**
 * Posts `activity` to core as Teams would, through the router, and waits
 * for what it does in the background.
 */
export const post = async (
  activity: unknown,
  {
    path = "/api/channels/teams",
    authorization,
    coreEnv = env,
  }: { path?: string; authorization?: string | null; coreEnv?: Env } = {}
): Promise<number> => {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(routerSecretHeader, env.ROUTER_SECRET);
  const bearer =
    authorization === undefined ? `Bearer ${await signed()}` : authorization;
  if (bearer !== null) {
    headers.set("authorization", bearer);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://acme.grasp.test${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(activity),
    }),
    coreEnv,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response.status;
};

const reachedSchema = z.object({
  posted: z.array(
    z.object({
      conversation: z.string(),
      activity: z
        .object({ type: z.string(), text: z.string().optional() })
        .loose(),
      id: z.string().optional(),
      editOf: z.string().optional(),
    })
  ),
  asked: z.array(z.string()),
});

/**
 * What the Bot Connector was sent in `conversation`: every activity, in
 * order, and the text of its messages (`lines`); and what it was asked of
 * the conversation's roster.
 */
export const reached = async (conversation: string) => {
  const response = await providers().fetch(botConnectorPostedUrl);
  const { posted, asked } = reachedSchema.parse(await response.json());
  const activities = posted
    .filter((each) => each.conversation === conversation)
    .map(({ activity }) => activity);
  return {
    activities,
    /** Each post with its id, and each edit with the id it replaced. */
    sent: posted.filter((each) => each.conversation === conversation),
    lines: activities
      .filter(({ type }) => type === "message")
      .map(({ text }) => text),
    asked: asked.filter((key) => key.startsWith(`${conversation} `)),
  };
};

/** Sets what Teams' roster says of `person` in their chat. */
export const onRoster = async (
  person: TeamsPerson,
  member: { userRole?: string; tenantId?: string }
): Promise<void> => {
  await providers().fetch(botConnectorMembersUrl, {
    method: "POST",
    body: JSON.stringify({
      members: {
        [`${person.conversation} ${person.userId}`]: {
          id: person.userId,
          aadObjectId: person.aadObjectId,
          ...member,
        },
      },
    }),
  });
};

/** The conversations kept for Teams' `conversation`, with whose they are. */
export const kept = async (conversation: string) => {
  const { results } = await env.DB.prepare(
    "SELECT platform, thread_id AS threadId, user_id AS userId FROM channel_conversations"
  ).all<{ platform: string; threadId: string; userId: string }>();
  return results
    .filter(
      ({ platform, threadId }) =>
        platform === "teams" &&
        decodeThreadId(threadId).conversationId === conversation
    )
    .map(({ platform, userId }) => ({ platform, userId }));
};

/**
 * A member of the client signed in once, writing to the bot on Teams,
 * whose chats `gateway` answers. Workspace objects share their
 * env, so people in one test share one gateway.
 */
export const memberAnsweredBy = async (
  idp: Idp,
  gateway: ReturnType<typeof fakeGateway>
) => {
  const signedIn = await signedInApi(idp, "user");
  await pointAtGateway(
    workspace(env, personalWorkspaceId(signedIn.userId)),
    gateway
  );
  const { oid } = signedIn.person;
  if (typeof oid !== "string") {
    throw new TypeError("Expected an Entra object id");
  }
  return { ...signedIn, gateway, teams: teamsPerson(oid) };
};

/** A member whose chats `replies` answer, in order. */
export const member = async (idp: Idp, ...replies: GatewayReply[]) =>
  await memberAnsweredBy(idp, fakeGateway(...replies));
