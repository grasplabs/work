import { decodeThreadId } from "@chat-adapter/teams";
import { routerSecretHeader } from "@grasp-os/shared/router";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair, importJWK } from "jose";
import type { CryptoKey as JoseKey } from "jose";
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

import worker from "../src/index.ts";
import {
  botConnectorMembersUrl,
  botConnectorPostedUrl,
  botFrameworkSharedKeyUrl,
  teamsBot,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, otherTenant } from "./sign-in-config.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// Who gets in through the door (src/channels/door.ts), as Teams posts to
// it through the Worker: a known person's private message is taken, once,
// and its conversation kept; everyone else gets one line, sent through
// connect to the fake Bot Connector behind it (test/bot-connector-fake.ts),
// and nothing they wrote is read; a flood is cut before anything is
// looked up; a platform the deployment hasn't set up isn't there.

const idp = mockIdp();

const serviceUrl = "https://smba.trafficmanager.net/emea/";

/** Every request core itself sent to Microsoft while a test ran. */
const toMicrosoft: string[] = [];

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

const providers = (): Fetcher => {
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
const watched = () => {
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

watched();

/** A token Microsoft signed for the client's bot. */
const signed = async (): Promise<string> => {
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
const teamsPerson = (aadObjectId: string = crypto.randomUUID()) => ({
  aadObjectId,
  userId: `29:${unique()}`,
  conversation: `a:${unique()}`,
});
type TeamsPerson = ReturnType<typeof teamsPerson>;

/** A message `person` sent the bot, as Teams posts one. */
const messageFrom = (
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
const post = async (
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
      activity: z.object({ text: z.string().optional() }).loose(),
    })
  ),
  asked: z.array(z.string()),
});

/** What the Bot Connector was sent in `conversation`, and asked of its roster. */
const reached = async (conversation: string) => {
  const response = await providers().fetch(botConnectorPostedUrl);
  const { posted, asked } = reachedSchema.parse(await response.json());
  return {
    lines: posted
      .filter((each) => each.conversation === conversation)
      .map(({ activity }) => activity.text),
    asked: asked.filter((key) => key.startsWith(`${conversation} `)),
  };
};

/** Sets what Teams' roster says of `person` in their chat. */
const onRoster = async (
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
const kept = async (conversation: string) => {
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

/** A member of the client signed in once, writing to the bot on Teams. */
const member = async () => {
  const signedIn = await signedInApi(idp, "user");
  const { oid } = signedIn.person;
  if (typeof oid !== "string") {
    throw new TypeError("Expected an Entra object id");
  }
  return { ...signedIn, teams: teamsPerson(oid) };
};

describe("a known person's message", () => {
  it("is taken, and its conversation kept as theirs", async () => {
    const { userId, teams } = await member();

    await expect(post(messageFrom(teams))).resolves.toBe(200);

    await expect(kept(teams.conversation)).resolves.toStrictEqual([
      { platform: "teams", userId },
    ]);
    const { lines } = await reached(teams.conversation);
    expect(lines).toStrictEqual([]);
    expect(toMicrosoft).toStrictEqual([]);
  });

  it("is taken once when Teams sends it again", async () => {
    const { teams } = await member();
    const message = messageFrom(teams);

    await post(message);
    await post(message);
    await post(messageFrom(teams));

    await expect(kept(teams.conversation)).resolves.toHaveLength(1);
    const { lines } = await reached(teams.conversation);
    expect(lines).toStrictEqual([]);
  });
});

describe("a request Teams didn't send for this client", () => {
  it("is refused without a token, and nothing is read or sent", async () => {
    const { teams } = await member();

    await expect(
      post(messageFrom(teams), { authorization: null })
    ).resolves.toBe(401);

    await expect(kept(teams.conversation)).resolves.toStrictEqual([]);
    await expect(reached(teams.conversation)).resolves.toStrictEqual({
      lines: [],
      asked: [],
    });
  });

  it("is refused from another tenant, and nothing is read or sent", async () => {
    const { teams } = await member();
    const elsewhere = messageFrom(teams, {
      conversation: {
        id: teams.conversation,
        conversationType: "personal",
        tenantId: otherTenant,
      },
      channelData: { tenant: { id: otherTenant } },
    });

    await expect(post(elsewhere)).resolves.toBe(401);

    await expect(kept(teams.conversation)).resolves.toStrictEqual([]);
    await expect(reached(teams.conversation)).resolves.toStrictEqual({
      lines: [],
      asked: [],
    });
  });
});

describe("someone who isn't one of the client's people", () => {
  it("gets one line when they're a guest, and nothing they wrote is read", async () => {
    const guest = teamsPerson();
    await onRoster(guest, { userRole: "guest", tenantId: acmeTenant });

    await expect(post(messageFrom(guest))).resolves.toBe(200);

    await expect(kept(guest.conversation)).resolves.toStrictEqual([]);
    const { lines } = await reached(guest.conversation);
    expect(lines).toStrictEqual([
      "I only help the company's own people, not its guests, so I can't help you here.",
    ]);
  });

  it("gets one line when they're from another company", async () => {
    const outsider = teamsPerson();
    await onRoster(outsider, { userRole: "user", tenantId: otherTenant });

    await post(messageFrom(outsider));

    await expect(kept(outsider.conversation)).resolves.toStrictEqual([]);
    const { lines } = await reached(outsider.conversation);
    expect(lines).toStrictEqual([
      "I only work for the people of the company that set me up, so I can't help you here.",
    ]);
  });

  it("gets the outsider's line when Teams can't say who they are", async () => {
    const unlisted = teamsPerson();

    await post(messageFrom(unlisted));

    const { lines } = await reached(unlisted.conversation);
    expect(lines).toStrictEqual([
      "I only work for the people of the company that set me up, so I can't help you here.",
    ]);
  });

  it("is asked to sign in once when they're the client's but Grasp hasn't seen them", async () => {
    const newcomer = teamsPerson();
    await onRoster(newcomer, { userRole: "user", tenantId: acmeTenant });

    await post(messageFrom(newcomer));

    await expect(kept(newcomer.conversation)).resolves.toStrictEqual([]);
    const { lines } = await reached(newcomer.conversation);
    expect(lines).toStrictEqual([
      "I don't know you yet. Sign in to Grasp once with your work account, and I'll answer you right after.",
    ]);
  });

  it("gets one line once they're removed, without a look at the roster", async () => {
    const admin = await signedInApi(idp, "admin");
    const { userId, teams } = await member();
    await admin.api.members.remove(userId);

    await expect(post(messageFrom(teams))).resolves.toBe(200);

    await expect(kept(teams.conversation)).resolves.toStrictEqual([]);
    await expect(reached(teams.conversation)).resolves.toStrictEqual({
      lines: [
        "You no longer have access to Grasp, so I can't help you. If you think that's a mistake, ask your admin.",
      ],
      asked: [],
    });
  });

  it("is never taken for someone else by a name or an email", async () => {
    const { teams } = await member();
    const impostor = teamsPerson();
    await onRoster(impostor, { userRole: "user", tenantId: acmeTenant });

    await post(
      messageFrom(impostor, {
        from: {
          id: impostor.userId,
          aadObjectId: impostor.aadObjectId,
          name: teams.userId,
          email: "person@acme.test",
        },
      })
    );

    await expect(kept(impostor.conversation)).resolves.toStrictEqual([]);
  });

  it("gets their line once when Teams sends it again", async () => {
    const guest = teamsPerson();
    await onRoster(guest, { userRole: "guest", tenantId: acmeTenant });
    const message = messageFrom(guest);

    await post(message);
    await post(message);

    const { lines } = await reached(guest.conversation);
    expect(lines).toHaveLength(1);
  });

  it("gets their line in the language their Teams is in", async () => {
    const guest = teamsPerson();
    await onRoster(guest, { userRole: "guest", tenantId: acmeTenant });

    await post(messageFrom(guest, { locale: "de-DE" }));

    const { lines } = await reached(guest.conversation);
    expect(lines).toStrictEqual([
      "Ich helfe nur den eigenen Leuten des Unternehmens, nicht seinen Gästen, deshalb kann ich Ihnen hier nicht helfen.",
    ]);
  });
});

describe("a group chat or a channel", () => {
  it("gets one line, even from a known person, and nothing is taken", async () => {
    const { teams } = await member();
    const group = `19:${unique()}@thread.v2`;

    await post(
      messageFrom(teams, {
        conversation: {
          id: group,
          conversationType: "groupChat",
          tenantId: acmeTenant,
        },
      })
    );

    await expect(kept(group)).resolves.toStrictEqual([]);
    await expect(reached(group)).resolves.toStrictEqual({
      lines: [
        "I only answer in a private chat. Send me a direct message, and I'll help you there.",
      ],
      asked: [],
    });
  });
});

describe("a flood from one person", () => {
  // The clock stands still, so no token comes back while a test sends.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is cut past the limit before anything is looked up, with one line to say so", async () => {
    const flooder = teamsPerson();
    await onRoster(flooder, { userRole: "guest", tenantId: acmeTenant });

    for (let sent = 0; sent < 13; sent += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, as typed
      await post(messageFrom(flooder));
    }

    const { lines, asked } = await reached(flooder.conversation);
    // Ten taken, each answered; then one line to slow down, and silence.
    expect(asked).toHaveLength(10);
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toBe(
      "You've sent me a lot of messages in a short time. Wait a moment, then ask me again."
    );
  });

  it("is counted per person: someone else still gets in", async () => {
    const flooder = teamsPerson();
    for (let sent = 0; sent < 11; sent += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, as typed
      await post(messageFrom(flooder));
    }
    const { teams } = await member();

    await post(messageFrom(teams));

    await expect(kept(teams.conversation)).resolves.toHaveLength(1);
  });
});

describe("a platform the deployment hasn't set up", () => {
  it("isn't there", async () => {
    const { teams } = await member();

    await expect(
      post(messageFrom(teams), { path: "/api/channels/whatsapp" })
    ).resolves.toBe(404);
    await expect(
      post(messageFrom(teams), { coreEnv: { ...env, TEAMS_BOT_ID: "" } })
    ).resolves.toBe(404);

    await expect(kept(teams.conversation)).resolves.toStrictEqual([]);
  });
});
