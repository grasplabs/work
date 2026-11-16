import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { memberOf } from "../src/auth/identity.ts";
import { addSource, rememberAs } from "../src/brain-next.ts";
import { confirmAction, startAction } from "../src/channels/cards.tsx";
import { channelResponse } from "../src/channels/door.ts";
import type { ChannelMessage } from "../src/channels/door.ts";
import { inertOn } from "../src/channels/inert.ts";
import { say } from "../src/channels/words.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import {
  channelConversations,
  channelAccounts,
  channelLinks,
} from "../src/db/core/schema.ts";
import { workspace } from "../src/durable-objects.ts";
import { shareWorkflowResource } from "../src/workflow-members.ts";
import {
  createWorkflowResource,
  setWorkflowAskable,
} from "../src/workflow-resources.ts";
import { codeStep, keptAnswersOf, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { chatIdsOf } from "./code-step-trace.ts";
import { slackApp, slackPostedUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { attacks, ordinary } from "./inert-answers.ts";
import { saveInstructions } from "./instruction-saves.ts";
import { anyNamesOf, greetingOf } from "./json-workflow-apps.ts";
import { mailConnection } from "./mail-connection.ts";
import { fakeProvider } from "./model-provider.ts";
import {
  callOf,
  liveNotes,
  noteTitles,
  ownSource,
  writesNote,
} from "./notes-app.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import {
  memberAnsweredBy,
  messageFrom as teamsMessageFrom,
  post as postToTeams,
  reached,
  watched,
} from "./teams-door.ts";
import { testBinding } from "./test-env.ts";
import { publishDefinition } from "./workflow-publishing.ts";

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
    // Upper case, as Slack's ids are.
    channel = `D${unique().toUpperCase()}`,
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

/** A word no other text holds. */
const marker = (): string => `m${unique()}`;

/** The titles of a person's chats in Grasp, as their list shows them. */
const listedFor = async (
  api: Awaited<ReturnType<typeof linkedPerson>>["api"]
) => {
  const listed = await api.chats.list();
  return listed.map(({ title }) => title);
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
      first: first.handed.map(({ platform, userId: from, place }) => ({
        platform,
        from,
        place,
      })),
      again: again.handed,
      kept: kept?.userId,
      // Nothing was sent to the person: the answer is the next step's.
      sent: sentThere.map(({ method }) => method),
    }).toStrictEqual({
      // A direct message, as Slack names it: the person's alone.
      first: [{ platform: "slack", from: userId, place: { kind: "direct" } }],
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

  it("answers a linked person writing anywhere but a direct message with one line, and hands nothing on", async () => {
    const { slackUser } = await linkedPerson();
    // A channel, a group DM, and a conversation whose two names of it
    // disagree: only one Slack names a direct message both ways is one.
    const places = [
      { channel: `C${unique().toUpperCase()}`, channelType: "channel" },
      { channel: `C${unique().toUpperCase()}`, channelType: "mpim" },
      { channel: `G${unique().toUpperCase()}`, channelType: "im" },
    ];
    const answered = [];
    for (const place of places) {
      // oxlint-disable-next-line no-await-in-loop -- one message at a time
      const { handed } = await post(messageFrom(slackUser, place));
      // oxlint-disable-next-line no-await-in-loop -- one message at a time
      const sent = await slackSawIn(place.channel);
      answered.push({
        handed,
        sent: sent.map(({ method, fields }) => ({ method, text: fields.text })),
      });
    }
    expect(answered).toStrictEqual(
      places.map(() => ({
        handed: [],
        sent: [{ method: "chat.postMessage", text: say("privateOnly", "en") }],
      }))
    );
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
  it("gets the same answer as the same question in Teams, in a conversation no list in Grasp shows", async () => {
    const answer =
      "Parental leave lasts sixteen weeks, as the leave policy and the HR page say.";
    const { slackUser, api } = await linkedPerson();
    // One provider for the organization: it answers both chats.
    const provider = await fakeProvider(says(answer), says(answer));
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
    // A conversation in a chat app is never a chat in Grasp: each
    // person's list holds only what they started in Grasp itself.
    await api.chats.create("Leave questions");
    expect({
      // Posted once, whole.
      slack: slackPosts.some(
        ({ method, fields, authorized }) =>
          method === "chat.postMessage" &&
          authorized &&
          JSON.stringify(fields).includes(answer)
      ),
      teams: teamsAnswer.includes(answer),
      listedForSlackPerson: await listedFor(api),
      listedForTeamsPerson: await listedFor(inTeams.api),
    }).toStrictEqual({
      slack: true,
      teams: true,
      listedForSlackPerson: ["Leave questions"],
      listedForTeamsPerson: [],
    });
  });

  it("posts an answer with its indentation as the model wrote it, after a blank line too", async () => {
    const answer =
      "Here:\n\n```python\ndef f():\n    x = 1\n\n    return x\n```\n\n- a\n\n  - nested b";
    const { slackUser } = await linkedPerson();
    await fakeProvider(says(answer));
    const asked = messageFrom(slackUser);
    asked.event.text = "Show me f.";
    await post(asked, { caught: false });

    const posted = await slackSawIn(asked.event.channel);
    const said = JSON.stringify(
      posted.filter(({ method }) =>
        ["chat.postMessage", "chat.update"].includes(method)
      )
    );
    expect({
      returnIndented: said.includes(String.raw`\n    return x`),
      nestedIndented: said.includes(String.raw`\n  - nested b`),
    }).toStrictEqual({ returnIndented: true, nestedIndented: true });
  });

  it("goes on with what was said before, in a conversation whose address answers as a chat that doesn't exist", async () => {
    const badge = `badge-${unique()}`;
    const { slackUser, api, userId } = await linkedPerson();
    const provider = await fakeProvider(says("Noted."), says(`It's ${badge}.`));
    const channel = `D${unique().toUpperCase()}`;
    const told = messageFrom(slackUser, { channel });
    told.event.text = `My badge is ${badge}.`;
    await post(told, { caught: false });
    const asked = messageFrom(slackUser, { channel });
    asked.event.text = `What is my badge? ${unique()}`;
    await post(asked, { caught: false });

    const [conversation] = await chatIdsOf(
      workspace(env, personalWorkspaceId(userId)),
      userId
    );
    if (conversation === undefined) {
      throw new Error("Expected the Slack conversation to be kept");
    }
    const answering = provider.requests
      .map(({ body }) => JSON.stringify(body))
      .filter(
        (body) =>
          body.includes(asked.event.text) &&
          !body.includes("You sort one message a person sent to Stephen")
      );
    expect({
      remembered:
        answering.length > 0 && answering.every((body) => body.includes(badge)),
      listed: await listedFor(api),
      opened: await outcome(api.chats.summary(conversation.id)),
      followed: await outcome(
        api.chats.watch(conversation.id, null, () => {
          // Nothing is ever pushed for it.
        })
      ),
    }).toStrictEqual({
      remembered: true,
      listed: [],
      opened: await outcome(api.chats.summary(crypto.randomUUID())),
      followed: await outcome(
        api.chats.watch(crypto.randomUUID(), null, () => {
          // Nothing is ever pushed for it either.
        })
      ),
    });
  });
});

/** The text of the first block of `blocks`, as Slack's API got them. */
const firstBlockText = (blocks: unknown): string | undefined => {
  const parsed = z
    .array(z.object({ text: z.object({ text: z.string(), type: z.string() }) }))
    .safeParse(typeof blocks === "string" ? JSON.parse(blocks) : blocks);
  return parsed.data?.[0]?.text.text;
};

/** A `<` or `>`, or an `&` that starts none of Slack's three escapes. */
const unescapedInSlack = /[<>]|&(?!amp;|lt;|gt;)/u;

/** Every character but the white space between them, in order. */
const ink = (text: string): string => text.replaceAll(/\s/gu, "");

/** Every section's text in `blocks`, as Slack's API got them, in order. */
const sectionTextsOf = (blocks: unknown): string[] => {
  const parsed = z
    .array(
      z
        .object({
          type: z.string(),
          text: z.object({ text: z.string() }).optional(),
        })
        .loose()
    )
    .safeParse(typeof blocks === "string" ? JSON.parse(blocks) : blocks);
  return (parsed.data ?? []).flatMap(({ type, text }) =>
    type === "section" && text !== undefined ? [text.text] : []
  );
};

describe("a linked person's answer in Slack", () => {
  it("is posted whole over several messages when too long for one, Slack's own syntax escaped in each, no section cut", async () => {
    const sentence =
      "Tom & Jerry's <b>invoices</b> are at [the list](https://e.test). ";
    const answer = Array.from(
      { length: 30 },
      (_, at) => `${at}. ${sentence.repeat(40).trim()}`
    ).join("\n\n");
    const { slackUser } = await linkedPerson();
    await fakeProvider(says(answer));
    const message = messageFrom(slackUser);
    message.event.text = "Tell me about the invoices.";
    await post(message, { caught: false });

    const seen = await slackSawIn(message.event.channel);
    const posts = seen.filter(
      ({ method, fields }) =>
        method === "chat.postMessage" &&
        // Not the card offering their own Microsoft 365 (connect-own.ts).
        !JSON.stringify(fields).includes("/connect-microsoft")
    );
    const sections = posts.flatMap(({ fields }) =>
      sectionTextsOf(fields.blocks)
    );
    expect({
      several: posts.length > 1,
      whole: ink(sections.join("")) === ink(inertOn("slack")(answer)),
      unescaped: sections.filter((section) => unescapedInSlack.test(section))
        .length,
      eachWithin: sections.every((section) => section.length <= 3000),
    }).toStrictEqual({
      several: true,
      whole: true,
      unescaped: 0,
      eachWithin: true,
    });
  });

  it("is posted once, on a card, previews off, never updated, Slack's own syntax escaped, and kept as written", async () => {
    const { userId, slackUser } = await linkedPerson();
    await fakeProvider(says(attacks));
    const message = messageFrom(slackUser);
    message.event.text = "How does leave work?";
    await post(message, { caught: false });

    const sent = await slackSawIn(message.event.channel);
    const posts = sent.filter(({ method }) => method === "chat.postMessage");
    const answer = firstBlockText(posts[0]?.fields.blocks) ?? "";
    expect({
      methods: [...new Set(sent.map(({ method }) => method))],
      // Every post, the answer's and those after it: Slack fetches none.
      previews: posts.map(({ fields }) => [
        fields.unfurl_links,
        fields.unfurl_media,
      ]),
      // Escaped once, by Grasp, and sent as such: Slack decodes it for
      // display, so none of the bracketed links, mentions or broadcasts
      // the model wrote stands; a bare `@U…` stays text, as the adapter
      // makes a mention of one only in a text post, never in a card's
      // blocks. A plain `@here` Slack itself would still parse (inert.ts).
      answer,
      unescaped: [answer, String(posts[0]?.fields.text)].filter((text) =>
        unescapedInSlack.test(text)
      ),
      kept: await keptAnswersOf(userId),
    }).toStrictEqual({
      methods: ["chat.postMessage"],
      previews: posts.map(() => ["false", "false"]),
      answer: inertOn("slack")(attacks),
      unescaped: [],
      kept: [[attacks]],
    });
  });

  it("keeps an ordinary answer's words and formatting, nothing escaped but Slack's bold", async () => {
    const { slackUser } = await linkedPerson();
    await fakeProvider(says(ordinary));
    const message = messageFrom(slackUser);
    message.event.text = "How does leave work?";
    await post(message, { caught: false });

    const [first] = await slackSawIn(message.event.channel);
    // Slack's own bold is one star, as its adapter writes it.
    expect(firstBlockText(first?.fields.blocks)).toBe(
      ordinary.replace("**Leave**", "*Leave*")
    );
  });
});

/** A builder's workflow shared with `userId`, open to asking Stephen. */
const askableWorkflow = async (userId: string, definition = greetingOf()) => {
  const builder = await signedInApi(idp, "builder");
  const by = await memberOf(env.DB, builder.userId);
  if (by === undefined) {
    throw new Error("Expected the builder to be a member");
  }
  const workflow = await createWorkflowResource(env, by, `ask-${unique()}`);
  await publishDefinition(env, by, workflow.id, definition);
  await shareWorkflowResource(env, by, workflow.id, {
    type: "person",
    id: userId,
    role: "user",
  });
  await setWorkflowAskable(env, by, workflow.id, true);
  return workflow;
};

/** A post's buttons, as Slack's API got its blocks. */
const buttonsSchema = z.array(
  z.looseObject({
    elements: z
      .array(z.looseObject({ action_id: z.string(), value: z.string() }))
      .optional(),
  })
);

/** The offer a start card posted to Slack carries. */
const offerOf = (fields: Record<string, unknown>): string | undefined => {
  const blocks = buttonsSchema.safeParse(
    typeof fields.blocks === "string" ? JSON.parse(fields.blocks) : []
  );
  return (blocks.data ?? [])
    .flatMap(({ elements = [] }) => elements)
    .find(({ action_id: action }) => action === startAction)?.value;
};

describe("a workflow started from Slack", () => {
  it("is said to have started on a card, where the adapter adds no mention to what it names", async () => {
    const { userId, slackUser } = await linkedPerson();
    const workflow = await askableWorkflow(userId);
    await fakeProvider(
      codeStep(
        `export default async (self, env) => {
  const [first] = await env.workflows.askable();
  return await env.workflows.offer(first.id, { who: "Ada" });
};`
      ),
      says("There's a card for it.")
    );
    const message = messageFrom(slackUser);
    message.event.text = "Run the greeting for Ada";
    await post(message, { caught: false });
    const offered = await slackSawIn(message.event.channel);
    const offer = offered.map(({ fields }) => offerOf(fields)).find(Boolean);

    await post(
      pressFrom(slackUser, {
        channel: message.event.channel,
        actionId: startAction,
        value: offer ?? "",
      }),
      { form: true }
    );

    const sent = await slackSawIn(message.event.channel);
    const said = sent.at(-1);
    expect([
      said?.method,
      firstBlockText(said?.fields.blocks),
      said?.fields.unfurl_links,
    ]).toStrictEqual([
      "chat.postMessage",
      say("started", "en", { workflow: workflow.name }),
      "false",
    ]);
  });
});

describe("a workflow offered in Slack", () => {
  it("is offered without Start where the card can't show a field in full once it is escaped, and with it where it can", async () => {
    // Keys of `<&>`: 30 characters as written, 130 on the card as
    // `&lt;&amp;&gt;` (inert.ts), past the 100 a label takes; and 21, 91
    // on the card, which fit.
    const cut = "<&>".repeat(10);
    const fits = "<&>".repeat(7);
    const { userId, slackUser } = await linkedPerson();
    await askableWorkflow(userId, anyNamesOf());
    await fakeProvider(
      codeStep(
        `export default async (self, env) => {
  const [first] = await env.workflows.askable();
  await env.workflows.offer(first.id, { ${JSON.stringify(cut)}: "Ada" });
  return await env.workflows.offer(first.id, { ${JSON.stringify(fits)}: "Ada" });
};`
      ),
      says("There are cards for it.")
    );
    const message = messageFrom(slackUser);
    message.event.text = "Run the greeting for Ada";
    await post(message, { caught: false });

    const sent = await slackSawIn(message.event.channel);
    const [offerLine = ""] = say("startOffer", "en", { workflow: "|" }).split(
      "|"
    );
    const cards = sent
      .map(({ fields }) => JSON.stringify(fields.blocks ?? ""))
      .filter((blocks) => blocks.includes(offerLine));
    expect(
      cards.map((blocks) => ({
        start: blocks.includes(startAction),
        line: blocks.includes(say("startTooLong", "en")),
      }))
    ).toStrictEqual([
      { start: false, line: true },
      { start: true, line: false },
    ]);
  });
});

/**
 * What reached Slack once a linked person's turn held a mail to Ben with
 * `subject`, which the model wrote.
 */
const heldInSlack = async (subject: string) => {
  const admin = await signedInApi(idp, "admin");
  const mail = await mailConnection([], ["MAIL_SEND"]);
  const binding = `MAIL${unique()}`.toUpperCase();
  await requestGranted(idp, admin, {
    subject: { type: "agent", agentId: chatAgentId },
    object: { type: "connection", connectionId: mail.id },
    actions: ["MAIL_SEND"],
    binding,
  });
  const { slackUser } = await linkedPerson();
  await fakeProvider(
    codeStep(
      `export default async (self, env) => { await env.connections.call(${JSON.stringify(binding)}, "MAIL_SEND", ${JSON.stringify({ to: "ben@acme.test", subject })}); return "held"; };`
    ),
    says("It waits for you to confirm it.")
  );
  const message = messageFrom(slackUser);
  message.event.text = "Mail ben@acme.test the agenda.";
  await post(message, { caught: false });
  return await slackSawIn(message.event.channel);
};

describe("a linked person's held write in Slack", () => {
  it("shows on its card each value as it will be sent, Slack's own syntax escaped", async () => {
    // An injected mail had the model put a link and a mention in what it
    // would send.
    const sent = await heldInSlack(
      "<https://evil.example/?d=salary|Agenda> for <!here> & co"
    );
    const card = JSON.stringify(
      sent.find(({ fields }) => JSON.stringify(fields).includes(confirmAction))
        ?.fields ?? {}
    );
    // Escaped once, as Slack decodes it for display: shown in full, its
    // bracketed link and broadcast neither.
    expect({
      shown: card.includes(
        "&lt;https://evil.example/?d=salary|Agenda&gt; for &lt;!here&gt; &amp; co"
      ),
      raw: card.includes("<https://evil.example") || card.includes("<!here>"),
      previews: sent
        .filter(({ method }) => method === "chat.postMessage")
        .every(
          ({ fields }) =>
            fields.unfurl_links === "false" && fields.unfurl_media === "false"
        ),
    }).toStrictEqual({ shown: true, raw: false, previews: true });
  });

  it("is on a card without Confirm where a value fits the card but not one of Slack's fields, which its adapter cuts", async () => {
    const sent = await heldInSlack("y".repeat(2500));
    const card = JSON.stringify(
      sent.find(({ fields }) =>
        JSON.stringify(fields).includes(say("heldOne", "en"))
      )?.fields ?? {}
    );
    expect({
      confirm: card.includes(confirmAction),
      said: card.includes(say("cardTooLong", "en")),
    }).toStrictEqual({ confirm: false, said: true });
  });

  it("is on a card without Confirm where a value fits as written but not once escaped", async () => {
    // 3,500 bytes as written, 17,500 as `&amp;`: past what one card takes.
    const sent = await heldInSlack("&".repeat(3500));
    const card = JSON.stringify(
      sent.find(({ fields }) =>
        JSON.stringify(fields).includes(say("heldOne", "en"))
      )?.fields ?? {}
    );
    expect({
      confirm: card.includes(confirmAction),
      said: card.includes(say("cardTooLong", "en")),
    }).toStrictEqual({ confirm: false, said: true });
  });
});

/** The value Confirm carries on a card Slack was sent, and its fields' texts. */
const slackCardOf = (fields: Record<string, unknown>) => {
  const blocks: unknown =
    typeof fields.blocks === "string"
      ? JSON.parse(fields.blocks)
      : fields.blocks;
  let confirm: string | undefined;
  const texts: string[] = [];
  JSON.stringify(blocks, (key, value: unknown) => {
    const button = z
      .object({ action_id: z.literal(confirmAction), value: z.string() })
      .safeParse(value);
    if (button.success) {
      confirm = button.data.value;
    }
    if (key === "text" && typeof value === "string") {
      texts.push(value);
    }
    return value;
  });
  return { confirm, texts };
};

/** A binding name no other test in the file grants. */
const bindingOf = (name: string): string =>
  `${name}${unique().toUpperCase().replaceAll("-", "_")}`;

/**
 * A linked person, a user of a live Notes App the agent may write to,
 * whose direct message, asked about a depot only their own store knows,
 * writes a note titled `title`, which the model wrote (GRA-1929): the card
 * of held writes Slack was sent.
 */
const heldAppWriteInSlack = async (title: string) => {
  const builder = await signedInApi(idp, "builder");
  const admin = await signedInApi(idp, "admin");
  const { app, release } = await liveNotes(builder);
  const { slackUser, userId } = await linkedPerson();
  await builder.api.apps.members.add(app, {
    type: "person",
    id: userId,
    role: "user",
  });
  await requestGranted(idp, builder, {
    subject: { type: "agent", agentId: chatAgentId },
    object: { type: "app", appId: app },
    actions: ["read", "write"],
    binding: bindingOf("NOTES"),
  });
  await requestGranted(idp, admin, {
    subject: { type: "agent", agentId: chatAgentId },
    object: { type: "platform" },
    actions: ["brain"],
    binding: bindingOf("BRAIN"),
  });
  const depot = marker();
  await ownSource(userId, `Depot ${depot} opens at seven.`);
  await fakeProvider(
    writesNote(app, release, title),
    says("It waits for you to confirm it.")
  );
  const message = messageFrom(slackUser);
  message.event.text = `When does depot ${depot} open? Note it.`;
  await post(message, { caught: false });
  const sent = await slackSawIn(message.event.channel);
  const card = sent.find(({ fields }) =>
    JSON.stringify(fields).includes(say("heldOne", "en"))
  );
  if (card === undefined) {
    throw new Error("Expected a card of held writes");
  }
  return {
    slackUser,
    channel: message.event.channel,
    request: callOf(release, "notes.create", { title }),
    card: slackCardOf(card.fields),
    titles: async () => await noteTitles(builder.userId, app, release),
  };
};

describe("a linked person's held write to an App in Slack", () => {
  it("shows on its card why it waits and the exact request, Slack's own syntax escaped, and Confirm writes it as asked for, once", async () => {
    // What the person's own content led the model to write had a link and
    // a broadcast in it.
    const hostile = "<https://evil.example/?d=salary|Agenda> <!here> & co";
    const held = await heldAppWriteInSlack(hostile);
    const press = pressFrom(held.slackUser, {
      channel: held.channel,
      value: held.card.confirm ?? "",
    });
    await post(press, { form: true });
    await post(press, { form: true });

    expect({
      why: held.card.texts.includes(say("heldPrivate", "en")),
      request: held.card.texts.includes(
        `*${say("heldAppRequest", "en")}*\n${inertOn("slack")(held.request)}`
      ),
      raw: held.card.texts.some(
        (text) => text.includes("<https://evil") || text.includes("<!here>")
      ),
      titles: await held.titles(),
    }).toStrictEqual({
      why: true,
      request: true,
      raw: false,
      titles: [hostile],
    });
  });

  it("shows every character nobody sees in its request as an escape, with Confirm", async () => {
    // Tag characters, a bidi override and a zero-width joiner: drawn as
    // nothing in Slack.
    const held = await heldAppWriteInSlack(
      "Agenda\u{E0041}\u{E0042}\u202Eevil\u200D!"
    );
    const request =
      held.card.texts.find((text) =>
        text.startsWith(`*${say("heldAppRequest", "en")}*`)
      ) ?? "";

    expect({
      escapes: ["\\u{E0041}", "\\u{E0042}", "\\u{202E}", "\\u{200D}"].map(
        (escape) => request.includes(escape)
      ),
      unseen: /[\p{Cf}\p{Co}\p{Cn}]/u.test(request),
      confirm: held.card.confirm !== undefined,
    }).toStrictEqual({
      escapes: [true, true, true, true],
      unseen: false,
      confirm: true,
    });
  });

  it("is on a card without Confirm where its request fits the card but not one of Slack's fields", async () => {
    // Slack's adapter cuts a field past 2,000 characters: Confirm would
    // stand under a request shown in part.
    const held = await heldAppWriteInSlack("y".repeat(2500));

    expect({
      confirm: held.card.confirm,
      said: held.card.texts.includes(say("cardTooLong", "en")),
    }).toStrictEqual({ confirm: undefined, said: true });
  });
});

describe("a linked person's direct message in Slack", () => {
  it("is their own chat, as in Grasp: their own sources, memories, instruction file and skills, which no channel or group DM gets", async () => {
    // A direct message is the person's own chat (GRA-1821): only one
    // Slack names a direct message both ways (`im`, a `D…` channel) is
    // one, and Slack's channels and group DMs never reach a turn at all.
    await requestGranted(idp, await signedInApi(idp, "admin"), {
      subject: { type: "agent", agentId: chatAgentId },
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const { slackUser, userId, api } = await linkedPerson();
    const provider = await fakeProvider(says("Noted."));
    const [depot, own, ownWord, file] = [
      marker(),
      marker(),
      marker(),
      marker(),
    ];
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: `Depot ${depot} keeps the person's own note ${own}`,
      readers: { kind: "owner", personId: userId },
    });
    const statement = `Depot ${depot} keeps the person's own memory ${ownWord}`;
    await rememberAs(env, userId, {
      change: crypto.randomUUID(),
      about: { kind: "customer", names: [`Depot ${depot}`] },
      type: "fact",
      statement,
      quote: statement,
    });
    await saveInstructions(
      api,
      { scope: "person", personId: userId },
      `Call me ${file}.`
    );
    const skill = `depot-${unique()}`;
    await api.skills.save(
      `---\nname: ${skill}\ndescription: Look up a depot\n---\n\nThe steps.\n`
    );
    /** What of theirs reached the model for what they posted in `place`. */
    const sentFor = async (place: {
      channel?: string;
      channelType?: string;
    }) => {
      const before = provider.requests.length;
      const message = messageFrom(slackUser, place);
      message.event.text = `What about depot ${depot}?`;
      await post(message, { caught: false });
      const sent = JSON.stringify(
        provider.requests.slice(before).map(({ body }) => body)
      );
      return {
        answered: provider.requests.length > before,
        own: sent.includes(own),
        ownMemory: sent.includes(ownWord),
        file: sent.includes(file),
        ownSkill: sent.includes(`- ${skill} (person`),
      };
    };

    /** What reached the model for `place`, and the lines posted there. */
    const answeredIn = async (place: {
      channel: string;
      channelType: string;
    }) => {
      const sent = await sentFor(place);
      const posted = await slackSawIn(place.channel);
      return {
        ...sent,
        lines: posted.map(({ method, fields }) => ({
          method,
          text: fields.text,
        })),
      };
    };
    const elsewhere = [
      await answeredIn({
        channel: `C${unique().toUpperCase()}`,
        channelType: "channel",
      }),
      await answeredIn({
        channel: `C${unique().toUpperCase()}`,
        channelType: "mpim",
      }),
    ];
    const direct = await sentFor({});

    // Told it answers only in a direct message, and nothing else.
    const none = {
      answered: false,
      own: false,
      ownMemory: false,
      file: false,
      ownSkill: false,
      lines: [{ method: "chat.postMessage", text: say("privateOnly", "en") }],
    };
    expect({ elsewhere, direct }).toStrictEqual({
      elsewhere: [none, none],
      direct: {
        answered: true,
        own: true,
        ownMemory: true,
        file: true,
        ownSkill: true,
      },
    });
  });
});
