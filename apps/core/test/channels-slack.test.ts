import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { confirmAction, startAction } from "../src/channels/cards.tsx";
import { channelResponse } from "../src/channels/door.ts";
import type { ChannelMessage } from "../src/channels/door.ts";
import { say } from "../src/channels/words.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import {
  channelConversations,
  channelAccounts,
  channelLinks,
} from "../src/db/core/schema.ts";
import { workspace } from "../src/durable-objects.ts";
import { configureObject, says } from "./agent-chat.ts";
import { slackApp, slackPostedUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { signedInApi, unique } from "./sign-in.ts";
import {
  memberAnsweredBy,
  messageFrom as teamsMessageFrom,
  post as postToTeams,
  reached,
  watched,
} from "./teams-door.ts";
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

watched();

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
  /**
   * How the body goes: as JSON, as Slack sends events (the default), or
   * form-encoded as `payload=`, as Slack sends a press on a button.
   */
  form?: boolean;
  /** Slack's headers, or none of them (`null`). */
  signed?: { timestamp?: number; secret?: string; body?: string } | null;
  doorEnv?: Env;
  /** Whether the door hands messages to the test (`true`) or to the agent. */
  caught?: boolean;
}

/**
 * Posts `payload` to the door as Slack would, signed unless `signed` says
 * otherwise, and waits for what it does in the background: its status,
 * its body, and the messages it handed on.
 */
const post = async (
  payload: unknown,
  { form = false, signed = {}, doorEnv = env, caught = true }: Sent = {}
) => {
  const body = form
    ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
    : JSON.stringify(payload);
  const headers = new Headers({
    "content-type": form
      ? "application/x-www-form-urlencoded"
      : "application/json",
  });
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
    caught
      ? {
          handoff: async (message) => {
            handed.push(message);
            await Promise.resolve();
          },
        }
      : {}
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
    // Unique, as Slack's are: the Chat SDK takes a message once by it.
    ts: `${Math.floor(Date.now() / 1000)}.${String(
      crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
    )
      .padStart(10, "0")
      .slice(0, 6)}`,
    channel,
    channel_type: channelType,
    ...extra,
  },
});

/**
 * A press by `user` on button `actionId` of a message the bot sent in
 * `channel`, carrying `value`, as Slack posts one (`block_actions`).
 */
const pressFrom = (
  user: string,
  {
    channel = `D${unique().toUpperCase()}`,
    actionId = confirmAction,
    value,
  }: { channel?: string; actionId?: string; value: string }
) => {
  const ts = `${Math.floor(Date.now() / 1000)}.000100`;
  return {
    type: "block_actions",
    team: { id: "TACME", domain: "acme" },
    api_app_id: "ASTEPHEN",
    user: { id: user, username: "ben", name: "ben", team_id: "TACME" },
    channel: { id: channel, name: "directmessage" },
    container: {
      type: "message",
      message_ts: ts,
      channel_id: channel,
      is_ephemeral: false,
    },
    message: { type: "message", ts, user: "UBOT", text: "Card" },
    trigger_id: `trigger-${unique()}`,
    response_url: "https://hooks.slack.test/actions/T/1/x",
    actions: [
      {
        type: "button",
        block_id: "actions",
        action_id: actionId,
        value,
        action_ts: ts,
      },
    ],
  };
};

/** Someone with a Slack account linked to their Grasp person. */
const linkedPerson = async () => {
  const { userId, api } = await signedInApi(idp, "user");
  const slackUser = `U${unique()}`;
  await drizzle(env.DB).insert(channelAccounts).values({
    id: crypto.randomUUID(),
    platform: "slack",
    platformUserId: slackUser,
    userId,
    linkedAt: new Date(),
    linkedHow: "sign_in_link",
  });
  return { userId, slackUser, api };
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

/** Which app each of a person's listed chats came through. */
const viaOf = async (api: Awaited<ReturnType<typeof linkedPerson>>["api"]) => {
  const listed = await api.chats.list();
  return listed.map(({ via }) => via).toSorted();
};

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

describe("a press on a card in Slack", () => {
  it("reaches the card's handler for a linked person in their own direct message, as a press in Teams does", async () => {
    const { slackUser } = await linkedPerson();
    // Writes that aren't held: the card's handler says it changed since.
    const confirm = pressFrom(slackUser, {
      value: JSON.stringify([
        { id: crypto.randomUUID(), inputHash: "0".repeat(64) },
      ]),
    });
    const confirmed = await post(confirm, { form: true });
    // An offer that isn't there: Start's handler says it is gone.
    const start = pressFrom(slackUser, {
      actionId: startAction,
      value: crypto.randomUUID(),
    });
    const started = await post(start, { form: true });

    const said = async (channel: string) => {
      const calls = await slackSawIn(channel);
      return calls.map(({ method, fields }) => [method, fields.text]);
    };
    expect({
      confirmed: confirmed.status,
      confirmSaid: await said(confirm.channel.id),
      started: started.status,
      startSaid: await said(start.channel.id),
    }).toStrictEqual({
      confirmed: 200,
      confirmSaid: [["chat.postMessage", say("changedSince", "en")]],
      started: 200,
      startSaid: [["chat.postMessage", say("startGone", "en")]],
    });
  });

  it("is refused unsigned, and runs nothing for someone who hasn't linked their Slack account, or outside a direct message", async () => {
    const { slackUser } = await linkedPerson();
    const value = JSON.stringify([
      { id: crypto.randomUUID(), inputHash: "0".repeat(64) },
    ]);
    const unsigned = await post(pressFrom(slackUser, { value }), {
      form: true,
      signed: null,
    });
    const stranger = pressFrom(`U${unique()}`, { value });
    const inChannel = pressFrom(slackUser, {
      channel: `C${unique().toUpperCase()}`,
      value,
    });
    await post(stranger, { form: true });
    await post(inChannel, { form: true });

    expect({
      unsigned: unsigned.status,
      stranger: await slackSawIn(stranger.channel.id),
      inChannel: await slackSawIn(inChannel.channel.id),
    }).toStrictEqual({ unsigned: 401, stranger: [], inChannel: [] });
  });
});

describe("a linked person's question in Slack", () => {
  it("gets the same answer as the same question in Teams, in their own Slack chat, which their list says came through Slack", async () => {
    const answer = "Parental leave lasts sixteen weeks.";
    const { userId, slackUser, api } = await linkedPerson();
    // One provider for the organization: it answers both chats.
    const provider = await fakeProvider(says(answer), says(answer));
    await configureObject(workspace(env, personalWorkspaceId(userId)));
    const question = "How long is parental leave?";
    const fromSlack = messageFrom(slackUser);
    fromSlack.event.text = question;
    await post(fromSlack, { caught: false });

    const inTeams = await memberAnsweredBy(idp, provider);
    await postToTeams(teamsMessageFrom(inTeams.teams, { text: question }));

    const slackPosts = await slackSawIn(fromSlack.event.channel);
    const { activities } = await reached(inTeams.teams.conversation);
    const teamsAnswer = JSON.stringify(
      activities.filter(({ type }) => type === "message")
    );
    // Each person's list says which app their chat came through, and a
    // chat started in Grasp itself is Grasp's own.
    const inGrasp = await api.chats.create("Leave questions");
    expect({
      // Posted whole, or streamed: a first post, then updated as it comes.
      slack: slackPosts.some(
        ({ method, fields, authorized }) =>
          ["chat.postMessage", "chat.update"].includes(method) &&
          authorized &&
          JSON.stringify(fields).includes(answer)
      ),
      teams: teamsAnswer.includes(answer),
      created: inGrasp.via,
      listedForSlackPerson: await viaOf(api),
      listedForTeamsPerson: await viaOf(inTeams.api),
    }).toStrictEqual({
      slack: true,
      teams: true,
      created: "web",
      listedForSlackPerson: ["slack", "web"],
      listedForTeamsPerson: ["teams"],
    });
  });
});
