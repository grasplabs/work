import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { channelResponse } from "../src/channels/door.ts";
import type { ChannelMessage } from "../src/channels/door.ts";
import { say } from "../src/channels/words.ts";
import { channelAccounts, channelLinks } from "../src/db/core/schema.ts";
import { telegramBot, telegramSentUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// Telegram as a door into core (src/channels/telegram.ts, src/channels/
// door.ts), from its threat model first: a request without the client's
// webhook secret, or with another, is refused with a 401 before anything
// is read; a resent update is taken once. Then who gets in: only a person
// who linked their Telegram account to Grasp, in their private chat with
// the bot. Anyone else gets one line, or the link to sign in by, sent
// through connect to the fake Bot API (test/connect-providers.ts), and
// nothing they wrote is read.

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

interface Sent {
  /** The webhook's secret as sent, or none (`null`). */
  secret?: string | null;
  doorEnv?: Env;
}

/**
 * Posts `update` to the door as Telegram would, with the client's webhook
 * secret unless told otherwise, and waits for what it does in the
 * background: its status and the messages it handed on.
 */
const post = async (
  update: unknown,
  { secret = telegramBot.webhookSecret, doorEnv = env }: Sent = {}
) => {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== null) {
    headers.set("x-telegram-bot-api-secret-token", secret);
  }
  const handed: ChannelMessage[] = [];
  const ctx = createExecutionContext();
  const response = await channelResponse(
    new Request("https://acme.grasp.test/api/channels/telegram", {
      method: "POST",
      headers,
      body: JSON.stringify(update),
    }),
    doorEnv,
    "telegram",
    "request-1",
    ctx,
    {
      handoff: async (message) => {
        handed.push(message);
        await Promise.resolve();
      },
    }
  );
  await response.body?.cancel();
  await waitOnExecutionContext(ctx);
  return { status: response.status, handed };
};

/** A Telegram user id no other test has. */
const someone = (): number =>
  1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);

let updates = Math.floor(Math.random() * 1_000_000);

/** A message `from` sent the bot, as Telegram posts one. */
const messageFrom = (
  from: number,
  {
    chat = { id: from, type: "private" },
    isBot = false,
    language = "en",
    updateId = (updates += 1),
  }: {
    chat?: { id: number; type: string };
    isBot?: boolean;
    language?: string;
    updateId?: number;
  } = {}
) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    from: {
      id: from,
      is_bot: isBot,
      first_name: "Someone",
      language_code: language,
    },
    chat: { ...chat, first_name: "Someone" },
    text: "What's on my calendar today?",
  },
});

/** Someone with a Telegram account linked to their Grasp person. */
const linkedPerson = async () => {
  const { userId } = await signedInApi(idp, "user");
  const telegramUser = someone();
  await drizzle(env.DB)
    .insert(channelAccounts)
    .values({
      id: crypto.randomUUID(),
      platform: "telegram",
      platformUserId: String(telegramUser),
      userId,
      linkedAt: new Date(),
      linkedHow: "sign_in_link",
    });
  return { userId, telegramUser };
};

const sentSchema = z.array(
  z.object({
    method: z.string(),
    fields: z.record(z.string(), z.unknown()),
    authorized: z.boolean(),
  })
);

/** What reached Telegram for chat `chatId`. */
const telegramSawIn = async (chatId: number) => {
  const response = await providers().fetch(telegramSentUrl);
  return sentSchema
    .parse(await response.json())
    .filter(({ fields }) => String(fields.chat_id) === String(chatId));
};

const refused = { status: 401, handed: [] };

describe("a request Telegram didn't send for the client's bot", () => {
  it("is refused without the webhook's secret, or with another", async () => {
    const { telegramUser } = await linkedPerson();
    const outcomes = [
      await post(messageFrom(telegramUser), { secret: null }),
      await post(messageFrom(telegramUser), { secret: "a-guessed-secret" }),
      await post(messageFrom(telegramUser), {
        secret: `${telegramBot.webhookSecret}x`,
      }),
    ];
    expect(outcomes).toStrictEqual([refused, refused, refused]);
    await expect(telegramSawIn(telegramUser)).resolves.toStrictEqual([]);
  });

  it("isn't there while the deployment hasn't set Telegram up", async () => {
    const { telegramUser } = await linkedPerson();
    const statuses = [];
    for (const TELEGRAM_WEBHOOK_SECRET of [undefined, ""]) {
      // oxlint-disable-next-line no-await-in-loop -- one setting at a time
      const { status } = await post(messageFrom(telegramUser), {
        doorEnv: { ...env, TELEGRAM_WEBHOOK_SECRET },
      });
      statuses.push(status);
    }
    expect(statuses).toStrictEqual([404, 404]);
  });
});

describe("who gets in from Telegram", () => {
  it("takes a linked person's private message once, however often Telegram sends it", async () => {
    const { userId, telegramUser } = await linkedPerson();
    const update = messageFrom(telegramUser);
    const first = await post(update);
    const again = await post(update);
    expect({
      first: first.handed.map(({ platform, userId: from, message }) => ({
        platform,
        from,
        text: message.text,
      })),
      again: again.handed,
    }).toStrictEqual({
      first: [
        {
          platform: "telegram",
          from: userId,
          text: "What's on my calendar today?",
        },
      ],
      again: [],
    });
  });

  it("sends someone who hasn't linked their Telegram account the link to sign in by, in their language, and reads nothing they wrote", async () => {
    const telegramUser = someone();
    const { handed } = await post(
      messageFrom(telegramUser, { language: "nl" })
    );
    const sent = await telegramSawIn(telegramUser);
    const links = await drizzle(env.DB)
      .select({ platform: channelLinks.platform })
      .from(channelLinks)
      .where(eq(channelLinks.platformUserId, String(telegramUser)));
    const shown = JSON.stringify(sent[0]?.fields ?? {});
    expect({
      handed,
      sent: sent.map(({ method, authorized }) => ({ method, authorized })),
      links,
      linksToGrasp: shown.includes("https://acme.grasp.test/chat-link#"),
      inDutch: shown.includes("Ik ken je nog niet"),
      echoed: shown.includes("calendar"),
    }).toStrictEqual({
      handed: [],
      sent: [{ method: "sendMessage", authorized: true }],
      links: [{ platform: "telegram" }],
      linksToGrasp: true,
      inDutch: true,
      echoed: false,
    });
  });

  it("answers a linked person writing in a group with one line, and hands nothing on", async () => {
    const { telegramUser } = await linkedPerson();
    const group = -someone();
    const { handed } = await post(
      messageFrom(telegramUser, { chat: { id: group, type: "group" } })
    );
    const sent = await telegramSawIn(group);
    expect({
      handed,
      sent: sent.map(({ method, fields }) => ({ method, text: fields.text })),
    }).toStrictEqual({
      handed: [],
      sent: [{ method: "sendMessage", text: say("privateOnly", "en") }],
    });
  });

  it("drops other bots' messages without a word", async () => {
    const bot = someone();
    const { status, handed } = await post(messageFrom(bot, { isBot: true }));
    expect({ status, handed, sent: await telegramSawIn(bot) }).toStrictEqual({
      status: 200,
      handed: [],
      sent: [],
    });
  });
});
