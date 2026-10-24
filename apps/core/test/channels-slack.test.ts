import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { channelResponse } from "../src/channels/door.ts";
import type { ChannelMessage } from "../src/channels/door.ts";
import { say } from "../src/channels/words.ts";
import {
  channelConversations,
  channelAccounts,
  channelLinks,
} from "../src/db/core/schema.ts";
import { slackApp, slackPostedUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// Slack as a door into core (src/channels/slack.ts, src/channels/door.ts),
// from its threat model first: a request Slack didn't sign for this
// client's app, one signed for a moment long gone, and one changed after
// signing are each refused with a 401 before anything is read; a resent
// event is taken once. Then who gets in: only a person who linked their
// Slack account to Grasp, in their own direct message with the bot.
// Anyone else gets one line, or the link to sign in by, sent through
// connect to the fake Slack behind it (test/connect-providers.ts).

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

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

/** Slack's signature of `body` at `timestamp`, under `secret`. */
const signature = async (
  body: string,
  timestamp: number,
  secret: string = slackApp.signingSecret
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`)
  );
  return `v0=${hex(mac)}`;
};

interface Sent {
  /** Slack's headers, or none of them (`null`). */
  signed?: { timestamp?: number; secret?: string; body?: string } | null;
  doorEnv?: Env;
}

/**
 * Posts `payload` to the door as Slack would, signed unless `signed` says
 * otherwise, and waits for what it does in the background: its status,
 * its body, and the messages it handed on.
 */
const post = async (
  payload: unknown,
  { signed = {}, doorEnv = env }: Sent = {}
) => {
  const body = JSON.stringify(payload);
  const headers = new Headers({ "content-type": "application/json" });
  if (signed !== null) {
    const timestamp = signed.timestamp ?? Math.floor(Date.now() / 1000);
    headers.set("x-slack-request-timestamp", String(timestamp));
    headers.set(
      "x-slack-signature",
      await signature(signed.body ?? body, timestamp, signed.secret)
    );
  }
  const handed: ChannelMessage[] = [];
  const ctx = createExecutionContext();
  const response = await channelResponse(
    new Request("https://acme.grasp.test/api/channels/slack", {
      method: "POST",
      headers,
      body,
    }),
    doorEnv,
    "slack",
    "request-1",
    ctx,
    {
      handoff: async (message) => {
        handed.push(message);
        await Promise.resolve();
      },
    }
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, text, handed };
};

/** A message `user` sent the bot in `channel`, as Slack posts one. */
const messageFrom = (
  user: string,
  {
    channel = `D${unique()}`,
    channelType = "im",
    extra = {},
  }: { channel?: string; channelType?: string; extra?: object } = {}
) => ({
  type: "event_callback",
  team_id: "TACME",
  api_app_id: "ASTEPHEN",
  event_id: `Ev${unique()}`,
  event_time: Math.floor(Date.now() / 1000),
  event: {
    type: "message",
    user,
    text: "What's on my calendar today?",
    ts: `${Math.floor(Date.now() / 1000)}.000100`,
    channel,
    channel_type: channelType,
    ...extra,
  },
});

/** Someone with a Slack account linked to their Grasp person. */
const linkedPerson = async () => {
  const { userId } = await signedInApi(idp, "user");
  const slackUser = `U${unique()}`;
  await drizzle(env.DB).insert(channelAccounts).values({
    id: crypto.randomUUID(),
    platform: "slack",
    platformUserId: slackUser,
    userId,
    linkedAt: new Date(),
    linkedHow: "sign_in_link",
  });
  return { userId, slackUser };
};

const callSchema = z.array(
  z.object({
    method: z.string(),
    fields: z.record(z.string(), z.unknown()),
    authorized: z.boolean(),
  })
);

/** What reached Slack for `channel`. */
const slackSawIn = async (channel: string) => {
  const response = await providers().fetch(slackPostedUrl);
  return callSchema
    .parse(await response.json())
    .filter(({ fields }) => fields.channel === channel);
};

const refused = { status: 401, text: "Unauthorized", handed: [] };

describe("a request Slack didn't sign for the client's app", () => {
  it("is refused unsigned, signed with another secret, or changed after signing", async () => {
    const { slackUser } = await linkedPerson();
    const message = messageFrom(slackUser);
    const outcomes = [
      await post(message, { signed: null }),
      await post(message, {
        signed: { secret: "another-apps-signing-secret" },
      }),
      await post(message, {
        signed: { body: JSON.stringify(messageFrom(slackUser)) },
      }),
    ];
    expect(outcomes).toStrictEqual([refused, refused, refused]);
    await expect(slackSawIn(message.event.channel)).resolves.toStrictEqual([]);
  });

  it("is refused when it was signed more than five minutes ago, or ahead", async () => {
    const { slackUser } = await linkedPerson();
    const now = Math.floor(Date.now() / 1000);
    const outcomes = [
      await post(messageFrom(slackUser), {
        signed: { timestamp: now - 6 * 60 },
      }),
      await post(messageFrom(slackUser), {
        signed: { timestamp: now + 6 * 60 },
      }),
    ];
    expect(outcomes).toStrictEqual([refused, refused]);
  });

  it("answers Slack's URL check only when Slack signed it", async () => {
    const check = {
      type: "url_verification",
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    };
    const [unsigned, answered] = [
      await post(check, { signed: null }),
      await post(check),
    ];
    expect({ unsigned: unsigned.status, answered }).toStrictEqual({
      unsigned: 401,
      answered: {
        status: 200,
        text: JSON.stringify({ challenge: check.challenge }),
        handed: [],
      },
    });
  });

  it("isn't there while the deployment hasn't set Slack up", async () => {
    const { slackUser } = await linkedPerson();
    for (const SLACK_SIGNING_SECRET of [undefined, ""]) {
      // oxlint-disable-next-line no-await-in-loop -- one setting at a time
      const { status } = await post(messageFrom(slackUser), {
        doorEnv: { ...env, SLACK_SIGNING_SECRET },
      });
      expect(status).toBe(404);
    }
  });
});

describe("who gets in from Slack", () => {
  it("takes a linked person's direct message once, however often Slack sends it, and keeps the conversation as theirs", async () => {
    const { userId, slackUser } = await linkedPerson();
    const message = messageFrom(slackUser);
    const first = await post(message);
    const again = await post(message);
    const sentThere = await slackSawIn(message.event.channel);
    const [kept] = await drizzle(env.DB)
      .select({ userId: channelConversations.userId })
      .from(channelConversations)
      .where(
        and(
          eq(channelConversations.platform, "slack"),
          eq(channelConversations.threadId, `slack:${message.event.channel}:`)
        )
      );
    expect({
      first: first.handed.map(({ platform, userId: from }) => ({
        platform,
        from,
      })),
      again: again.handed,
      kept: kept?.userId,
      // Nothing was sent to the person: the answer is the next step's.
      sent: sentThere.map(({ method }) => method),
    }).toStrictEqual({
      first: [{ platform: "slack", from: userId }],
      again: [],
      kept: userId,
      sent: [],
    });
  });

  it("sends someone who hasn't linked their Slack account the link to sign in by, and reads nothing they wrote", async () => {
    const slackUser = `U${unique()}`;
    const message = messageFrom(slackUser);
    const { handed } = await post(message);
    const sent = await slackSawIn(message.event.channel);
    const links = await drizzle(env.DB)
      .select({ platform: channelLinks.platform })
      .from(channelLinks)
      .where(eq(channelLinks.platformUserId, slackUser));
    const shown = JSON.stringify(sent[0]?.fields ?? {});
    expect({
      handed,
      sent: sent.map(({ method, authorized }) => ({ method, authorized })),
      links,
      linksToGrasp: shown.includes("https://acme.grasp.test/chat-link#"),
      echoed: shown.includes("calendar"),
    }).toStrictEqual({
      handed: [],
      sent: [{ method: "chat.postMessage", authorized: true }],
      links: [{ platform: "slack" }],
      linksToGrasp: true,
      echoed: false,
    });
  });

  it("answers a linked person writing in a channel with one line, and hands nothing on", async () => {
    const { slackUser } = await linkedPerson();
    const channel = `C${unique()}`;
    const { handed } = await post(
      messageFrom(slackUser, { channel, channelType: "channel" })
    );
    const sent = await slackSawIn(channel);
    expect({
      handed,
      sent: sent.map(({ method, fields }) => ({ method, text: fields.text })),
    }).toStrictEqual({
      handed: [],
      sent: [{ method: "chat.postMessage", text: say("privateOnly", "en") }],
    });
  });

  it("drops the bot's own messages and edits without a word", async () => {
    const { slackUser } = await linkedPerson();
    const ownChannel = `D${unique()}`;
    const results = [
      await post(
        messageFrom(slackUser, {
          channel: ownChannel,
          extra: { bot_id: "BSTEPHEN" },
        })
      ),
      await post(
        messageFrom(slackUser, {
          channel: ownChannel,
          extra: { subtype: "message_changed" },
        })
      ),
    ];
    expect({
      handed: results.flatMap(({ handed }) => handed),
      statuses: results.map(({ status }) => status),
      sent: await slackSawIn(ownChannel),
    }).toStrictEqual({ handed: [], statuses: [200, 200], sent: [] });
  });
});
