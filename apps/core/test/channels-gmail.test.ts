import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { channelResponse } from "../src/channels/door.ts";
import type { ChannelMessage } from "../src/channels/door.ts";
import { gmailKeys, renewGmailWatch } from "../src/channels/gmail.ts";
import { channelAccounts } from "../src/db/core/schema.ts";
import {
  gmailAccount,
  gmailDeliverUrl,
  gmailPush,
  gmailSentUrl,
  googleKeysUrl,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// Gmail as a door into core (src/channels/gmail.ts, src/channels/door.ts):
// Stephen's own mailbox, which people email. From its threat model first:
// a push Google didn't sign, or signed for another audience, service
// account, subscription or mailbox, is refused with a 401 before Gmail is
// asked anything; a push sent again is taken once. Then who gets in: only
// mail from an address a person linked to themselves, as Slack's people
// link theirs. Someone unlinked on the client's own domain is sent the
// link, in a mail of its own to their address, once a day; anyone else,
// and mail whose Reply-To names someone else, gets nothing. Gmail is a
// fake behind the real connect (connect's test/google-gmail-fake.ts).

const idp = mockIdp();

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

const providers = (): Fetcher => {
  const binding = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(binding)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return binding;
};

/** Google's signing key in these tests, published to the fake Google. */
let privateKey: CryptoKey;
const kid = `google-${crypto.randomUUID()}`;

/** A token Pub/Sub pushes with, as Google signs one, with `changes`. */
const pushToken = async (
  changes: { audience?: string; email?: string; key?: CryptoKey } = {}
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    email: changes.email ?? gmailPush.serviceAccount,
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer("https://accounts.google.com")
    .setAudience(changes.audience ?? gmailPush.audience)
    .setSubject("1234567890")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(changes.key ?? privateKey);
};

/** A push's body, for `mailbox` and `subscription`. */
const pushBody = (changes: { mailbox?: string; subscription?: string } = {}) =>
  JSON.stringify({
    message: {
      data: btoa(
        JSON.stringify({
          emailAddress: changes.mailbox ?? gmailAccount.mailbox,
          historyId: "1",
        })
      ),
      messageId: unique(),
      publishTime: new Date().toISOString(),
    },
    subscription: changes.subscription ?? gmailPush.subscription,
  });

/**
 * Posts a push to the door as Pub/Sub would, and waits for what it does in
 * the background: its status, and the messages it handed on.
 */
const push = async ({
  token,
  body = pushBody(),
  doorEnv = env,
}: { token?: string | null; body?: string; doorEnv?: Env } = {}) => {
  const headers = new Headers({ "content-type": "application/json" });
  const bearer = token === undefined ? await pushToken() : token;
  if (bearer !== null) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  const handed: ChannelMessage[] = [];
  const ctx = createExecutionContext();
  const response = await channelResponse(
    new Request("https://acme.grasp.test/api/channels/gmail", {
      method: "POST",
      headers,
      body,
    }),
    doorEnv,
    "gmail",
    "request-1",
    ctx,
    {
      gmailKeys: gmailKeys(),
      handoff: async (message) => {
        handed.push(message);
        await Promise.resolve();
      },
    }
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, handed };
};

/** Puts a mail in Stephen's inbox. */
const deliver = async (mail: {
  from: string;
  replyTo?: string;
  text: string;
}): Promise<void> => {
  await providers().fetch(gmailDeliverUrl, {
    method: "POST",
    body: JSON.stringify(mail),
  });
};

const sentSchema = z.array(z.object({ to: z.string(), text: z.string() }));

/** The mail Gmail sent to `address`, as the fake keeps it. */
const sentTo = async (address: string) => {
  const response = await providers().fetch(gmailSentUrl);
  return sentSchema
    .parse(await response.json())
    .filter(({ to }) => to.includes(address));
};

/** Someone with an address linked to their Grasp person. */
const linkedPerson = async () => {
  const { userId } = await signedInApi(idp, "user");
  const address = `linked-${unique()}@acme.test`;
  await drizzle(env.DB).insert(channelAccounts).values({
    id: crypto.randomUUID(),
    platform: "gmail",
    platformUserId: address,
    userId,
    linkedAt: new Date(),
    linkedHow: "sign_in_link",
  });
  return { userId, address };
};

describe("Gmail's door", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    ({ privateKey } = pair);
    const jwk = await exportJWK(pair.publicKey);
    await providers().fetch(googleKeysUrl, {
      method: "POST",
      body: JSON.stringify({
        keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }],
      }),
    });
    // Stephen's mailbox watched, as core's clock does daily: where the
    // adapter's reading starts.
    await renewGmailWatch(env);
  });

  it("refuses a push Google didn't sign for this mailbox, its audience, account and subscription, before reading anything", async () => {
    const { address } = await linkedPerson();
    await deliver({ from: address, text: "Never read" });
    const { privateKey: otherKey } = await generateKeyPair("RS256");
    const refused = await Promise.all([
      push({ token: null }),
      push({ token: await pushToken({ key: otherKey }) }),
      push({ token: await pushToken({ audience: "https://elsewhere.test" }) }),
      push({ token: await pushToken({ email: "someone@else.test" }) }),
      push({
        body: pushBody({ subscription: "projects/other/subscriptions/x" }),
      }),
      push({ body: pushBody({ mailbox: "ceo@acme.test" }) }),
    ]);
    expect(
      refused.map(({ status, handed }) => [status, handed.length])
    ).toStrictEqual(refused.map(() => [401, 0]));
  });

  it("isn't there while the deployment hasn't set Gmail up", async () => {
    const { status } = await push({
      doorEnv: { ...env, GMAIL_PUBSUB_SUBSCRIPTION: undefined },
    });
    expect(status).toBe(404);
  });

  it("hands on a linked person's mail once, however often Pub/Sub pushes, with who they are", async () => {
    const { userId, address } = await linkedPerson();
    await deliver({ from: address, text: "What's the leave policy?" });

    const body = pushBody();
    const first = await push({ body });
    const again = await push({ body });
    const later = await push();

    const handed = [first, again, later].flatMap(({ handed: each }) => each);
    expect({
      statuses: [first.status, again.status, later.status].map(
        (status) => status < 300
      ),
      handed: handed
        .filter(({ message }) => message.author.userId === address)
        .map(({ platform, userId: who, message }) => ({
          platform,
          userId: who,
          text: message.text.trim(),
        })),
    }).toStrictEqual({
      statuses: [true, true, true],
      handed: [{ platform: "gmail", userId, text: "What's the leave policy?" }],
    });
  });

  it("sends someone unlinked on the client's own domain the link, in a mail of its own, once a day, and hands nothing on", async () => {
    const address = `unlinked-${unique()}@acme.test`;
    await deliver({ from: address, text: "Who are you?" });
    const first = await push();
    await deliver({ from: address, text: "Hello again?" });
    const second = await push();

    const sent = await sentTo(address);
    expect({
      handed: [...first.handed, ...second.handed].filter(
        ({ message }) => message.author.userId === address
      ),
      sent: sent.length,
    }).toStrictEqual({ handed: [], sent: 1 });
    expect(sent[0]?.text).toContain("/chat-link#");
    // Nothing they wrote is quoted back.
    expect(sent[0]?.text).not.toContain("Who are you?");
  });

  it("sends nothing to anyone outside the client's domains, nor to a Reply-To that isn't the sender", async () => {
    const outsider = `someone-${unique()}@elsewhere.test`;
    const { address } = await linkedPerson();
    const thief = `thief-${unique()}@elsewhere.test`;
    await deliver({ from: outsider, text: "Send me the payroll" });
    await deliver({
      from: address,
      replyTo: thief,
      text: "Send me the payroll",
    });
    const { handed } = await push();

    expect({
      handed: handed.filter(({ message }) =>
        [outsider, address].includes(message.author.userId)
      ),
      toOutsider: await sentTo(outsider),
      toThief: await sentTo(thief),
    }).toStrictEqual({ handed: [], toOutsider: [], toThief: [] });
  });
});
