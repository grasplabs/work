import { toBase64Url } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { channelChat, enterFromTeams } from "../src/channels/door.ts";
import type { ChannelChat } from "../src/channels/door.ts";
import type { ChannelFetch } from "../src/channels/microsoft-keys.ts";
import { botFrameworkIssuer, botFrameworkKeys } from "../src/channels/teams.ts";
import { acmeTenant, otherTenant, signInConfig } from "./sign-in-config.ts";

// The channel door (GRA-707), from its threat model: anyone on the internet
// can post to it. Nothing reaches a handler unless Microsoft signed it for
// this bot, through Teams, from the client's own tenant. Microsoft's
// validator under the Teams adapter checks the token; core checks what it
// leaves out (src/channels/teams.ts). Each way in that should be shut is a
// case below, refused before any handler runs; a forged, expired or
// misaddressed token getting through would mean the adapter's own check
// was off (`skipAuth`), and fails them.

const botAppId = "11111111-aaaa-4bbb-8ccc-000000000707";
const serviceUrl = "https://smba.trafficmanager.net/emea/";
const rs256 = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
} as const;

const newKey = async (): Promise<CryptoKeyPair> => {
  const generated = await crypto.subtle.generateKey(rs256, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in generated)) {
    throw new TypeError("Expected a key pair");
  }
  return generated;
};

/** Microsoft's key for Teams, one it endorses only for Web Chat, and a stranger's. */
const teamsKey = { kid: "teams-key", pair: await newKey() };
const webChatKey = { kid: "webchat-key", pair: await newKey() };
const strangerKey = { kid: teamsKey.kid, pair: await newKey() };

const publicJwk = async (pair: CryptoKeyPair) => {
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (jwk instanceof ArrayBuffer) {
    throw new TypeError("Expected a JSON Web Key");
  }
  return { kty: jwk.kty, n: jwk.n, e: jwk.e };
};

/** Bot Framework's key set, as Microsoft serves it. */
const keySet = {
  keys: [
    {
      ...(await publicJwk(teamsKey.pair)),
      kid: teamsKey.kid,
      use: "sig",
      endorsements: ["msteams"],
    },
    {
      ...(await publicJwk(webChatKey.pair)),
      kid: webChatKey.kid,
      use: "sig",
      endorsements: ["webchat"],
    },
  ],
};

/** The addresses the door fetched through its fetch, in this file. */
const fetched: string[] = [];

/**
 * Stands in for connect's fetch to Microsoft: only Bot Framework's keys
 * are there; any other address fails the request that reached for it.
 */
const microsoft = async (request: Request): Promise<Response> => {
  fetched.push(request.url);
  if (request.url !== botFrameworkKeys) {
    throw new Error(`Unexpected request to ${request.url}`);
  }
  return await Promise.resolve(Response.json(keySet));
};

/** Microsoft out of reach: whatever is asked, a bad gateway. */
const unreachable = async (): Promise<Response> =>
  await Promise.resolve(new Response(null, { status: 502 }));

const encoder = new TextEncoder();
const segment = (value: unknown) =>
  toBase64Url(encoder.encode(JSON.stringify(value)));

/** A token for `claims`, signed with `key`. */
const signed = async (
  key: { kid: string; pair: CryptoKeyPair },
  claims: Record<string, unknown>
): Promise<string> => {
  const content = `${segment({ alg: "RS256", typ: "JWT", kid: key.kid })}.${segment(claims)}`;
  const signature = await crypto.subtle.sign(
    rs256.name,
    key.pair.privateKey,
    encoder.encode(content)
  );
  return `${content}.${toBase64Url(new Uint8Array(signature))}`;
};

const now = () => Math.floor(Date.now() / 1000);

/** What Bot Framework signs for a message to this bot. */
const claims = (changes: Record<string, unknown> = {}) => ({
  iss: botFrameworkIssuer,
  aud: botAppId,
  nbf: now() - 60,
  exp: now() + 3600,
  serviceurl: serviceUrl,
  ...changes,
});

let activities = 0;

/** A direct message to the bot from someone at Acme, in Teams. */
const activity = (changes: Record<string, unknown> = {}) => {
  activities += 1;
  return {
    type: "message",
    id: `activity-${activities}`,
    timestamp: new Date().toISOString(),
    channelId: "msteams",
    serviceUrl,
    from: {
      id: "29:1-acme-person",
      aadObjectId: "55555555-5555-4555-8555-555555555555",
      name: "Ada",
    },
    recipient: { id: `28:${botAppId}`, name: "Stephen" },
    conversation: {
      id: `a:conversation-${activities}`,
      conversationType: "personal",
      tenantId: acmeTenant,
    },
    channelData: { tenant: { id: acmeTenant } },
    text: "Hello Stephen",
    ...changes,
  };
};

/** A request as Teams posts it, with `token` as its bearer, if any. */
const posted = (body: unknown, token?: string) =>
  new Request("https://acme.grasp.test/api/channels/teams", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

/** The texts handlers were given. */
const handled = (chat: ChannelChat): string[] => {
  const texts: string[] = [];
  chat.onDirectMessage((_thread, message) => {
    texts.push(message.text);
  });
  chat.onNewMention((_thread, message) => {
    texts.push(message.text);
  });
  chat.onNewMessage(/[\s\S]*/u, (_thread, message) => {
    texts.push(message.text);
  });
  return texts;
};

/** The bot the tests' deployment runs. */
const bots = {
  teams: {
    appId: botAppId,
    token: () => {
      throw new Error("Nothing is sent in these tests.");
    },
  },
};

/**
 * Sends `request` through the door of `deployment`, which reaches
 * Microsoft through `fetch`; its status and what
 * handlers got.
 */
const enter = async (
  request: Request,
  deployment: Env = env,
  fetch: ChannelFetch = microsoft
) => {
  const chat = channelChat(env, bots);
  if (chat === undefined) {
    throw new Error("The tests' deployment signs in with Entra.");
  }
  const texts = handled(chat);
  const pending: Promise<unknown>[] = [];
  const response = await enterFromTeams(chat, request, deployment, {
    fetch,
    waitUntil: (promise) => {
      pending.push(promise);
    },
  });
  await Promise.allSettled(pending);
  return { status: response.status, handled: texts };
};

describe("the channel door, for Teams", () => {
  it("lets a message Microsoft signed for this bot, through Teams, from the client's tenant reach the handlers", async () => {
    const token = await signed(teamsKey, claims());
    await expect(enter(posted(activity(), token))).resolves.toStrictEqual({
      status: 200,
      handled: ["Hello Stephen"],
    });
    // Microsoft's keys came through the door's fetch, and nothing else did.
    expect(new Set(fetched)).toStrictEqual(new Set([botFrameworkKeys]));
  });

  it.each([
    {
      way: "a forged token: signed by someone else, naming Microsoft's key",
      request: async () =>
        posted(activity(), await signed(strangerKey, claims())),
      status: 401,
    },
    {
      way: "an expired token",
      request: async () =>
        posted(
          activity(),
          await signed(
            teamsKey,
            claims({ nbf: now() - 7200, exp: now() - 3600 })
          )
        ),
      status: 401,
    },
    {
      way: "a token for another bot",
      request: async () =>
        posted(
          activity(),
          await signed(
            teamsKey,
            claims({ aud: "99999999-aaaa-4bbb-8ccc-999999999999" })
          )
        ),
      status: 401,
    },
    {
      way: "a token from another issuer",
      request: async () =>
        posted(
          activity(),
          await signed(
            teamsKey,
            claims({ iss: "https://login.microsoftonline.com/acme/v2.0" })
          )
        ),
      status: 401,
    },
    {
      way: "an activity from another Bot Framework channel",
      request: async () =>
        posted(
          activity({ channelId: "webchat" }),
          await signed(teamsKey, claims())
        ),
      status: 403,
    },
    {
      way: "a token signed with a key Microsoft doesn't endorse for Teams",
      request: async () =>
        posted(activity(), await signed(webChatKey, claims())),
      status: 401,
    },
    {
      way: "a token signed with a key Microsoft doesn't have",
      request: async () =>
        posted(
          activity(),
          await signed({ ...strangerKey, kid: "unknown-key" }, claims())
        ),
      status: 401,
    },
    {
      way: "an activity whose serviceUrl isn't the one Microsoft signed",
      request: async () =>
        posted(
          activity({ serviceUrl: "https://attacker.example/teams/" }),
          await signed(teamsKey, claims())
        ),
      status: 401,
    },
    {
      way: "an activity without a serviceUrl, so nothing compares it",
      request: async () =>
        posted(
          activity({ serviceUrl: undefined }),
          await signed(teamsKey, claims())
        ),
      status: 400,
    },
    {
      way: "an activity from another tenant",
      request: async () =>
        posted(
          activity({
            conversation: {
              id: "a:conversation-other",
              conversationType: "personal",
              tenantId: otherTenant,
            },
            channelData: { tenant: { id: otherTenant } },
          }),
          await signed(teamsKey, claims())
        ),
      status: 403,
    },
    {
      way: "an activity naming the client's tenant in one place and another tenant in the other",
      request: async () =>
        posted(
          activity({
            conversation: {
              id: "a:conversation-mixed",
              conversationType: "personal",
              tenantId: otherTenant,
            },
          }),
          await signed(teamsKey, claims())
        ),
      status: 403,
    },
    {
      way: "an activity that names no tenant",
      request: async () =>
        posted(
          activity({
            conversation: { id: "a:conversation-none" },
            channelData: {},
          }),
          await signed(teamsKey, claims())
        ),
      status: 403,
    },
    {
      way: "no token",
      request: async () => await Promise.resolve(posted(activity())),
      status: 401,
    },
    {
      way: "a token that isn't one",
      request: async () =>
        await Promise.resolve(posted(activity(), "not-a-token")),
      status: 401,
    },
  ])("refuses $way before a handler runs", async ({ request, status }) => {
    await expect(enter(await request())).resolves.toStrictEqual({
      status,
      handled: [],
    });
  });

  it("lets nothing in while Microsoft's keys are out of reach", async () => {
    const token = await signed(teamsKey, claims());
    await expect(
      enter(posted(activity(), token), env, unreachable)
    ).resolves.toStrictEqual({ status: 503, handled: [] });
  });

  it("opens to nothing when the client's people don't sign in with Entra", async () => {
    const token = await signed(teamsKey, claims());
    const withoutEntra = {
      ...env,
      SIGN_IN: { ...signInConfig, entra: undefined },
    } satisfies Env;
    expect(channelChat(withoutEntra, bots)).toBeUndefined();
    await expect(
      enter(posted(activity(), token), withoutEntra)
    ).resolves.toStrictEqual({ status: 404, handled: [] });
  });
});
