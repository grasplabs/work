import { durableObjectState } from "@grasp-os/chat/state";
import { Chat } from "chat";
import type { WebhookOptions } from "chat";
import { env } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { CryptoKey as JoseKey, JWTPayload } from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { channelAdapters } from "../src/channels/door.ts";
import { teamsKeys } from "../src/channels/teams.ts";
import {
  botFrameworkAskedUrl,
  botFrameworkFailUrl,
  botFrameworkKeysUrl,
} from "./connect-providers.ts";
import { acmeTenant, otherTenant, signInConfig } from "./sign-in-config.ts";
import { unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// Teams as a door into core (src/channels/teams.ts), from its threat model:
// every way a request that Microsoft didn't send for this client's bot and
// tenant could reach a handler, each refused with a 401 before any
// handler runs; then the one that is let in. Requests go in through the
// Chat SDK, as the door hands them on, with the keys published on a fake
// of login.botframework.com that connect fetches from
// (connect's test/bot-framework-keys-fake.ts).

const botId = "5b1e7c2a-3f4d-4e6b-9a8c-1d2e3f4a5b6c";
const serviceUrl = "https://smba.trafficmanager.net/emea/";
const issuer = "https://api.botframework.com";

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

const providers = (): Fetcher => {
  const binding = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(binding)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return binding;
};

interface SigningKey {
  kid: string;
  privateKey: JoseKey;
  jwk: Record<string, unknown>;
}

const signingKey = async (kid: string): Promise<SigningKey> => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid } };
};

let teamsKey: SigningKey;
let skypeKey: SigningKey;
let unpublishedKey: SigningKey;

const publish = async (keys: { key: SigningKey; endorsements: string[] }[]) => {
  await providers().fetch(botFrameworkKeysUrl, {
    method: "POST",
    body: JSON.stringify({
      keys: keys.map(({ key, endorsements }) => ({
        ...key.jwk,
        use: "sig",
        endorsements,
      })),
    }),
  });
};

const keysAsked = async (): Promise<number> => {
  const response = await providers().fetch(botFrameworkAskedUrl);
  const paths = z.array(z.string()).parse(await response.json());
  return paths.filter((path) => path === "/v1/.well-known/keys").length;
};

/** Every request core itself sent out while a test ran. */
const outbound: string[] = [];

/**
 * The file's keys, published once before its tests, and a fetch spy on
 * core for each test that answers everything with a 404.
 */
const door = () => {
  beforeAll(async () => {
    teamsKey = await signingKey("teams-key");
    skypeKey = await signingKey("skype-key");
    unpublishedKey = await signingKey("unpublished-key");
    await publish([
      { key: teamsKey, endorsements: ["msteams", "webchat"] },
      { key: skypeKey, endorsements: ["skype"] },
    ]);
  });
  beforeEach(() => {
    outbound.length = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      outbound.push(request.url);
      return await Promise.resolve(new Response("Not found", { status: 404 }));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
};

door();

/** A direct message to the bot, as Teams posts one. */
const directMessage = (changes: Record<string, unknown> = {}) => ({
  type: "message",
  id: `1729${unique()}`,
  timestamp: new Date().toISOString(),
  channelId: "msteams",
  serviceUrl,
  from: { id: `29:${unique()}`, aadObjectId: crypto.randomUUID() },
  recipient: { id: `28:${botId}`, name: "Stephen" },
  conversation: {
    id: `a:${unique()}`,
    conversationType: "personal",
    tenantId: acmeTenant,
  },
  channelData: { tenant: { id: acmeTenant } },
  text: "What's on my calendar today?",
  ...changes,
});

const claimsNow = () => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: issuer,
    aud: botId,
    serviceurl: serviceUrl,
    nbf: now - 60,
    exp: now + 3600,
  };
};

const sign = async (
  claims: JWTPayload = {},
  {
    key = teamsKey,
    kid = key.kid,
  }: { key?: SigningKey; kid?: string | null } = {}
): Promise<string> =>
  await new SignJWT({ ...claimsNow(), ...claims })
    .setProtectedHeader(kid === null ? { alg: "RS256" } : { alg: "RS256", kid })
    .sign(key.privateKey);

const base64Url = (value: unknown): string =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

/** A token whose header and payload are as given, signed with `signature`. */
const unsignedToken = (
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signature = ""
): string => `${base64Url(header)}.${base64Url(payload)}.${signature}`;

const teamsEnv = (changes: Partial<Env> = {}): Env => ({
  ...env,
  TEAMS_BOT_ID: botId,
  ...changes,
});

/**
 * The keys this file's requests are checked against, fetched for it
 * alone: test files may share an isolate, whose keys another file may
 * have fetched before this one published its own.
 */
const fileKeys = teamsKeys();

/** Delivers `activity` with `authorization` to the door; what happened. */
const deliver = async (
  activity: unknown,
  authorization: string | undefined,
  doorEnv: Env = teamsEnv(),
  adapters: (adaptersEnv: Env) => ReturnType<typeof channelAdapters> = (
    adaptersEnv
  ) => channelAdapters(adaptersEnv, { teamsKeys: fileKeys })
): Promise<{ status: number; handled: number }> => {
  const chat = new Chat({
    userName: "Stephen",
    adapters: adapters(doorEnv),
    state: durableObjectState(env.CHAT_STATE),
    logger: "silent",
  });
  let handled = 0;
  chat.onDirectMessage(() => {
    handled += 1;
  });
  chat.onNewMention(() => {
    handled += 1;
  });
  chat.onNewMessage(/[\s\S]*/u, () => {
    handled += 1;
  });
  const background: Promise<unknown>[] = [];
  const response = await chat.webhooks.teams(
    new Request("https://acme.grasp.test/api/channels/teams", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify(activity),
    }),
    {
      waitUntil: (promise) => {
        background.push(promise);
      },
    }
  );
  await Promise.allSettled(background);
  return { status: response.status, handled };
};

const refused = { status: 401, handled: 0 };

describe("a request without a token Microsoft signed", () => {
  it("is refused without a token, or with one that isn't a bearer JWT", async () => {
    for (const authorization of [
      undefined,
      "",
      "Bearer",
      "Bearer not-a-jwt",
      "Basic dXNlcjpwYXNz",
      `bearer ${await sign()}`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        deliver(directMessage(), authorization)
      ).resolves.toStrictEqual(refused);
    }
  });

  it("is refused for a token without a key id", async () => {
    const token = await sign({}, { kid: null });
    await expect(
      deliver(directMessage(), `Bearer ${token}`)
    ).resolves.toStrictEqual(refused);
  });

  it("is refused for a forged signature on a published key id", async () => {
    const forged = await sign({}, { key: unpublishedKey, kid: teamsKey.kid });
    await expect(
      deliver(directMessage(), `Bearer ${forged}`)
    ).resolves.toStrictEqual(refused);
    const genuine = await sign();
    const [header, , signature] = genuine.split(".");
    const tampered = `${header}.${base64Url({ ...claimsNow(), aud: "other" })}.${signature}`;
    await expect(
      deliver(directMessage(), `Bearer ${tampered}`)
    ).resolves.toStrictEqual(refused);
  });

  it("is refused for a key id Microsoft doesn't publish", async () => {
    const token = await sign({}, { key: unpublishedKey });
    await expect(
      deliver(directMessage(), `Bearer ${token}`)
    ).resolves.toStrictEqual(refused);
  });

  it("is refused for alg none or HS256, even keyed with the public key", async () => {
    const none = unsignedToken({ alg: "none", kid: teamsKey.kid }, claimsNow());
    await expect(
      deliver(directMessage(), `Bearer ${none}`)
    ).resolves.toStrictEqual(refused);
    const secret = new TextEncoder().encode(JSON.stringify(teamsKey.jwk));
    const hs256 = await new SignJWT(claimsNow())
      .setProtectedHeader({ alg: "HS256", kid: teamsKey.kid })
      .sign(secret);
    await expect(
      deliver(directMessage(), `Bearer ${hs256}`)
    ).resolves.toStrictEqual(refused);
  });

  it("is refused for a key Microsoft endorses only for another channel", async () => {
    const token = await sign({}, { key: skypeKey });
    await expect(
      deliver(directMessage(), `Bearer ${token}`)
    ).resolves.toStrictEqual(refused);
  });
});

describe("a token Microsoft signed for something else", () => {
  it("is refused once expired, or before it is valid, past five minutes' skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ ...claimsNow(), exp: now - 6 * 60 })
      .setProtectedHeader({ alg: "RS256", kid: teamsKey.kid })
      .sign(teamsKey.privateKey);
    await expect(
      deliver(directMessage(), `Bearer ${expired}`)
    ).resolves.toStrictEqual(refused);
    const early = await new SignJWT({ ...claimsNow(), nbf: now + 6 * 60 })
      .setProtectedHeader({ alg: "RS256", kid: teamsKey.kid })
      .sign(teamsKey.privateKey);
    await expect(
      deliver(directMessage(), `Bearer ${early}`)
    ).resolves.toStrictEqual(refused);
    const { exp: _, ...claims } = claimsNow();
    const endless = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: teamsKey.kid })
      .sign(teamsKey.privateKey);
    await expect(
      deliver(directMessage(), `Bearer ${endless}`)
    ).resolves.toStrictEqual(refused);
  });

  it("is let in within five minutes' skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    const justExpired = await new SignJWT({ ...claimsNow(), exp: now - 60 })
      .setProtectedHeader({ alg: "RS256", kid: teamsKey.kid })
      .sign(teamsKey.privateKey);
    await expect(
      deliver(directMessage(), `Bearer ${justExpired}`)
    ).resolves.toStrictEqual({ status: 200, handled: 1 });
  });

  it("is refused for another audience", async () => {
    for (const aud of ["another-bot", `api://another-bot`, `${botId}x`]) {
      // oxlint-disable-next-line no-await-in-loop
      const token = await sign({ aud });
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        deliver(directMessage(), `Bearer ${token}`)
      ).resolves.toStrictEqual(refused);
    }
  });

  it("is refused from another issuer, Entra's included", async () => {
    for (const iss of [
      `https://login.microsoftonline.com/${acmeTenant}/v2.0`,
      `https://sts.windows.net/${acmeTenant}/`,
      "https://api.botframework.com/",
      "https://attacker.test",
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const token = await sign({ iss });
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        deliver(directMessage(), `Bearer ${token}`)
      ).resolves.toStrictEqual(refused);
    }
  });

  it("is refused without a service URL claim, or with another than the activity's", async () => {
    const { serviceurl: _, ...claims } = claimsNow();
    const without = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: teamsKey.kid })
      .sign(teamsKey.privateKey);
    await expect(
      deliver(directMessage(), `Bearer ${without}`)
    ).resolves.toStrictEqual(refused);
    const elsewhere = await sign({ serviceurl: "https://attacker.test/" });
    await expect(
      deliver(directMessage(), `Bearer ${elsewhere}`)
    ).resolves.toStrictEqual(refused);
  });

  it("is refused replayed onto an activity for another service URL", async () => {
    const token = await sign();
    await expect(
      deliver(directMessage(), `Bearer ${token}`)
    ).resolves.toStrictEqual({
      status: 200,
      handled: 1,
    });
    await expect(
      deliver(
        directMessage({ serviceUrl: "https://attacker.test/" }),
        `Bearer ${token}`
      )
    ).resolves.toStrictEqual(refused);
  });
});

describe("an activity from somewhere else", () => {
  it("is refused from a channel other than Teams", async () => {
    const token = await sign();
    for (const channelId of ["webchat", "skype", "slack", "MSTEAMS"]) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        deliver(directMessage({ channelId }), `Bearer ${token}`)
      ).resolves.toStrictEqual(refused);
    }
  });

  it("is refused from another tenant, or naming none", async () => {
    const token = await sign();
    const elsewhere = [
      directMessage({ channelData: { tenant: { id: otherTenant } } }),
      directMessage({
        conversation: {
          id: "a:dm",
          conversationType: "personal",
          tenantId: otherTenant,
        },
      }),
      directMessage({
        channelData: {},
        conversation: { id: "a:dm", conversationType: "personal" },
      }),
    ];
    for (const activity of elsewhere) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(deliver(activity, `Bearer ${token}`)).resolves.toStrictEqual(
        refused
      );
    }
  });

  it("is refused when the body isn't an activity", async () => {
    const token = await sign();
    for (const body of ["not json", [], { channelId: "msteams" }]) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(deliver(body, `Bearer ${token}`)).resolves.toStrictEqual(
        refused
      );
    }
  });
});

describe("a door that isn't set up", () => {
  it("refuses everything without the bot's id", async () => {
    const token = await sign();
    for (const TEAMS_BOT_ID of [undefined, ""]) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        deliver(directMessage(), `Bearer ${token}`, teamsEnv({ TEAMS_BOT_ID }))
      ).resolves.toStrictEqual(refused);
    }
  });

  it("refuses everything without the client's Entra tenant", async () => {
    const token = await sign();
    const { entra: _, ...withoutEntra } = signInConfig;
    await expect(
      deliver(
        directMessage(),
        `Bearer ${token}`,
        teamsEnv({ SIGN_IN: withoutEntra })
      )
    ).resolves.toStrictEqual(refused);
  });
});

describe("every adapter", () => {
  it("refuses an unsigned request, whatever the SDK's switch says", async () => {
    vi.stubEnv("DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS", "true");
    try {
      const chat = new Chat({
        userName: "Stephen",
        adapters: channelAdapters(teamsEnv()),
        state: durableObjectState(env.CHAT_STATE),
        logger: "silent",
      });
      let handled = 0;
      chat.onNewMessage(/[\s\S]*/u, () => {
        handled += 1;
      });
      chat.onDirectMessage(() => {
        handled += 1;
      });
      const webhooks: Record<
        string,
        (request: Request, options: WebhookOptions) => Promise<Response>
      > = chat.webhooks;
      const platforms = Object.keys(webhooks);
      expect(platforms).toStrictEqual(["teams", "slack", "whatsapp"]);
      for (const [platform, webhook] of Object.entries(webhooks)) {
        // oxlint-disable-next-line no-await-in-loop
        const response = await webhook(
          new Request(`https://acme.grasp.test/api/channels/${platform}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(directMessage()),
          }),
          { waitUntil: () => {} }
        );
        expect(response.status).toBe(401);
      }
      expect(handled).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("a request Microsoft sent", () => {
  it("reaches the handler as a direct message", async () => {
    const token = await sign();
    await expect(
      deliver(directMessage(), `Bearer ${token}`)
    ).resolves.toStrictEqual({
      status: 200,
      handled: 1,
    });
  });

  it("is let in for the bot's api:// audiences too", async () => {
    for (const aud of [`api://botid-${botId}`, `api://${botId}`]) {
      // oxlint-disable-next-line no-await-in-loop
      const token = await sign({ aud });
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        deliver(directMessage(), `Bearer ${token}`)
      ).resolves.toStrictEqual({ status: 200, handled: 1 });
    }
  });

  it("is checked against keys connect fetched: core never asks Microsoft itself", async () => {
    const token = await sign();
    await deliver(directMessage(), `Bearer ${token}`);
    expect(
      outbound.filter((url) =>
        new URL(url).hostname.endsWith("botframework.com")
      )
    ).toStrictEqual([]);
  });
});

const minute = 60 * 1000;

/** Moves the clock `ms` on, for `Date` alone. */
const later = (ms: number) => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ms });
};

describe("keys Microsoft rotates", () => {
  // Each test here has keys of its own, which it alone fetched: these
  // tests move the clock, and the isolate's keys would keep the times.
  let keys = teamsKeys();
  beforeEach(() => {
    keys = teamsKeys();
  });
  const deliverFresh = async (activity: unknown, authorization: string) =>
    await deliver(activity, authorization, teamsEnv(), (freshEnv) =>
      channelAdapters(freshEnv, { teamsKeys: keys })
    );

  it("are fetched again once for a burst of unknown key ids, a minute on", async () => {
    await expect(
      deliverFresh(directMessage(), `Bearer ${await sign()}`)
    ).resolves.toStrictEqual({ status: 200, handled: 1 });
    later(2 * minute);
    const before = await keysAsked();
    const token = await sign({}, { key: unpublishedKey });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        deliverFresh(directMessage(), `Bearer ${token}`)
      ).resolves.toStrictEqual(refused);
    }
    const after = await keysAsked();
    expect(after - before).toBe(1);
  });

  it("aren't fetched again for an unknown key id within the minute", async () => {
    await deliverFresh(directMessage(), `Bearer ${await sign()}`);
    const before = await keysAsked();
    const token = await sign({}, { key: unpublishedKey });
    await expect(
      deliverFresh(directMessage(), `Bearer ${token}`)
    ).resolves.toStrictEqual(refused);
    const after = await keysAsked();
    expect(after - before).toBe(0);
  });

  it("let in a newly published key once the minute has passed", async () => {
    await deliverFresh(directMessage(), `Bearer ${await sign()}`);
    const rotated = await signingKey(`rotated-${unique()}`);
    await publish([
      { key: teamsKey, endorsements: ["msteams", "webchat"] },
      { key: skypeKey, endorsements: ["skype"] },
      { key: rotated, endorsements: ["msteams"] },
    ]);
    later(2 * minute);
    const token = await sign({}, { key: rotated });
    await expect(
      deliverFresh(directMessage(), `Bearer ${token}`)
    ).resolves.toStrictEqual({ status: 200, handled: 1 });
  });

  it("are fetched at most once a minute while fetching them fails", async () => {
    await providers().fetch(botFrameworkFailUrl, {
      method: "POST",
      body: JSON.stringify({ status: 503 }),
    });
    try {
      const before = await keysAsked();
      const token = await sign();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop
        await expect(
          deliverFresh(directMessage(), `Bearer ${token}`)
        ).resolves.toStrictEqual(refused);
      }
      const after = await keysAsked();
      expect(after - before).toBe(1);
    } finally {
      await providers().fetch(botFrameworkFailUrl, {
        method: "POST",
        body: JSON.stringify({ status: null }),
      });
    }
  });
});
